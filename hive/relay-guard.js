/**
 * relay-guard.js — policy checks for transactions built by a REMOTE server.
 *
 * WHY THIS EXISTS
 * ---------------
 * When `lpAgentRelayEnabled` is on, Meridian asks api.agentmeridian.xyz to BUILD the
 * transaction, then signs it with the user's key and submits it. The remote server
 * therefore chooses the instructions; the wallet just signs.
 *
 * In tools/dlmm.js the two relay paths are guarded asymmetrically:
 *
 *   close  (zap-out, line ~1550)  ->  signAndSimulateRelayTransactions(...)
 *                                     simulate + SOL-loss cap + system-transfer check
 *   deploy (zap-in,  line ~665)   ->  signSerializedTransactions(...)
 *                                     no simulation, no SOL cap, no transfer check
 *                                     (only assertNoInitializeBinArrayInstructions)
 *
 * The deploy path is the one that SENDS SOL out of the wallet. The weaker guard is on
 * the more dangerous direction. A compromised or malicious relay only has to return a
 * "zap-in" payload to get a blind signature on an arbitrary transfer.
 *
 * This module makes the policy explicit, symmetric and unit-testable. The chain-specific
 * decoding lives in a thin adapter (see `inspectVersionedTransaction` in the patch notes);
 * everything here operates on a plain inspection object so it can be tested without RPC.
 *
 * @typedef {object} TxInspection
 * @property {string[]} programIds        program ids invoked, in order
 * @property {Array<{destination:string, lamports:number}>} systemTransfers
 * @property {string[]} staticAccounts    account keys present in the message
 * @property {string[]} signers           accounts required to sign
 * @property {number|null} ownerLamportDelta  simulated net lamport change for the owner
 * @property {object|null} simulationError
 */

export const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Programs a liquidity-deploy or close relay legitimately needs. */
export const DEFAULT_ALLOWED_PROGRAMS = new Set([
  METEORA_DLMM_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  JUPITER_V6_PROGRAM,
]);

/**
 * @typedef {object} RelayPolicy
 * @property {string}  owner                    our wallet pubkey
 * @property {number}  maxSolLoss               max net SOL the owner may lose in this tx
 * @property {Set<string>} [allowedPrograms]
 * @property {string[]} [allowedTransferDestinations]  system-transfer destinations we accept
 * @property {string[]} [requiredAccounts]      accounts that MUST appear (e.g. the pool)
 * @property {boolean} [requireSimulation=true]
 */

/**
 * Check one inspected transaction against the policy.
 * Pure function — no I/O, no chain access. Returns a list of violations
 * (empty means the transaction is acceptable).
 *
 * @param {TxInspection} tx
 * @param {RelayPolicy} policy
 * @returns {string[]} violations
 */
export function checkRelayTransaction(tx, policy) {
  const violations = [];
  const {
    owner,
    maxSolLoss,
    allowedPrograms = DEFAULT_ALLOWED_PROGRAMS,
    allowedTransferDestinations = [],
    requiredAccounts = [],
    requireSimulation = true,
  } = policy || {};

  if (!owner) return ["policy is missing the owner pubkey"];
  if (!Number.isFinite(maxSolLoss) || maxSolLoss < 0) {
    return ["policy is missing a valid maxSolLoss"];
  }

  // 1. Program allow-list. An unknown program is the single clearest sign that the
  //    relay is not doing what it said it was doing.
  for (const pid of tx.programIds || []) {
    if (!allowedPrograms.has(pid)) {
      violations.push(`invokes non-allowlisted program ${pid}`);
    }
  }

  // 2. No signer other than us. A second required signer means the relay expects to
  //    co-sign something we have not inspected.
  for (const s of tx.signers || []) {
    if (s !== owner) violations.push(`requires an unexpected additional signer ${s}`);
  }

  // 3. Raw SOL transfers must go somewhere we explicitly approved. Rent-exempt
  //    account creation shows up here too, hence the allow-list rather than a ban.
  const allowedDest = new Set([owner, ...allowedTransferDestinations]);
  for (const t of tx.systemTransfers || []) {
    if (!allowedDest.has(t.destination)) {
      violations.push(
        `system transfer of ${(t.lamports / 1e9).toFixed(6)} SOL to unapproved ${t.destination}`,
      );
    }
  }

  // 4. Required accounts (the pool we asked for) must actually be in the message —
  //    otherwise the relay swapped the target out from under us.
  const staticSet = new Set(tx.staticAccounts || []);
  for (const acc of requiredAccounts) {
    if (acc && !staticSet.has(acc)) {
      violations.push(`missing required account ${acc}`);
    }
  }

  // 5. Simulation. This is the check the deploy path skips entirely today.
  if (requireSimulation) {
    if (tx.simulationError) {
      violations.push(`simulation failed: ${JSON.stringify(tx.simulationError)}`);
    } else if (tx.ownerLamportDelta == null) {
      violations.push("simulation did not report the owner balance delta");
    } else {
      const lossLamports = -Math.min(0, tx.ownerLamportDelta);
      const capLamports = Math.floor(maxSolLoss * 1e9);
      if (lossLamports > capLamports) {
        violations.push(
          `simulated SOL loss ${(lossLamports / 1e9).toFixed(6)} exceeds cap ${maxSolLoss}`,
        );
      }
    }
  }

  return violations;
}

/**
 * Compute the SOL-loss cap for a deploy. The deploy legitimately spends
 * `amountSol` plus rent and fees, so the cap is the deploy amount plus a
 * bounded overhead — not an unbounded allowance.
 */
export function deployLossCap(amountSol, { overheadSol = 0.05 } = {}) {
  const amt = Number(amountSol);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("deployLossCap needs a positive amountSol");
  return Math.round((amt + overheadSol) * 1e6) / 1e6;
}

/**
 * Orchestrator: inspect + check every transaction in a relay payload, throwing on the
 * first violation so nothing is submitted. Use for BOTH zap-in and zap-out.
 *
 * @param {string[]} serializedTxs   base64 unsigned transactions from the relay
 * @param {object} deps
 * @param {(serialized:string) => Promise<TxInspection>} deps.inspect
 * @param {RelayPolicy} policy
 * @param {string} [label]
 */
export async function guardRelayPayload(serializedTxs, { inspect }, policy, label = "relay tx") {
  const list = (serializedTxs || []).filter((s) => typeof s === "string" && s.length > 0);
  const report = [];

  for (const [i, serialized] of list.entries()) {
    const inspection = await inspect(serialized);
    const violations = checkRelayTransaction(inspection, policy);
    report.push({ index: i, violations, programIds: inspection.programIds });
    if (violations.length > 0) {
      throw new Error(
        `${label} ${i + 1}/${list.length} rejected by relay guard: ${violations.join("; ")}`,
      );
    }
  }

  return { checked: list.length, report };
}
