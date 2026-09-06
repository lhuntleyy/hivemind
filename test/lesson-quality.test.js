import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRule,
  classifyJunk,
  evidenceScore,
  volatilityBucket,
  binStepBucket,
  buildFeatureBands,
  ingestSwarmLessons,
} from "../hive/lesson-quality.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "live-hive-pull.json"), "utf8"));

// ─── parsing real shapes off the live feed ──────────────────────

test("parses the PREFER shape", () => {
  const p = parseRule('PREFER: FABLE-SOL-type pools (volatility=12.9208, bin_step=100) with strategy="bid_ask" - 100% in-range efficiency, PnL +1.49%. Entry: mcap=235K, tvl=11K, vol=1K.');
  assert.equal(p.kind, "PREFER");
  assert.equal(p.pool, "FABLE-SOL");
  assert.equal(p.strategy, "bid_ask");
  assert.equal(p.volatility, 12.9208);
  assert.equal(p.bin_step, 100);
  assert.equal(p.pnl_pct, 1.49);
  assert.equal(p.range_efficiency, 100);
  assert.equal(p.entry_mcap, 235000);
});

test("parses the FAILED shape including the close reason", () => {
  const p = parseRule('FAILED: grail-SOL, strategy=spot, bin_step=100, volatility=2.72, fee_tvl_ratio=0.16, organic=85, bin_range={"min":-531,"max":-478,"bins_below":53,"bins_above":0} -> PnL -15.06%, range efficiency 100%. Reason: stop loss.');
  assert.equal(p.kind, "FAILED");
  assert.equal(p.pool, "grail-SOL");
  assert.equal(p.strategy, "spot");
  assert.equal(p.pnl_pct, -15.06);
  assert.equal(p.fee_tvl_ratio, 0.16);
  assert.equal(p.organic, 85);
  assert.equal(p.bins_below, 53);
  assert.equal(p.reason, "stop loss");
});

test("returns null for text that is not a lesson", () => {
  assert.equal(parseRule("hello world"), null);
  assert.equal(parseRule(""), null);
});

// ─── junk filtering ─────────────────────────────────────────────

test("rejects the TEST-SOL records that pollute the live feed", () => {
  const rule = 'FAILED: TEST-SOL, strategy=spot, bin_step=100, volatility=2, fee_tvl_ratio=0.05, organic=85, bin_range={"min":-50,"max":0} -> PnL -30.93%, range efficiency 100%. Reason: test close.';
  const j = classifyJunk(parseRule(rule), { rule });
  assert.equal(j.junk, true);
  assert.ok(j.reasons.includes("test_pool_name"));
  assert.ok(j.reasons.includes("test_close_reason"));
});

test("rejects rules whose features serialised as undefined/null", () => {
  const rule = "FAILED: FEE/SOL, strategy=spot, bin_step=undefined, volatility=undefined, fee_tvl_ratio=undefined, organic=undefined -> PnL -17%, range efficiency 50%. Reason: test.";
  const j = classifyJunk(parseRule(rule), { rule });
  assert.equal(j.junk, true);
  assert.ok(j.reasons.includes("null_features"));
});

test("rejects a PREFER whose PnL is inside fee/gas noise", () => {
  const rule = 'PREFER: X-SOL-type pools (volatility=3, bin_step=100) with strategy="spot" - 100% in-range efficiency, PnL +0.4%.';
  const j = classifyJunk(parseRule(rule), { rule });
  assert.ok(j.reasons.includes("pnl_below_noise_floor"));
});

test("keeps a real, well-specified outcome", () => {
  const rule = 'PREFER: ABC-SOL-type pools (volatility=6.05, bin_step=100) with strategy="spot" - 96% in-range efficiency, PnL +8.2%.';
  assert.equal(classifyJunk(parseRule(rule), { rule }).junk, false);
});

// ─── evidence scoring ───────────────────────────────────────────

test("ranks by evidence, not by the near-constant server score", () => {
  const now = Date.parse("2026-08-01T00:00:00Z");
  const parsed = parseRule('PREFER: A-SOL-type pools (volatility=3, bin_step=100) with strategy="spot" - 90% in-range efficiency, PnL +9%.');

  const strong = evidenceScore(
    { distinctAgents: 200, sampleCount: 500, confidence: 0.82, consensus: "strong", created_at: "2026-07-30T00:00:00Z" },
    parsed, { now },
  );
  const weak = evidenceScore(
    { distinctAgents: 1, sampleCount: 1, confidence: 0.82, consensus: "weak", created_at: "2026-07-30T00:00:00Z" },
    parsed, { now },
  );
  assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
});

test("agreement credit saturates - the swarm is correlated, not independent", () => {
  const now = Date.now();
  const parsed = parseRule('PREFER: A-SOL-type pools (volatility=3, bin_step=100) with strategy="spot" - 90% in-range efficiency, PnL +9%.');
  const at30 = evidenceScore({ distinctAgents: 30, sampleCount: 30, confidence: 0.8, created_at: new Date(now).toISOString() }, parsed, { now });
  const at280 = evidenceScore({ distinctAgents: 280, sampleCount: 280, confidence: 0.8, created_at: new Date(now).toISOString() }, parsed, { now });
  const gain = at280.score - at30.score;
  assert.ok(gain >= 0, "more agents should not hurt");
  assert.ok(gain < 0.09, `9x more agents must not be worth much more (gain was ${gain})`);
});

test("contradicted lessons are heavily discounted", () => {
  const now = Date.now();
  const parsed = parseRule('PREFER: A-SOL-type pools (volatility=3, bin_step=100) with strategy="spot" - 90% in-range efficiency, PnL +9%.');
  const base = { distinctAgents: 50, sampleCount: 100, confidence: 0.8, created_at: new Date(now).toISOString() };
  const ok = evidenceScore(base, parsed, { now }).score;
  const bad = evidenceScore({ ...base, contradictory: true }, parsed, { now }).score;
  assert.ok(bad < ok * 0.5, `contradicted (${bad}) must be far below agreed (${ok})`);
});

test("old lessons decay", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const parsed = parseRule('PREFER: A-SOL-type pools (volatility=3, bin_step=100) with strategy="spot" - 90% in-range efficiency, PnL +9%.');
  const fresh = evidenceScore({ distinctAgents: 40, sampleCount: 40, confidence: 0.8, created_at: "2026-08-31T00:00:00Z" }, parsed, { now }).score;
  const stale = evidenceScore({ distinctAgents: 40, sampleCount: 40, confidence: 0.8, created_at: "2026-04-01T00:00:00Z" }, parsed, { now }).score;
  assert.ok(stale < fresh, "a 5-month-old memecoin lesson must rank below a fresh one");
});

// ─── generalisation ─────────────────────────────────────────────

test("bucket helpers", () => {
  assert.equal(volatilityBucket(0.4), "vol<1");
  assert.equal(volatilityBucket(3.2), "vol2.5-5");
  assert.equal(volatilityBucket(12.9), "vol10+");
  assert.equal(volatilityBucket(null), null);
  assert.equal(binStepBucket(100), "step50-100");
  assert.equal(binStepBucket(125), "step101-125");
});

test("feature bands collapse pool-specific rules into a transferable pattern", () => {
  const mk = (pool, pnl, kind) => ({
    parsed: parseRule(`${kind}: ${pool}-type pools (volatility=6, bin_step=100) with strategy="spot" - 95% in-range efficiency, PnL ${pnl > 0 ? "+" : ""}${pnl}%.`),
    score: 0.5,
    raw: { agentIds: ["a1", "a2"] },
  });
  const bands = buildFeatureBands([
    mk("AAA-SOL", 9, "PREFER"),
    mk("BBB-SOL", 7, "PREFER"),
    mk("CCC-SOL", -8, "AVOID"),
  ]);
  assert.equal(bands.length, 1, "three different pools collapse into one pattern");
  const b = bands[0];
  assert.equal(b.key, "spot | vol5-10 | step50-100");
  assert.equal(b.distinct_pools, 3);
  assert.ok(b.win_rate > 0.5 && b.win_rate < 1, `smoothed win rate should not be 100% (got ${b.win_rate})`);
});

// ─── against the real captured payload ──────────────────────────

test("the live payload is mostly junk and the pipeline says so", () => {
  const out = ingestSwarmLessons(LIVE.lessons, { now: Date.parse("2026-08-15T00:00:00Z") });
  assert.equal(out.stats.received, 12);
  assert.ok(out.stats.rejected >= 4, `expected the TEST/null-feature records to be dropped, rejected=${out.stats.rejected}`);
  // Nothing that survives may mention a test pool.
  for (const a of out.accepted) {
    assert.ok(!/TEST-SOL/i.test(a.rule), `test record survived: ${a.rule}`);
  }
});

test("upstream score ordering carries no information on the live payload", () => {
  const scores = LIVE.lessons.map((l) => Number(l.score));
  const spread = Math.max(...scores) - Math.min(...scores);
  assert.ok(spread < 1, `server score spread was ${spread} - sorting on it is effectively arbitrary`);

  // Our evidence score must spread the same records out much further.
  const out = ingestSwarmLessons(LIVE.lessons, { now: Date.parse("2026-08-15T00:00:00Z") });
  if (out.accepted.length >= 2) {
    const ours = out.accepted.map((a) => a.score);
    const ourSpread = Math.max(...ours) - Math.min(...ours);
    assert.ok(ourSpread > 0, "evidence scores must differentiate records");
  }
});

test("ingest is safe on garbage input", () => {
  for (const bad of [null, undefined, "nope", 42, [{}], [{ rule: null }]]) {
    const out = ingestSwarmLessons(bad);
    assert.ok(out && typeof out.stats.received === "number");
  }
});
