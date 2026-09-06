/**
 * wiring.test.js — every control must actually control something.
 *
 * This project keeps producing the same class of bug, three times now:
 *
 *   1. a duplicate `risk:` key in config.js silently left maxPositions and
 *      maxDeployAmount undefined, disabling both caps with no error
 *   2. noteDeploy / noteScreenWithoutDeploy were written but never called, so the
 *      starvation release that fixes the threshold deadlock never fired
 *   3. config.screening.source existed and the control panel offered a dropdown for
 *      it, and nothing in the codebase read the value
 *
 * All three look correct in review, in the config file, and in the UI. None of them
 * would fail a behavioural test, because the behaviour they gate simply never runs.
 * The only thing that catches them is asserting the WIRING itself, so that is what
 * this file does — structurally, over the source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EDITABLE } from "../web/server.js";
import { config } from "../config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .js source file, excluding tests, node_modules and vendored code. */
function sourceFiles(dir = ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "test") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) acc.push(full);
  }
  return acc;
}

const SOURCES = sourceFiles();
const CORPUS = SOURCES.map((f) => fs.readFileSync(f, "utf8")).join("\n");

/** Where does a panel setting land in the live config object? */
function configPathFor(key) {
  if (key.startsWith("risk.")) return ["risk", key.slice(5)];
  if (key.startsWith("venue.")) return ["venue", key.slice(6)];
  if (key.startsWith("spot.")) return ["spot", key.slice(5)];
  if (key.startsWith("hiveMind.share.")) return ["hiveMind", "share", key.slice(15)];
  const sections = {
    maxPositions: "risk", maxDeployAmount: "risk",
    deployAmountSol: "management", positionSizePct: "management", gasReserve: "management",
    stopLossPct: "management", takeProfitPct: "management", trailingTakeProfit: "management",
    trailingTriggerPct: "management", trailingDropPct: "management",
    outOfRangeWaitMinutes: "management", solMode: "management", swapSlippageBps: "management",
    minTvl: "screening", maxTvl: "screening", minOrganic: "screening", minHolders: "screening",
    minMcap: "screening", maxMcap: "screening", minBinStep: "screening", maxBinStep: "screening",
    minTokenFeesSol: "screening", minFeeActiveTvlRatio: "screening", timeframe: "screening",
    screeningSource: ["screening", "source"],
    strategy: ["strategy", "strategy"],
    managementIntervalMin: "schedule", screeningIntervalMin: "schedule",
    screeningModel: "llm", managementModel: "llm", generalModel: "llm",
    llmProvider: ["llm", "provider"], llmBaseUrl: ["llm", "baseUrl"],
    hiveMindPullMode: ["hiveMind", "pullMode"],
  };
  const s = sections[key];
  if (Array.isArray(s)) return s;
  if (s) return [s, key];
  return null;
}

function getPath(obj, parts) {
  return parts.reduce((n, p) => (n == null ? undefined : n[p]), obj);
}

/**
 * Remove JS comments so structural assertions read code, not prose.
 * CRLF-safe: `[^\n\r]*` rather than `.*$`, because `.` does not match `\r`.
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n\r]*/g, "");
}

test("every panel setting resolves to a real value in the live config", () => {
  const dead = [];
  for (const key of Object.keys(EDITABLE)) {
    const parts = configPathFor(key);
    if (!parts) { dead.push(`${key} (no known config path)`); continue; }
    const value = getPath(config, parts);
    // null is legitimate for optional fields (llmBaseUrl, per-role models); undefined
    // is not — it means the config key does not exist and the control is inert.
    if (value === undefined) dead.push(`${key} -> config.${parts.join(".")} is undefined`);
  }
  assert.deepEqual(dead, [], `panel settings that do not map to live config:\n  ${dead.join("\n  ")}`);
});

test("every panel setting is read somewhere outside config.js and the panel itself", () => {
  // A setting that only exists in config.js and web/server.js is a knob wired to
  // nothing. This is exactly how screeningSource shipped inert.
  const exempt = new Set([
    // Read via the resolveLlm() indirection rather than by literal name.
    "llmProvider", "llmBaseUrl",
  ]);

  const consumers = SOURCES.filter((f) => !/config\.js$|web[\\/]server\.js$/.test(f));
  const consumerCorpus = consumers.map((f) => fs.readFileSync(f, "utf8")).join("\n");

  const unread = [];
  for (const key of Object.keys(EDITABLE)) {
    if (exempt.has(key)) continue;
    const leaf = key.includes(".") ? key.split(".").pop() : key;
    // Look for the leaf name used as a property access or object key anywhere.
    const re = new RegExp(`[.\\[\"'\`]${leaf}\\b`);
    if (!re.test(consumerCorpus)) unread.push(key);
  }
  assert.deepEqual(unread, [], `panel settings nothing reads:\n  ${unread.join("\n  ")}`);
});

test("exported functions that gate safety are actually called", () => {
  // Each of these exists to change behaviour. If nothing calls it, the behaviour it
  // was written for does not happen — and every one of these has been dead at least
  // once during this build.
  const mustBeCalled = [
    "noteDeploy",                 // resets the deploy-drought counter
    "noteScreenWithoutDeploy",    // advances it
    "evolveThresholdsBidirectional",
    "getPlaybookForPrompt",
    "recordUnaccountedClose",     // records holes in the risk ledger
    "markPortfolioEquity",        // feeds the drawdown limit
    "canDeploy",                  // the breaker gate itself
    "guardZapIn",                 // relay transaction guard
    "assertRiskRewardSanity",
    "getSwarmBlock",
    "monitorSpot",
    "runSpotEntry",
    "getPricesSol",
  ];

  const dead = [];
  for (const fn of mustBeCalled) {
    // A call site, not a definition or an export list.
    const called = new RegExp(`(?<!function )(?<!export function )\\b${fn}\\s*\\(`).test(CORPUS);
    if (!called) dead.push(fn);
  }
  assert.deepEqual(dead, [], `defined but never called:\n  ${dead.join("\n  ")}`);
});

test("config.js has no duplicate top-level section", () => {
  // The literal bug: two `risk: {` keys in one object literal, second wins, first
  // silently discarded.
  const src = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  const seen = new Map();
  for (const m of src.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  assert.deepEqual(dupes, [], `duplicate config sections silently shadow each other: ${dupes.join(", ")}`);
});

test("the risk breaker gates deploys and nothing else", () => {
  // A breaker that blocks the exit is worse than no breaker. Assert the gate appears
  // in the deploy safety check and that no close/claim/swap path consults it.
  const executor = fs.readFileSync(path.join(ROOT, "tools", "executor.js"), "utf8");
  assert.match(executor, /case "deploy_position"[\s\S]{0,600}riskGuard\.canDeploy\(\)/,
    "canDeploy must gate deploy_position");

  for (const tool of ["close_position", "claim_fees", "swap_token"]) {
    const block = executor.split(`case "${tool}"`)[1]?.slice(0, 500) ?? "";
    assert.ok(!/canDeploy/.test(block), `${tool} must never be gated by the breaker`);
  }
});

test("the swarm block is not rendered inside the trusted lessons section", () => {
  // Meridian appended shared lessons under "LESSONS LEARNED", putting text written by
  // strangers in the trusted region of the system prompt.
  const lessons = fs.readFileSync(path.join(ROOT, "lessons.js"), "utf8");
  const inGetLessons = lessons.split("export function getLessonsForPrompt")[1]?.split("\n}")[0] ?? "";

  // Assert on CODE, not on prose: an earlier version of this test matched the word
  // HIVEMIND inside the comment explaining why the merge was removed, and failed on
  // correct code.
  //
  // The comment stripper must not use `//.*$`. In JavaScript `.` does not match `\r`,
  // and these files are CRLF, so `.*` stops before the carriage return and `$` never
  // matches — the comment survives and the test fails on correct source. Match the
  // comment body explicitly instead.
  const code = stripComments(inGetLessons);

  assert.ok(
    !/getSharedLessonsForPrompt\s*\(/.test(code),
    "getLessonsForPrompt must not pull swarm content into the trusted lessons block",
  );
  assert.ok(
    !/HIVEMIND/.test(code),
    "no HIVEMIND section header may be emitted from getLessonsForPrompt",
  );

  const prompt = fs.readFileSync(path.join(ROOT, "prompt.js"), "utf8");
  assert.match(prompt, /SWARM DATA RULE/, "the prompt must tell the model swarm text is data");
  assert.match(prompt, /swarmBlock/, "the prompt must render the swarm block separately");
});

test("no source file hardcodes a live-looking API key", () => {
  const offenders = [];
  for (const f of SOURCES) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(sk-or-v1-[A-Za-z0-9]{24,}|sk-ant-[A-Za-z0-9]{24,}|gsk_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{30,})/g)) {
      offenders.push(`${path.relative(ROOT, f)}: ${m[1].slice(0, 12)}…`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded keys:\n  ${offenders.join("\n  ")}`);
});
