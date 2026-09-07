/**
 * paper-wallet.test.js — a dry run must be able to reach the deploy path.
 *
 * WHAT WENT WRONG
 * ---------------
 * Dry runs never opened a position on an unfunded wallet, and the reason was not a bug
 * in any guard — every guard was correct. runScreeningCycle already skipped its
 * "insufficient SOL" check under DRY_RUN, and executor.runSafetyChecks already skipped
 * its balance check too.
 *
 * The model refused on its own:
 *
 *   WHY SKIPPED
 *   - Hard capital blocker: wallet holds only 0.029 SOL (~$3) vs the 0.5 SOL deploy
 *     target — cannot fund the position even if the setup were clean.
 *
 * It reads the balance from the goal header and from get_wallet_balance, and it is
 * right to refuse — those are real numbers. Skipping the code guard while still feeding
 * the model a balance it cannot deploy from makes the deploy path unreachable, so the
 * one thing a dry run exists to exercise is the one thing it never exercises.
 *
 * The fix substitutes the balance at the single point every consumer reads it from, and
 * labels it everywhere so paper SOL can never be mistaken for funds on hand.
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

test("config exposes a paper balance with a usable default", async () => {
  const { config } = await import("../config.js");
  assert.ok(config.dryRun, "config.dryRun must exist");
  const paper = config.dryRun.paperWalletSol;
  assert.ok(Number.isFinite(paper), `paperWalletSol must be a number, got ${paper}`);
  assert.ok(
    paper === 0 || paper > config.management.deployAmountSol + config.management.gasReserve,
    "the default must clear deploy + gas, or a dry run still cannot deploy",
  );
});

test("the substitution is gated on DRY_RUN and on a positive balance", () => {
  const src = code("tools/wallet.js");
  const fn = src.split("function applyPaperWallet")[1]?.split("\n}")[0] ?? "";
  assert.ok(fn, "sanity: found applyPaperWallet");
  assert.match(fn, /process\.env\.DRY_RUN !== "true"\) return balances/, "live mode must be untouched");
  assert.match(fn, /paper <= 0\) return balances/, "0 must mean 'use the real balance'");
});

test("the real balance survives the substitution", () => {
  const fn = code("tools/wallet.js").split("function applyPaperWallet")[1]?.split("\n}")[0] ?? "";
  assert.match(fn, /real_sol: real/, "the on-chain figure must stay visible");
  assert.match(fn, /simulated: true/, "callers must be able to tell paper from real");
  assert.match(fn, /note:/, "the model must be told in words, not just by a flag");
});

test("every consumer reads the substituted balance", () => {
  // The point of substituting inside getWalletBalances is that there is exactly one
  // place to do it. A second exported reader would let a caller see the real balance
  // and re-introduce the refusal.
  const src = code("tools/wallet.js");
  assert.match(src, /export async function getWalletBalances\(\)\s*\{\s*return applyPaperWallet\(await fetchWalletBalances\(\)\)/);
  assert.ok(!/export async function fetchWalletBalances/.test(src), "the raw fetcher must stay private");
});

test("applyPaperWallet leaves live mode byte-identical", async () => {
  const before = process.env.DRY_RUN;
  try {
    process.env.DRY_RUN = "false";
    const { getWalletBalances } = await import("../tools/wallet.js");
    const live = await getWalletBalances();
    assert.equal(live.simulated, undefined, "live balances must carry no simulation marker");
    assert.equal(live.real_sol, undefined);
  } finally {
    if (before === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = before;
  }
});

test("the paper balance is labelled where a human and the model can see it", () => {
  const idx = code("index.js");
  assert.match(idx, /Mode: DRY RUN\$\{paperSol > 0 \?/, "the startup banner must name the paper balance");
  assert.match(
    idx,
    /currentBalance\.simulated \? " \(SIMULATED paper balance/,
    "the screening goal header must mark the balance as simulated",
  );
});

test("the paper balance is editable from the panel and reloads without a restart", () => {
  assert.match(code("web/settings-schema.js"), /dryRunPaperWalletSol:\s*num\(/, "must be an editable setting");
  assert.match(
    code("web/server.js"),
    /dryRunPaperWalletSol: \["dryRun", "paperWalletSol"\]/,
    "the panel needs an alias or the field renders blank",
  );
  assert.match(
    code("config.js"),
    /fresh\.dryRunPaperWalletSol/,
    "reloadScreeningThresholds must pick it up, or the control lies until the next restart",
  );
});
