import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

/**
 * Read user-config.json with an error a human can act on.
 *
 * A bare JSON.parse here — which is what this used to be — turns one missing comma into
 * an unhandled SyntaxError that takes down the agent, every CLI command and the whole
 * test suite, with a stack trace pointing at config.js:14 rather than at the line the
 * operator actually mistyped.
 *
 * It still FAILS rather than falling back to defaults: a malformed config means the
 * limits the operator intended are not loaded, and quietly trading on defaults is worse
 * than not starting.
 */
function readUserConfigOrExplain(filePath) {
  if (!fs.existsSync(filePath)) return {};

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }

  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top level must be a JSON object");
    }
    return parsed;
  } catch (error) {
    // Locate the offending line so the message points at the typo, not at this file.
    const posMatch = /position (\d+)/.exec(error.message);
    let where = "";
    let excerpt = "";
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const before = raw.slice(0, pos);
      const line = before.split(/\r?\n/).length;
      const column = pos - (before.lastIndexOf("\n") + 1);
      where = ` at line ${line}, column ${column}`;

      const lines = raw.split(/\r?\n/);
      const from = Math.max(0, line - 3);
      excerpt = lines
        .slice(from, line + 1)
        .map((text, i) => {
          const n = from + i + 1;
          return `${n === line ? " >" : "  "} ${String(n).padStart(4)} | ${text}`;
        })
        .join("\n");
    }

    throw new Error(
      `user-config.json is not valid JSON${where}.\n\n${excerpt}\n\n` +
      `  ${error.message}\n\n` +
      `The most common cause is a missing or trailing comma between entries.\n` +
      `Validate it with:  node -e "JSON.parse(require('fs').readFileSync('user-config.json','utf8'))"\n` +
      `File: ${filePath}`,
    );
  }
}

const u = readUserConfigOrExplain(USER_CONFIG_PATH);
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

// GMGN's own tooling stores its key in ~/.config/gmgn/.env. Read it as a last resort so
// an operator who already set GMGN up does not have to copy the key into a second place.
// Only GMGN_* names are lifted — this file may also hold GMGN_PRIVATE_KEY (a trading
// key) and we deliberately do NOT load that: this build never signs a GMGN transaction.
if (!process.env.GMGN_API_KEY) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      const gmgnEnvPath = `${home}/.config/gmgn/.env`;
      if (fs.existsSync(gmgnEnvPath)) {
        for (const line of fs.readFileSync(gmgnEnvPath, "utf8").split(/\r?\n/)) {
          const m = line.match(/^\s*(GMGN_API_KEY)\s*=\s*(.+?)\s*$/);
          if (m) {
            process.env.GMGN_API_KEY = m[2].replace(/^["']|["']$/g, "");
            break;
          }
        }
      }
    }
  } catch { /* optional convenience only */ }
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

// Default paper balance for a dry run: enough to fund every position the risk caps
// allow, plus gas, and nothing more.
//
// Derived rather than a round number, because computeDeployAmount scales position size
// with the wallet. A flat default of 5 SOL made a dry run deploy 1.68 SOL on a wallet
// that would really deploy the 0.5 floor — so the rehearsal exercised a trade size the
// operator will never place, against pools screened for a different size of position.
// This funds exactly maxPositions × deployAmountSol, so the simulated trade matches the
// first real one and the maxPositions cap is still reachable.
// toFixed, because 0.3 * 3 + 0.2 is 1.0999999999999999 in IEEE-754 and that figure ends
// up in the startup banner and on the dashboard.
const DEFAULT_PAPER_WALLET_SOL = Number(
  ((Number(u.deployAmountSol ?? 0.5) * Number(u.maxPositions ?? 3)) + Number(u.gasReserve ?? 0.2)).toFixed(4),
);

export const config = {
  // ─── Dry run ─────────────────────────────
  // A dry run that reports "insufficient SOL" has tested nothing. The code guard was
  // already bypassed under DRY_RUN, but the model still reads the real balance out of
  // the goal header and get_wallet_balance, and refuses on its own — so the deploy path
  // was unreachable for anyone whose wallet was not already funded.
  //
  // paperWalletSol replaces ONLY the SOL figure, and only while DRY_RUN=true. The real
  // balance is still carried alongside as real_sol, every consumer is told the number is
  // simulated, and the risk ledger is fed real_sol so a rehearsal cannot set a fake
  // all-time equity peak that trips the drawdown breaker on the first live cycle.
  dryRun: {
    paperWalletSol: Number(u.dryRunPaperWalletSol ?? DEFAULT_PAPER_WALLET_SOL),
  },
  // ─── Risk limits ─────────────────────────
  // Per-position caps (inherited from Meridian) AND the portfolio breaker live in one
  // object on purpose: they were briefly split into two `risk:` keys in the same object
  // literal, and the second silently shadowed the first — which left maxPositions and
  // maxDeployAmount undefined, disabling both caps with no error anywhere. Keep them
  // together, and see test/config-risk.test.js which asserts every one of them is a
  // real number at boot.
  risk: {
    // per-position
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    // portfolio breaker — stops a losing SEQUENCE, not a losing trade
    enabled:              u.risk?.enabled              ?? true,
    maxDailyLossSol:      u.risk?.maxDailyLossSol      ?? 0.5,
    maxDailyLossPct:      u.risk?.maxDailyLossPct      ?? 12,
    maxConsecutiveLosses: u.risk?.maxConsecutiveLosses ?? 4,
    maxDrawdownPct:       u.risk?.maxDrawdownPct       ?? 25,
    cooldownMinutes:      u.risk?.cooldownMinutes      ?? 240,
    lossNoiseFloorSol:    u.risk?.lossNoiseFloorSol    ?? 0.002,
    // Hard cap on what a relay-built deploy transaction may cost us, on top of the
    // deploy amount itself. Guards the zap-in blind-signing path.
    relayOverheadSol:     u.risk?.relayOverheadSol     ?? 0.05,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    // meteora = Meteora pool-discovery API; gmgn = GMGN rank + KOL + indicator pipeline
    // (needs GMGN_API_KEY). Only affects CANDIDATE SOURCING, never execution.
    source:            u.screeningSource    ?? "meteora",
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    // Meridian shipped -50 here while its README documented -15. Paired with
    // takeProfitPct=5 that is a 1:10 payoff against you — break-even needs a 90.9% win
    // rate. Defaulting to the documented -15 (1:3, break-even 75%); still unfavourable,
    // which is why assertRiskRewardSanity() warns loudly at boot. Override deliberately.
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -15,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Max acceptable slippage on every Jupiter swap this agent makes (entry, exit and
    // the auto base->SOL after a close). Clamped to [50, 500] bps in tools/wallet.js.
    swapSlippageBps:       u.swapSlippageBps       ?? 150,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    // 2 decimals: some OpenAI-compatible gateways validate the precision and reject
    // more (LiteLLM in front of GLM returns a 400 naming the parameter). agent.js
    // rounds defensively too, but shipping a value that fails is not a default.
    temperature: u.temperature ?? 0.37,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    // Provider / endpoint / key. Resolved live by llm-providers.js on every request —
    // these are the stored preference, not the value agent.js reads at call time.
    provider: nonEmptyString(u.llmProvider, process.env.LLM_PROVIDER, "openrouter"),
    baseUrl:  nonEmptyString(u.llmBaseUrl, process.env.LLM_BASE_URL),
    // Per-role models. Left null so llm-providers.js can supply a provider-appropriate
    // default; a hard-coded OpenRouter model id is a guaranteed 404 on any other vendor.
    managementModel: nonEmptyString(u.managementModel, process.env.LLM_MODEL),
    screeningModel:  nonEmptyString(u.screeningModel,  process.env.LLM_MODEL),
    generalModel:    nonEmptyString(u.generalModel,    process.env.LLM_MODEL),
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  // ─── Swarm (HiveMind) — PULL-ONLY by default ────────────────
  // We consume other agents' lessons but publish nothing. Every share flag is
  // opt-in; with all of them false the client never issues a write request.
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
    share: {
      lessons:     u.hiveMind?.share?.lessons     ?? false,
      performance: u.hiveMind?.share?.performance ?? false,
      poolAddress: u.hiveMind?.share?.poolAddress ?? false,
      poolName:    u.hiveMind?.share?.poolName    ?? false,
      baseMint:    u.hiveMind?.share?.baseMint    ?? false,
    },
    pullIntervalMinutes: Number(u.hiveMind?.pullIntervalMinutes ?? 30),
    staleAfterMinutes:   Number(u.hiveMind?.staleAfterMinutes ?? 180),
  },


  // ─── GMGN (spot venue + fee source + KOL/indicator screening) ────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    // gmgn = use GMGN /v1/token/info total_fee for global_fees_sol (minTokenFeesSol gate); jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
    interval: gmgnValue("interval", "gmgnInterval", "5m"),
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    requestDelayMs: gmgnValue("requestDelayMs", "gmgnRequestDelayMs", 350),
    maxRetries: gmgnValue("maxRetries", "gmgnMaxRetries", 2),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    klineResolution: gmgnValue("klineResolution", "gmgnKlineResolution", "5m"),
    klineLookbackMinutes: gmgnValue("klineLookbackMinutes", "gmgnKlineLookbackMinutes", 60),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minSmartDegenCount: gmgnValue("minSmartDegenCount", "gmgnMinSmartDegenCount", 1),
    requireKol: gmgnValue("requireKol", "gmgnRequireKol", true),
    minKolCount: gmgnValue("minKolCount", "gmgnMinKolCount", 1),
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
    indicatorInterval: gmgnValue("indicatorInterval", "gmgnIndicatorInterval", "15_MINUTE"),
    indicatorRules: (() => {
      const r = gmgnUserConfig.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  // ─── Agent Meridian API + PnL poller + opportunity poller ────
  // These were lost during an earlier config edit; config.pnl.pollIntervalSec is read
  // by startCronJobs, so their absence crashed the agent at boot. See
  // test/boot.test.js, which now starts the real cron path.
  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── Spot venue (GMGN signals, Jupiter execution) ────────────
  // Inverted payoff vs LP on purpose: tight stop, wide target. LP on this agent's own
  // swarm data wins ~2.6% and loses ~15%, which needs an ~85% win rate to break even.
  // Spot cuts at -8% and lets winners run, so the same signal quality is survivable.
  spot: {
    maxPositions:       u.spot?.maxPositions       ?? 3,
    sizeSol:            u.spot?.sizeSol            ?? 0.25,
    maxSizeSol:         u.spot?.maxSizeSol         ?? 2,
    stopLossPct:        u.spot?.stopLossPct        ?? -8,
    takeProfitPct:      u.spot?.takeProfitPct      ?? 40,
    trailingTriggerPct: u.spot?.trailingTriggerPct ?? 15,
    trailingDropPct:    u.spot?.trailingDropPct    ?? 8,
    maxHoldMinutes:     u.spot?.maxHoldMinutes     ?? 360,
    // Wider than LP: spot entries are thinner pairs and a failed exit is worse than a
    // costly one. Still clamped to 500 bps inside tools/wallet.js.
    slippageBps:        u.spot?.slippageBps        ?? 300,
    minSolReserve:      u.spot?.minSolReserve      ?? 0.05,
    monitorIntervalSec: u.spot?.monitorIntervalSec ?? 30,
    // Entry is attempted far less often than exits are checked: a missed entry costs
    // an opportunity, a missed exit costs money.
    entryIntervalSec:   u.spot?.entryIntervalSec   ?? 300,
  },

  // ─── Execution venues ────────────────────────────────────────
  // LP (Meteora DLMM) is the only venue enabled by default. Spot (GMGN) is wired
  // but off: running two execution engines at once doubles the surface where a bug
  // touches money. Turn it on deliberately, after paper-trading it.
  venue: {
    lp:   u.venue?.lp   ?? true,
    spot: u.venue?.spot ?? false,
  },

  // ─── Local control panel ─────────────────────────────────────
  // Binds to loopback by default. This UI reads and writes wallet/LLM secrets, so
  // exposing it on 0.0.0.0 without a reverse proxy + auth would publish them.
  web: {
    enabled: u.web?.enabled ?? true,
    host:    u.web?.host    ?? "127.0.0.1",
    port:    Number(u.web?.port ?? 4141),
    // Required when host is not loopback. Sent as the x-hivemind-token header.
    token:   nonEmptyString(u.web?.token, process.env.HIVEMIND_WEB_TOKEN),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    // Reloaded here so a paper-balance change from the panel applies to the next
    // cycle. Every other setting on this path does; leaving one out is how a control
    // ends up looking wired while doing nothing until the next restart.
    if (numericConfig(fresh.dryRunPaperWalletSol) != null) {
      config.dryRun.paperWalletSol = numericConfig(fresh.dryRunPaperWalletSol);
    }
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}

/**
 * Warn at boot when the configured exits imply a win rate the strategy is unlikely to
 * reach. This does not block anything — it is the operator's money — but a payoff ratio
 * is the single easiest thing to get catastrophically wrong while every individual
 * setting looks reasonable, and nothing in Meridian ever said it out loud.
 *
 * @returns {Array<{level:string,text:string}>}
 */
export function assertRiskRewardSanity(cfg = config) {
  const out = [];
  const sl = Math.abs(Number(cfg.management.stopLossPct));
  const tp = Number(cfg.management.takeProfitPct);
  if (!Number.isFinite(sl) || !Number.isFinite(tp) || tp <= 0) return out;

  const ratio = sl / tp;
  const breakEven = (sl / (sl + tp)) * 100;
  if (ratio >= 3) {
    out.push({
      level: ratio >= 5 ? "error" : "warn",
      text:
        `Exit asymmetry: stop loss ${-sl}% vs take profit +${tp}% is 1:${ratio.toFixed(1)} against you. ` +
        `Break-even needs a ${breakEven.toFixed(1)}% win rate before swap fees. ` +
        `Raise takeProfitPct or tighten stopLossPct.`,
    });
  }

  // Trailing TP that arms below the swap round-trip cost books guaranteed small losses.
  if (cfg.management.trailingTakeProfit) {
    const trigger = Number(cfg.management.trailingTriggerPct);
    if (Number.isFinite(trigger) && trigger < 1.2) {
      out.push({
        level: "warn",
        text:
          `trailingTriggerPct ${trigger}% is at or below the ~1% Jupiter round-trip swap cost — ` +
          `trailing exits at that level book a loss after fees.`,
      });
    }
  }
  return out;
}
