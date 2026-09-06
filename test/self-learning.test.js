import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wilsonLowerBound,
  volBucket,
  stepBucket,
  mcapBucket,
  buildPlaybook,
} from "../self-learning.js";

// ─── Wilson bound ───────────────────────────────────────────────

test("Wilson lower bound refuses to call a tiny sample certain", () => {
  // The whole point: 2/2 must NOT read as 100%, or one lucky pair of trades becomes
  // a rule the screener trusts. Meridian's raw win_rate did exactly that.
  const two = wilsonLowerBound(2, 2);
  const fifty = wilsonLowerBound(40, 50);
  assert.ok(two < 0.45, `2/2 should be well under 45%, got ${two}`);
  assert.ok(fifty > 0.65, `40/50 should clear 65%, got ${fifty}`);
  assert.ok(fifty > two, "a large sample must outrank a tiny one at the same-ish rate");
});

test("Wilson bound rises with evidence at a constant rate", () => {
  const a = wilsonLowerBound(3, 4);
  const b = wilsonLowerBound(30, 40);
  const c = wilsonLowerBound(300, 400);
  assert.ok(a < b && b < c, `expected monotonic growth, got ${a} ${b} ${c}`);
  assert.ok(c < 0.75, "it never exceeds the observed rate");
});

test("Wilson bound handles the degenerate cases", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(0, 10) < 0.05, true);
  assert.ok(wilsonLowerBound(1, 1) < 0.3);
});

// ─── bucketing ──────────────────────────────────────────────────

test("buckets", () => {
  assert.equal(volBucket(0.5), "vol<1");
  assert.equal(volBucket(6), "vol5-10");
  assert.equal(volBucket(null), null);
  assert.equal(volBucket(NaN), null);
  assert.equal(stepBucket(100), "step50-100");
  assert.equal(mcapBucket(250_000), "mc<300K");
  assert.equal(mcapBucket(2_000_000), "mc1-5M");
});

// ─── playbook ───────────────────────────────────────────────────

function close(over = {}) {
  return {
    strategy: "bid_ask",
    volatility: 6,
    bin_step: 100,
    entry_mcap: 400_000,
    pnl_pct: 5,
    fees_earned_usd: 2,
    range_efficiency: 90,
    minutes_held: 120,
    recorded_at: new Date().toISOString(),
    ...over,
  };
}

test("playbook generalises across pools instead of memorising names", () => {
  // Three different tokens, same configuration. Meridian would emit three unrelated
  // "PREFER: X-SOL-type pools" lessons; we get one band that transfers.
  const perf = [
    close({ pool_name: "AAA-SOL" }),
    close({ pool_name: "BBB-SOL" }),
    close({ pool_name: "CCC-SOL", pnl_pct: -4 }),
  ];
  const pb = buildPlaybook(perf, { minObservations: 3 });
  assert.equal(pb.length, 1);
  assert.equal(pb[0].key, "bid_ask | vol5-10 | step50-100 | mc300K-1M");
  assert.equal(pb[0].observations, 3);
  assert.equal(pb[0].wins, 2);
  assert.ok(pb[0].confidence_floor < pb[0].win_rate, "the floor must sit below the raw rate");
});

test("bands below the observation threshold are dropped", () => {
  const pb = buildPlaybook([close(), close()], { minObservations: 3 });
  assert.equal(pb.length, 0, "two closes is not a pattern");
});

test("closes outside the window are ignored", () => {
  const old = new Date(Date.now() - 120 * 86400000).toISOString();
  const pb = buildPlaybook(
    [close({ recorded_at: old }), close({ recorded_at: old }), close({ recorded_at: old })],
    { minObservations: 3, windowDays: 45 },
  );
  assert.equal(pb.length, 0, "a 4-month-old memecoin regime is not evidence about today");
});

test("closes missing a strategy or volatility cannot form a band", () => {
  const pb = buildPlaybook(
    [close({ strategy: null }), close({ volatility: null }), close({ strategy: undefined })],
    { minObservations: 1 },
  );
  assert.equal(pb.length, 0);
});

test("playbook is safe on malformed performance data", () => {
  // getPlaybookForPrompt runs on EVERY agent cycle, so a hole in lessons.json must
  // degrade to "no playbook", never throw. A null entry used to crash this.
  for (const bad of [null, undefined, "nope", 42, [null], [undefined], [{}], [{ strategy: {} }], [{ strategy: "spot" }]]) {
    assert.doesNotThrow(() => buildPlaybook(bad, { minObservations: 1 }), `threw on ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(buildPlaybook([null, undefined], { minObservations: 1 }), []);
});

test("a non-string strategy cannot create a junk band", () => {
  const rows = [
    { strategy: {}, volatility: 6, pnl_pct: 5, recorded_at: new Date().toISOString() },
    { strategy: {}, volatility: 6, pnl_pct: 5, recorded_at: new Date().toISOString() },
  ];
  const pb = buildPlaybook(rows, { minObservations: 1 });
  assert.equal(pb.length, 0, "[object Object] must never become a strategy name");
});

test("different strategies at the same volatility stay separate bands", () => {
  const perf = [
    close({ strategy: "spot" }), close({ strategy: "spot" }), close({ strategy: "spot" }),
    close({ strategy: "bid_ask" }), close({ strategy: "bid_ask" }), close({ strategy: "bid_ask" }),
  ];
  const pb = buildPlaybook(perf, { minObservations: 3 });
  assert.equal(pb.length, 2);
  assert.deepEqual(new Set(pb.map((b) => b.strategy)), new Set(["spot", "bid_ask"]));
});
