/**
 * atomic-write.test.js — a contended rename must not lose the write.
 *
 * WHAT WENT WRONG
 * ---------------
 * Both JSON stores did writeFileSync(tmp) + renameSync(tmp, target) with no guard. On
 * POSIX a rename over an open file succeeds. On Windows it does not — any other process
 * holding the target (a second agent instance, an editor, antivirus) makes it throw:
 *
 *     [ERROR] Agent loop error at step 2: EPERM: operation not permitted,
 *       rename 'risk-state.json.tmp' -> 'risk-state.json'
 *     [CRON_ERROR] Screening cycle failed: EPERM ...
 *
 * Observed here with two agent processes running against the same repo. It killed the
 * screening cycle outright.
 *
 * The conflicting handle is transient, so a short bounded retry clears it. What the fix
 * must NOT do is fall back to writing the target directly — the temp-and-rename dance
 * exists so a crash mid-write cannot truncate the ledger, and the risk guard treats a
 * corrupt ledger as a reason to halt. That is why exhaustion throws rather than degrades.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fsReal from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../atomic-write.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** fs stub that fails the rename a fixed number of times. */
function flakyFs({ failures, code = "EPERM" }) {
  const calls = { writes: [], renames: 0, unlinks: 0 };
  return {
    calls,
    writeFileSync: (p, data) => calls.writes.push({ p, data }),
    renameSync: () => {
      calls.renames++;
      if (calls.renames <= failures) {
        const error = new Error(`${code}: operation not permitted, rename`);
        error.code = code;
        throw error;
      }
    },
    unlinkSync: () => { calls.unlinks++; },
    existsSync: () => true,
  };
}

test("a rename that succeeds first time writes once and renames once", () => {
  const fs = flakyFs({ failures: 0 });
  writeFileAtomic(fs, "state.json", "{}", { sleep: () => {} });
  assert.equal(fs.calls.writes.length, 1);
  assert.equal(fs.calls.writes[0].p, "state.json.tmp", "must write to the temp path, never the target");
  assert.equal(fs.calls.renames, 1);
  assert.equal(fs.calls.unlinks, 0);
});

test("a transient EPERM is retried until it clears", () => {
  const fs = flakyFs({ failures: 3 });
  const waits = [];
  writeFileAtomic(fs, "state.json", "{}", { sleep: (ms) => waits.push(ms) });
  assert.equal(fs.calls.renames, 4, "three failures then success");
  assert.deepEqual(waits, [40, 80, 120], "linear backoff between attempts");
  assert.equal(fs.calls.writes.length, 1, "the payload is written once, not re-serialised per attempt");
});

test("EBUSY and EACCES are treated the same way", () => {
  for (const code of ["EBUSY", "EACCES"]) {
    const fs = flakyFs({ failures: 1, code });
    writeFileAtomic(fs, "state.json", "{}", { sleep: () => {} });
    assert.equal(fs.calls.renames, 2, `${code} must be retried`);
  }
});

test("a permanent error fails immediately instead of burning the backoff", () => {
  const fs = flakyFs({ failures: 99, code: "ENOSPC" });
  assert.throws(() => writeFileAtomic(fs, "state.json", "{}", { sleep: () => {} }), /ENOSPC|Could not write/);
  assert.equal(fs.calls.renames, 1, "no retries for a condition that will not clear");
});

test("exhaustion throws — it never degrades to a non-atomic write", () => {
  // Falling back to writeFileSync(target) would trade a loud, recoverable failure for a
  // silently truncated ledger, which the risk guard reads as corrupt-and-halt.
  const fs = flakyFs({ failures: 99 });
  assert.throws(
    () => writeFileAtomic(fs, "risk-state.json", "{}", { sleep: () => {} }),
    (error) => {
      assert.equal(error.code, "EPERM");
      assert.match(error.message, /Another process is holding risk-state\.json open/);
      assert.match(error.message, /second agent instance/, "the message must name the likely cause");
      return true;
    },
  );
  assert.equal(fs.calls.writes.length, 1);
  assert.ok(!fs.calls.writes.some((w) => w.p === "risk-state.json"), "must never write the target directly");
  assert.equal(fs.calls.unlinks, 1, "the stale temp file is cleaned up");
});

test("the backoff is bounded", () => {
  const fs = flakyFs({ failures: 99 });
  const waits = [];
  try { writeFileAtomic(fs, "s.json", "{}", { sleep: (ms) => waits.push(ms) }); } catch { /* expected */ }
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= 1000, `total backoff ${total}ms must not stall a cron tick`);
});

test("it really writes a file on a real disk", () => {
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), "hivemind-atomic-"));
  const target = path.join(dir, "state.json");
  try {
    writeFileAtomic(fsReal, target, JSON.stringify({ ok: true }));
    assert.deepEqual(JSON.parse(fsReal.readFileSync(target, "utf8")), { ok: true });
    assert.ok(!fsReal.existsSync(`${target}.tmp`), "no temp file left behind");

    writeFileAtomic(fsReal, target, JSON.stringify({ ok: false }));
    assert.deepEqual(JSON.parse(fsReal.readFileSync(target, "utf8")), { ok: false }, "overwrite works");
  } finally {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

test("both JSON stores go through the helper", () => {
  // A third bare renameSync would reintroduce exactly this bug in a new place.
  const strip = (p) => fsReal.readFileSync(path.join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n\r]*/g, "");
  for (const file of ["hive/risk-guard.js", "hive/hive-client.js"]) {
    const src = strip(file);
    assert.match(src, /writeFileAtomic\(/, `${file} must use the helper`);
    assert.ok(!/renameSync/.test(src), `${file} still calls renameSync directly`);
  }
});
