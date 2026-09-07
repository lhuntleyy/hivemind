/**
 * exit-miner.test.js — recovering other agents' exit thresholds from their lessons.
 *
 * The swarm publishes no config: /presets/pull returns []. But a FAILED lesson carries
 * its close reason verbatim, and the close reason names the threshold that fired. Those
 * strings are the only evidence in the feed about how other forks size their exits, and
 * they are written loosely enough ("= -15%", "25% max") that the parsing has to be
 * pinned down by tests or it will silently mine nonsense.
 *
 * The strings below are real, taken from api.agentmeridian.xyz/api/hivemind/lessons/pull.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentIdOf,
  reasonOf,
  parseExitReason,
  mineExitRules,
  compareToOwnExits,
} from "../hive/exit-miner.js";

const REAL = {
  stopLoss:
    "FAILED: grail-SOL, strategy=spot, bin_step=100, volatility=2.72, fee_tvl_ratio=0.16, " +
    "organic=85 → PnL -15.06%, range efficiency 100%. Reason: Stop loss: PnL -16.05% = -15%.",
  ruleThree:
    "FAILED: x-SOL, strategy=spot, bin_step=100, volatility=1.0 → PnL -29%. " +
    "Reason: Rule 3: dumped far below range (loss 29% = 25% max).",
  trailing: "FAILED: y-SOL, strategy=spot, bin_step=100 → PnL 2%. Reason: Trailing TP stop loss.",
  oor: "FAILED: z-SOL, strategy=spot, bin_step=100 → PnL -4%. Reason: OOR with drawdown.",
  test: "FAILED: test_pool, strategy=spot, bin_step=100 → PnL -1%. Reason: test close.",
};

const lesson = (agent, ts, rule) => ({ id: `lesson:agt_${agent}:${ts}`, rule });

test("the agent is recovered from the lesson id", () => {
  assert.equal(agentIdOf("lesson:agt_838ae8ef8753e4de12aa3fdd:1784885070026"), "agt_838ae8ef8753e4de12aa3fdd");
  assert.equal(agentIdOf("nonsense"), null);
  assert.equal(agentIdOf(undefined), null);
});

test("the close reason is extracted and test spam is dropped", () => {
  assert.equal(reasonOf(REAL.stopLoss), "Stop loss: PnL -16.05% = -15%");
  assert.equal(reasonOf(REAL.trailing), "Trailing TP stop loss");
  assert.equal(reasonOf("PREFER: FABLE-SOL-type pools — PnL +3.29%."), null, "no reason, no exit rule");
  assert.equal(reasonOf(REAL.test), null, "a smoke test is not a strategy the swarm runs");
});

test("the configured threshold is separated from the realised PnL", () => {
  // "PnL -16.05% = -15%" — the LEFT number is what happened, the RIGHT one is the rule.
  // Mining the left number would report other agents' losses as their stop settings.
  const sl = parseExitReason("Stop loss: PnL -16.05% = -15%");
  assert.equal(sl.class, "stop_loss");
  assert.equal(sl.threshold_pct, -15);
  assert.equal(sl.actual_pct, -16.05);
});

test("a loss written as a positive magnitude is normalised to negative", () => {
  // "(loss 29% = 25% max)" means -25%, not +25%. Without the sign fix a median over
  // these two forms is meaningless.
  const r = parseExitReason("Rule 3: dumped far below range (loss 29% = 25% max)");
  assert.equal(r.class, "range_dump");
  assert.equal(r.threshold_pct, -25);
});

test("a trailing exit is not counted as a fixed stop", () => {
  // "Trailing TP stop loss" contains "stop loss". They are different rules with
  // different numbers; folding them together corrupts both medians.
  assert.equal(parseExitReason("Trailing TP stop loss").class, "trailing_tp");
  assert.equal(parseExitReason("Stop loss: PnL -16% = -15%").class, "stop_loss");
});

test("a percentage that is not a threshold is never mined as one", () => {
  const r = parseExitReason("Closed at -12% after the pool went quiet");
  assert.equal(r.threshold_pct, null, "no '=' means no configured threshold was named");
});

test("one vote per agent, at that agent's most recent setting", () => {
  const mined = mineExitRules([
    lesson("aaa", 1000, "F → PnL -1%. Reason: Stop loss: PnL -11% = -10%."),
    lesson("aaa", 2000, "F → PnL -1%. Reason: Stop loss: PnL -21% = -20%."), // same agent, retuned
    lesson("aaa", 1500, "F → PnL -1%. Reason: Stop loss: PnL -16% = -15%."),
    lesson("bbb", 1000, "F → PnL -1%. Reason: Stop loss: PnL -31% = -30%."),
  ]);
  const t = mined.thresholds.stop_loss;
  assert.equal(t.agents, 2, "three lessons from one agent are one vote");
  assert.deepEqual(t.values, [-30, -20], "the agent's newest value wins");
  assert.equal(t.median_pct, -25);
});

test("an unattributable lesson never reaches a threshold median", () => {
  // Anonymous votes are unbounded votes: the same rule reposted without an agent id
  // could otherwise dominate the median.
  const mined = mineExitRules([
    { id: "no-agent-here", rule: "F → PnL -1%. Reason: Stop loss: PnL -51% = -50%." },
    lesson("aaa", 1000, "F → PnL -1%. Reason: Stop loss: PnL -11% = -10%."),
  ]);
  assert.deepEqual(mined.thresholds.stop_loss.values, [-10]);
  assert.equal(mined.samples, 2, "it still counts toward the reason mix");
});

test("mining the real feed recovers the thresholds it contains", () => {
  const mined = mineExitRules([
    lesson("a1", 1784885070026, REAL.stopLoss),
    lesson("a2", 1784885070027, REAL.ruleThree),
    lesson("a3", 1784885070028, REAL.trailing),
    lesson("a4", 1784885070029, REAL.oor),
    lesson("a5", 1784885070030, REAL.test),
  ]);
  assert.equal(mined.samples, 4, "the test lesson is excluded");
  assert.equal(mined.agents, 4);
  assert.equal(mined.thresholds.stop_loss.median_pct, -15);
  assert.equal(mined.thresholds.range_dump.median_pct, -25);
  assert.equal(mined.thresholds.trailing_tp, undefined, "no number in that reason, so no threshold");
  assert.equal(mined.reason_mix.reduce((a, r) => a + r.count, 0), 4);
});

test("the comparison states the gap and flags a thin sample", () => {
  const mined = mineExitRules([lesson("a1", 1000, REAL.stopLoss)]);
  const [cmp] = compareToOwnExits(mined, { stopLossPct: -50, takeProfitPct: 5 });
  assert.equal(cmp.key, "stop_loss");
  assert.equal(cmp.ours, -50);
  assert.equal(cmp.swarm_median, -15);
  assert.match(cmp.note, /35pp wider/);
  assert.match(cmp.note, /Sample too small to act on alone/);
});

test("comparison is skipped when there is nothing to compare against", () => {
  assert.deepEqual(compareToOwnExits({ thresholds: {} }, { stopLossPct: -50 }), []);
  assert.deepEqual(compareToOwnExits(null, {}), []);
  assert.deepEqual(mineExitRules(null), { thresholds: {}, reason_mix: [], samples: 0, agents: 0 });
});
