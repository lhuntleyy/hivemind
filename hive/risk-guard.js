/**
 * risk-guard.js — portfolio-level circuit breaker.
 *
 * WHY THIS EXISTS
 * ---------------
 * Meridian has per-position risk (stopLossPct, trailingTakeProfit, maxPositions,
 * maxDeployAmount) but NOTHING at the portfolio level. Grepping the whole repo for
 * circuit / killSwitch / dailyLoss / maxDrawdown / consecutiveLoss returns zero hits.
 *
 * Consequence: an agent that is wrong in a regime — a market-wide dump, a bad evolved
 * threshold, a bug in the PnL feed — will keep re-deploying every 30 minutes, taking a
 * -15% stop loss each time, indefinitely. Each individual trade obeys the rules; the
 * sequence destroys the account. There is no state in the system that can say "stop".
 *
 * This module is that state. It is deliberately deterministic and LLM-free: the model
 * cannot argue its way past a tripped breaker, because the breaker is checked in the
 * tool-execution safety gate, not in the prompt.
 */

import fs from "fs";
import { writeFileAtomic } from "../atomic-write.js";
import path from "path";

const DEFAULTS = {
  // Realized loss in SOL over one UTC day that halts new deploys.
  maxDailyLossSol: 0.5,
  // Same, as a fraction of the day's opening equity. Whichever trips first wins.
  maxDailyLossPct: 12,
  // Consecutive losing closes that halt new deploys.
  maxConsecutiveLosses: 4,
  // Drawdown from the all-time equity peak (percent) that halts new deploys.
  maxDrawdownPct: 25,
  // How long a trip lasts before it can auto-clear.
  cooldownMinutes: 240,
  // A close smaller than this in SOL is noise and does not count toward the
  // consecutive-loss streak (avoids dust closes tripping the breaker).
  lossNoiseFloorSol: 0.002,
  enabled: true,
};

export class RiskGuard {
  /**
   * @param {object} opts
   * @param {string} opts.stateFile  path to the JSON ledger
   * @param {object} [opts.config]   overrides for DEFAULTS
   * @param {function} [opts.now]    injectable clock (testing)
   * @param {function} [opts.log]
   */
  constructor({ stateFile, config = {}, now = () => Date.now(), log = () => {} } = {}) {
    if (!stateFile) throw new Error("RiskGuard requires a stateFile path");
    this.stateFile = stateFile;
    this.cfg = { ...DEFAULTS, ...config };
    this.now = now;
    this.log = log;
  }

  // ─── persistence ──────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
        if (parsed && typeof parsed === "object") return { ...this._empty(), ...parsed };
      }
    } catch {
      // A corrupt ledger must fail CLOSED, not open. Returning the empty ledger
      // would silently reset a tripped breaker, so mark it tripped instead.
      const fresh = this._empty();
      fresh.halted = true;
      fresh.halt_reason = "risk ledger unreadable — halting until manually resumed";
      fresh.halted_at = new Date(this.now()).toISOString();
      fresh.halted_until = null; // null = no auto-clear, needs explicit resume()
      return fresh;
    }
    return this._empty();
  }

  _empty() {
    return {
      day: null,                  // YYYY-MM-DD (UTC)
      day_open_equity_sol: null,
      day_realized_pnl_sol: 0,
      day_closes: 0,
      consecutive_losses: 0,
      unaccounted_closes: 0,
      unaccounted: [],
      peak_equity_sol: null,
      last_equity_sol: null,
      halted: false,
      halt_reason: null,
      halted_at: null,
      halted_until: null,
      trips: [],
      updated_at: null,
    };
  }

  _save(state) {
    state.updated_at = new Date(this.now()).toISOString();
    const dir = path.dirname(this.stateFile);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // A crash mid-write must not leave a truncated ledger that the next _load()
    // would treat as corrupt-and-halt. writeFileAtomic also retries the rename,
    // which on Windows fails outright while another process holds the file.
    writeFileAtomic(fs, this.stateFile, JSON.stringify(state, null, 2));
  }

  _today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Roll the daily counters when the UTC date changes. */
  _rollDay(state, equitySol = null) {
    const today = this._today();
    if (state.day === today) return state;
    state.day = today;
    state.day_realized_pnl_sol = 0;
    state.day_closes = 0;
    state.day_open_equity_sol = equitySol ?? state.last_equity_sol ?? null;
    return state;
  }

  // ─── inputs ───────────────────────────────────────────────────
  /**
   * A position vanished from chain without going through our close path — closed by
   * hand in the Meteora UI, or a close whose bookkeeping we lost. Its PnL is NOT
   * recoverable, so we deliberately do not guess it: inventing a number would either
   * cause false halts or paper over real losses.
   *
   * Instead the hole is recorded. Once the ledger has unaccounted closes, the daily
   * and drawdown numbers are known to be incomplete, and both the panel and
   * `status()` say so rather than presenting a confident wrong figure.
   */
  recordUnaccountedClose({ position = null, note = null } = {}) {
    const state = this._rollDay(this._load());
    state.unaccounted_closes = (state.unaccounted_closes || 0) + 1;
    state.unaccounted = [...(state.unaccounted || []), {
      at: new Date(this.now()).toISOString(),
      position,
      note,
    }].slice(-25);
    this._save(state);
    this.log(
      "risk_warn",
      `Unaccounted close (${state.unaccounted_closes} total) — realized PnL for ${position || "a position"} ` +
      `never reached the risk ledger, so daily loss and drawdown are now understated.`,
    );
    return { unaccounted: state.unaccounted_closes };
  }

  /**
   * Call on every equity observation (wallet SOL + position value).
   * Tracks the all-time peak used for the drawdown breaker.
   */
  markEquity(equitySol) {
    const eq = Number(equitySol);
    if (!Number.isFinite(eq) || eq < 0) return null;

    const state = this._rollDay(this._load(), eq);
    state.last_equity_sol = eq;
    if (state.day_open_equity_sol == null) state.day_open_equity_sol = eq;
    if (state.peak_equity_sol == null || eq > state.peak_equity_sol) state.peak_equity_sol = eq;

    const trip = this._evaluate(state);
    this._save(state);
    return trip;
  }

  /**
   * Call after every closed position.
   * @param {object} close
   * @param {number} close.pnl_sol      realized PnL in SOL (fees included)
   * @param {string} [close.pool_name]
   * @param {string} [close.reason]
   */
  recordClose({ pnl_sol, pool_name = null, reason = null } = {}) {
    const pnl = Number(pnl_sol);
    if (!Number.isFinite(pnl)) return null;

    const state = this._rollDay(this._load());
    state.day_realized_pnl_sol = round6(state.day_realized_pnl_sol + pnl);
    state.day_closes += 1;

    // Only losses beyond the noise floor advance the streak; any real win resets it.
    if (pnl < -Math.abs(this.cfg.lossNoiseFloorSol)) {
      state.consecutive_losses += 1;
    } else if (pnl > Math.abs(this.cfg.lossNoiseFloorSol)) {
      state.consecutive_losses = 0;
    }

    const trip = this._evaluate(state, { pool_name, reason });
    this._save(state);
    return trip;
  }

  // ─── breaker logic ────────────────────────────────────────────
  _evaluate(state, ctx = {}) {
    if (!this.cfg.enabled || state.halted) return null;

    const reasons = [];

    const dailyLoss = -Math.min(0, state.day_realized_pnl_sol);
    if (this.cfg.maxDailyLossSol > 0 && dailyLoss >= this.cfg.maxDailyLossSol) {
      reasons.push(`daily realized loss ${dailyLoss.toFixed(4)} SOL >= limit ${this.cfg.maxDailyLossSol} SOL`);
    }

    if (this.cfg.maxDailyLossPct > 0 && state.day_open_equity_sol > 0) {
      const pct = (dailyLoss / state.day_open_equity_sol) * 100;
      if (pct >= this.cfg.maxDailyLossPct) {
        reasons.push(`daily loss ${pct.toFixed(2)}% of opening equity >= limit ${this.cfg.maxDailyLossPct}%`);
      }
    }

    if (this.cfg.maxConsecutiveLosses > 0 && state.consecutive_losses >= this.cfg.maxConsecutiveLosses) {
      reasons.push(`${state.consecutive_losses} consecutive losing closes >= limit ${this.cfg.maxConsecutiveLosses}`);
    }

    if (
      this.cfg.maxDrawdownPct > 0 &&
      state.peak_equity_sol > 0 &&
      state.last_equity_sol != null
    ) {
      const dd = ((state.peak_equity_sol - state.last_equity_sol) / state.peak_equity_sol) * 100;
      if (dd >= this.cfg.maxDrawdownPct) {
        reasons.push(`drawdown ${dd.toFixed(2)}% from peak ${state.peak_equity_sol.toFixed(4)} SOL >= limit ${this.cfg.maxDrawdownPct}%`);
      }
    }

    if (reasons.length === 0) return null;

    const at = this.now();
    state.halted = true;
    state.halt_reason = reasons.join("; ");
    state.halted_at = new Date(at).toISOString();
    state.halted_until = this.cfg.cooldownMinutes > 0
      ? new Date(at + this.cfg.cooldownMinutes * 60_000).toISOString()
      : null;
    state.trips.push({
      at: state.halted_at,
      reasons,
      day_realized_pnl_sol: state.day_realized_pnl_sol,
      consecutive_losses: state.consecutive_losses,
      equity_sol: state.last_equity_sol,
      ...ctx,
    });
    if (state.trips.length > 50) state.trips = state.trips.slice(-50);

    this.log("risk_halt", state.halt_reason);
    return { halted: true, reason: state.halt_reason, until: state.halted_until };
  }

  // ─── gate ─────────────────────────────────────────────────────
  /**
   * The gate that belongs in runSafetyChecks("deploy_position").
   * Returns { pass, reason }.
   *
   * Note it only blocks OPENING risk. Closing, claiming and swapping stay allowed —
   * a breaker that stops you from exiting is worse than no breaker at all.
   */
  canDeploy() {
    if (!this.cfg.enabled) return { pass: true };

    // canDeploy is a READ of the breaker. It used to persist on every call just to
    // carry a day roll, which put a disk write on the hot path of every deploy check —
    // and that write is what a transient file lock turned into a dead screening cycle
    // (EPERM renaming risk-state.json while a second agent process held it). Save only
    // when something actually changed.
    const loaded = this._load();
    const dayBefore = loaded.day;
    const state = this._rollDay(loaded);
    const dayRolled = state.day !== dayBefore;

    if (!state.halted) {
      if (dayRolled) this._save(state);
      return { pass: true };
    }

    // Auto-clear once the cooldown has elapsed. halted_until === null means the
    // trip requires an explicit human resume().
    if (state.halted_until && this.now() >= Date.parse(state.halted_until)) {
      state.halted = false;
      const cleared = state.halt_reason;
      state.halt_reason = null;
      state.halted_at = null;
      state.halted_until = null;
      state.consecutive_losses = 0;

      // Re-evaluate immediately. A cooldown expiring does not undo the day's realized
      // loss or the drawdown from peak — without this the breaker would let one more
      // deploy through and only re-trip on the NEXT close.
      const retrip = this._evaluate(state);
      this._save(state);
      if (retrip) {
        this.log("risk_halt", `Cooldown elapsed but conditions persist: ${retrip.reason}`);
        return {
          pass: false,
          reason:
            `RISK BREAKER STILL TRIPPED after cooldown: ${retrip.reason}. ` +
            `New deploys blocked until ${retrip.until || "manually resumed"}.`,
        };
      }
      this.log("risk_resume", `Cooldown elapsed, breaker cleared (was: ${cleared})`);
      return { pass: true };
    }

    // Still halted and nothing changed — refusing a deploy needs no disk write.
    if (dayRolled) this._save(state);
    return {
      pass: false,
      reason:
        `RISK BREAKER TRIPPED: ${state.halt_reason}. New deploys are blocked until ` +
        `${state.halted_until || "manually resumed"}. Closing and claiming remain allowed.`,
    };
  }

  /** Manual override — the only way past a no-auto-clear trip. */
  resume(note = "manual resume") {
    const state = this._load();
    state.halted = false;
    state.halt_reason = null;
    state.halted_at = null;
    state.halted_until = null;
    state.consecutive_losses = 0;
    this._save(state);
    this.log("risk_resume", note);
    return { resumed: true };
  }

  /** Force a halt (panic button from Telegram / CLI). */
  halt(reason = "manual halt") {
    const state = this._rollDay(this._load());
    state.halted = true;
    state.halt_reason = reason;
    state.halted_at = new Date(this.now()).toISOString();
    state.halted_until = null; // manual halt never auto-clears
    this._save(state);
    this.log("risk_halt", reason);
    return { halted: true, reason };
  }

  status() {
    const state = this._rollDay(this._load());
    const dd =
      state.peak_equity_sol > 0 && state.last_equity_sol != null
        ? ((state.peak_equity_sol - state.last_equity_sol) / state.peak_equity_sol) * 100
        : null;
    return {
      enabled: this.cfg.enabled,
      halted: state.halted,
      halt_reason: state.halt_reason,
      halted_until: state.halted_until,
      day: state.day,
      day_realized_pnl_sol: state.day_realized_pnl_sol,
      day_closes: state.day_closes,
      consecutive_losses: state.consecutive_losses,
      unaccounted_closes: state.unaccounted_closes || 0,
      // False means positions closed outside our close path, so day_realized_pnl_sol
      // and drawdown_pct are a LOWER bound on the real numbers. Surfaced rather than
      // hidden: a confident wrong figure is worse than an admitted gap.
      ledger_complete: (state.unaccounted_closes || 0) === 0,
      equity_sol: state.last_equity_sol,
      peak_equity_sol: state.peak_equity_sol,
      drawdown_pct: dd == null ? null : Math.round(dd * 100) / 100,
      limits: this.cfg,
      recent_trips: state.trips.slice(-5),
    };
  }
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export { DEFAULTS as RISK_DEFAULTS };
