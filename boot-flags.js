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
 */

if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";
if (process.argv.includes("--live")) process.env.DRY_RUN = "false";

export const DRY_RUN = process.env.DRY_RUN === "true";
