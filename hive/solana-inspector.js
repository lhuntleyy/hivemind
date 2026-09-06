/**
 * solana-inspector.js — the chain-facing half of relay-guard.
 *
 * Turns a base64 transaction from the relay into the plain TxInspection object that
 * lib/relay-guard.js checks. Kept separate so the policy logic stays unit-testable
 * without an RPC connection or @solana/web3.js.
 *
 * Drop this into the Meridian repo (it already depends on @solana/web3.js ^1.95).
 */

import { VersionedTransaction, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { guardRelayPayload, deployLossCap, DEFAULT_ALLOWED_PROGRAMS } from "./relay-guard.js";

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toString();
const SYS_TRANSFER_IX = 2; // SystemInstruction enum: Transfer

function decode(base64) {
  const bytes = Buffer.from(base64, "base64");
  try {
    return { kind: "versioned", tx: VersionedTransaction.deserialize(bytes) };
  } catch {
    return { kind: "legacy", tx: Transaction.from(bytes) };
  }
}

function staticKeys(decoded) {
  return decoded.kind === "versioned"
    ? decoded.tx.message.staticAccountKeys.map((k) => k.toString())
    : [...new Set(decoded.tx.instructions.flatMap((ix) => [
        ix.programId.toString(),
        ...ix.keys.map((k) => k.pubkey.toString()),
      ]))];
}

function compiled(decoded) {
  if (decoded.kind === "versioned") {
    const keys = decoded.tx.message.staticAccountKeys.map((k) => k.toString());
    return decoded.tx.message.compiledInstructions.map((ix) => ({
      programId: keys[ix.programIdIndex],
      accounts: (ix.accountKeyIndexes || []).map((i) => keys[i]),
      data: Buffer.from(ix.data || []),
    }));
  }
  return decoded.tx.instructions.map((ix) => ({
    programId: ix.programId.toString(),
    accounts: ix.keys.map((k) => k.pubkey.toString()),
    data: Buffer.from(ix.data || []),
  }));
}

/** Decode SystemProgram::Transfer instructions (4-byte LE discriminator + u64 lamports). */
function systemTransfers(instructions) {
  const out = [];
  for (const ix of instructions) {
    if (ix.programId !== SYSTEM_PROGRAM_ID) continue;
    if (ix.data.length < 12) continue;
    if (ix.data.readUInt32LE(0) !== SYS_TRANSFER_IX) continue;
    out.push({
      destination: ix.accounts[1] ?? "unknown",
      lamports: Number(ix.data.readBigUInt64LE(4)),
    });
  }
  return out;
}

function requiredSigners(decoded) {
  if (decoded.kind === "versioned") {
    const n = decoded.tx.message.header.numRequiredSignatures;
    return decoded.tx.message.staticAccountKeys.slice(0, n).map((k) => k.toString());
  }
  return (decoded.tx.signatures || []).map((s) => s.publicKey.toString());
}

/**
 * Build an inspector bound to a connection and an owner.
 * Simulation is what supplies ownerLamportDelta — the check the zap-in path skips today.
 */
export function makeInspector(connection, ownerPubkey) {
  const owner = ownerPubkey.toString();

  return async function inspect(base64) {
    const decoded = decode(base64);
    const ixs = compiled(decoded);
    const keys = staticKeys(decoded);

    let ownerLamportDelta = null;
    let simulationError = null;

    try {
      // simulateTransaction with `accounts.addresses` returns the account state AFTER
      // the simulated execution. Read the owner's balance BEFORE simulating so the two
      // readings bracket the same instant; doing it the other way round can straddle a
      // real balance change and produce a delta that is off by a whole transaction.
      const balanceBefore = await connection.getBalance(new PublicKey(owner));

      const sim = await connection.simulateTransaction(decoded.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: [owner] },
      });
      simulationError = sim.value?.err ?? null;

      const postAccount = sim.value?.accounts?.[0];
      if (postAccount && typeof postAccount.lamports === "number") {
        // Negative = SOL leaves the wallet, which is what the loss cap checks.
        ownerLamportDelta = postAccount.lamports - balanceBefore;
      }
      // If the RPC did not return the account (some providers omit it), leave the delta
      // null. checkRelayTransaction treats a missing delta as a violation, so the
      // transaction is refused rather than signed unverified.
    } catch (e) {
      simulationError = { simulateThrew: String(e.message || e) };
    }

    return {
      programIds: [...new Set(ixs.map((ix) => ix.programId))],
      systemTransfers: systemTransfers(ixs),
      staticAccounts: keys,
      signers: requiredSigners(decoded),
      ownerLamportDelta,
      simulationError,
    };
  };
}

/**
 * Drop-in guard for the zap-in (deploy) relay path in tools/dlmm.js.
 *
 * Replace:
 *     const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
 *     const swap = signSerializedTransactions(swapUnsigned, wallet);
 *
 * With:
 *     await guardZapIn([...addLiquidityUnsigned, ...swapUnsigned], {
 *       connection: getConnection(), owner: wallet.publicKey,
 *       amountSol: finalAmountY, pool: pool_address,
 *     });
 *     const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
 *     const swap = signSerializedTransactions(swapUnsigned, wallet);
 */
export async function guardZapIn(serializedTxs, { connection, owner, amountSol, pool, overheadSol = 0.05, extraAllowedPrograms = [] }) {
  const allowed = new Set([...DEFAULT_ALLOWED_PROGRAMS, ...extraAllowedPrograms]);
  return guardRelayPayload(
    serializedTxs,
    { inspect: makeInspector(connection, owner) },
    {
      owner: owner.toString(),
      maxSolLoss: deployLossCap(amountSol, { overheadSol }),
      allowedPrograms: allowed,
      requiredAccounts: pool ? [String(pool)] : [],
      requireSimulation: true,
    },
    "zap-in",
  );
}
