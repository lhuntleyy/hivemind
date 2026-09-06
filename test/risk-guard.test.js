import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RiskGuard } from "../hive/risk-guard.js";

function tmpFile(name = "risk-state.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-risk-"));
  return path.join(dir, name);
}

function guardAt(iso, config = {}) {
  let t = Date.parse(iso);
  const g = new RiskGuard({
    stateFile: tmpFile(),
    config,
    now: () => t,
  });
  g.advance = (ms) => { t += ms; };
  g.setTime = (nextIso) => { t = Date.parse(nextIso); };
  return g;
}

test("a clean guard allows deploys", () => {
  const g = guardAt("2026-09-01T10:00:00Z");
  assert.equal(g.canDeploy().pass, true);
});

test("daily realized loss in SOL trips the breaker", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxDailyLossSol: 0.3, maxConsecutiveLosses: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 });
  g.recordClose({ pnl_sol: -0.15 });
  assert.equal(g.canDeploy().pass, true, "one loss under the cap is fine");
  g.recordClose({ pnl_sol: -0.2 });
  const gate = g.canDeploy();
  assert.equal(gate.pass, false);
  assert.match(gate.reason, /daily realized loss/);
});

test("wins net against losses inside the same day", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxDailyLossSol: 0.3, maxConsecutiveLosses: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 });
  g.recordClose({ pnl_sol: -0.25 });
  g.recordClose({ pnl_sol: +0.40 });
  g.recordClose({ pnl_sol: -0.20 });
  assert.equal(g.canDeploy().pass, true, "net PnL is positive, the breaker must not trip");
});

test("consecutive losses trip independently of size", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxConsecutiveLosses: 3, maxDailyLossSol: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 });
  g.recordClose({ pnl_sol: -0.01 });
  g.recordClose({ pnl_sol: -0.01 });
  assert.equal(g.canDeploy().pass, true);
  g.recordClose({ pnl_sol: -0.01 });
  assert.match(g.canDeploy().reason, /consecutive losing closes/);
});

test("a real win resets the loss streak but dust does not", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxConsecutiveLosses: 3, maxDailyLossSol: 0, maxDailyLossPct: 0, maxDrawdownPct: 0, lossNoiseFloorSol: 0.002 });
  g.recordClose({ pnl_sol: -0.01 });
  g.recordClose({ pnl_sol: -0.01 });
  g.recordClose({ pnl_sol: +0.0001 });      // dust, must not reset
  assert.equal(g.status().consecutive_losses, 2);
  g.recordClose({ pnl_sol: +0.05 });        // real win, resets
  assert.equal(g.status().consecutive_losses, 0);
  assert.equal(g.canDeploy().pass, true);
});

test("dust losses do not advance the streak", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxConsecutiveLosses: 2, maxDailyLossSol: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 });
  g.recordClose({ pnl_sol: -0.0005 });
  g.recordClose({ pnl_sol: -0.0005 });
  assert.equal(g.canDeploy().pass, true, "dust must not trip the breaker");
});

test("drawdown from the equity peak trips the breaker", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxDrawdownPct: 20, maxDailyLossSol: 0, maxDailyLossPct: 0, maxConsecutiveLosses: 0 });
  g.markEquity(10);
  g.markEquity(12);       // new peak
  g.markEquity(10.5);     // -12.5% from peak
  assert.equal(g.canDeploy().pass, true);
  g.markEquity(9.5);      // -20.8% from peak
  assert.match(g.canDeploy().reason, /drawdown/);
});

test("daily loss as a percent of opening equity trips the breaker", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxDailyLossPct: 10, maxDailyLossSol: 0, maxConsecutiveLosses: 0, maxDrawdownPct: 0 });
  g.markEquity(5);                       // opening equity 5 SOL
  g.recordClose({ pnl_sol: -0.6 });      // -12% of opening
  assert.match(g.canDeploy().reason, /% of opening equity/);
});

test("daily counters roll over at UTC midnight", () => {
  const g = guardAt("2026-09-01T23:50:00Z", { maxDailyLossSol: 0.3, maxConsecutiveLosses: 0, maxDailyLossPct: 0, maxDrawdownPct: 0, cooldownMinutes: 1 });
  g.recordClose({ pnl_sol: -0.4 });
  assert.equal(g.canDeploy().pass, false);
  g.setTime("2026-09-02T00:10:00Z");
  assert.equal(g.canDeploy().pass, true, "cooldown elapsed and the new UTC day resets the counter");
  assert.equal(g.status().day_realized_pnl_sol, 0);
});

test("cooldown auto-clears a streak trip, manual halt does not", () => {
  // A consecutive-loss trip is a "cool off" condition: the cooldown resets the streak,
  // so the condition genuinely no longer holds and the breaker clears.
  // (A daily-loss trip behaves differently on purpose — see adversarial.test.js,
  // "waiting out the cooldown does not buy a deploy while still over the daily limit".)
  const g = guardAt("2026-09-01T10:00:00Z", { maxConsecutiveLosses: 2, cooldownMinutes: 60, maxDailyLossSol: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 });
  g.recordClose({ pnl_sol: -0.05 });
  g.recordClose({ pnl_sol: -0.05 });
  assert.equal(g.canDeploy().pass, false);
  g.advance(61 * 60_000);
  assert.equal(g.canDeploy().pass, true, "auto-clear after cooldown");

  g.halt("operator pulled the plug");
  const gate = g.canDeploy();
  assert.equal(gate.pass, false);
  assert.match(gate.reason, /manually resumed/);
  g.advance(24 * 60 * 60_000);
  assert.equal(g.canDeploy().pass, false, "a manual halt must never auto-clear");
  g.resume();
  assert.equal(g.canDeploy().pass, true);
});

test("a corrupt ledger fails closed, not open", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ this is not json");
  const g = new RiskGuard({ stateFile: file, now: () => Date.parse("2026-09-01T10:00:00Z") });
  const gate = g.canDeploy();
  assert.equal(gate.pass, false, "unreadable risk state must block new risk");
  assert.match(gate.reason, /unreadable/);
});

test("state survives a restart", () => {
  const file = tmpFile();
  const cfg = { maxConsecutiveLosses: 2, maxDailyLossSol: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 };
  const t = Date.parse("2026-09-01T10:00:00Z");
  const a = new RiskGuard({ stateFile: file, config: cfg, now: () => t });
  a.recordClose({ pnl_sol: -0.05 });
  a.recordClose({ pnl_sol: -0.05 });
  assert.equal(a.canDeploy().pass, false);

  const b = new RiskGuard({ stateFile: file, config: cfg, now: () => t });
  assert.equal(b.canDeploy().pass, false, "a restart must not clear a tripped breaker");
});

test("disabled guard never blocks", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { enabled: false, maxDailyLossSol: 0.01 });
  g.recordClose({ pnl_sol: -5 });
  assert.equal(g.canDeploy().pass, true);
});

test("status reports the numbers an operator needs", () => {
  const g = guardAt("2026-09-01T10:00:00Z", { maxDrawdownPct: 90 });
  g.markEquity(10);
  g.markEquity(8);
  g.recordClose({ pnl_sol: -0.3, pool_name: "ABC-SOL", reason: "stop loss" });
  const s = g.status();
  assert.equal(s.day_closes, 1);
  assert.equal(s.consecutive_losses, 1);
  assert.equal(s.peak_equity_sol, 10);
  assert.equal(s.drawdown_pct, 20);
});

test("non-numeric inputs are ignored rather than corrupting the ledger", () => {
  const g = guardAt("2026-09-01T10:00:00Z");
  g.recordClose({ pnl_sol: NaN });
  g.recordClose({ pnl_sol: "abc" });
  g.markEquity(undefined);
  g.markEquity(-1);
  const s = g.status();
  assert.equal(s.day_realized_pnl_sol, 0);
  assert.equal(s.day_closes, 0);
});
