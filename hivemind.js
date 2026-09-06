/**
 * hivemind.js — swarm layer, PULL-ONLY.
 *
 * Rewritten from Meridian's original. Behavioural differences that matter:
 *
 *  1. PULL ONLY. Every push is gated on config.hiveMind.share.*, all false by default.
 *     With the defaults, this module never issues a write request of any kind — we
 *     consume other agents' lessons and publish nothing about our own positions.
 *
 *  2. Evidence ranking instead of the server's `score`. On the live feed every score
 *     sits in 57.28..57.52 while distinctAgents spans 8..280; the original sorted on
 *     the former and discarded the latter.
 *
 *  3. Junk filtering. The live feed carries `TEST-SOL ... Reason: test close` records
 *     backed by 176 distinct agents. Unfiltered, three of the four lessons Meridian
 *     injects into the SCREENER prompt are test data.
 *
 *  4. Injection defence + fencing. Shared text is rendered inside a nonce-fenced
 *     block marked as data, never inside the trusted LESSONS LEARNED section.
 *
 * The public API is kept source-compatible with the original so callers elsewhere in
 * the repo do not need to change.
 */

import fs from "fs";
import crypto from "crypto";
import { log } from "./logger.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { HiveClient, fileStore } from "./hive/hive-client.js";
import { mineStrategies, formatStrategyIntel } from "./hive/strategy-miner.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const CACHE_PATH = repoPath("hivemind-cache.json");

let _syncTimer = null;
let _client = null;

// ─── agent id ───────────────────────────────────────────────────

export function ensureAgentId() {
  let userConfig = {};
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    }
  } catch { /* fall through to generation */ }

  if (userConfig.agentId) {
    config.hiveMind.agentId = userConfig.agentId;
    return userConfig.agentId;
  }

  const agentId = `agt_${crypto.randomBytes(12).toString("hex")}`;
  userConfig.agentId = agentId;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  config.hiveMind.agentId = agentId;
  log("hivemind", `Generated agentId ${agentId}`);
  return agentId;
}

export function isHiveMindEnabled() {
  return !!(config.hiveMind?.url && config.hiveMind?.apiKey);
}

/** True when at least one share flag is on — i.e. we would transmit something. */
export function isSharingEnabled() {
  const s = config.hiveMind?.share || {};
  return !!(s.lessons || s.performance);
}

function client() {
  if (!_client) {
    _client = new HiveClient({
      baseUrl: config.hiveMind.url,
      apiKey: config.hiveMind.apiKey,
      agentId: config.hiveMind.agentId || ensureAgentId(),
      store: fileStore(fs, CACHE_PATH),
      config: {
        share: config.hiveMind.share,
        staleAfterMinutes: config.hiveMind.staleAfterMinutes,
      },
      log,
    });
  }
  return _client;
}

// ─── pull ───────────────────────────────────────────────────────

export async function pullHiveMindLessons(limit = 50) {
  if (!isHiveMindEnabled()) return null;
  const cache = await client().pullLessons({ limit });
  return cache?.lessons ?? null;
}

/**
 * Presets are advertised by the API but the live endpoint returns an empty array,
 * so this is a no-op kept for API compatibility. Strategy intelligence is recovered
 * from lesson TAGS instead — see getStrategyIntel().
 */
export async function pullHiveMindPresets() {
  return [];
}

export function getHiveMindPullMode() {
  return config.hiveMind?.pullMode === "manual" ? "manual" : "auto";
}

/**
 * Swarm block for the system prompt. Returns a self-fencing block, or null when the
 * cache is empty or stale. Callers must NOT wrap it in a trusted-looking header.
 */
export function getSharedLessonsForPrompt({ agentType = "GENERAL" } = {}) {
  if (!isHiveMindEnabled()) return null;
  try {
    return client().getPromptBlock({ agentType });
  } catch (error) {
    log("hivemind_warn", `prompt block failed: ${error.message}`);
    return null;
  }
}

/** Operator view: feature bands + mined strategy vocabulary. Not for the prompt. */
export function getStrategyIntel() {
  try {
    return client().getIntel();
  } catch {
    return { intel: null, bands: [], stats: null, pulledAt: null };
  }
}

export function formatStrategyIntelText() {
  const { intel, pulledAt } = getStrategyIntel();
  if (!intel) return "No swarm data pulled yet. Run /swarm-sync or wait for the next cycle.";
  return `${formatStrategyIntel(intel)}\n\nPulled at: ${pulledAt || "never"}`;
}

// ─── lifecycle ──────────────────────────────────────────────────

export async function bootstrapHiveMind() {
  if (!isHiveMindEnabled()) return null;
  ensureAgentId();

  // Registration is a WRITE that publishes our existence and capability flags. In
  // pull-only mode we skip it: the pull endpoint accepts any agentId, so registering
  // buys nothing and costs a fingerprint.
  if (getHiveMindPullMode() === "auto") {
    await pullHiveMindLessons().catch(() => null);
  }

  const mode = isSharingEnabled() ? "pull+push" : "PULL-ONLY";
  log("hivemind", `Swarm ready (${mode}, agentId ${config.hiveMind.agentId})`);
  return { enabled: true, agentId: config.hiveMind.agentId, pullMode: getHiveMindPullMode(), sharing: isSharingEnabled() };
}

export function startHiveMindBackgroundSync() {
  if (!isHiveMindEnabled() || _syncTimer) return null;
  const minutes = Math.max(5, Number(config.hiveMind.pullIntervalMinutes ?? 30));
  _syncTimer = setInterval(() => {
    if (getHiveMindPullMode() !== "auto") return;
    pullHiveMindLessons().catch(() => null);
  }, minutes * 60_000);
  if (typeof _syncTimer.unref === "function") _syncTimer.unref();
  log("hivemind", `Background swarm pull every ${minutes}m`);
  return _syncTimer;
}

export function stopHiveMindBackgroundSync() {
  if (_syncTimer) {
    clearInterval(_syncTimer);
    _syncTimer = null;
  }
}

// ─── push (opt-in only) ─────────────────────────────────────────

export async function pushHiveLesson(lesson) {
  if (!config.hiveMind?.share?.lessons) return null;   // default: never
  return client().pushLesson(lesson);
}

export async function pushHivePerformanceEvent(perf) {
  if (!config.hiveMind?.share?.performance) return null; // default: never
  return client().pushPerformance(perf);
}

/** Kept for API compatibility; registration is a write we do not perform. */
export async function registerHiveMindAgent() {
  return null;
}
