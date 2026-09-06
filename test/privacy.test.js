/**
 * privacy.test.js — this build is PULL-ONLY. These tests are the contract.
 *
 * Meridian pushed pool address, pool name, base mint, exact PnL and hold time to a
 * third-party server, keyed to a stable agentId. That is enough for anyone with read
 * access to reconstruct which pools a wallet is in and when it exits — i.e. to follow
 * or front-run it. The operator asked for consumption without contribution, so the
 * default must be: no writes at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HiveClient, memoryStore, redactPoolNames } from "../hive/hive-client.js";
import { config } from "../config.js";
import { assertRiskRewardSanity } from "../config.js";

function spyClient(share = {}) {
  const calls = [];
  const c = new HiveClient({
    baseUrl: "https://x.test",
    apiKey: "k",
    agentId: "agt_test",
    store: memoryStore(),
    config: { share },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
  });
  c.calls = calls;
  return c;
}

// ─── the default posture ────────────────────────────────────────

test("shipped defaults transmit nothing", async () => {
  const c = spyClient({ lessons: false, performance: false });
  await c.pushLesson({ rule: "PREFER: FABLE-SOL-type pools (volatility=5, bin_step=100) PnL +9%.", id: 1 });
  await c.pushPerformance({ pool: "POOL", pool_name: "FABLE-SOL", pnl_pct: 9 });
  assert.equal(c.calls.length, 0, "pull-only means zero outbound writes");
});

test("the live config really is pull-only", () => {
  const s = config.hiveMind.share;
  assert.equal(s.lessons, false);
  assert.equal(s.performance, false);
  assert.equal(s.poolAddress, false);
  assert.equal(s.poolName, false);
  assert.equal(s.baseMint, false);
});

test("pulling still works with sharing off", async () => {
  const c = new HiveClient({
    baseUrl: "https://x.test", apiKey: "k", agentId: "a",
    store: memoryStore(), config: { share: { lessons: false, performance: false } },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ lessons: [] }) }),
  });
  const out = await c.pullLessons();
  assert.ok(out, "consumption must not depend on contribution");
});

// ─── opt-in leaks only what was opted into ──────────────────────

test("opting into lesson sharing still redacts pool identity by default", async () => {
  const c = spyClient({ lessons: true });
  await c.pushLesson({
    rule: 'PREFER: FABLE-SOL-type pools (volatility=5.5, bin_step=100) with strategy="spot" PnL +3.29%.',
    id: 7, tags: ["spot"], pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6d",
  });
  assert.equal(c.calls.length, 1);
  const body = JSON.parse(c.calls[0].init.body);
  assert.ok(!/FABLE-SOL/.test(body.lesson.rule), `pool name leaked: ${body.lesson.rule}`);
  assert.match(body.lesson.rule, /<pool>-type pools/);
  assert.equal(body.lesson.pool, undefined, "pool address needs its own opt-in");
  // The useful part survives.
  assert.match(body.lesson.rule, /volatility=5\.5/);
  assert.match(body.lesson.rule, /PnL \+3\.29%/);
});

test("pool name is only sent when that specific flag is on", async () => {
  const c = spyClient({ lessons: true, poolName: true });
  await c.pushLesson({ rule: "PREFER: FABLE-SOL-type pools (volatility=5, bin_step=100) PnL +9%.", id: 1 });
  const body = JSON.parse(c.calls[0].init.body);
  assert.match(body.lesson.rule, /FABLE-SOL/);
});

test("redactPoolNames strips names and raw addresses but keeps the shape", () => {
  assert.equal(
    redactPoolNames('PREFER: FABLE-SOL-type pools (volatility=5) with strategy="spot"'),
    'PREFER: <pool>-type pools (volatility=5) with strategy="spot"',
  );
  assert.equal(
    redactPoolNames("FAILED: grail-SOL, strategy=spot, bin_step=100"),
    "FAILED: <pool>, strategy=spot, bin_step=100",
  );
  assert.match(redactPoolNames("note 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6d here"), /<addr>/);
});

test("performance push buckets size rather than reporting it exactly", async () => {
  const c = spyClient({ performance: true });
  await c.pushPerformance({ amount_sol: 1.37, pnl_pct: 4, strategy: "spot", close_reason: "take profit" });
  const body = JSON.parse(c.calls[0].init.body);
  assert.equal(body.event.sizeBucket, "1-3");
  assert.equal(body.event.amountSol, undefined, "exact position size identifies the wallet");
  assert.equal(body.event.pool, undefined);
  assert.equal(body.event.baseMint, undefined);
});

test("no registration heartbeat is sent — it is a write that only fingerprints us", async () => {
  const { registerHiveMindAgent } = await import("../hivemind.js");
  assert.equal(await registerHiveMindAgent(), null);
});

// ─── payoff sanity ──────────────────────────────────────────────

test("the exit-asymmetry check fires on a lopsided payoff", () => {
  const warn = assertRiskRewardSanity({ management: { stopLossPct: -50, takeProfitPct: 5, trailingTakeProfit: false } });
  assert.equal(warn.length, 1);
  assert.equal(warn[0].level, "error", "1:10 against should be an error, not a nudge");
  assert.match(warn[0].text, /90\.9% win rate/);
});

test("a balanced payoff produces no warning", () => {
  const warn = assertRiskRewardSanity({ management: { stopLossPct: -10, takeProfitPct: 10, trailingTakeProfit: false } });
  assert.deepEqual(warn, []);
});

test("a trailing trigger below the swap round-trip is flagged", () => {
  const warn = assertRiskRewardSanity({
    management: { stopLossPct: -10, takeProfitPct: 10, trailingTakeProfit: true, trailingTriggerPct: 0.8 },
  });
  assert.equal(warn.length, 1);
  assert.match(warn[0].text, /round-trip swap cost/);
});

test("the SHIPPED defaults are flagged, not silently shipped as sane", () => {
  // Asserted against the shipped values explicitly, not against config.management —
  // that reads the operator's own user-config.json, so this test used to pass or fail
  // depending on whose machine ran it. (It found a real setting while failing: a local
  // config with stopLossPct -50 against takeProfitPct 5, i.e. 1:10 and a 90.9%
  // break-even. The check works; the assertion was just pinned to the wrong source.)
  const shipped = { management: { stopLossPct: -15, takeProfitPct: 5, trailingTakeProfit: false } };
  const warn = assertRiskRewardSanity(shipped);
  assert.equal(warn.length, 1, "1:3 against still deserves a warning");
  assert.match(warn[0].text, /75\.0% win rate/);
});

test("whatever the operator has configured locally is at least evaluated", () => {
  // Not asserting a verdict — their numbers are their decision — only that the check
  // runs against the live config and returns a well-formed result.
  const warn = assertRiskRewardSanity();
  assert.ok(Array.isArray(warn));
  for (const w of warn) {
    assert.ok(["warn", "error"].includes(w.level));
    assert.ok(typeof w.text === "string" && w.text.length > 0);
  }
});
