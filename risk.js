/**
 * risk.js — the single portfolio risk breaker instance for the whole process.
 *
 * Meridian had per-position stops (stopLossPct, trailing TP, maxPositions) but nothing
 * that could stop a losing SEQUENCE. Every trade obeyed the rules while the sequence
 * drained the account. This is the missing state.
 *
 * It is deliberately deterministic and LLM-free. The model cannot argue past it,
 * because the gate lives in the tool-execution safety check, not in the prompt.
 */

import { RiskGuard } from "./hive/risk-guard.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";

export const riskGuard = new RiskGuard({
  stateFile: repoPath("risk-state.json"),
  config: {
    enabled:              config.risk.enabled,
    maxDailyLossSol:      config.risk.maxDailyLossSol,
    maxDailyLossPct:      config.risk.maxDailyLossPct,
    maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
    maxDrawdownPct:       config.risk.maxDrawdownPct,
    cooldownMinutes:      config.risk.cooldownMinutes,
    lossNoiseFloorSol:    config.risk.lossNoiseFloorSol,
  },
  log,
});

// Rate-limits the pricing-blindness warning so a provider outage does not flood the log.
let _lastPricingWarnAt = 0;

/**
 * Feed the breaker a full equity reading.
 *
 * IMPORTANT: equity must be wallet SOL PLUS the value of open positions. Passing wallet
 * balance alone hides the exact failure the drawdown limit exists to catch — a position
 * bleeding out that has not been closed yet moves no realized-PnL counter.
 *
 * @param {number} walletSol
 * @param {Array}  positions  from getMyPositions(); total_value_usd is in SOL when solMode
 * @param {number|null} solUsd
 */
export function markPortfolioEquity(walletSol, positions = [], solUsd = null) {
  const wallet = Number(walletSol);
  if (!Number.isFinite(wallet)) return null;

  let positionsSol = 0;
  for (const p of positions) {
    const value = Number(p?.total_value_usd);
    const fees = Number(p?.unclaimed_fees_usd) || 0;
    if (!Number.isFinite(value)) continue;
    if (config.management.solMode) {
      positionsSol += value + fees;             // already denominated in SOL
    } else if (solUsd > 0) {
      positionsSol += (value + fees) / solUsd;  // USD -> SOL
    } else {
      // Cannot price the position this tick. Skipping it would UNDERSTATE equity and
      // could fire a false drawdown halt, so abandon the reading entirely.
      //
      // Logged, and rate-limited, because this is a SILENT blindness: during a Jupiter
      // or Helius outage the drawdown limit simply stops receiving data, which is
      // exactly when a market is most likely to be moving against us. An operator needs
      // to know the breaker is running on stale equity, not assume no news is good news.
      const now = Date.now();
      if (now - _lastPricingWarnAt > 10 * 60_000) {
        _lastPricingWarnAt = now;
        log("risk_warn", "Equity reading skipped — open positions could not be priced in SOL. The drawdown limit is running on the last good reading.");
      }
      return null;
    }
  }

  return riskGuard.markEquity(wallet + positionsSol);
}

/** Convert a closed-position record into a SOL-denominated realized PnL and record it. */
export function recordClosedPosition(perf, solUsd = null) {
  let pnlSol = Number(perf?.pnl_sol);
  if (!Number.isFinite(pnlSol)) {
    const pnlUsd = Number(perf?.pnl_usd);
    if (config.management.solMode && Number.isFinite(pnlUsd)) {
      pnlSol = pnlUsd;                       // solMode already reports SOL in the usd field
    } else if (Number.isFinite(pnlUsd) && solUsd > 0) {
      pnlSol = pnlUsd / solUsd;
    } else {
      log("risk_warn", `Close for ${perf?.pool_name || perf?.pool} not counted — PnL not priceable in SOL`);
      return null;
    }
  }
  return riskGuard.recordClose({
    pnl_sol: pnlSol,
    pool_name: perf?.pool_name ?? null,
    reason: perf?.close_reason ?? null,
  });
}
