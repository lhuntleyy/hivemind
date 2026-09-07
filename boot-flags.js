/**
 * boot-flags.js — resolve CLI flags into env BEFORE any module reads them.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * `DRY_RUN=true node index.js` is POSIX-only. On Windows cmd it fails outright with
 *   'DRY_RUN' is not recognized as an internal or external command
 * so `npm run dev` could not start at all. A `--dry-run` flag works on every platform
 * and needs no cross-env dependency.
 *
 * But the obvious fix — putting `if (process.argv.includes("--dry-run")) ...` at the
 * top of index.js — does NOT work, and fails silently, which is worse than the original
 * error. ES module imports are HOISTED: every `import` in index.js is evaluated before
 * any top-level statement in it runs. config.js would already have read process.env
 * and decided the mode by the time that line executed.
 *
 * Module side effects, however, run in import order. So this must be its own module,
 * imported FIRST, before anything that reads DRY_RUN.
 *
 * Anything importing this must keep it as the first import in the file.
 *
 * WHY THE LOCK EXISTS
 * -------------------
 * Setting process.env here was not enough. envcrypt.js calls
 *
 *     dotenv.config({ path: envPath, override: true })
 *
 * with override deliberately true, so a repo `.env` beats a stale PM2-injected
 * environment on restart. That is right for keys — and catastrophic for DRY_RUN,
 * because it also beats a flag the operator typed one second ago:
 *
 *     .env says DRY_RUN=false   (what the VPS "going live" step writes)
 *     operator runs `npm run dev`  → boot-flags sets DRY_RUN=true
 *     envcrypt loads .env          → DRY_RUN back to "false"
 *     → the agent sends REAL transactions during what was asked for as a dry run
 *
 * Every other dry-run bug in this repo over-reported: it claimed a trade that had not
 * happened. This one is the inverse and far worse — it would place a trade the operator
 * explicitly asked not to place.
 *
 * So flags are recorded as LOCKED and re-applied after any .env load. Precedence, most
 * to least authoritative:
 *
 *   1. --dry-run / --live      what the operator just typed
 *   2. .env                    what the box is configured to do
 *   3. inherited process env   whatever the supervisor happened to leak in
 */

/**
 * Env vars set from the command line. loadEnv() re-applies these after dotenv, so a
 * file on disk can never silently overrule an explicit flag.
 * @type {Map<string, string>}
 */
export const CLI_ENV_LOCKS = new Map();

function lockEnv(key, value) {
  process.env[key] = value;
  CLI_ENV_LOCKS.set(key, value);
}

/** Re-assert every CLI flag. Called by loadEnv() after dotenv has run. */
export function reapplyCliEnvLocks() {
  for (const [key, value] of CLI_ENV_LOCKS) process.env[key] = value;
  return CLI_ENV_LOCKS.size;
}

const wantsDryRun = process.argv.includes("--dry-run");
const wantsLive = process.argv.includes("--live");

if (wantsDryRun && wantsLive) {
  // Previously --live won by falling second. Silently picking the money-spending
  // option out of a contradictory command line is not a defensible default.
  throw new Error(
    "Both --dry-run and --live were passed. Refusing to guess which one you meant — " +
    "pass exactly one, or neither to use DRY_RUN from .env.",
  );
}

if (wantsDryRun) lockEnv("DRY_RUN", "true");
if (wantsLive) lockEnv("DRY_RUN", "false");

/** Where the mode came from, so the startup banner can say it out loud. */
export const DRY_RUN_SOURCE = wantsDryRun
  ? "--dry-run flag"
  : wantsLive
    ? "--live flag"
    : "DRY_RUN in .env";

export const DRY_RUN = process.env.DRY_RUN === "true";
