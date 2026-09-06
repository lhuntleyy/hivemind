/**
 * ledger-integrity.test.js — round-2 fixes.
 *
 * Each of these covers a hole found by auditing the NEW code rather than Meridian's:
 * a risk ledger that silently understated losses, and a .env writer that could
 * silently break an encrypted install.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RiskGuard } from "../hive/risk-guard.js";
import { writeEnvValues } from "../web/server.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hm-ledger-"));
const tmpFile = (n = "risk-state.json") => path.join(tmpDir(), n);

// ─── unaccounted closes ─────────────────────────────────────────

test("a position that vanishes on-chain is recorded as a hole, not guessed", () => {
  // syncOpenPositions marks a position closed without ever calling recordPerformance,
  // so its realized PnL never reaches the breaker. Inventing a number here would either
  // trip the breaker falsely or paper over a real loss, so the hole itself is the record.
  const g = new RiskGuard({ stateFile: tmpFile() });
  assert.equal(g.status().ledger_complete, true);

  g.recordUnaccountedClose({ position: "POS1", note: "ABC-SOL" });
  const s = g.status();
  assert.equal(s.unaccounted_closes, 1);
  assert.equal(s.ledger_complete, false, "the ledger must admit it is incomplete");
  assert.equal(s.day_realized_pnl_sol, 0, "no PnL is invented");
  assert.equal(s.day_closes, 0, "and it is not counted as a normal close");
});

test("unaccounted closes accumulate and do not trip the breaker on their own", () => {
  const g = new RiskGuard({ stateFile: tmpFile(), config: { maxConsecutiveLosses: 2 } });
  for (let i = 0; i < 5; i++) g.recordUnaccountedClose({ position: `P${i}` });
  assert.equal(g.status().unaccounted_closes, 5);
  assert.equal(g.canDeploy().pass, true, "an unknown outcome is not evidence of a loss");
});

test("a real close after a hole still counts normally", () => {
  const g = new RiskGuard({ stateFile: tmpFile(), config: { maxDailyLossSol: 0.3, maxConsecutiveLosses: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 } });
  g.recordUnaccountedClose({ position: "GONE" });
  g.recordClose({ pnl_sol: -0.4 });
  const gate = g.canDeploy();
  assert.equal(gate.pass, false);
  assert.equal(g.status().unaccounted_closes, 1, "the hole is still on the record");
});

test("the hole list is bounded so the ledger cannot grow without limit", () => {
  const g = new RiskGuard({ stateFile: tmpFile() });
  for (let i = 0; i < 40; i++) g.recordUnaccountedClose({ position: `P${i}` });
  const raw = JSON.parse(fs.readFileSync(g.stateFile, "utf8"));
  assert.equal(raw.unaccounted_closes, 40, "the counter is exact");
  assert.ok(raw.unaccounted.length <= 25, "but the detail list is capped");
});

test("holes survive a restart", () => {
  const file = tmpFile();
  new RiskGuard({ stateFile: file }).recordUnaccountedClose({ position: "P" });
  assert.equal(new RiskGuard({ stateFile: file }).status().ledger_complete, false);
});

// ─── .env writer ────────────────────────────────────────────────

function envSandbox(contents) {
  const f = path.join(tmpDir(), ".env");
  fs.writeFileSync(f, contents);
  return f;
}

test("writing over an envcrypt-encrypted value removes its marker", () => {
  // envcrypt flags an encrypted value with "# encrypted" on the preceding line. Leaving
  // that marker behind after writing plaintext makes envcrypt "decrypt" plaintext at
  // boot and hand the agent a corrupted wallet key — silently.
  const f = envSandbox(["# encrypted", "WALLET_PRIVATE_KEY=Zm9vYmFy", "OTHER=keep"].join("\n"));
  writeEnvValues({ WALLET_PRIVATE_KEY: "plainkey" }, f, { applyToProcess: false });
  const after = fs.readFileSync(f, "utf8");
  assert.ok(!after.includes("# encrypted"), "stale marker would corrupt the key at boot");
  assert.match(after, /WALLET_PRIVATE_KEY=plainkey/);
  assert.match(after, /OTHER=keep/);
});

test("comments, ordering and unmanaged keys survive a write", () => {
  const f = envSandbox(["# my notes", "A=1", "", "# section", "B=2", "C=3"].join("\n"));
  writeEnvValues({ B: "changed" }, f, { applyToProcess: false });
  const lines = fs.readFileSync(f, "utf8").split("\n");
  assert.deepEqual(lines.slice(0, 5), ["# my notes", "A=1", "", "# section", "B=changed"]);
  assert.equal(lines[5], "C=3");
});

test("a key that is not yet present is appended", () => {
  const f = envSandbox("A=1\n");
  writeEnvValues({ NEWKEY: "v" }, f, { applyToProcess: false });
  assert.match(fs.readFileSync(f, "utf8"), /NEWKEY=v/);
});

test("writing to a non-existent .env creates it", () => {
  const f = path.join(tmpDir(), ".env");
  writeEnvValues({ A: "1" }, f, { applyToProcess: false });
  assert.equal(fs.readFileSync(f, "utf8").trim(), "A=1");
});

test("the writer never touches process.env when asked not to", () => {
  const f = envSandbox("HM_TEST_SENTINEL=old\n");
  delete process.env.HM_TEST_SENTINEL;
  writeEnvValues({ HM_TEST_SENTINEL: "new" }, f, { applyToProcess: false });
  assert.equal(process.env.HM_TEST_SENTINEL, undefined, "tests must not mutate the live env");
});
