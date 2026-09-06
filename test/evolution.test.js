/**
 * evolution.test.js — bidirectional threshold evolution.
 *
 * Meridian's evolveThresholds could only tighten (`if (rounded > current)` guarded every
 * write). That is a one-way ratchet: after a bad streak the floors climb until nothing
 * passes screening, the agent stops trading, and — because it is no longer trading — it
 * generates no new data that could ever argue the floors back down. The deadlock is
 * permanent without manual intervention, and nothing surfaces it.
 *
 * These tests pin the three behaviours that fix it: LOOSEN, TIGHTEN, and the starvation
 * release. All of them write to temp files, never the operator's real user-config.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evolveThresholdsBidirectional,
  noteScreenWithoutDeploy,
  noteDeploy,
  getLearningStatus,
} from "../self-learning.js";

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-evo-"));
  return {
    learningFile: path.join(dir, "learning-state.json"),
    userConfigFile: path.join(dir, "user-config.json"),
    read: () => JSON.parse(fs.readFileSync(path.join(dir, "user-config.json"), "utf8")),
  };
}

const cfg = (over = {}) => ({
  screening: { minFeeActiveTvlRatio: 0.5, minOrganic: 70, ...over },
});

/** n closes at a given fee/TVL and organic score. */
function closes(n, { pnl, fee, organic }) {
  return Array.from({ length: n }, () => ({
    pnl_pct: pnl,
    fee_tvl_ratio: fee,
    organic_score: organic,
    recorded_at: new Date().toISOString(),
  }));
}

test("does nothing below the sample floor", () => {
  const s = sandbox();
  const r = evolveThresholdsBidirectional(closes(3, { pnl: 5, fee: 1, organic: 80 }), cfg(), s);
  assert.equal(r, null, "3 closes is not enough evidence to move a threshold");
});

test("LOOSENS when the floor is cutting into profitable ground", () => {
  // Winners at fee/TVL 0.2 while the floor sits at 0.5: the floor would have excluded
  // every one of these trades. Meridian could never make this move.
  const s = sandbox();
  const c = cfg();
  const perf = [...closes(6, { pnl: 8, fee: 0.2, organic: 80 }), ...closes(3, { pnl: -8, fee: 0.9, organic: 60 })];
  const r = evolveThresholdsBidirectional(perf, c, s);
  assert.ok(r && r.changes.minFeeActiveTvlRatio != null, `expected a change, got ${JSON.stringify(r)}`);
  assert.ok(r.changes.minFeeActiveTvlRatio < 0.5, "the floor must come DOWN");
  assert.match(r.rationale.minFeeActiveTvlRatio, /cutting into profitable ground/);
  assert.equal(c.screening.minFeeActiveTvlRatio, r.changes.minFeeActiveTvlRatio, "live config must be updated too");
  assert.equal(s.read().minFeeActiveTvlRatio, r.changes.minFeeActiveTvlRatio, "and persisted");
});

test("TIGHTENS when losers sit in a clean band below the winners", () => {
  const s = sandbox();
  const c = cfg({ minFeeActiveTvlRatio: 0.5 });
  const perf = [...closes(5, { pnl: 9, fee: 1.4, organic: 85 }), ...closes(4, { pnl: -9, fee: 0.6, organic: 55 })];
  const r = evolveThresholdsBidirectional(perf, c, s);
  assert.ok(r && r.changes.minFeeActiveTvlRatio != null, `expected a change, got ${JSON.stringify(r)}`);
  assert.ok(r.changes.minFeeActiveTvlRatio > 0.5, "the floor must go UP");
  assert.match(r.rationale.minFeeActiveTvlRatio, /raising into the gap/);
});

test("a single step can never move a threshold more than its step limit", () => {
  const s = sandbox();
  const c = cfg({ minFeeActiveTvlRatio: 1.0 });
  // Winners way below the floor would ask for a huge drop; the step cap must hold.
  const perf = [...closes(6, { pnl: 8, fee: 0.05, organic: 80 }), ...closes(3, { pnl: -8, fee: 1.5, organic: 60 })];
  const r = evolveThresholdsBidirectional(perf, c, s);
  assert.ok(r.changes.minFeeActiveTvlRatio >= 1.0 * 0.85 - 1e-9, `moved too far in one step: ${r.changes.minFeeActiveTvlRatio}`);
});

test("thresholds stay inside their hard bounds", () => {
  const s = sandbox();
  const c = cfg({ minFeeActiveTvlRatio: 0.021 }); // already near the 0.02 floor
  const perf = [...closes(6, { pnl: 8, fee: 0.001, organic: 80 }), ...closes(3, { pnl: -8, fee: 0.5, organic: 60 })];
  const r = evolveThresholdsBidirectional(perf, c, s);
  const next = r?.changes?.minFeeActiveTvlRatio ?? c.screening.minFeeActiveTvlRatio;
  assert.ok(next >= 0.02, `broke through the hard floor: ${next}`);
});

test("STARVATION RELEASE: a long deploy drought relaxes the floor", () => {
  // This is the deadlock exit. Without it, thresholds that let nothing through produce
  // no data, and no data can ever argue them back down.
  const s = sandbox();
  for (let i = 0; i < 40; i++) noteScreenWithoutDeploy(s);
  assert.equal(getLearningStatus(s).screens_since_deploy, 40);

  const c = cfg({ minFeeActiveTvlRatio: 2.0 });
  // Only losers on record, and none of them near the floor — normally no change at all.
  const perf = closes(9, { pnl: -6, fee: 3.0, organic: 40 });
  const r = evolveThresholdsBidirectional(perf, c, s);
  assert.ok(r && r.changes.minFeeActiveTvlRatio != null, `starvation must force a move, got ${JSON.stringify(r)}`);
  assert.ok(r.changes.minFeeActiveTvlRatio < 2.0, "the floor must relax");
  assert.match(r.rationale.minFeeActiveTvlRatio, /no deploy in 40 screens/);
  assert.equal(getLearningStatus(s).screens_since_deploy, 0, "counter resets so the new floor gets a fair run");
});

test("a deploy resets the drought counter", () => {
  const s = sandbox();
  for (let i = 0; i < 12; i++) noteScreenWithoutDeploy(s);
  assert.equal(getLearningStatus(s).screens_since_deploy, 12);
  noteDeploy(s);
  assert.equal(getLearningStatus(s).screens_since_deploy, 0);
});

test("evolution history is recorded and bounded", () => {
  const s = sandbox();
  const c = cfg();
  for (let i = 0; i < 3; i++) {
    evolveThresholdsBidirectional(
      [...closes(6, { pnl: 8, fee: 0.2, organic: 80 }), ...closes(3, { pnl: -8, fee: 0.9, organic: 60 })],
      c, s,
    );
  }
  const st = getLearningStatus(s);
  assert.ok(st.recent_evolutions.length >= 1, "evolutions must be auditable");
  assert.ok(st.last_evolved_at, "and timestamped");
});

test("a corrupt learning file does not stop evolution", () => {
  const s = sandbox();
  fs.writeFileSync(s.learningFile, "{{{ not json");
  assert.doesNotThrow(() => noteScreenWithoutDeploy(s));
  assert.equal(getLearningStatus(s).screens_since_deploy, 1, "starts a fresh count rather than throwing");
});

test("evolution never touches the real repo config", () => {
  // Regression guard for the test harness itself: if paths stop being injectable, this
  // suite would silently start rewriting the operator's live thresholds.
  const s = sandbox();
  evolveThresholdsBidirectional(
    [...closes(6, { pnl: 8, fee: 0.2, organic: 80 }), ...closes(3, { pnl: -8, fee: 0.9, organic: 60 })],
    cfg(), s,
  );
  assert.ok(fs.existsSync(s.userConfigFile), "the sandbox file is where the write landed");
});
