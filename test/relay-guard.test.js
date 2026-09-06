import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRelayTransaction,
  guardRelayPayload,
  deployLossCap,
  METEORA_DLMM_PROGRAM,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
} from "../hive/relay-guard.js";

const OWNER = "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey";
const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6d";
const ATTACKER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

/** A well-formed zap-in that spends 1 SOL of liquidity. */
function healthyDeploy(overrides = {}) {
  return {
    programIds: [COMPUTE_BUDGET_PROGRAM, METEORA_DLMM_PROGRAM],
    systemTransfers: [],
    staticAccounts: [OWNER, POOL, METEORA_DLMM_PROGRAM],
    signers: [OWNER],
    ownerLamportDelta: -1_010_000_000, // 1 SOL + fees
    simulationError: null,
    ...overrides,
  };
}

const policy = {
  owner: OWNER,
  maxSolLoss: deployLossCap(1),
  requiredAccounts: [POOL],
};

test("accepts a well-formed deploy", () => {
  assert.deepEqual(checkRelayTransaction(healthyDeploy(), policy), []);
});

test("deployLossCap bounds the allowance to the deploy size", () => {
  assert.equal(deployLossCap(1), 1.05);
  assert.equal(deployLossCap(0.5, { overheadSol: 0.02 }), 0.52);
  assert.throws(() => deployLossCap(0));
  assert.throws(() => deployLossCap("abc"));
});

test("rejects a transaction that drains more SOL than the deploy justifies", () => {
  // This is the attack the zap-in path currently has no defence against: the relay
  // returns a payload that moves far more SOL than we asked to deploy.
  const v = checkRelayTransaction(healthyDeploy({ ownerLamportDelta: -8_000_000_000 }), policy);
  assert.equal(v.length, 1);
  assert.match(v[0], /simulated SOL loss 8\.0+ exceeds cap 1\.05/);
});

test("rejects an unknown program", () => {
  const v = checkRelayTransaction(
    healthyDeploy({ programIds: [METEORA_DLMM_PROGRAM, "EvilPr0gram1111111111111111111111111111111"] }),
    policy,
  );
  assert.match(v[0], /non-allowlisted program Evil/);
});

test("rejects a raw SOL transfer to an unapproved destination", () => {
  const v = checkRelayTransaction(
    healthyDeploy({
      programIds: [SYSTEM_PROGRAM, METEORA_DLMM_PROGRAM],
      systemTransfers: [{ destination: ATTACKER, lamports: 500_000_000 }],
    }),
    policy,
  );
  assert.match(v[0], /system transfer of 0\.500000 SOL to unapproved/);
});

test("allows a transfer to an explicitly approved destination", () => {
  const v = checkRelayTransaction(
    healthyDeploy({
      programIds: [SYSTEM_PROGRAM, METEORA_DLMM_PROGRAM],
      systemTransfers: [{ destination: POOL, lamports: 2_000_000 }],
    }),
    { ...policy, allowedTransferDestinations: [POOL] },
  );
  assert.deepEqual(v, []);
});

test("rejects an unexpected co-signer", () => {
  const v = checkRelayTransaction(healthyDeploy({ signers: [OWNER, ATTACKER] }), policy);
  assert.match(v[0], /unexpected additional signer/);
});

test("rejects a payload that swapped out the pool we asked for", () => {
  const v = checkRelayTransaction(
    healthyDeploy({ staticAccounts: [OWNER, "SomeOtherPool111111111111111111111111111111"] }),
    policy,
  );
  assert.match(v.join(" "), /missing required account/);
});

test("rejects when simulation failed", () => {
  const v = checkRelayTransaction(
    healthyDeploy({ simulationError: { InstructionError: [0, "Custom"] } }),
    policy,
  );
  assert.match(v[0], /simulation failed/);
});

test("rejects when simulation was never run - the current zap-in behaviour", () => {
  const v = checkRelayTransaction(healthyDeploy({ ownerLamportDelta: null }), policy);
  assert.match(v[0], /did not report the owner balance delta/);
});

test("simulation can be waived only by explicit policy", () => {
  const v = checkRelayTransaction(healthyDeploy({ ownerLamportDelta: null }), {
    ...policy,
    requireSimulation: false,
  });
  assert.deepEqual(v, []);
});

test("a malformed policy is rejected rather than defaulting open", () => {
  assert.match(checkRelayTransaction(healthyDeploy(), { maxSolLoss: 1 })[0], /missing the owner/);
  assert.match(checkRelayTransaction(healthyDeploy(), { owner: OWNER })[0], /valid maxSolLoss/);
});

test("guardRelayPayload throws on the first bad transaction and submits nothing", async () => {
  const txs = ["good", "bad"];
  const inspect = async (s) =>
    s === "good" ? healthyDeploy() : healthyDeploy({ ownerLamportDelta: -9_000_000_000 });

  await assert.rejects(
    () => guardRelayPayload(txs, { inspect }, policy, "zap-in"),
    /zap-in 2\/2 rejected by relay guard/,
  );
});

test("guardRelayPayload reports every checked transaction on success", async () => {
  const out = await guardRelayPayload(["a", "b"], { inspect: async () => healthyDeploy() }, policy);
  assert.equal(out.checked, 2);
  assert.equal(out.report.length, 2);
});

test("guardRelayPayload ignores empty entries", async () => {
  const out = await guardRelayPayload(["", null, undefined, "a"], { inspect: async () => healthyDeploy() }, policy);
  assert.equal(out.checked, 1);
});
