/**
 * strategy-miner.js — recover the swarm's STRATEGY vocabulary from lesson tags.
 *
 * WHY THIS EXISTS
 * ---------------
 * The question "can we pull other agents' strategies?" has a surprising answer:
 * /hivemind/presets/pull returns `{"presets":[]}` — preset sharing is not populated.
 * But the lesson `tags` array is, and it is full of other forks' strategy names:
 *
 *   ["efficient","trinity","bid_ask+spot (70/30, 45 bins)","cooling","stable",
 *    "tempo:normal","tempo:wide","bid_ask"]
 *   ["spot_wallet_1h_v1","fee_winner","efficient","spot_on_dump","spot+bid_ask",
 *    "spot","spot_farm","degen"]
 *
 * Meridian only supports three strategies (spot / bid_ask / curve) and its client
 * discards tags entirely when ranking. So the swarm is broadcasting a catalogue of
 * strategies — mixed-ratio deploys, tempo variants, regime tags — and every agent
 * throws it away. This module reads it.
 *
 * Output is INTELLIGENCE, not configuration. It tells you which strategy labels the
 * swarm associates with wins; it must never auto-apply anything.
 */

import { sanitizeUntrusted } from "./prompt-armor.js";
import { parseRule, evidenceScore } from "./lesson-quality.js";

// Tags that are outcome labels, not strategies — used to score, not to name.
const OUTCOME_TAGS = new Set([
  "efficient", "worked", "failed", "fee_winner", "oor", "volume_collapse",
  "evolution", "config_change", "self_tune", "manual",
]);

// Regime / market-condition tags.
const REGIME_TAGS = new Set(["degen", "stable", "cooling", "heating", "trending", "chop"]);

const BASE_STRATEGIES = new Set(["spot", "bid_ask", "curve"]);

/**
 * Classify one tag.
 * @returns {{kind:string, name:string, params?:object}}
 */
export function classifyTag(rawTag) {
  const tag = String(rawTag || "").trim();
  if (!tag) return { kind: "empty", name: "" };

  const lower = tag.toLowerCase();

  if (OUTCOME_TAGS.has(lower)) return { kind: "outcome", name: lower };
  if (REGIME_TAGS.has(lower)) return { kind: "regime", name: lower };

  // "tempo:normal", "tempo:wide"
  const tempo = lower.match(/^tempo:(.+)$/);
  if (tempo) return { kind: "tempo", name: tempo[1] };

  // "volatility_3"
  if (/^volatility_\d+$/.test(lower)) return { kind: "feature", name: lower };

  // "bid_ask+spot (70/30, 45 bins)" — a mixed deploy with explicit parameters.
  const mix = lower.match(/^([a-z_]+)\+([a-z_]+)\s*(?:\(([^)]*)\))?$/);
  if (mix) {
    const params = {};
    const spec = mix[3] || "";
    const ratio = spec.match(/(\d+)\s*\/\s*(\d+)/);
    if (ratio) params.ratio = [Number(ratio[1]), Number(ratio[2])];
    const bins = spec.match(/(\d+)\s*bins/);
    if (bins) params.bins = Number(bins[1]);
    return { kind: "mix", name: `${mix[1]}+${mix[2]}`, params };
  }

  if (BASE_STRATEGIES.has(lower)) return { kind: "base", name: lower };

  // "spot_wallet_1h_v1", "spot_on_dump", "spot_farm", "spotImbalanced", "trinity"
  if (/^[a-z][a-z0-9_]*$/i.test(tag) && tag.length <= 40) {
    return { kind: "named", name: tag };
  }

  return { kind: "unknown", name: tag };
}

/**
 * Mine strategy intelligence from a raw lessons payload.
 *
 * Every tag on a lesson inherits that lesson's evidence weight and win/loss sense,
 * so a strategy label attached to many well-evidenced wins rises, and one attached to
 * junk (test lessons, single-agent flukes) does not.
 *
 * @param {Array} lessons  raw /hivemind/lessons/pull payload
 * @param {object} opts
 * @returns {{ strategies, mixes, tempos, regimes, unknown_to_us, stats }}
 */
export function mineStrategies(lessons, { now = Date.now(), minWeight = 0.15 } = {}) {
  const acc = new Map();
  let considered = 0;
  let skipped = 0;

  for (const raw of Array.isArray(lessons) ? lessons : []) {
    const clean = sanitizeUntrusted(raw?.rule, { maxLen: 400, strict: true });
    if (!clean) { skipped += 1; continue; }

    const parsed = parseRule(clean.text);
    if (!parsed) { skipped += 1; continue; }

    const { score } = evidenceScore(raw, parsed, { now });
    const isWin =
      parsed.kind === "PREFER" || parsed.kind === "WORKED" ||
      (parsed.pnl_pct != null && parsed.pnl_pct > 0);
    considered += 1;

    const tags = Array.isArray(raw?.tags) ? raw.tags : [];
    for (const rawTag of tags) {
      // Tags are attacker-controlled text too — they end up in a prompt block.
      const safeTag = sanitizeUntrusted(rawTag, { maxLen: 48, strict: true });
      if (!safeTag) continue;

      const c = classifyTag(safeTag.text);
      if (c.kind === "empty" || c.kind === "unknown" || c.kind === "outcome") continue;

      const key = `${c.kind}:${c.name}`;
      if (!acc.has(key)) {
        acc.set(key, {
          kind: c.kind, name: c.name, params: c.params || null,
          winWeight: 0, lossWeight: 0, weight: 0,
          observations: 0, pnlWeighted: 0,
          pools: new Set(), agents: new Set(),
          coStrategies: new Set(),
        });
      }
      const e = acc.get(key);
      if (isWin) e.winWeight += score; else e.lossWeight += score;
      e.weight += score;
      e.pnlWeighted += score * (parsed.pnl_pct ?? 0);
      e.observations += 1;
      if (parsed.pool) e.pools.add(parsed.pool);
      for (const a of raw?.agentIds || []) e.agents.add(a);
      if (parsed.strategy) e.coStrategies.add(parsed.strategy);
      // Merge params seen on later occurrences of the same mix.
      if (c.params && e.params) Object.assign(e.params, c.params);
    }
  }

  const rows = [...acc.values()]
    .filter((e) => e.weight >= minWeight)
    .map((e) => ({
      kind: e.kind,
      name: e.name,
      params: e.params,
      observations: e.observations,
      distinct_pools: e.pools.size,
      distinct_agents: e.agents.size,
      // Laplace-smoothed weighted win rate.
      win_rate: r3((e.winWeight + 0.5) / (e.weight + 1)),
      avg_pnl_pct: r3(e.pnlWeighted / e.weight),
      weight: r3(e.weight),
      seen_with: [...e.coStrategies],
    }))
    .sort((a, b) => b.weight - a.weight);

  const byKind = (k) => rows.filter((r) => r.kind === k);

  // Strategy labels the swarm uses that this codebase cannot express. These are the
  // actual "other agents' strategies" — candidates to implement, not to enable.
  const unknownToUs = rows.filter(
    (r) => (r.kind === "named" || r.kind === "mix") && !BASE_STRATEGIES.has(r.name),
  );

  return {
    strategies: byKind("base"),
    mixes: byKind("mix"),
    named: byKind("named"),
    tempos: byKind("tempo"),
    regimes: byKind("regime"),
    unknown_to_us: unknownToUs,
    stats: { lessons_considered: considered, lessons_skipped: skipped, tag_groups: rows.length },
  };
}

function r3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Render mined intelligence as a compact, human-readable table (for /swarm in the REPL
 * or Telegram). Deliberately NOT a prompt block — this is for the operator to read and
 * decide what to implement.
 */
export function formatStrategyIntel(intel, { limit = 8 } = {}) {
  const lines = [];
  const section = (title, rows) => {
    if (!rows.length) return;
    lines.push(`\n${title}`);
    for (const r of rows.slice(0, limit)) {
      const p = r.params
        ? ` ${JSON.stringify(r.params)}`
        : "";
      lines.push(
        `  ${String(r.name + p).padEnd(34)} win ${(r.win_rate * 100).toFixed(0).padStart(3)}%  ` +
        `avgPnL ${String(r.avg_pnl_pct).padStart(7)}%  obs ${String(r.observations).padStart(3)}  ` +
        `pools ${String(r.distinct_pools).padStart(3)}  w ${r.weight}`,
      );
    }
  };

  lines.push("SWARM STRATEGY INTEL (evidence-weighted, advisory only)");
  section("Base strategies we support:", intel.strategies);
  section("Mixed deploys used by other forks:", intel.mixes);
  section("Named strategies we do NOT implement:", intel.named);
  section("Tempo variants:", intel.tempos);
  section("Market-regime labels:", intel.regimes);
  lines.push(
    `\n${intel.stats.lessons_considered} lessons mined, ${intel.stats.tag_groups} tag groups. ` +
    `Nothing here is auto-applied.`,
  );
  return lines.join("\n");
}
