/**
 * dry-run.test.js — a dry run must never be reported as a completed action.
 *
 * WHAT WENT WRONG
 * ---------------
 * `deployPosition` returns `{ dry_run: true, would_deploy: {...} }` — with no
 * `success: false`, because nothing failed. Every consumer computed success as
 * `result.success !== false && !result.error`, which is TRUE for that object. So a
 * dry run:
 *
 *   - sent a Telegram message reading "✅ Deployed TAO-SOL / Position: undefined... /
 *     Tx: undefined.."
 *   - set deploySucceeded = true, so the cycle recorded a deploy that never happened
 *   - reset the deploy-drought counter that threshold evolution depends on
 *
 * Reporting a trade that did not occur is worse than reporting nothing: it is the one
 * output an operator cannot sanity-check against the chain without going looking.
 *
 * The log line was wrong too — `[deploy_position] ✓ TAO-SOL undefined SOL` — because
 * the formatter read `args.amount_sol` while the model sends `amount_y`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Comment-free source. CRLF-safe: `.` does not match \r in JS. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n\r]*/g, "");

// The exact shape deployPosition returns when DRY_RUN=true.
const DRY_DEPLOY = {
  dry_run: true,
  would_deploy: { pool_address: "POOL", amount_y: 0.5, bins_below: 43, bins_above: 0 },
  message: "DRY RUN — no transaction sent",
};

test("the dry-run result has no success:false to catch it by", () => {
  // This is the whole trap, asserted so nobody 'simplifies' the guards away.
  assert.equal(DRY_DEPLOY.success, undefined);
  assert.equal(DRY_DEPLOY.error, undefined);
  const naiveSuccess = DRY_DEPLOY.success !== false && !DRY_DEPLOY.error;
  assert.equal(naiveSuccess, true, "the naive check reads a dry run as a success — hence the explicit dry_run guards");
});

test("executeTool gates its side effects on dry_run, not just success", () => {
  const src = code("tools/executor.js");
  assert.match(src, /const isDryRun = result\?\.dry_run === true/, "must compute a dry-run flag");
  assert.match(src, /if \(success && !isDryRun\)/, "notifications and auto-swap must be gated on it");
});

test("the screening cycle does not count a dry run as a deploy", () => {
  const src = code("index.js");
  const block = src.split('if (name === "deploy_position") {')[1]?.slice(0, 400) ?? "";
  assert.match(block, /deploySucceeded/, "sanity: found the right block");
  assert.match(block, /!result\?\.dry_run/, "deploySucceeded must exclude dry runs");
});

test("the Telegram summary reports a dry run as such, before any per-tool wording", () => {
  const src = code("telegram.js");
  const fn = src.split("function summarizeToolResult")[1]?.split("\n}")[0] ?? "";
  const dryIdx = fn.indexOf("result.dry_run");
  const switchIdx = fn.indexOf("switch (name)");
  assert.ok(dryIdx > -1, "must check dry_run");
  assert.ok(switchIdx > -1, "sanity: found the switch");
  assert.ok(dryIdx < switchIdx, "the dry-run check must come BEFORE the per-tool switch, so no tool can bypass it");
});

test("the log line reads the amount field the model actually sends", () => {
  // The model sends amount_y for a single-sided SOL deploy. Reading only the legacy
  // amount_sol alias printed "undefined SOL" on every single deploy.
  const src = code("logger.js");
  const line = src.split('case "deploy_position":')[1]?.split("\n")[0] ?? "";
  assert.match(line, /amount_y/, "must read amount_y");
  assert.match(line, /amount_sol/, "should still fall back to the legacy alias");
  assert.ok(!/\$\{a\.amount_sol\} SOL/.test(line), "must not read amount_sol alone");
});

test("write-tool log lines are marked when the result is a dry run", () => {
  const src = code("logger.js");
  assert.match(src, /dry_run \? " \[DRY RUN\]"/, "must compute a dry-run marker");
  for (const tool of ["deploy_position", "close_position", "claim_fees", "swap_token"]) {
    const line = src.split(`case "${tool}":`)[1]?.split("\n")[0] ?? "";
    assert.match(line, /\$\{dry\}/, `${tool} log line must carry the dry-run marker`);
  }
});

test("deployPosition returns before any state is written in dry run", () => {
  // trackPosition / noteDeploy / appendDecision must all be downstream of the early
  // return, or a dry run would leave real state behind.
  const src = code("tools/dlmm.js");
  const fn = src.split("export async function deployPosition")[1] ?? "";
  const dryReturn = fn.indexOf('dry_run: true');
  assert.ok(dryReturn > -1, "sanity: found the dry-run branch");
  for (const sideEffect of ["trackPosition(", "noteDeploy()", "appendDecision("]) {
    const at = fn.indexOf(sideEffect);
    if (at === -1) continue;
    assert.ok(at > dryReturn, `${sideEffect} must come after the dry-run early return`);
  }
});

test("every write tool has a dry-run branch at all", () => {
  // A write tool with no DRY_RUN check would send a real transaction during a dry run.
  const src = code("tools/dlmm.js") + code("tools/wallet.js");
  for (const fn of ["deployPosition", "closePosition", "claimFees", "swapToken"]) {
    const at = src.indexOf(`function ${fn}`);
    assert.ok(at > -1, `sanity: ${fn} not found`);
    // deployPosition spends ~5.6k characters on validation before its DRY_RUN branch,
    // so the window has to be generous. Bounded rather than searching the whole file,
    // otherwise a DRY_RUN check in a LATER function would satisfy this assertion.
    const body = src.slice(at, at + 12000);
    assert.match(body, /DRY_RUN/, `${fn} must check DRY_RUN before sending anything`);
  }
});
