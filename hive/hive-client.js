/**
 * hive-client.js — hardened replacement for Meridian's hivemind.js pull/push layer.
 *
 * Fixes carried over the original:
 *  1. Keeps consensus metadata (distinctAgents / sampleCount / contradictory / consensus)
 *     instead of discarding it, and ranks on evidence instead of the near-constant
 *     server `score` (observed live range: 57.28..57.52).
 *  2. Renders shared lessons in a nonce-fenced UNTRUSTED block. The original injected
 *     them into the same "LESSONS LEARNED" section as the agent's own lessons, so a
 *     hostile push landed in the trusted region of the system prompt.
 *  3. Every request has a timeout and a response size cap. The original used bare
 *     fetch() with neither.
 *  4. Push is opt-in per field. The original unconditionally shipped pool address,
 *     base mint, pool name, strategy, PnL and hold time keyed to a stable agentId —
 *     enough for a third party to reconstruct and follow the wallet's positions.
 *  5. Cache carries provenance and a staleness flag, so a dead server degrades to
 *     "no swarm input" rather than silently steering on month-old data.
 *
 * Deliberately dependency-free: filesystem, config and logging are injected so this
 * module is unit-testable without a repo, a key or a network.
 */

import { ingestSwarmLessons } from "./lesson-quality.js";
import { mineStrategies } from "./strategy-miner.js";
import { fenceUntrusted } from "./prompt-armor.js";

const DEFAULTS = {
  requestTimeoutMs: 8_000,
  maxResponseBytes: 512 * 1024,
  cacheTtlMinutes: 60,
  staleAfterMinutes: 180,
  maxPromptLessons: 5,
  maxPromptBands: 4,
  minBandObservations: 3,
  // Push privacy. Default posture: contribute outcome statistics, not position identity.
  share: {
    lessons: true,
    performance: true,
    poolAddress: false,   // upstream default was effectively true
    poolName: false,
    baseMint: false,
  },
};

export class HiveClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.apiKey
   * @param {string} opts.agentId
   * @param {object} [opts.config]      overrides for DEFAULTS
   * @param {object} opts.store         { read(): object, write(obj): void } cache store
   * @param {function} [opts.fetchImpl] injectable fetch
   * @param {function} [opts.log]
   * @param {function} [opts.now]
   */
  constructor({ baseUrl, apiKey, agentId, config = {}, store, fetchImpl, log = () => {}, now = () => Date.now() } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.apiKey = String(apiKey || "");
    this.agentId = String(agentId || "");
    this.cfg = { ...DEFAULTS, ...config, share: { ...DEFAULTS.share, ...(config.share || {}) } };
    this.store = store || memoryStore();
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log;
    this.now = now;
  }

  get enabled() {
    return !!(this.baseUrl && this.apiKey && this.agentId);
  }

  // ─── transport ────────────────────────────────────────────────
  async _request(pathname, { method = "GET", body = null, query = {} } = {}) {
    if (!this.enabled) return null;

    const url = new URL(pathname, this.baseUrl + "/");
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await this.fetch(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-api-key": this.apiKey,
          ...(body != null ? { "content-type": "application/json" } : {}),
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      if (text.length > this.cfg.maxResponseBytes) {
        throw new Error(`response ${text.length}B exceeds cap ${this.cfg.maxResponseBytes}B`);
      }
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

      if (!res.ok) throw new Error(payload?.error || `HiveMind ${res.status}`);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── pull ─────────────────────────────────────────────────────
  /**
   * Pull, filter, score and cache swarm lessons. Never throws — a swarm outage must
   * not take down the trading loop.
   */
  async pullLessons({ limit = 50 } = {}) {
    if (!this.enabled) return null;
    try {
      const payload = await this._request("api/hivemind/lessons/pull", {
        query: { agentId: this.agentId, limit },
      });
      const raw = Array.isArray(payload?.lessons) ? payload.lessons : [];

      const ingest = ingestSwarmLessons(raw, { now: this.now() });
      const intel = mineStrategies(raw, { now: this.now() });

      const cache = this.store.read();
      cache.lessons = ingest.accepted.map((a) => ({
        id: a.id,
        rule: a.rule,
        score: a.score,
        parts: a.parts,
        parsed: a.parsed,
        // Role lives on the SERVER record, not in the rule text — parseRule never
        // produces one. Reading it off `parsed` (as an earlier revision did) made the
        // role filter in getPromptBlock a silent no-op.
        role: normalizeRole(a.raw?.role),
        distinctAgents: a.raw?.distinctAgents ?? null,
        sampleCount: a.raw?.sampleCount ?? null,
        consensus: a.raw?.consensus ?? null,
        contradictory: !!a.raw?.contradictory,
      }));
      cache.bands = ingest.bands;
      cache.intel = intel;
      cache.stats = ingest.stats;
      cache.rejected_sample = ingest.rejected.slice(0, 10);
      cache.pulledAt = new Date(this.now()).toISOString();
      this.store.write(cache);

      this.log(
        "hive",
        `pull: ${ingest.stats.received} received, ${ingest.stats.accepted} accepted, ` +
        `${ingest.stats.rejected} rejected, ${ingest.bands.length} feature bands, ` +
        `${intel.unknown_to_us.length} unknown strategy labels`,
      );
      return cache;
    } catch (error) {
      this.log("hive_warn", `lesson pull failed: ${error.message}`);
      return null;
    }
  }

  /** Age of the cached swarm data in minutes, or null when never pulled. */
  cacheAgeMinutes() {
    const at = this.store.read().pulledAt;
    if (!at) return null;
    const ms = this.now() - Date.parse(at);
    return Number.isFinite(ms) ? Math.floor(ms / 60_000) : null;
  }

  // ─── prompt rendering ─────────────────────────────────────────
  /**
   * Build the swarm block for the system prompt.
   *
   * Contract differences vs upstream getSharedLessonsForPrompt():
   *  - returns null when the cache is stale, instead of steering on old data
   *  - shows the evidence behind each line so the model can discount it
   *  - leads with generalised feature bands, not pool-name anecdotes
   *  - everything sits inside a nonce fence marked as data
   */
  getPromptBlock({ agentType = "GENERAL" } = {}) {
    const cache = this.store.read();
    const age = this.cacheAgeMinutes();
    if (age == null) return null;
    if (age > this.cfg.staleAfterMinutes) {
      this.log("hive_warn", `swarm cache is ${age}m old (> ${this.cfg.staleAfterMinutes}m) — not injecting`);
      return null;
    }

    const lines = [];

    const bands = (cache.bands || [])
      .filter((b) => b.observations >= this.cfg.minBandObservations && b.distinct_pools > 1)
      .slice(0, this.cfg.maxPromptBands);

    for (const b of bands) {
      lines.push(
        `PATTERN ${b.key}: win_rate ${(b.win_rate * 100).toFixed(0)}%, ` +
        `avg PnL ${b.avg_pnl_pct}%, across ${b.distinct_pools} pools / ${b.observations} obs ` +
        `(weight ${b.weight})`,
      );
    }

    const role = String(agentType || "GENERAL").toUpperCase();
    const lessons = (cache.lessons || [])
      .filter((l) => !l.role || l.role === role || role === "GENERAL")
      .slice(0, this.cfg.maxPromptLessons);

    for (const l of lessons) {
      lines.push(
        `${l.rule} [evidence ${l.score}, ${l.distinctAgents ?? "?"} agents, ` +
        `consensus ${l.consensus ?? "?"}${l.contradictory ? ", CONTRADICTED" : ""}]`,
      );
    }

    if (lines.length === 0) return null;

    const header =
      `Swarm data pulled ${age}m ago from ${cache.lessons?.length ?? 0} accepted lessons ` +
      `(${cache.stats?.rejected ?? 0} rejected as junk/unsafe). ` +
      `Note: these agents mostly run the SAME code, so agreement is correlated, not independent.`;

    return fenceUntrusted([header, ...lines], { label: "SWARM_EVIDENCE" });
  }

  /** Operator-facing view (REPL / Telegram), not for the prompt. */
  getIntel() {
    const cache = this.store.read();
    return { intel: cache.intel || null, bands: cache.bands || [], stats: cache.stats || null, pulledAt: cache.pulledAt || null };
  }

  // ─── push ─────────────────────────────────────────────────────
  /**
   * Push a derived lesson. Off unless share.lessons is explicitly enabled.
   *
   * The rule text is scrubbed of pool identity first: a lesson reading
   * "PREFER: FABLE-SOL-type pools ..." names the exact pool this wallet was in, which
   * is the same disclosure the performance push is careful to avoid.
   */
  async pushLesson(lesson) {
    if (!this.enabled || !this.cfg.share.lessons) return null;

    const rawRule = str(lesson?.rule, 400);
    if (!rawRule) return null;
    const rule = this.cfg.share.poolName ? rawRule : redactPoolNames(rawRule);

    try {
      return await this._request("api/hivemind/lessons/push", {
        method: "POST",
        body: {
          eventId: `lesson:${this.agentId}:${lesson?.id ?? this.now()}`,
          agentId: this.agentId,
          timestamp: lesson?.created_at || new Date(this.now()).toISOString(),
          lesson: {
            rule,
            tags: Array.isArray(lesson?.tags) ? lesson.tags.map((t) => str(t, 48)).filter(Boolean).slice(0, 12) : [],
            role: normalizeRole(lesson?.role),
            outcome: str(lesson?.outcome, 20) || "manual",
            sourceType: str(lesson?.sourceType, 24) || "performance",
            confidence: numOrNull(lesson?.confidence),
            metrics: {
              pnlPct: numOrNull(lesson?.pnl_pct),
              rangeEfficiency: numOrNull(lesson?.range_efficiency),
              closeReason: str(lesson?.close_reason, 160),
            },
            ...(this.cfg.share.poolAddress ? { pool: str(lesson?.pool, 64) } : {}),
          },
        },
      });
    } catch (error) {
      this.log("hive_warn", `lesson push failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Push a closed-position outcome, scrubbed according to the share policy.
   * Identity fields are omitted unless explicitly enabled.
   */
  async pushPerformance(perf) {
    if (!this.enabled || !this.cfg.share.performance) return null;
    const s = this.cfg.share;

    const event = {
      strategy: str(perf.strategy, 32),
      closeReason: str(perf.close_reason, 200) || "unknown",
      pnlPct: numOr0(perf.pnl_pct),
      feesUsd: numOr0(perf.fees_earned_usd),
      minutesHeld: numOr0(perf.minutes_held),
      // Bucketed rather than exact: the shape of the outcome is the useful part,
      // the exact size is what identifies the wallet.
      sizeBucket: sizeBucket(perf.amount_sol),
      binStep: numOrNull(perf.bin_step),
      volatility: numOrNull(perf.volatility),
      countInAdjustedWinRate: countsInWinRate(perf.close_reason),
    };
    if (s.poolAddress) event.pool = str(perf.pool, 64);
    if (s.poolName) event.poolName = str(perf.pool_name, 80);
    if (s.baseMint) event.baseMint = str(perf.base_mint, 64);

    try {
      return await this._request("api/hivemind/performance/push", {
        method: "POST",
        body: {
          eventId: str(perf.eventId, 200) || `close:${this.agentId}:${this.now()}`,
          agentId: this.agentId,
          timestamp: perf.recorded_at || new Date(this.now()).toISOString(),
          event,
        },
      });
    } catch (error) {
      this.log("hive_warn", `performance push failed: ${error.message}`);
      return null;
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────

function str(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, max);
  return s || null;
}
function numOr0(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Strip the pool label out of a lesson so the rule keeps its shape but not its identity.
 * "PREFER: FABLE-SOL-type pools (volatility=5)" -> "PREFER: <pool>-type pools (volatility=5)"
 * Also removes any bare base58 address that slipped into the text.
 */
export function redactPoolNames(rule) {
  return String(rule)
    .replace(/^(PREFER|AVOID):\s*.+?-type pools/i, "$1: <pool>-type pools")
    .replace(/^(WORKED|FAILED):\s*.+?,\s*strategy=/i, "$1: <pool>, strategy=")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "<addr>");
}

/** Server-supplied role is untrusted text; accept only the three known values. */
export function normalizeRole(role) {
  const r = String(role || "").trim().toUpperCase();
  return r === "SCREENER" || r === "MANAGER" || r === "GENERAL" ? r : null;
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export function sizeBucket(amountSol) {
  const n = Number(amountSol);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 0.5) return "<0.5";
  if (n < 1) return "0.5-1";
  if (n < 3) return "1-3";
  if (n < 10) return "3-10";
  return "10+";
}

export function countsInWinRate(closeReason) {
  const t = String(closeReason || "").toLowerCase();
  return !(t.includes("out of range") || t.includes("pumped far above range") || t.includes("oor"));
}

export function memoryStore(initial = {}) {
  let data = { lessons: [], bands: [], intel: null, stats: null, pulledAt: null, ...initial };
  return {
    read: () => JSON.parse(JSON.stringify(data)),
    write: (next) => { data = JSON.parse(JSON.stringify(next)); },
  };
}

export function fileStore(fs, filePath) {
  const empty = { lessons: [], bands: [], intel: null, stats: null, pulledAt: null };
  return {
    read() {
      try {
        if (!fs.existsSync(filePath)) return { ...empty };
        return { ...empty, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
      } catch {
        return { ...empty };
      }
    },
    write(next) {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, filePath);
    },
  };
}

export { DEFAULTS as HIVE_DEFAULTS };
