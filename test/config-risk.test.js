/**
 * config-risk.test.js — every risk control must be a real value at boot.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * While adding the portfolio breaker I introduced a SECOND `risk: {}` key into the same
 * object literal in config.js. JavaScript silently keeps the last one, so
 * config.risk.maxPositions and config.risk.maxDeployAmount became `undefined`. The
 * safety checks that read them are written as:
 *
 *     if (positions.total_positions >= config.risk.maxPositions)   // >= undefined -> false
 *     if (amountY > config.risk.maxDeployAmount)                   // >  undefined -> false
 *
 * Both comparisons are false against undefined, so the position-count cap and the
 * per-deploy size cap were BOTH disabled, with no error, no warning and no test failure.
 * Nothing in the repo would have caught it — it surfaced only because the control panel
 * rendered those two fields blank.
 *
 * That is the same class of failure this whole project is about: a risk control that is
 * present in the source, reads as configured, and does nothing. So it gets asserted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_SRC = fs.readFileSync(path.join(HERE, "..", "config.js"), "utf8");

const NUMERIC_RISK_KEYS = [
  "maxPositions",
  "maxDeployAmount",
  "maxDailyLossSol",
  "maxDailyLossPct",
  "maxConsecutiveLosses",
  "maxDrawdownPct",
  "cooldownMinutes",
  "lossNoiseFloorSol",
  "relayOverheadSol",
];

test("every numeric risk control resolves to a finite number", () => {
  for (const key of NUMERIC_RISK_KEYS) {
    const v = config.risk[key];
    assert.equal(typeof v, "number", `config.risk.${key} is ${v} (${typeof v}) — the control is inert`);
    assert.ok(Number.isFinite(v), `config.risk.${key} is not finite`);
  }
});

test("the per-position caps are positive, not zero", () => {
  // A zero here would be as bad as undefined for maxPositions (never deploy) and worse
  // for maxDeployAmount (every deploy rejected), so pin the sign explicitly.
  assert.ok(config.risk.maxPositions >= 1, "maxPositions must allow at least one position");
  assert.ok(config.risk.maxDeployAmount > 0, "maxDeployAmount must be positive");
});

test("the breaker is armed by default", () => {
  assert.equal(config.risk.enabled, true, "shipping with the breaker off defeats the point");
});

test("config.js declares each top-level section exactly once", () => {
  // The root cause was a duplicate key in one object literal. Catch it structurally
  // rather than trusting review.
  const sections = ["risk", "screening", "management", "strategy", "schedule", "llm", "darwin", "hiveMind", "api", "venue", "web", "gmgn", "jupiter", "pnl", "opportunity", "indicators", "tokens"];
  for (const s of sections) {
    const matches = CONFIG_SRC.match(new RegExp(`^  ${s}: \\{`, "gm")) || [];
    assert.ok(matches.length <= 1, `config.js declares "${s}:" ${matches.length} times — a later duplicate silently shadows the earlier one`);
  }
});

test("swarm sharing is off in the shipped defaults", () => {
  const s = config.hiveMind.share;
  for (const k of ["lessons", "performance", "poolAddress", "poolName", "baseMint"]) {
    assert.equal(s[k], false, `hiveMind.share.${k} must default to false — this build is pull-only`);
  }
});

test("only the LP venue is enabled by default", () => {
  assert.equal(config.venue.lp, true);
  assert.equal(config.venue.spot, false, "spot execution must be an explicit opt-in");
});

test("the control panel binds to loopback by default", () => {
  assert.equal(config.web.host, "127.0.0.1", "this UI serves and accepts the wallet key");
});

test("screening thresholds that gate deploys are all numbers", () => {
  for (const key of ["minTvl", "minOrganic", "minHolders", "minMcap", "maxMcap", "minBinStep", "maxBinStep", "minTokenFeesSol", "minFeeActiveTvlRatio"]) {
    assert.ok(Number.isFinite(config.screening[key]), `config.screening.${key} is not a finite number`);
  }
});

test("exit thresholds are numbers with the right sign", () => {
  assert.ok(Number.isFinite(config.management.stopLossPct));
  assert.ok(config.management.stopLossPct < 0, "stopLossPct must be negative or it can never trigger");
  assert.ok(Number.isFinite(config.management.takeProfitPct));
  assert.ok(config.management.takeProfitPct > 0);
});
