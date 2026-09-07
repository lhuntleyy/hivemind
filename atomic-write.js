/**
 * atomic-write.js — write-to-temp-then-rename, with the Windows failure mode handled.
 *
 * WHAT WENT WRONG
 * ---------------
 * Both JSON stores that matter — the risk ledger and the swarm cache — did:
 *
 *     fs.writeFileSync(tmp, json);
 *     fs.renameSync(tmp, target);
 *
 * On POSIX, rename over an open file succeeds: the old inode lives on until the last
 * handle closes. On Windows it does not. If ANY other process has the target open —
 * a second agent instance, an editor, antivirus, the search indexer — the rename
 * throws EPERM, and the write is lost:
 *
 *     [ERROR] Agent loop error at step 2: EPERM: operation not permitted,
 *       rename 'risk-state.json.tmp' -> 'risk-state.json'
 *     [CRON_ERROR] Screening cycle failed: EPERM ...
 *
 * That killed a whole screening cycle. The conflicting handle is almost always
 * transient, so a short bounded retry clears it. What a retry must NOT do is fall back
 * to writing the target directly: the temp-and-rename dance exists so that a crash
 * mid-write cannot leave a truncated ledger, and the risk guard treats a corrupt ledger
 * as a reason to halt trading. Losing atomicity to save a write would trade a loud,
 * recoverable failure for a silent, dangerous one.
 *
 * So on exhaustion this throws — deliberately. The risk ledger is fail-closed: if the
 * state cannot be persisted, the caller must not proceed as though it had. The message
 * names the likely cause so the failure is actionable rather than a bare errno.
 */

/**
 * Sleep synchronously. `_save` is a synchronous API called from synchronous guard code,
 * so there is no await to reach for; Atomics.wait on a throwaway buffer is the standard
 * way to block a Node main thread for a bounded interval.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Errors that mean "someone else is holding this file right now" rather than
// "this will never work". Anything else (ENOSPC, EROFS, ENOENT) fails immediately —
// retrying a permanent condition just delays the report.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Write `contents` to `filePath` atomically, retrying a contended rename.
 *
 * @param {object} fs          node:fs (injected, so this is testable without a disk)
 * @param {string} filePath
 * @param {string} contents
 * @param {object} [opts]
 * @param {number} [opts.retries=5]  rename attempts after the first
 * @param {number} [opts.waitMs=40]  base backoff, multiplied by attempt number
 * @param {function} [opts.sleep]    injectable, so tests do not actually wait
 */
export function writeFileAtomic(fs, filePath, contents, { retries = 5, waitMs = 40, sleep = sleepSync } = {}) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT.has(error?.code)) break;
      // Linear backoff: 40, 80, 120, 160, 200ms — 600ms total, bounded, and short
      // enough that a cron tick is not visibly stalled by it.
      if (attempt < retries) sleep(waitMs * (attempt + 1));
    }
  }

  // A leftover .tmp is confusing on the next run and its contents are superseded by
  // whatever the caller writes after handling this throw.
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }

  const hint = TRANSIENT.has(lastError?.code)
    ? ` Another process is holding ${filePath} open — most often a second agent instance ` +
      `(check for an already-running "npm run dev" / pm2 process), an editor, or antivirus.`
    : "";
  const error = new Error(`Could not write ${filePath}: ${lastError?.message ?? "unknown error"}.${hint}`);
  error.code = lastError?.code;
  error.cause = lastError;
  throw error;
}
