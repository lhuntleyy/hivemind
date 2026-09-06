/**
 * self-learning.js — the agent's own learning loop, independent of the swarm.
 *
 * WHAT MERIDIAN DID AND WHY IT WAS NOT ENOUGH
 * -------------------------------------------
 * `lessons.js#derivLesson` turns each closed position into a sentence keyed on the
 * POOL NAME ("PREFER: FABLE-SOL-type pools ..."). That memorises dead memecoins. The
 * next candidate is a different token, so the lesson matches nothing and the only
 * thing it does is consume prompt budget.
 *
 * `lessons.js#evolveThresholds` moves exactly two knobs (minFeeActiveTvlRatio,
 * minOrganic) and both are guarded by `if (rounded > current)` — it can only ever make
 * screening STRICTER. Every ratchet is one-way. After a bad streak the thresholds climb
 * until no pool qualifies and the agent silently stops trading, with no path back.
 *
 * THIS MODULE
 * -----------
 *  1. PLAYBOOK — generalises our own closes into feature bands
 *     (strategy x volatility x bin_step x mcap) with a Wilson lower bound, so a 2-for-2
 *     record does not read as "100% win rate". This is what gets injected into the
 *     prompt instead of pool-name anecdotes.
 *  2. BIDIRECTIONAL EVOLUTION — thresholds can loosen as well as tighten, with hard
 *     floors and ceilings, plus a starvation release: if screening has produced no
 *     deploy for a long stretch, the ratchet backs off instead of deadlocking.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

// Paths are module-level defaults but overridable per call. Without this, exercising
// threshold evolution in a test would rewrite the operator's real user-config.json —
// so the most safety-critical function in this file was also the only untestable one.
const LESSONS_FILE = repoPath("lessons.json");
const LEARNING_FILE = repoPath("learning-state.json");
const USER_CONFIG_FILE = repoPath("user-config.json");

function paths(over = {}) {
  return {
    lessons: over.lessonsFile ?? LESSONS_FILE,
    learning: over.learningFile ?? LEARNING_FILE,
    userConfig: over.userConfigFile ?? USER_CONFIG_FILE,
  };
}

// ─── Feature bucketing (shared vocabulary with hive/lesson-quality.js) ──

export function volBucket(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v < 1) return "vol<1";
  if (v < 2.5) return "vol1-2.5";
  if (v < 5) return "vol2.5-5";
  if (v < 10) return "vol5-10";
  return "vol10+";
}

export function stepBucket(b) {
  if (b == null || !Number.isFinite(b)) return null;
  if (b < 50) return "step<50";
  if (b <= 100) return "step50-100";
  if (b <= 125) return "step101-125";
  return "step125+";
}

export function mcapBucket(m) {
  if (m == null || !Number.isFinite(m)) return null;
  if (m < 300_000) return "mc<300K";
  if (m < 1_000_000) return "mc300K-1M";
  if (m < 5_000_000) return "mc1-5M";
  return "mc5M+";
}

/**
 * Wilson score lower bound at 95% confidence.
 *
 * Chosen over a raw or Laplace-smoothed rate because it is asymmetric in exactly the
 * way we need: 2 wins from 2 trades yields ~0.34, not 1.0, while 40 wins from 50 yields
 * ~0.68. Small samples cannot masquerade as certainty, which is what makes it safe to
 * feed straight into a deploy decision.
 */
export function wilsonLowerBound(wins, total, z = 1.96) {
  if (total <= 0) return 0;
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

// ─── Playbook ───────────────────────────────────────────────────

function loadPerformance() {
  try {
    if (!fs.existsSync(LESSONS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return Array.isArray(data.performance) ? data.performance : [];
  } catch {
    return [];
  }
}

/**
 * Collapse our own closes into feature bands.
 *
 * @param {Array} performance
 * @param {object} opts
 * @param {number} [opts.minObservations=3] bands thinner than this are not actionable
 * @param {number} [opts.windowDays=45]     older closes describe a different market
 */
export function buildPlaybook(performance = loadPerformance(), { minObservations = 3, windowDays = 45, now = Date.now() } = {}) {
  const cutoff = now - windowDays * 86_400_000;
  const bands = new Map();

  for (const p of Array.isArray(performance) ? performance : []) {
    // lessons.json is written by several code paths and has been seen with holes in
    // it. A single null here used to throw, and since getPlaybookForPrompt runs on
    // every cycle, that would take down screening and management alike.
    if (!p || typeof p !== "object") continue;

    const ts = Date.parse(p.recorded_at || p.closed_at || "") || 0;
    if (ts && ts < cutoff) continue;

    const snap = (p.signal_snapshot && typeof p.signal_snapshot === "object") ? p.signal_snapshot : {};
    const vol = volBucket(Number(p.volatility ?? snap.volatility));
    const step = stepBucket(Number(p.bin_step));
    const mc = mcapBucket(Number(p.entry_mcap ?? snap.entry_mcap));
    // Must be a real string: an object here would stringify into "[object Object]"
    // and silently create a junk band.
    const strategy = typeof p.strategy === "string" && p.strategy.trim() ? p.strategy.trim() : null;
    if (!strategy || !vol) continue; // strategy+volatility is the minimum useful key

    const key = [strategy, vol, step ?? "step?", mc ?? "mc?"].join(" | ");
    if (!bands.has(key)) {
      bands.set(key, { key, strategy, vol, step, mc, wins: 0, total: 0, pnlSum: 0, feeSum: 0, rangeSum: 0, holdSum: 0 });
    }
    const b = bands.get(key);
    b.total += 1;
    if (Number(p.pnl_pct) > 0) b.wins += 1;
    b.pnlSum += Number(p.pnl_pct) || 0;
    b.feeSum += Number(p.fees_earned_usd) || 0;
    b.rangeSum += Number(p.range_efficiency) || 0;
    b.holdSum += Number(p.minutes_held) || 0;
  }

  return [...bands.values()]
    .filter((b) => b.total >= minObservations)
    .map((b) => ({
      key: b.key,
      strategy: b.strategy,
      volatility: b.vol,
      bin_step: b.step,
      mcap: b.mc,
      observations: b.total,
      wins: b.wins,
      win_rate: r3(b.wins / b.total),
      // The number the prompt should actually reason with.
      confidence_floor: r3(wilsonLowerBound(b.wins, b.total)),
      avg_pnl_pct: r2(b.pnlSum / b.total),
      avg_fees_usd: r2(b.feeSum / b.total),
      avg_range_efficiency: r1(b.rangeSum / b.total),
      avg_hold_minutes: Math.round(b.holdSum / b.total),
    }))
    .sort((a, b) => b.confidence_floor - a.confidence_floor);
}

/**
 * Prompt block for the SCREENER: what OUR OWN history says works and what does not.
 * Unlike swarm evidence this is trusted — it is our own closed positions.
 */
export function getPlaybookForPrompt({ maxBands = 6 } = {}) {
  const playbook = buildPlaybook();
  if (playbook.length === 0) return null;

  const good = playbook.filter((b) => b.confidence_floor >= 0.5).slice(0, maxBands);
  const bad = playbook
    .filter((b) => b.win_rate <= 0.34 && b.observations >= 4)
    .sort((a, b) => a.win_rate - b.win_rate)
    .slice(0, 3);

  const lines = ["YOUR OWN PLAYBOOK (from closed positions, Wilson 95% lower bound):"];
  if (good.length) {
    lines.push("  Configurations that hold up:");
    for (const b of good) {
      lines.push(
        `    ${b.key.padEnd(42)} floor ${(b.confidence_floor * 100).toFixed(0)}% ` +
        `(${b.wins}/${b.observations}), avg PnL ${b.avg_pnl_pct}%, hold ${b.avg_hold_minutes}m`,
      );
    }
  }
  if (bad.length) {
    lines.push("  Configurations that have repeatedly failed — avoid:");
    for (const b of bad) {
      lines.push(`    ${b.key.padEnd(42)} ${b.wins}/${b.observations} wins, avg PnL ${b.avg_pnl_pct}%`);
    }
  }
  if (good.length === 0 && bad.length === 0) {
    lines.push("  Not enough closed positions yet for any band to be conclusive.");
  }
  return lines.join("\n");
}

// ─── Bidirectional threshold evolution ──────────────────────────

/**
 * Bounds are hard. Evolution moves inside them and can go BOTH ways; Meridian's
 * version could only tighten, so a bad streak walked the agent into a state where
 * nothing passed screening and there was no path back.
 */
const BOUNDS = {
  minFeeActiveTvlRatio: { min: 0.02, max: 2.0, step: 0.15 },
  minOrganic:           { min: 40,   max: 90,  step: 0.10 },
  minHolders:           { min: 100,  max: 5000, step: 0.15 },
  minTokenFeesSol:      { min: 5,    max: 200, step: 0.15 },
};

const MIN_SAMPLES = 8;
const STARVATION_CYCLES = 40; // screening cycles with no deploy before we relax

function loadLearningState(file = LEARNING_FILE) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { /* a corrupt learning file is not safety-critical; start fresh */ }
  return { screensSinceDeploy: 0, lastEvolvedAt: null, history: [] };
}

function saveLearningState(state, file = LEARNING_FILE) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Called by the screening cycle every time it finishes without deploying. */
export function noteScreenWithoutDeploy(opts = {}) {
  const p = paths(opts);
  const s = loadLearningState(p.learning);
  s.screensSinceDeploy = (s.screensSinceDeploy || 0) + 1;
  saveLearningState(s, p.learning);
  return s.screensSinceDeploy;
}

/** Called on every successful deploy. */
export function noteDeploy(opts = {}) {
  const p = paths(opts);
  const s = loadLearningState(p.learning);
  s.screensSinceDeploy = 0;
  saveLearningState(s, p.learning);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Evolve screening thresholds in both directions.
 *
 * TIGHTEN when losers cluster below where winners sit.
 * LOOSEN when either (a) winners sit at or below the current floor, meaning the floor
 * is cutting into profitable territory, or (b) we have been starved of deploys for
 * STARVATION_CYCLES screens — the deadlock release.
 *
 * @returns {{changes, rationale}|null}
 */
export function evolveThresholdsBidirectional(perfData, config, { now = Date.now(), ...fileOpts } = {}) {
  if (!Array.isArray(perfData) || perfData.length < MIN_SAMPLES) return null;

  const p = paths(fileOpts);
  const state = loadLearningState(p.learning);
  const starved = (state.screensSinceDeploy || 0) >= STARVATION_CYCLES;

  const winners = perfData.filter((p) => Number(p.pnl_pct) > 0);
  const losers = perfData.filter((p) => Number(p.pnl_pct) <= -5);
  if (winners.length < 2 && !starved) return null;

  const changes = {};
  const rationale = {};

  const fields = [
    { key: "minFeeActiveTvlRatio", pick: (p) => Number(p.fee_tvl_ratio), round: (v) => Number(v.toFixed(3)) },
    { key: "minOrganic",           pick: (p) => Number(p.organic_score), round: (v) => Math.round(v) },
  ];

  for (const { key, pick, round } of fields) {
    const bounds = BOUNDS[key];
    const current = Number(config.screening[key]);
    if (!Number.isFinite(current) || !bounds) continue;

    const wv = winners.map(pick).filter(Number.isFinite);
    const lv = losers.map(pick).filter(Number.isFinite);

    let target = null;
    let why = null;

    if (wv.length >= 2) {
      const minWinner = Math.min(...wv);

      // LOOSEN: our floor is above the weakest configuration that still won for us,
      // so the floor is excluding profitable trades.
      if (minWinner < current * 0.9) {
        target = minWinner * 0.95;
        why = `weakest winner had ${key}=${round(minWinner)} but the floor is ${current} — the floor is cutting into profitable ground`;
      } else if (lv.length >= 2) {
        const maxLoser = Math.max(...lv);
        // TIGHTEN: losers all sit below the weakest winner. There is a clean gap.
        if (maxLoser < minWinner && maxLoser >= current) {
          target = Math.min(maxLoser * 1.1, minWinner * 0.95);
          why = `losers topped out at ${round(maxLoser)}, weakest winner ${round(minWinner)} — raising into the gap`;
        }
      }
    }

    // Starvation release outranks everything: a threshold that lets nothing through
    // produces no data, so it can never be corrected by evidence.
    if (starved && target == null) {
      target = current * 0.85;
      why = `no deploy in ${state.screensSinceDeploy} screens — relaxing to break the deadlock`;
    }

    if (target == null) continue;

    const maxMove = current * bounds.step;
    const delta = clamp(target - current, -maxMove, maxMove);
    const next = round(clamp(current + delta, bounds.min, bounds.max));
    if (next === round(current)) continue;

    changes[key] = next;
    rationale[key] = `${why} → ${current} to ${next}`;
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // Persist to user-config.json and apply live.
  const USER_CONFIG_PATH = p.userConfig;
  let userConfig = {};
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch { /* keep going with an empty base rather than losing the evolution */ }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date(now).toISOString();
  userConfig._positionsAtEvolution = perfData.length;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  for (const [k, v] of Object.entries(changes)) config.screening[k] = v;

  state.lastEvolvedAt = new Date(now).toISOString();
  state.history = [...(state.history || []), { at: state.lastEvolvedAt, changes, rationale, starved }].slice(-30);
  if (starved) state.screensSinceDeploy = 0; // give the relaxed thresholds a fair run
  saveLearningState(state, p.learning);

  log("evolve", `Bidirectional evolution: ${JSON.stringify(changes)}`);
  return { changes, rationale };
}

export function getLearningStatus(opts = {}) {
  const state = loadLearningState(paths(opts).learning);
  return {
    screens_since_deploy: state.screensSinceDeploy || 0,
    starvation_at: STARVATION_CYCLES,
    last_evolved_at: state.lastEvolvedAt || null,
    recent_evolutions: (state.history || []).slice(-5),
    playbook: buildPlaybook(),
  };
}

function r1(n) { return Math.round(n * 10) / 10; }
function r2(n) { return Math.round(n * 100) / 100; }
function r3(n) { return Math.round(n * 1000) / 1000; }
