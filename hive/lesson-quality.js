/**
 * lesson-quality.js — turn raw swarm lessons into ranked, generalisable evidence.
 *
 * WHY THIS EXISTS
 * ---------------
 * A live pull from api.agentmeridian.xyz returns lessons shaped like:
 *
 *   { rule: "PREFER: FABLE-SOL-type pools (volatility=12.9, bin_step=100) with
 *            strategy=bid_ask - 100% in-range efficiency, PnL +1.49%.",
 *     score: 57.28, consensus: "strong", distinctAgents: 280, sampleCount: 595,
 *     contradictory: false, confidence: 0.82, tags: [...] }
 *
 * Meridian's client (hivemind.js#normalizeSharedLesson) keeps only
 *   { id, rule, tags, role, outcome, sourceType, score, created_at }
 * and then RANKS BY `score`. On the live feed every score sits in 57.28..57.52 —
 * a 0.24 spread. So the client sorts on the one field carrying almost no signal
 * and discards distinctAgents / sampleCount / contradictory / consensus, which
 * carry all of it. This module inverts that.
 *
 * It also fixes two content problems:
 *   1. junk: "TEST-SOL ... Reason: test close." is on the live feed with 176
 *      distinct agents behind it. Pure pollution.
 *   2. overfitting: a rule keyed on a dead memecoin's name ("FABLE-SOL-type pools")
 *      generalises to nothing. We re-express each lesson as a FEATURE BAND
 *      (strategy x volatility bucket x bin_step) which does generalise.
 */

import { sanitizeUntrusted } from "./prompt-armor.js";

// ─── Rule text parsing ──────────────────────────────────────────
// The swarm emits four shapes (see lessons.js#derivLesson upstream):
//   PREFER: <pool>-type pools (volatility=N, bin_step=N) with strategy=S - E% in-range efficiency, PnL +P%.
//   AVOID:  <pool>-type pools (volatility=N, bin_step=N) with strategy=S - went OOR X% of the time...
//   WORKED: <pool>, strategy=S, bin_step=N, volatility=N, ... PnL +P%, range efficiency E%.
//   FAILED: <pool>, strategy=S, bin_step=N, volatility=N, ... PnL P%, range efficiency E%. Reason: R.

const KIND_RE = /^(PREFER|AVOID|WORKED|FAILED)\b/i;

function num(re, text) {
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseRule(rule) {
  const text = String(rule || "");
  const kindMatch = text.match(KIND_RE);
  if (!kindMatch) return null;

  const kind = kindMatch[1].toUpperCase();

  // Pool label: "PREFER: NAME-type pools" or "FAILED: NAME, strategy="
  const poolMatch =
    text.match(/^(?:PREFER|AVOID):\s*(.+?)-type pools/i) ||
    text.match(/^(?:WORKED|FAILED):\s*(.+?),\s*strategy=/i);
  const pool = poolMatch ? poolMatch[1].trim() : null;

  const strategyMatch = text.match(/strategy="?([a-z_]+)"?/i);
  const strategy = strategyMatch ? strategyMatch[1].toLowerCase() : null;

  const reasonMatch = text.match(/Reason:\s*(.+?)\.?$/i);

  return {
    kind,
    pool,
    strategy,
    volatility:     num(/volatility=([0-9.]+)/i, text),
    bin_step:       num(/bin_step=([0-9]+)/i, text),
    fee_tvl_ratio:  num(/fee_tvl_ratio=([0-9.]+)/i, text),
    organic:        num(/organic=([0-9.]+)/i, text),
    bins_below:     num(/"?bins_below"?:\s*([0-9]+)/i, text),
    entry_mcap:     parseMagnitude(text, /mcap=([0-9.]+[KM]?)/i),
    entry_tvl:      parseMagnitude(text, /tvl=([0-9.]+[KM]?)/i),
    pnl_pct:        num(/PnL\s*([+-]?[0-9.]+)%/i, text),
    range_efficiency:
      num(/(?:range |in-range )efficiency[:\s]*([0-9.]+)%/i, text) ??
      num(/([0-9.]+)%\s*in-range efficiency/i, text),
    reason: reasonMatch ? reasonMatch[1].trim() : null,
  };
}

function parseMagnitude(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1];
  const mult = /M$/i.test(raw) ? 1e6 : /K$/i.test(raw) ? 1e3 : 1;
  const n = parseFloat(raw) * mult;
  return Number.isFinite(n) ? n : null;
}

// ─── Junk detection ─────────────────────────────────────────────
// These come straight off the live feed and are worse than useless: they are
// confidently-scored, high-consensus records describing nothing real.

const TEST_POOL_RE = /^(test|demo|foo|bar|example|dummy)\b/i;

export function classifyJunk(parsed, raw = {}) {
  const reasons = [];
  if (!parsed) return { junk: true, reasons: ["unparseable"] };

  if (parsed.pool && TEST_POOL_RE.test(parsed.pool)) reasons.push("test_pool_name");
  if (parsed.reason && /^test\b|test close|testing/i.test(parsed.reason)) reasons.push("test_close_reason");

  // Upstream writes the literal strings "undefined"/"null" into the rule text.
  if (/=\s*(undefined|null)\b/.test(String(raw.rule || ""))) reasons.push("null_features");

  // A lesson whose defining features are all missing describes no configuration
  // at all, so it can never be matched against a future candidate.
  const featureCount = ["strategy", "volatility", "bin_step", "fee_tvl_ratio", "organic"]
    .filter((k) => parsed[k] != null).length;
  if (featureCount < 2) reasons.push("insufficient_features");

  // A "win" of +0.2% is inside fee/gas noise; it is not evidence of anything.
  if (parsed.kind === "PREFER" && parsed.pnl_pct != null && Math.abs(parsed.pnl_pct) < 1) {
    reasons.push("pnl_below_noise_floor");
  }

  return { junk: reasons.length > 0, reasons };
}

// ─── Evidence scoring ───────────────────────────────────────────
/**
 * Replaces the upstream `score` sort.
 *
 * Key modelling choice: distinctAgents is NOT treated as independent observations.
 * Every agent in this swarm runs the same code with the same defaults, so 280 agents
 * reporting "FABLE-SOL worked" are largely one correlated observation repeated, not
 * 280 independent trials. Credit therefore saturates logarithmically and is capped —
 * an agreement of 280 is worth only modestly more than an agreement of 30.
 *
 * Components (each 0..1):
 *   independence  log-saturating credit for distinct agents
 *   depth         extra observations per agent, heavily discounted
 *   conviction    upstream confidence
 *   magnitude     how large the PnL outcome was
 *   recency       exponential decay, 21-day half-life
 * Penalties:
 *   contradictory  x0.35   (the swarm disagrees with itself)
 *   weak consensus x0.7
 */
export function evidenceScore(raw, parsed, { now = Date.now(), halfLifeDays = 21 } = {}) {
  const distinct = Math.max(0, Number(raw.distinctAgents) || 0);
  const samples = Math.max(distinct, Number(raw.sampleCount) || 0);

  const independence = Math.min(1, Math.log1p(distinct) / Math.log1p(50));
  const perAgent = distinct > 0 ? samples / distinct : 0;
  const depth = Math.min(1, Math.log1p(Math.max(0, perAgent - 1)) / Math.log1p(4));
  const conviction = Math.min(1, Math.max(0, Number(raw.confidence) || 0));

  const pnl = Math.abs(parsed?.pnl_pct ?? 0);
  const magnitude = Math.min(1, pnl / 15); // +/-15% is a decisive outcome

  const createdAt = Date.parse(raw.created_at || raw.createdAt || "") || now;
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / halfLifeDays);

  let score =
    0.34 * independence +
    0.10 * depth +
    0.18 * conviction +
    0.20 * magnitude +
    0.18 * recency;

  if (raw.contradictory) score *= 0.35;
  if (String(raw.consensus || "").toLowerCase() === "weak") score *= 0.7;

  return {
    score: round3(score),
    parts: {
      independence: round3(independence),
      depth: round3(depth),
      conviction: round3(conviction),
      magnitude: round3(magnitude),
      recency: round3(recency),
    },
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ─── Generalisation: pool-specific rule -> feature band ─────────

export function volatilityBucket(v) {
  if (v == null) return null;
  if (v < 1) return "vol<1";
  if (v < 2.5) return "vol1-2.5";
  if (v < 5) return "vol2.5-5";
  if (v < 10) return "vol5-10";
  return "vol10+";
}

export function binStepBucket(b) {
  if (b == null) return null;
  if (b < 50) return "step<50";
  if (b <= 100) return "step50-100";
  if (b <= 125) return "step101-125";
  return "step125+";
}

/**
 * Collapse many pool-specific lessons into feature bands with a win rate.
 * This is the piece that actually generalises: "bid_ask at vol5-10 / step50-100
 * won 7 of 9 weighted observations" transfers to a pool the swarm has never seen,
 * whereas "FABLE-SOL-type pools" does not.
 */
export function buildFeatureBands(scored, { minWeight = 0.3 } = {}) {
  const bands = new Map();

  for (const item of scored) {
    const p = item.parsed;
    const vb = volatilityBucket(p.volatility);
    const sb = binStepBucket(p.bin_step);
    if (!p.strategy || (!vb && !sb)) continue;

    const key = [p.strategy, vb ?? "vol?", sb ?? "step?"].join(" | ");
    if (!bands.has(key)) {
      bands.set(key, {
        key,
        strategy: p.strategy,
        volatility: vb,
        bin_step: sb,
        winWeight: 0,
        lossWeight: 0,
        totalWeight: 0,
        pnlWeighted: 0,
        observations: 0,
        agents: new Set(),
        pools: new Set(),
      });
    }
    const b = bands.get(key);
    const w = item.score;
    const isWin =
      p.kind === "PREFER" || p.kind === "WORKED" || (p.pnl_pct != null && p.pnl_pct > 0);

    if (isWin) b.winWeight += w;
    else b.lossWeight += w;
    b.totalWeight += w;
    b.pnlWeighted += w * (p.pnl_pct ?? 0);
    b.observations += 1;
    if (p.pool) b.pools.add(p.pool);
    for (const a of item.raw?.agentIds || []) b.agents.add(a);
  }

  return [...bands.values()]
    .filter((b) => b.totalWeight >= minWeight)
    .map((b) => ({
      key: b.key,
      strategy: b.strategy,
      volatility: b.volatility,
      bin_step: b.bin_step,
      observations: b.observations,
      distinct_pools: b.pools.size,
      distinct_agents: b.agents.size,
      // Laplace-smoothed so a single lucky observation cannot read as 100%.
      win_rate: round3((b.winWeight + 0.5) / (b.totalWeight + 1)),
      avg_pnl_pct: round3(b.pnlWeighted / b.totalWeight),
      weight: round3(b.totalWeight),
    }))
    .sort((a, b) => b.weight - a.weight);
}

// ─── Pipeline ───────────────────────────────────────────────────
/**
 * Full ingest: sanitize -> parse -> drop junk -> score -> dedupe -> bands.
 *
 * @param {Array}  lessons raw payload from /hivemind/lessons/pull
 * @param {object} opts
 * @returns {{ accepted, rejected, bands, stats }}
 */
export function ingestSwarmLessons(lessons, { now = Date.now(), minScore = 0.18, maxKeep = 40 } = {}) {
  const accepted = [];
  const rejected = [];

  for (const raw of Array.isArray(lessons) ? lessons : []) {
    const clean = sanitizeUntrusted(raw?.rule, { maxLen: 400, strict: true });
    if (!clean) {
      rejected.push({ id: raw?.id ?? null, reason: "sanitizer_rejected" });
      continue;
    }

    const parsed = parseRule(clean.text);
    const junk = classifyJunk(parsed, { rule: clean.text });
    if (junk.junk) {
      rejected.push({ id: raw?.id ?? null, reason: junk.reasons.join("+") });
      continue;
    }

    const { score, parts } = evidenceScore(raw, parsed, { now });
    if (score < minScore) {
      rejected.push({ id: raw?.id ?? null, reason: `low_evidence(${score})` });
      continue;
    }

    accepted.push({ id: raw?.id ?? null, rule: clean.text, parsed, score, parts, raw });
  }

  // Dedupe by feature signature, keeping the best-evidenced representative.
  const bySig = new Map();
  for (const item of accepted) {
    const p = item.parsed;
    const sig = [p.kind, p.strategy, volatilityBucket(p.volatility), binStepBucket(p.bin_step)].join("|");
    const prev = bySig.get(sig);
    if (!prev || item.score > prev.score) bySig.set(sig, item);
  }

  const deduped = [...bySig.values()].sort((a, b) => b.score - a.score).slice(0, maxKeep);

  return {
    accepted: deduped,
    rejected,
    bands: buildFeatureBands(accepted),
    stats: {
      received: Array.isArray(lessons) ? lessons.length : 0,
      accepted: deduped.length,
      rejected: rejected.length,
      deduped_away: accepted.length - deduped.length,
    },
  };
}
