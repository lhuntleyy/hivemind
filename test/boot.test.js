/**
 * boot.test.js — the agent must actually start.
 *
 * WHY THIS EXISTS
 * ---------------
 * 202 tests passed while `npm run dev` crashed on the first line of startCronJobs:
 *
 *     TypeError: Cannot read properties of undefined (reading 'pollIntervalSec')
 *
 * An earlier config edit had removed three whole sections — api, pnl and opportunity —
 * and nothing noticed, because every test imported modules and none of them booted the
 * process. Unit coverage of the parts said nothing about whether the thing runs.
 *
 * So this file asserts the boot path itself: every config section the runtime reads is
 * present, and the cron wiring can be constructed and torn down for real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every `config.<section>` referenced anywhere in the source. */
function referencedSections() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "test"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n\r]*/g, "");   // CRLF-safe; `.` does not match \r

      // Only files that actually import the shared config object can be reading it.
      // Without this, `config` as a local parameter name (hive-client.js takes one)
      // and strings like "user-config.telegramChatId" both register as sections.
      if (!/from\s+["'][^"']*\/?config\.js["']/.test(src)) continue;

      // Bare identifier `config` only: not `userConfig`, not `user-config`, not a path.
      for (const m of src.matchAll(/(?<![A-Za-z0-9_$."'`/-])config\??\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
        const section = m[1];
        if (section === "js" || section === "json" || section === "example") continue;
        found.add(section);
      }
    }
  };
  walk(ROOT);
  return found;
}

// Properties that are functions or exports on the config module, not config sections.
const NOT_SECTIONS = new Set(["screening", "management"].filter(() => false));

test("every config section the code reads actually exists", () => {
  const referenced = referencedSections();
  const missing = [...referenced].filter(
    (s) => !NOT_SECTIONS.has(s) && config[s] === undefined,
  );
  assert.deepEqual(
    missing.sort(), [],
    `code reads config.${missing.join(", config.")} but the config object has no such section — ` +
    `this is what crashed startup when api/pnl/opportunity went missing`,
  );
});

test("the sections the cron scheduler reads at boot are complete", () => {
  // startCronJobs touches these on its very first lines. A missing one is not a
  // degraded feature, it is a process that will not start.
  const required = {
    "schedule.managementIntervalMin": config.schedule?.managementIntervalMin,
    "schedule.screeningIntervalMin": config.schedule?.screeningIntervalMin,
    "pnl.pollIntervalSec": config.pnl?.pollIntervalSec,
    "pnl.confirmTicks": config.pnl?.confirmTicks,
    "opportunity.enabled": config.opportunity?.enabled,
    "opportunity.pollIntervalSec": config.opportunity?.pollIntervalSec,
    "opportunity.minScore": config.opportunity?.minScore,
    "risk.maxPositions": config.risk?.maxPositions,
    "management.deployAmountSol": config.management?.deployAmountSol,
    "management.gasReserve": config.management?.gasReserve,
    "venue.spot": config.venue?.spot,
    "web.enabled": config.web?.enabled,
    "api.url": config.api?.url,
  };
  const missing = Object.entries(required).filter(([, v]) => v === undefined).map(([k]) => k);
  assert.deepEqual(missing, [], `config.${missing.join(", config.")} is undefined at boot`);
});

test("the degen scorer's targets are present — the opportunity poller divides by them", () => {
  for (const k of ["targetVolRatio", "targetLpCount", "targetFeeRatio", "targetLiquidity"]) {
    const v = config.opportunity?.[k];
    assert.ok(Number.isFinite(v) && v > 0, `config.opportunity.${k} must be a positive number, got ${v}`);
  }
});

test("startCronJobs constructs and tears down without throwing", async () => {
  // The real thing, in dry run. This is the assertion that would have caught the
  // missing pnl section immediately.
  process.env.DRY_RUN = "true";
  const index = await import("../index.js");

  assert.equal(typeof index.startCronJobs, "function");
  assert.doesNotThrow(() => index.startCronJobs(), "cron wiring must construct");

  // Tear down, or the 3s PnL poller keeps the event loop alive and the test runner
  // never exits — which is how this test first presented: a hang, not a failure.
  assert.equal(typeof index.stopCronJobs, "function", "stopCronJobs must be exported so timers can be stopped");
  index.stopCronJobs();

  const { stopControlPanel } = await import("../web/server.js");
  stopControlPanel();
  const { stopHiveMindBackgroundSync } = await import("../hivemind.js");
  stopHiveMindBackgroundSync();
});

test("index.js exports the lifecycle the entry point and tests rely on", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  for (const fn of ["startCronJobs", "runManagementCycle", "runScreeningCycle"]) {
    assert.match(src, new RegExp(`export (async )?function ${fn}\\b`), `index.js must export ${fn}`);
  }
});

test("boot-flags is the first import in index.js", () => {
  // ESM hoists imports above top-level statements, so --dry-run can only be honoured
  // if the module that reads it is imported before anything that reads DRY_RUN.
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const firstImport = src.match(/^import .*$/m)?.[0] ?? "";
  assert.match(firstImport, /boot-flags/, `first import is "${firstImport}" — boot-flags must come first`);
});

test("npm scripts are cross-platform", () => {
  // `DRY_RUN=true node index.js` fails on Windows cmd with
  //   'DRY_RUN' is not recognized as an internal or external command
  // which is how `npm run dev` was completely unusable there.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const posixEnv = Object.entries(pkg.scripts)
    .filter(([, v]) => /^[A-Z_]+=/.test(v.trim()))
    .map(([k]) => k);
  assert.deepEqual(posixEnv, [], `these scripts use POSIX-only env syntax: ${posixEnv.join(", ")}`);
});
