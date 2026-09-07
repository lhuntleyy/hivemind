/**
 * mode-precedence.test.js — a file on disk must never overrule --dry-run.
 *
 * WHAT WENT WRONG
 * ---------------
 * boot-flags.js resolved --dry-run into process.env before any module read it. Then
 * envcrypt.js, imported one line later, ran:
 *
 *     dotenv.config({ path: envPath, override: true })
 *
 * override is deliberately true so a repo .env beats a stale PM2-injected environment
 * on restart. Right for keys — and it also beat the flag the operator had just typed:
 *
 *     .env: DRY_RUN=false      ← exactly what deploy/README's "going live" sed writes
 *     $ npm run dev            → boot-flags sets DRY_RUN=true
 *                              → envcrypt loads .env, DRY_RUN back to "false"
 *                              → REAL transactions during a run asked to be a simulation
 *
 * Every other dry-run defect in this repo over-reported — claiming a trade that had not
 * happened. This one is the inverse and much worse: it places a trade the operator
 * explicitly asked not to place, on a box where "going live once" is enough to arm it.
 *
 * These tests run real child processes, because the bug lives entirely in module
 * evaluation order and a unit test that imported the modules directly would not see it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors index.js's import order exactly: boot-flags, then the .env load.
const PROBE = `
import { loadEnv } from "./envcrypt.js";
import { DRY_RUN_SOURCE } from "./boot-flags.js";
const envPath = process.argv[process.argv.indexOf("--envfile") + 1];
loadEnv({ envPath, keyPath: envPath + "rypt" });
console.log(JSON.stringify({ dry: process.env.DRY_RUN, source: DRY_RUN_SOURCE }));
`;

function runWith({ envFileValue, flags = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-mode-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, `DRY_RUN=${envFileValue}\n`);

  // The probe must live in the repo so its relative imports resolve.
  const probe = path.join(ROOT, `.mode-probe-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(probe, PROBE);
  try {
    const out = execFileSync(process.execPath, [probe, ...flags, "--envfile", envFile], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split("\n").pop());
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("--dry-run wins over a .env that says DRY_RUN=false", () => {
  // THE bug. A box that has been live once has DRY_RUN=false on disk forever after,
  // so every later `npm run dev` would have traded real money.
  const r = runWith({ envFileValue: "false", flags: ["--dry-run"] });
  assert.equal(r.dry, "true", "the flag the operator typed must win");
  assert.equal(r.source, "--dry-run flag");
});

test("--live wins over a .env that says DRY_RUN=true", () => {
  // The same precedence rule in the other direction. Not dangerous, but a flag that is
  // honoured only when it agrees with the file is not a flag.
  const r = runWith({ envFileValue: "true", flags: ["--live"] });
  assert.equal(r.dry, "false");
  assert.equal(r.source, "--live flag");
});

test("with no flag, .env decides — this is how the VPS unit runs", () => {
  // systemd runs `node index.js` with no flags, and vps-setup.sh writes DRY_RUN=true.
  // deploy/README promises "The agent starts in DRY_RUN=true"; this is that promise.
  assert.equal(runWith({ envFileValue: "true" }).dry, "true");
  assert.equal(runWith({ envFileValue: "false" }).dry, "false");
  assert.equal(runWith({ envFileValue: "true" }).source, "DRY_RUN in .env");
});

test("passing both flags is refused rather than resolved", () => {
  // --live used to win simply by being the second assignment. Silently choosing the
  // money-spending option out of a contradictory command line is not defensible.
  assert.throws(
    () => runWith({ envFileValue: "true", flags: ["--dry-run", "--live"] }),
    (error) => {
      assert.match(String(error.stderr ?? error.message), /Refusing to guess which one you meant/);
      return true;
    },
  );
});

test("the lock re-applies after dotenv, not before", () => {
  // Order is the whole bug: setting process.env before dotenv's override achieves
  // nothing. Assert the call sits after dotenv.config in the source.
  const src = fs.readFileSync(path.join(ROOT, "envcrypt.js"), "utf8");
  const dotenvAt = src.indexOf("dotenv.config({ path: envPath, override, quiet: true })");
  const reapplyAt = src.indexOf("reapplyCliEnvLocks()");
  assert.ok(dotenvAt > -1 && reapplyAt > dotenvAt, "reapplyCliEnvLocks must run AFTER dotenv.config");
});

test("the startup banner names which source decided the mode", () => {
  // .env and the flag can disagree. The operator has to see which one won before the
  // first cycle spends anything.
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.match(src, /Mode: DRY RUN \(from \$\{DRY_RUN_SOURCE\}\)/);
  assert.match(src, /Mode: \*\*\* LIVE \*\*\* \(from \$\{DRY_RUN_SOURCE\}\)/);
});
