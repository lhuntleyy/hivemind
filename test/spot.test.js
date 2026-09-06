/**
 * spot.test.js — the spot venue's exit rules and safety gates.
 *
 * The exit rules are the whole point of the venue: LP's payoff on this agent's own
 * swarm data is ~+2.6% up / ~-15% down, which needs an ~85% win rate. Spot only
 * improves on that if the stop actually fires and the target actually runs. So the
 * rules are deterministic, LLM-free, and tested directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getSpotExitRule } from "../venues/spot.js";
import { config } from "../config.js";

const CFG = {
  stopLossPct: -8,
  takeProfitPct: 40,
  trailingTriggerPct: 15,
  trailingDropPct: 8,
  maxHoldMinutes: 360,
};

const NOW = Date.parse("2026-09-06T12:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

function pos(over = {}) {
  return {
    id: "spot_1",
    symbol: "ABC",
    entry_price_sol: 0.001,
    opened_at: minutesAgo(30),
    peak_pnl_pct: 0,
    trailing_active: false,
    ...over,
  };
}

// price for a given % move off a 0.001 basis
const priceAt = (pct) => 0.001 * (1 + pct / 100);

test("holds inside the band", () => {
  assert.equal(getSpotExitRule(pos(), priceAt(5), CFG, NOW), null);
  assert.equal(getSpotExitRule(pos(), priceAt(-5), CFG, NOW), null);
});

test("stop loss fires at the threshold", () => {
  assert.equal(getSpotExitRule(pos(), priceAt(-7.9), CFG, NOW), null);
  const r = getSpotExitRule(pos(), priceAt(-8.1), CFG, NOW);
  assert.match(r.reason, /stop loss/);
  assert.equal(r.action, "CLOSE");
});

test("take profit fires at the threshold", () => {
  assert.equal(getSpotExitRule(pos(), priceAt(39), CFG, NOW), null);
  assert.match(getSpotExitRule(pos(), priceAt(41), CFG, NOW).reason, /take profit/);
});

test("trailing only fires once armed", () => {
  // Peaked at +20 and fell to +10 — a 10-point drop, past the 8-point limit. But if
  // trailing was never armed the rule must not fire, or an un-armed position would
  // exit on any pullback.
  const notArmed = pos({ peak_pnl_pct: 20, trailing_active: false });
  assert.equal(getSpotExitRule(notArmed, priceAt(10), CFG, NOW), null);

  const armed = pos({ peak_pnl_pct: 20, trailing_active: true });
  assert.match(getSpotExitRule(armed, priceAt(10), CFG, NOW).reason, /trailing/);
});

test("an armed trailing position still holds inside the drop limit", () => {
  const armed = pos({ peak_pnl_pct: 20, trailing_active: true });
  assert.equal(getSpotExitRule(armed, priceAt(15), CFG, NOW), null, "5-point drop is inside the 8-point limit");
});

test("max hold fires regardless of price", () => {
  const old = pos({ opened_at: minutesAgo(400) });
  assert.match(getSpotExitRule(old, priceAt(5), CFG, NOW).reason, /max hold/);
});

test("max hold outranks a profitable price — a stale bag is still a stale bag", () => {
  const old = pos({ opened_at: minutesAgo(400) });
  assert.match(getSpotExitRule(old, priceAt(30), CFG, NOW).reason, /max hold/);
});

test("NO EXIT is signalled when the price cannot be established", () => {
  // The critical safety property. A null/zero price must not be treated as a crash to
  // zero — that would sell every winner at a fabricated -100% during any price-feed
  // outage. Time-based exit still applies; price-based rules stay silent.
  for (const bad of [null, undefined, 0, NaN, -1]) {
    assert.equal(getSpotExitRule(pos(), bad, CFG, NOW), null, `price ${bad} must not trigger a price rule`);
  }
  // ...but a stale position still times out even with no price.
  assert.match(getSpotExitRule(pos({ opened_at: minutesAgo(400) }), null, CFG, NOW).reason, /max hold/);
});

test("a missing cost basis disables price rules but not the clock", () => {
  const noBasis = pos({ entry_price_sol: null });
  assert.equal(getSpotExitRule(noBasis, priceAt(-50), CFG, NOW), null);
  assert.match(getSpotExitRule(pos({ entry_price_sol: 0, opened_at: minutesAgo(400) }), 0.002, CFG, NOW).reason, /max hold/);
});

test("maxHoldMinutes = 0 disables the clock rule rather than firing instantly", () => {
  const cfg = { ...CFG, maxHoldMinutes: 0 };
  assert.equal(getSpotExitRule(pos({ opened_at: minutesAgo(9999) }), priceAt(5), cfg, NOW), null);
});

// ─── payoff shape ───────────────────────────────────────────────

test("the shipped spot defaults are a POSITIVE-skew payoff", () => {
  // This is why the venue exists. If someone tunes it into LP's shape, the reason for
  // having a second venue disappears — so the direction of the asymmetry is asserted.
  const s = config.spot;
  assert.ok(s.takeProfitPct > Math.abs(s.stopLossPct), `take profit ${s.takeProfitPct}% must exceed stop ${s.stopLossPct}%`);
  const breakEven = (Math.abs(s.stopLossPct) / (Math.abs(s.stopLossPct) + s.takeProfitPct)) * 100;
  assert.ok(breakEven < 30, `break-even win rate should be well under 30%, got ${breakEven.toFixed(1)}%`);
});

test("spot ships disabled", () => {
  assert.equal(config.venue.spot, false, "a second engine that touches money must be an explicit opt-in");
});

test("spot slippage stays inside the wallet clamp", () => {
  assert.ok(config.spot.slippageBps >= 50 && config.spot.slippageBps <= 500);
});

// ─── pricing ────────────────────────────────────────────────────

import { getPricesSol, isPaperMode } from "../venues/spot.js";

const SOL = "So11111111111111111111111111111111111111112";

test("prices are converted to SOL per token, not left in USD", async () => {
  const out = await getPricesSol(["MINTA"], {
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: SOL, usdPrice: 200 },
        { id: "MINTA", usdPrice: 0.5 },
      ],
    }),
  });
  assert.equal(out.MINTA, 0.0025, "0.5 USD / 200 USD-per-SOL");
});

test("a missing SOL price yields NO prices rather than wrong ones", async () => {
  // Without a SOL price every conversion would be garbage. Returning null everywhere
  // makes the exit rules stand down; returning a wrong number would make them fire.
  const out = await getPricesSol(["MINTA"], {
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: "MINTA", usdPrice: 0.5 }] }),
  });
  assert.equal(out.MINTA, null);
});

test("a token Jupiter cannot price comes back null, not zero", async () => {
  // This is the trap the fallback exists for: a null treated as 0 reads as -100%
  // against any cost basis and would sell every position instantly.
  const out = await getPricesSol(["FRESH"], {
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: SOL, usdPrice: 200 }] }),
  });
  assert.equal(out.FRESH, null);
  assert.notEqual(out.FRESH, 0);
});

test("a price-feed outage degrades to nulls without throwing", async () => {
  for (const impl of [
    async () => { throw new Error("ECONNRESET"); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
    async () => ({ ok: true, json: async () => null }),
  ]) {
    const out = await getPricesSol(["A", "B"], { fetchImpl: impl });
    assert.deepEqual(out, { A: null, B: null });
  }
});

test("an empty mint list makes no network call", async () => {
  let called = false;
  const out = await getPricesSol([], { fetchImpl: async () => { called = true; } });
  assert.deepEqual(out, {});
  assert.equal(called, false);
});

test("duplicate mints are de-duplicated before the request", async () => {
  let url = "";
  await getPricesSol(["A", "A", "B"], {
    fetchImpl: async (u) => { url = u; return { ok: true, json: async () => [] }; },
  });
  const q = decodeURIComponent(url.split("query=")[1] || "");
  assert.equal(q.split(",").filter((m) => m === "A").length, 1);
});

test("paper mode follows DRY_RUN", () => {
  const saved = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  assert.equal(isPaperMode(), true);
  process.env.DRY_RUN = "false";
  assert.equal(isPaperMode(), false);
  if (saved === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = saved;
});
