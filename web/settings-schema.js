/**
 * web/settings-schema.js — the whitelist of settings the control panel may write.
 *
 * WHY A SCHEMA FILE
 * -----------------
 * The panel previously exposed 55 of the 163 settable config leaves, which pushed the
 * operator into hand-editing user-config.json — and hand-editing JSON is exactly how a
 * missing comma took down the whole agent. A settings UI that is not complete enough to
 * use is not a safety feature, it is a detour around one.
 *
 * Every entry is grouped so the UI can render sections instead of a wall of 160 inputs,
 * and every entry carries bounds, because this is a network-facing writer for a process
 * that trades money.
 *
 * DELIBERATELY NOT EXPOSED (and why):
 *   risk.enabled          disarming the breaker from a web form is the one click that
 *                         removes all portfolio protection. Edit config to do it.
 *   web.host/port/token   changing the bind from inside the UI can lock you out of the
 *                         UI, or publish it. Requires a restart anyway.
 *   hiveMind.url/apiKey   pointing the swarm feed at an arbitrary host from a form is a
 *                         remote-content injection vector.
 *   dryRun                config.js applies it with `||=`, so an existing env var wins.
 *                         A toggle that appears to disarm live trading without doing so
 *                         is the most dangerous control possible.
 *   *.apiKey              secrets go through /api/secrets into .env, never into
 *                         user-config.json where they would sit in plaintext beside
 *                         non-secret settings.
 */

const num = (min, max, group, label, help) => ({ type: "number", min, max, group, label, help });
const bool = (group, label, help) => ({ type: "boolean", group, label, help });
const str = (max, group, label, help) => ({ type: "string", max, group, label, help });
const enu = (values, group, label, help) => ({ type: "enum", values, group, label, help });
const list = (group, label, help) => ({ type: "csv", group, label, help });

export const GROUPS = [
  "Risk breaker",
  "Position sizing",
  "Exits",
  "Screening",
  "Token safety",
  "Cooldowns",
  "LP strategy",
  "Spot venue",
  "GMGN screening",
  "GMGN safety limits",
  "Indicators",
  "Learning",
  "Swarm",
  "Schedule",
  "LLM",
];

export function buildEditable(providerIds) {
  return {
    // ── Risk breaker ────────────────────────────────────────────
    "risk.maxDailyLossSol":      num(0, 1000, "Risk breaker", "Max daily loss (SOL)", "Realized loss in one UTC day that halts new deploys."),
    "risk.maxDailyLossPct":      num(0, 100, "Risk breaker", "Max daily loss (%)", "As a share of the day's opening equity. Whichever trips first wins."),
    "risk.maxConsecutiveLosses": num(0, 50, "Risk breaker", "Max consecutive losses", "0 disables this rule."),
    "risk.maxDrawdownPct":       num(0, 100, "Risk breaker", "Max drawdown (%)", "From the all-time equity peak."),
    "risk.cooldownMinutes":      num(0, 10080, "Risk breaker", "Cooldown (min)", "How long a trip lasts before it can auto-clear."),
    "risk.lossNoiseFloorSol":    num(0, 1, "Risk breaker", "Loss noise floor (SOL)", "Closes smaller than this do not advance the loss streak."),
    "risk.relayOverheadSol":     num(0, 5, "Risk breaker", "Relay overhead cap (SOL)", "Max SOL a relay-built deploy may cost beyond the deploy amount."),

    // ── Position sizing ─────────────────────────────────────────
    maxPositions:    num(1, 20, "Position sizing", "Max open LP positions"),
    deployAmountSol: num(0.05, 1000, "Position sizing", "Base deploy (SOL)", "Floor for the compounding formula."),
    maxDeployAmount: num(0.05, 10000, "Position sizing", "Max per position (SOL)"),
    positionSizePct: num(0.01, 1, "Position sizing", "Position size fraction", "Of deployable balance. 0.35 = 35%."),
    gasReserve:      num(0, 10, "Position sizing", "Gas reserve (SOL)"),
    minSolToOpen:    num(0, 100, "Position sizing", "Min wallet SOL to open"),
    solMode:         bool("Position sizing", "Report in SOL, not USD"),

    // ── Exits ───────────────────────────────────────────────────
    stopLossPct:            num(-100, 0, "Exits", "Stop loss (%)", "Negative. Paired with take profit this sets your break-even win rate."),
    takeProfitPct:          num(0, 1000, "Exits", "Take profit (%)"),
    trailingTakeProfit:     bool("Exits", "Trailing take profit"),
    trailingTriggerPct:     num(0, 100, "Exits", "Trailing arms at (%)"),
    trailingDropPct:        num(0.1, 100, "Exits", "Trailing drop (%)"),
    outOfRangeWaitMinutes:  num(0, 1440, "Exits", "Out-of-range wait (min)"),
    outOfRangeBinsToClose:  num(0, 500, "Exits", "Bins past range to force close"),
    minFeePerTvl24h:        num(0, 1000, "Exits", "Min fee/TVL 24h (%)", "Below this, a position is closed for low yield."),
    minAgeBeforeYieldCheck: num(0, 10080, "Exits", "Min age before yield check (min)"),
    minClaimAmount:         num(0, 10000, "Exits", "Min fees to claim (USD)"),
    autoSwapAfterClaim:     bool("Exits", "Auto-swap base to SOL after claim"),
    swapSlippageBps:        num(50, 500, "Exits", "Swap slippage (bps)", "Clamped to 50-500. 150 = 1.5%."),
    pnlSanityMaxDiffPct:    num(0, 100, "Exits", "PnL sanity max diff (%)"),

    // ── Screening ───────────────────────────────────────────────
    screeningSource: enu(["meteora", "gmgn"], "Screening", "Candidate source", "gmgn needs a GMGN API key; falls back to meteora without one."),
    minTvl:      num(0, 1e9, "Screening", "Min TVL (USD)"),
    maxTvl:      num(0, 1e9, "Screening", "Max TVL (USD)"),
    minVolume:   num(0, 1e9, "Screening", "Min volume"),
    minOrganic:  num(0, 100, "Screening", "Min organic score"),
    minQuoteOrganic: num(0, 100, "Screening", "Min quote organic score"),
    minHolders:  num(0, 1e6, "Screening", "Min holders"),
    minMcap:     num(0, 1e12, "Screening", "Min market cap (USD)"),
    maxMcap:     num(0, 1e12, "Screening", "Max market cap (USD)"),
    minBinStep:  num(1, 500, "Screening", "Min bin step"),
    maxBinStep:  num(1, 500, "Screening", "Max bin step"),
    minFeeActiveTvlRatio: num(0, 100, "Screening", "Min fee/active-TVL ratio"),
    timeframe:   enu(["5m", "30m", "1h", "2h", "4h", "12h", "24h"], "Screening", "Timeframe"),
    category:    enu(["trending", "top", "new"], "Screening", "Pool category"),
    loneCandidateMinDegen: num(0, 100, "Screening", "Lone-candidate min degen score"),
    minTokenAgeHours: num(0, 8760, "Screening", "Min token age (hours)"),
    maxTokenAgeHours: num(0, 8760, "Screening", "Max token age (hours)"),
    useDiscordSignals: bool("Screening", "Use Discord signals"),
    discordSignalMode: enu(["merge", "only"], "Screening", "Discord signal mode"),

    // ── Token safety ────────────────────────────────────────────
    minTokenFeesSol: num(0, 10000, "Token safety", "Min all-time fees (SOL)", "Low global fees means bundled or scam. Hard rule."),
    maxBotHoldersPct: num(0, 100, "Token safety", "Max bot holders (%)"),
    maxTop10Pct: num(0, 100, "Token safety", "Max top-10 concentration (%)"),
    excludeHighSupplyConcentration: bool("Token safety", "Exclude high supply concentration"),
    avoidPvpSymbols: bool("Token safety", "Avoid duplicate-symbol rivals"),
    blockPvpSymbols: bool("Token safety", "Hard-block duplicate symbols"),
    allowedLaunchpads: list("Token safety", "Allowed launchpads", "Comma separated. Empty means no allow-list."),
    blockedLaunchpads: list("Token safety", "Blocked launchpads", "e.g. pump.fun, letsbonk.fun"),

    // ── Cooldowns ───────────────────────────────────────────────
    oorCooldownTriggerCount: num(0, 50, "Cooldowns", "OOR closes before cooldown"),
    oorCooldownHours: num(0, 720, "Cooldowns", "OOR cooldown (hours)"),
    repeatDeployCooldownEnabled: bool("Cooldowns", "Repeat-deploy cooldown"),
    repeatDeployCooldownTriggerCount: num(0, 50, "Cooldowns", "Repeat deploys before cooldown"),
    repeatDeployCooldownHours: num(0, 720, "Cooldowns", "Repeat cooldown (hours)"),
    repeatDeployCooldownScope: enu(["pool", "token", "both"], "Cooldowns", "Cooldown scope"),
    repeatDeployCooldownMinFeeEarnedPct: num(0, 1000, "Cooldowns", "Min fee earned to count (%)"),
    minVolumeToRebalance: num(0, 1e9, "Cooldowns", "Min volume to rebalance"),

    // ── LP strategy ─────────────────────────────────────────────
    strategy: enu(["spot", "bid_ask", "curve"], "LP strategy", "Liquidity shape"),
    minBinsBelow: num(35, 1000, "LP strategy", "Min bins below", "Hard floor of 35 — below that is a 1-bin deploy."),
    maxBinsBelow: num(35, 1000, "LP strategy", "Max bins below"),
    defaultBinsBelow: num(35, 1000, "LP strategy", "Default bins below"),

    // ── Spot venue ──────────────────────────────────────────────
    "venue.lp":   bool("Spot venue", "LP venue enabled"),
    "venue.spot": bool("Spot venue", "Spot venue enabled", "Off by default. Paper-trade it first with DRY_RUN."),
    "spot.maxPositions":       num(1, 20, "Spot venue", "Max spot positions"),
    "spot.sizeSol":            num(0.01, 100, "Spot venue", "Size per entry (SOL)"),
    "spot.maxSizeSol":         num(0.01, 1000, "Spot venue", "Max size (SOL)"),
    "spot.stopLossPct":        num(-100, 0, "Spot venue", "Stop loss (%)"),
    "spot.takeProfitPct":      num(0, 10000, "Spot venue", "Take profit (%)"),
    "spot.trailingTriggerPct": num(0, 1000, "Spot venue", "Trailing arms at (%)"),
    "spot.trailingDropPct":    num(0.1, 100, "Spot venue", "Trailing drop (%)"),
    "spot.maxHoldMinutes":     num(0, 20160, "Spot venue", "Max hold (min)", "0 disables the clock rule."),
    "spot.slippageBps":        num(50, 500, "Spot venue", "Slippage (bps)"),
    "spot.minSolReserve":      num(0, 10, "Spot venue", "SOL reserve"),
    "spot.monitorIntervalSec": num(10, 3600, "Spot venue", "Exit check every (s)"),
    "spot.entryIntervalSec":   num(60, 86400, "Spot venue", "Entry attempt every (s)"),

    // ── GMGN screening ──────────────────────────────────────────
    "gmgn.interval":   enu(["1m", "5m", "1h", "6h", "24h"], "GMGN screening", "Rank interval"),
    "gmgn.orderBy":    enu(["default", "volume", "marketcap", "swaps", "liquidity"], "GMGN screening", "Order by"),
    "gmgn.direction":  enu(["desc", "asc"], "GMGN screening", "Direction"),
    "gmgn.limit":       num(1, 500, "GMGN screening", "Rank fetch limit"),
    "gmgn.enrichLimit": num(1, 200, "GMGN screening", "Enrich limit", "How many ranked tokens get the full audit. Each costs API calls."),
    "gmgn.requestDelayMs": num(0, 10000, "GMGN screening", "Request delay (ms)", "GMGN rate-limits; raise this on 429s."),
    "gmgn.maxRetries":  num(0, 10, "GMGN screening", "Max retries"),
    "gmgn.minMcap":     num(0, 1e12, "GMGN screening", "Min market cap"),
    "gmgn.maxMcap":     num(0, 1e12, "GMGN screening", "Max market cap"),
    "gmgn.minTvl":      num(0, 1e9, "GMGN screening", "Min TVL"),
    "gmgn.minVolume":   num(0, 1e9, "GMGN screening", "Min volume"),
    "gmgn.minHolders":  num(0, 1e6, "GMGN screening", "Min holders"),
    "gmgn.minTokenAgeHours": num(0, 8760, "GMGN screening", "Min token age (h)"),
    "gmgn.maxTokenAgeHours": num(0, 8760, "GMGN screening", "Max token age (h)"),
    "gmgn.feeSource":   enu(["gmgn", "jupiter"], "GMGN screening", "Fee source"),
    "gmgn.filters":    list("GMGN screening", "Filters", "e.g. renounced, frozen, not_wash_trading"),
    "gmgn.platforms":  list("GMGN screening", "Launch platforms"),

    // ── GMGN safety limits ──────────────────────────────────────
    "gmgn.requireKol":        bool("GMGN safety limits", "Require a KOL in the token"),
    "gmgn.minKolCount":       num(0, 100, "GMGN safety limits", "Min KOL count"),
    "gmgn.minSmartDegenCount": num(0, 100, "GMGN safety limits", "Min smart-degen count"),
    "gmgn.maxRugRatio":       num(0, 1, "GMGN safety limits", "Max rug ratio", "Share of the dev's past tokens that rugged."),
    "gmgn.maxTop10HolderRate": num(0, 1, "GMGN safety limits", "Max top-10 holder rate"),
    "gmgn.maxBundlerRate":    num(0, 1, "GMGN safety limits", "Max bundler rate"),
    "gmgn.maxRatTraderRate":  num(0, 1, "GMGN safety limits", "Max rat-trader rate"),
    "gmgn.maxFreshWalletRate": num(0, 1, "GMGN safety limits", "Max fresh-wallet rate"),
    "gmgn.maxDevTeamHoldRate": num(0, 1, "GMGN safety limits", "Max dev/team hold rate"),
    "gmgn.maxBotDegenRate":   num(0, 1, "GMGN safety limits", "Max bot-degen rate"),
    "gmgn.maxSniperCount":    num(0, 1000, "GMGN safety limits", "Max sniper count"),
    "gmgn.maxSniperHoldRate": num(0, 1, "GMGN safety limits", "Max sniper hold rate"),
    "gmgn.minTotalFeeSol":    num(0, 10000, "GMGN safety limits", "Min total fee (SOL)"),
    "gmgn.athFilterPct":      num(0, 100, "GMGN safety limits", "Max drop from ATH (%)"),
    "gmgn.preferredKolMinHoldPct": num(0, 100, "GMGN safety limits", "Preferred KOL min hold (%)"),
    "gmgn.dumpKolMinHoldPct": num(0, 100, "GMGN safety limits", "Dump-KOL min hold (%)"),
    "gmgn.preferredKolNames": list("GMGN safety limits", "Preferred KOL names"),
    "gmgn.dumpKolNames":      list("GMGN safety limits", "Dump KOL names"),

    // ── Indicators ──────────────────────────────────────────────
    "gmgn.indicatorFilter":   bool("Indicators", "GMGN indicator gate"),
    "gmgn.indicatorInterval": enu(["1_MINUTE", "5_MINUTE", "15_MINUTE", "1_HOUR", "4_HOUR"], "Indicators", "GMGN indicator interval"),
    "indicators.enabled":     bool("Indicators", "LP indicator confirmation"),
    "indicators.entryPreset": enu(["supertrend_break", "rsi_reversal", "bollinger_reversion", "rsi_plus_supertrend", "supertrend_or_rsi", "bb_plus_rsi", "fibo_reclaim", "fibo_reject"], "Indicators", "Entry preset"),
    "indicators.exitPreset":  enu(["supertrend_break", "rsi_reversal", "bollinger_reversion", "rsi_plus_supertrend", "supertrend_or_rsi", "bb_plus_rsi", "fibo_reclaim", "fibo_reject"], "Indicators", "Exit preset"),
    "indicators.rsiLength":   num(1, 100, "Indicators", "RSI length"),
    "indicators.rsiOversold": num(0, 100, "Indicators", "RSI oversold"),
    "indicators.rsiOverbought": num(0, 100, "Indicators", "RSI overbought"),
    "indicators.candles":     num(10, 1000, "Indicators", "Candles"),
    "indicators.requireAllIntervals": bool("Indicators", "Require all intervals to agree"),

    // ── Learning ────────────────────────────────────────────────
    "darwin.enabled":       bool("Learning", "Darwinian signal weighting"),
    "darwin.windowDays":    num(1, 365, "Learning", "Window (days)"),
    "darwin.recalcEvery":   num(1, 100, "Learning", "Recalc every N closes"),
    "darwin.boostFactor":   num(1, 3, "Learning", "Boost factor"),
    "darwin.decayFactor":   num(0.1, 1, "Learning", "Decay factor"),
    "darwin.weightFloor":   num(0.01, 1, "Learning", "Weight floor"),
    "darwin.weightCeiling": num(1, 10, "Learning", "Weight ceiling"),
    "darwin.minSamples":    num(1, 1000, "Learning", "Min samples"),

    // ── Swarm ───────────────────────────────────────────────────
    hiveMindPullMode: enu(["auto", "manual"], "Swarm", "Pull mode"),
    "hiveMind.pullIntervalMinutes": num(5, 1440, "Swarm", "Pull every (min)"),
    "hiveMind.staleAfterMinutes":   num(10, 10080, "Swarm", "Treat as stale after (min)", "Older swarm data is not injected at all."),
    "hiveMind.share.lessons":     bool("Swarm", "Share our lessons", "Off = pull-only. Nothing about this wallet is published."),
    "hiveMind.share.performance": bool("Swarm", "Share closed-position outcomes"),
    "hiveMind.share.poolAddress": bool("Swarm", "Share pool address", "Lets others reconstruct which pools this wallet is in."),
    "hiveMind.share.poolName":    bool("Swarm", "Share pool name"),
    "hiveMind.share.baseMint":    bool("Swarm", "Share base mint"),

    // ── Schedule ────────────────────────────────────────────────
    managementIntervalMin:  num(1, 1440, "Schedule", "Management cycle (min)"),
    screeningIntervalMin:   num(1, 1440, "Schedule", "Screening cycle (min)"),
    healthCheckIntervalMin: num(1, 1440, "Schedule", "Health check (min)"),

    // ── LLM ─────────────────────────────────────────────────────
    llmProvider:     enu(providerIds, "LLM", "Provider"),
    llmBaseUrl:      { type: "url", max: 300, group: "LLM", label: "Base URL", help: "Blank uses the provider default. Plaintext HTTP is refused for non-local hosts." },
    screeningModel:  str(120, "LLM", "Screening model"),
    managementModel: str(120, "LLM", "Management model"),
    generalModel:    str(120, "LLM", "General / chat model"),
    temperature:     num(0, 2, "LLM", "Temperature"),
    maxTokens:       num(256, 200000, "LLM", "Max output tokens"),
    maxSteps:        num(1, 100, "LLM", "Max tool steps per cycle"),
  };
}
