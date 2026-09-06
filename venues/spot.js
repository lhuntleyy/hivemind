/**
 * venues/spot.js — spot trading venue.
 *
 * ARCHITECTURE DECISION: GMGN SIGNALS, JUPITER EXECUTION
 * -----------------------------------------------------
 * GMGN exposes a trading API, and its own tooling asks for a GMGN_PRIVATE_KEY. We do
 * not use either. Signals come from GMGN (KOL flow, rug/bundler ratios, Supertrend +
 * RSI + Bollinger), execution goes through Jupiter with a locally-held key.
 *
 * Reasons, in order of weight:
 *   1. A second private key in a third-party config file is a second way to lose the
 *      wallet. The agent already signs locally for LP; there is no reason to widen that.
 *   2. tools/wallet.js#swapToken is the one execution path in this codebase that has
 *      been exercised, has slippage bounds, and has a DRY_RUN branch. A parallel path
 *      would need all of that rebuilt and would drift.
 *   3. Spot buy/sell IS a swap. Routing through a vendor adds a dependency without
 *      adding capability.
 *
 * WHY SPOT AT ALL
 * ---------------
 * The LP payoff on this agent's own swarm data is asymmetric the wrong way: winners
 * around +2.6%, losers around -15%, needing ~85% win rate to break even. That is
 * structural — single-sided SOL below price is a forced limit-buy ladder, so PnL is
 * dominated by direction, not fees. Spot inverts the asymmetry: cut at -8%, let winners
 * run. Same signal, better shape.
 *
 * DEFAULT: DISABLED. config.venue.spot must be turned on deliberately.
 */

import fs from "fs";
import { log } from "../logger.js";
import { config } from "../config.js";
import { repoPath } from "../repo-root.js";
import { getWalletBalances, swapToken, normalizeMint } from "../tools/wallet.js";
import { riskGuard } from "../risk.js";

const POSITIONS_FILE = repoPath("spot-positions.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── persistence ────────────────────────────────────────────────

function load() {
  try {
    if (!fs.existsSync(POSITIONS_FILE)) return { positions: {}, closed: [], updated_at: null };
    const d = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
    return { positions: d.positions || {}, closed: d.closed || [], updated_at: d.updated_at || null };
  } catch (error) {
    // Unlike the risk ledger, a corrupt position file cannot fail closed by pretending
    // there are no positions — that would strand real tokens with no exit rules. Refuse
    // loudly instead so the operator fixes it rather than silently trading blind.
    log("spot_error", `spot-positions.json unreadable: ${error.message}. Spot venue disabled until fixed.`);
    return null;
  }
}

function save(state) {
  state.updated_at = new Date().toISOString();
  const tmp = `${POSITIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, POSITIONS_FILE);
}

// ─── helpers ────────────────────────────────────────────────────

export function isSpotEnabled() {
  return !!config.venue?.spot;
}

function spotCfg() {
  const s = config.spot || {};
  return {
    maxPositions:   Number(s.maxPositions   ?? 3),
    sizeSol:        Number(s.sizeSol        ?? 0.25),
    maxSizeSol:     Number(s.maxSizeSol     ?? 2),
    stopLossPct:    Number(s.stopLossPct    ?? -8),
    takeProfitPct:  Number(s.takeProfitPct  ?? 40),
    trailingTriggerPct: Number(s.trailingTriggerPct ?? 15),
    trailingDropPct:    Number(s.trailingDropPct    ?? 8),
    maxHoldMinutes: Number(s.maxHoldMinutes ?? 360),
    slippageBps:    Number(s.slippageBps    ?? 300),
    minSolReserve:  Number(s.minSolReserve  ?? 0.05),
  };
}

function pctChange(from, to) {
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

// ─── entry ──────────────────────────────────────────────────────

/**
 * Open a spot position: swap SOL -> token, record cost basis.
 *
 * Gated by the SAME portfolio breaker as LP. A spot buy is new risk, so a tripped
 * breaker must block it exactly as it blocks deploy_position — otherwise turning on
 * spot would quietly route around the one control that stops a losing streak.
 */
export async function openSpot({ mint, symbol = null, amount_sol = null, reason = null, signal = null }) {
  if (!isSpotEnabled()) return { blocked: true, reason: "Spot venue is disabled (config.venue.spot = false)." };

  const gate = riskGuard.canDeploy();
  if (!gate.pass) return { blocked: true, reason: gate.reason };

  const state = load();
  if (!state) return { blocked: true, reason: "spot-positions.json is unreadable — refusing to trade blind." };

  const cfg = spotCfg();
  const targetMint = normalizeMint(mint);
  if (!targetMint || targetMint === SOL_MINT) {
    return { blocked: true, reason: "Refusing to open a spot position in SOL itself." };
  }

  const open = Object.values(state.positions).filter((p) => !p.closed);
  if (open.length >= cfg.maxPositions) {
    return { blocked: true, reason: `Max spot positions (${cfg.maxPositions}) reached.` };
  }
  if (open.some((p) => p.mint === targetMint)) {
    return { blocked: true, reason: `Already holding a spot position in ${symbol || targetMint.slice(0, 8)}.` };
  }

  const size = Math.min(
    cfg.maxSizeSol,
    Number.isFinite(Number(amount_sol)) && Number(amount_sol) > 0 ? Number(amount_sol) : cfg.sizeSol,
  );
  if (!(size > 0)) return { blocked: true, reason: "Spot size must be positive." };

  // Balance check. Skipped in DRY_RUN so a dry run without a funded wallet still
  // exercises the whole path.
  let entryPriceSol = null;
  if (process.env.DRY_RUN !== "true") {
    const bal = await getWalletBalances();
    if (bal.error) return { blocked: true, reason: `Cannot read wallet balance: ${bal.error}` };
    if (bal.sol < size + cfg.minSolReserve) {
      return { blocked: true, reason: `Insufficient SOL: have ${bal.sol}, need ${size + cfg.minSolReserve} (${size} buy + ${cfg.minSolReserve} reserve).` };
    }
  }

  const swap = await swapToken({
    input_mint: SOL_MINT,
    output_mint: targetMint,
    amount: size,
    slippage_bps: cfg.slippageBps,
  });

  if (swap?.dry_run) {
    log("spot", `[DRY RUN] would buy ${size} SOL of ${symbol || targetMint.slice(0, 8)}`);
    return { dry_run: true, would_open: { mint: targetMint, symbol, amount_sol: size, slippage_bps: swap.would_swap.slippage_bps }, reason };
  }
  if (!swap || swap.error || swap.success === false || !swap.tx) {
    return { success: false, error: swap?.error || "swap returned no transaction" };
  }

  const tokensOut = Number(swap.amount_out);
  if (!Number.isFinite(tokensOut) || tokensOut <= 0) {
    // We spent SOL but cannot establish a cost basis. Record the position anyway with a
    // null basis so the exit rules still fire on time/manual grounds — losing track of
    // a token we just bought is worse than an imperfect record.
    log("spot_warn", `Buy filled but amount_out was unusable (${swap.amount_out}) — cost basis unknown for ${targetMint.slice(0, 8)}`);
  } else {
    entryPriceSol = size / tokensOut;
  }

  const id = `spot_${Date.now()}_${targetMint.slice(0, 6)}`;
  state.positions[id] = {
    id,
    mint: targetMint,
    symbol: symbol || targetMint.slice(0, 8),
    amount_sol_in: size,
    tokens: Number.isFinite(tokensOut) ? tokensOut : null,
    entry_price_sol: entryPriceSol,
    entry_tx: swap.tx,
    opened_at: new Date().toISOString(),
    peak_pnl_pct: 0,
    trailing_active: false,
    closed: false,
    reason: reason || null,
    signal: signal || null,
  };
  save(state);

  log("spot", `OPEN ${state.positions[id].symbol}: ${size} SOL -> ${tokensOut} tokens (tx ${swap.tx.slice(0, 12)})`);
  return { success: true, id, mint: targetMint, amount_sol: size, tokens: tokensOut, tx: swap.tx };
}

// ─── exit ───────────────────────────────────────────────────────

export async function closeSpot(id, reason = "manual") {
  const state = load();
  if (!state) return { success: false, error: "spot-positions.json unreadable" };

  const pos = state.positions[id];
  if (!pos || pos.closed) return { success: false, error: `No open spot position ${id}` };

  const cfg = spotCfg();

  // Re-read the on-chain balance instead of trusting our stored token amount: a partial
  // fill, a transfer, or a rebasing token would make the stored figure wrong, and
  // selling an amount we do not hold fails the whole transaction.
  let sellAmount = pos.tokens;
  if (process.env.DRY_RUN !== "true") {
    const bal = await getWalletBalances();
    const held = bal.tokens?.find((t) => t.mint === pos.mint);
    if (!held || !(held.balance > 0)) {
      // The token is gone — sold elsewhere, or never actually received.
      pos.closed = true;
      pos.closed_at = new Date().toISOString();
      pos.close_reason = "token no longer in wallet";
      state.closed.push(pos);
      delete state.positions[id];
      save(state);
      riskGuard.recordUnaccountedClose({ position: id, note: `spot ${pos.symbol}` });
      return { success: false, error: "token not in wallet — marked closed as unaccounted" };
    }
    sellAmount = held.balance;
  }

  const swap = await swapToken({
    input_mint: pos.mint,
    output_mint: SOL_MINT,
    amount: sellAmount,
    slippage_bps: cfg.slippageBps,
  });

  if (swap?.dry_run) {
    log("spot", `[DRY RUN] would sell ${sellAmount} ${pos.symbol} (${reason})`);
    return { dry_run: true, would_close: { id, symbol: pos.symbol, reason } };
  }
  if (!swap || swap.error || swap.success === false || !swap.tx) {
    return { success: false, error: swap?.error || "sell swap returned no transaction" };
  }

  const solOut = Number(swap.amount_out);
  const pnlSol = Number.isFinite(solOut) ? solOut - pos.amount_sol_in : null;
  const pnlPct = Number.isFinite(pnlSol) && pos.amount_sol_in > 0 ? (pnlSol / pos.amount_sol_in) * 100 : null;

  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.close_reason = reason;
  pos.exit_tx = swap.tx;
  pos.sol_out = Number.isFinite(solOut) ? solOut : null;
  pos.pnl_sol = Number.isFinite(pnlSol) ? Math.round(pnlSol * 1e6) / 1e6 : null;
  pos.pnl_pct = Number.isFinite(pnlPct) ? Math.round(pnlPct * 100) / 100 : null;
  pos.minutes_held = Math.round((Date.now() - Date.parse(pos.opened_at)) / 60000);

  state.closed.push(pos);
  if (state.closed.length > 500) state.closed = state.closed.slice(-500);
  delete state.positions[id];
  save(state);

  // Feed the portfolio breaker. A spot loss must count toward the same daily limit as
  // an LP loss — they come out of the same wallet.
  if (Number.isFinite(pnlSol)) {
    riskGuard.recordClose({ pnl_sol: pnlSol, pool_name: `spot:${pos.symbol}`, reason });
  } else {
    riskGuard.recordUnaccountedClose({ position: id, note: `spot ${pos.symbol} — sell filled but PnL unpriceable` });
  }

  log("spot", `CLOSE ${pos.symbol}: ${pos.pnl_sol} SOL (${pos.pnl_pct}%) — ${reason}`);
  return { success: true, id, pnl_sol: pos.pnl_sol, pnl_pct: pos.pnl_pct, tx: swap.tx, reason };
}

// ─── monitoring ─────────────────────────────────────────────────

/**
 * Deterministic exit rules. No LLM: these must fire on a schedule the model cannot
 * delay, argue with, or forget. Mirrors the LP side's getDeterministicCloseRule.
 *
 * @param {object} pos      stored position
 * @param {number} priceSol current price in SOL per token
 * @returns {{action:string, reason:string}|null}
 */
export function getSpotExitRule(pos, priceSol, cfg = spotCfg(), now = Date.now()) {
  const held = Math.round((now - Date.parse(pos.opened_at)) / 60000);

  if (cfg.maxHoldMinutes > 0 && held >= cfg.maxHoldMinutes) {
    return { action: "CLOSE", reason: `max hold ${held}m >= ${cfg.maxHoldMinutes}m` };
  }

  // Everything below needs a price. Without a cost basis or a live price we can only
  // act on time — and we deliberately do NOT guess, because a wrong price here sells
  // a winner at a fabricated loss.
  if (!(pos.entry_price_sol > 0) || !(priceSol > 0)) return null;

  const pnl = pctChange(pos.entry_price_sol, priceSol);
  if (pnl == null) return null;

  if (cfg.stopLossPct < 0 && pnl <= cfg.stopLossPct) {
    return { action: "CLOSE", reason: `stop loss ${pnl.toFixed(2)}% <= ${cfg.stopLossPct}%` };
  }
  if (cfg.takeProfitPct > 0 && pnl >= cfg.takeProfitPct) {
    return { action: "CLOSE", reason: `take profit ${pnl.toFixed(2)}% >= ${cfg.takeProfitPct}%` };
  }
  if (pos.trailing_active && Number.isFinite(pos.peak_pnl_pct)) {
    const drop = pos.peak_pnl_pct - pnl;
    if (drop >= cfg.trailingDropPct) {
      return { action: "CLOSE", reason: `trailing: peak ${pos.peak_pnl_pct.toFixed(2)}% -> ${pnl.toFixed(2)}% (dropped ${drop.toFixed(2)}%)` };
    }
  }
  return null;
}

/**
 * One monitoring tick over all open spot positions.
 * Prices come from Helius (the same source as the wallet view) so this adds no new
 * provider dependency.
 */
export async function monitorSpot() {
  if (!isSpotEnabled()) return { checked: 0, actions: [] };
  const state = load();
  if (!state) return { checked: 0, actions: [], error: "positions file unreadable" };

  const open = Object.values(state.positions).filter((p) => !p.closed);
  if (open.length === 0) return { checked: 0, actions: [] };

  const cfg = spotCfg();
  const bal = await getWalletBalances().catch(() => null);
  const solPrice = bal?.sol_price || 0;
  const actions = [];

  for (const pos of open) {
    const held = bal?.tokens?.find((t) => t.mint === pos.mint);
    // Helius gives USD; convert to SOL per token so it is comparable to the basis.
    let priceSol = null;
    if (held && held.balance > 0 && Number.isFinite(held.usd) && solPrice > 0) {
      priceSol = (held.usd / held.balance) / solPrice;
    }

    // Update peak / arm trailing BEFORE evaluating exits, same order as the LP side.
    if (pos.entry_price_sol > 0 && priceSol > 0) {
      const pnl = pctChange(pos.entry_price_sol, priceSol);
      if (Number.isFinite(pnl)) {
        if (pnl > (pos.peak_pnl_pct ?? 0)) pos.peak_pnl_pct = pnl;
        if (!pos.trailing_active && cfg.trailingTriggerPct > 0 && pos.peak_pnl_pct >= cfg.trailingTriggerPct) {
          pos.trailing_active = true;
          log("spot", `${pos.symbol} trailing armed at peak ${pos.peak_pnl_pct.toFixed(2)}%`);
        }
        pos.last_pnl_pct = Math.round(pnl * 100) / 100;
      }
    }

    const rule = getSpotExitRule(pos, priceSol, cfg);
    if (rule) actions.push({ id: pos.id, symbol: pos.symbol, ...rule });
  }

  save(state);

  for (const a of actions) {
    const r = await closeSpot(a.id, a.reason).catch((e) => ({ success: false, error: e.message }));
    a.result = r;
  }

  return { checked: open.length, actions };
}

// ─── read ───────────────────────────────────────────────────────

export function getSpotPositions() {
  const state = load();
  if (!state) return { open: [], closed: [], error: "positions file unreadable" };
  return {
    open: Object.values(state.positions).filter((p) => !p.closed),
    closed: state.closed.slice(-50).reverse(),
    updated_at: state.updated_at,
  };
}

export function getSpotSummary() {
  const state = load();
  if (!state) return null;
  const closed = state.closed.filter((p) => Number.isFinite(p.pnl_sol));
  if (closed.length === 0) return { closed: 0, open: Object.keys(state.positions).length };
  const total = closed.reduce((s, p) => s + p.pnl_sol, 0);
  const wins = closed.filter((p) => p.pnl_sol > 0).length;
  return {
    open: Object.values(state.positions).filter((p) => !p.closed).length,
    closed: closed.length,
    total_pnl_sol: Math.round(total * 1e6) / 1e6,
    win_rate_pct: Math.round((wins / closed.length) * 100),
    avg_pnl_pct: Math.round((closed.reduce((s, p) => s + (p.pnl_pct || 0), 0) / closed.length) * 100) / 100,
  };
}
