/**
 * panel-dom.test.js — the control panel's buttons must actually do something.
 *
 * WHAT WENT WRONG
 * ---------------
 * The panel defines two selector helpers:
 *
 *   const $  = (s, r) => (r || document).querySelector(s);      // ONE element
 *   const $$ = (s, r) => [...(r || document).querySelectorAll(s)]; // an array
 *
 * "Save all settings" was written as `$("[data-key]").forEach(...)`. `$` returns a
 * single Element, Elements have no .forEach, so every click threw TypeError inside an
 * async onclick — which rejects a promise nobody awaits. No console error the operator
 * would see, no network request, no change on screen. From the outside the button was
 * simply dead, which is exactly what was reported.
 *
 * The same mistake had also killed the settings search box (`for (const el of $(...))`).
 *
 * These tests are structural rather than behavioural because the panel has no DOM in
 * the test environment. That is fine: the bug WAS structural.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "web/public/index.html"), "utf8");
const SCRIPT = HTML.split("<script>")[1]?.split("</script>")[0] ?? "";

test("the panel has an inline script and both selector helpers", () => {
  assert.ok(SCRIPT.length > 1000, "sanity: found the inline script");
  assert.match(SCRIPT, /const \$ = \(s, r\) => \(r \|\| document\)\.querySelector\(s\)/);
  assert.match(SCRIPT, /const \$\$ = \(s, r\) => \[\.\.\.\(r \|\| document\)\.querySelectorAll\(s\)\]/);
});

test("$ is never called with a selector that matches many elements", () => {
  // $ returns one Element. Any selector that is not an #id is a multi-element selector
  // by intent, and calling $ on it is the bug this file exists for.
  const offenders = [];
  for (const m of SCRIPT.matchAll(/(?<![$\w])\$\((["'])(.*?)\1/g)) {
    const selector = m[2];
    if (selector.startsWith("#")) continue;
    const line = SCRIPT.slice(0, m.index).split("\n").length;
    offenders.push(`line ${line}: $("${selector}") should be $$`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("array methods are only ever called on $$ results", () => {
  // Catches the same class of bug written a different way, e.g. $(x).map / .some.
  const bad = [...SCRIPT.matchAll(/(?<![$\w])\$\((["']).*?\1\)\s*\.\s*(forEach|map|some|every|filter|slice)\b/g)];
  assert.equal(bad.length, 0, `$(...) followed by an array method: ${bad.map((b) => b[0]).join(", ")}`);
});

test("for...of iterates $$ results, never $", () => {
  const bad = [...SCRIPT.matchAll(/for\s*\(\s*(?:const|let)\s+\w+\s+of\s+\$\(/g)];
  assert.equal(bad.length, 0, "for...of over a single element throws 'is not iterable'");
});

test("every save button runs inside an error guard", () => {
  // An unguarded `async onclick` that throws leaves the button looking inert. onAction
  // catches, reports into the page, and always re-enables the button.
  assert.match(SCRIPT, /function onAction\(sel, resultSel, fn\)/, "must define the guard");
  assert.match(SCRIPT, /catch \(err\) \{[\s\S]*?resultSel\)\.innerHTML/, "the guard must surface the failure on the page");
  assert.match(SCRIPT, /finally \{[\s\S]*?btn\.disabled = false/, "the guard must re-enable the button");

  for (const id of ["btn-save", "btn-save-llm", "btn-secrets"]) {
    assert.match(
      SCRIPT,
      new RegExp(`onAction\\("#${id}"`),
      `#${id} must be bound through onAction, not a bare .onclick`,
    );
    assert.ok(
      !new RegExp(`\\$\\("#${id}"\\)\\.onclick`).test(SCRIPT),
      `#${id} still has an unguarded .onclick`,
    );
  }
});

test("every id the script drives exists in the markup", () => {
  // A renamed element turns a working handler into a silent no-op — the same failure
  // mode, reached from the other direction.
  const markup = HTML.split("<script>")[0];
  const missing = [];
  for (const m of SCRIPT.matchAll(/\$\(["']#([\w-]+)["']\)/g)) {
    const id = m[1];
    if (!new RegExp(`id="${id}"`).test(markup)) missing.push(id);
  }
  assert.deepEqual([...new Set(missing)], [], `script targets ids that do not exist: ${missing.join(", ")}`);
});
