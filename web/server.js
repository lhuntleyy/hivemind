/**
 * web/server.js — local control panel for the Hivemind agent.
 *
 * SECURITY POSTURE (read before changing anything here)
 * -----------------------------------------------------
 * This server reads and writes the wallet private key and LLM API keys. It therefore:
 *
 *   - binds to 127.0.0.1 by default; binding elsewhere REQUIRES web.token
 *   - never returns a secret value, only a masked preview and a "set / not set" flag
 *   - refuses to start on a non-loopback host without a token, rather than starting
 *     insecurely and printing a warning nobody reads
 *   - sets a restrictive CSP and no-store on every response
 *   - rejects cross-origin requests by checking Origin, so a page the operator happens
 *     to be browsing cannot drive this API from their machine (DNS-rebinding / CSRF)
 *
 * On a VPS, do NOT set host to 0.0.0.0. Use an SSH tunnel:
 *     ssh -N -L 4141:127.0.0.1:4141 user@vps
 * and open http://127.0.0.1:4141 locally.
 *
 * Dependency-free on purpose: node:http only. Adding Express here would put a
 * network-facing dependency tree in front of the wallet key.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { config, assertRiskRewardSanity } from "../config.js";
import { PROVIDER_IDS, PROVIDERS, resolveLlm, testLlmConnection } from "../llm-providers.js";
import { buildEditable, GROUPS } from "./settings-schema.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const USER_CONFIG_PATH = repoPath("user-config.json");
const ENV_PATH = repoPath(".env");

let _server = null;

// ─── secret handling ────────────────────────────────────────────

const SECRET_ENV_KEYS = new Set([
  "WALLET_PRIVATE_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
  "HELIUS_API_KEY",
  "RPC_URL",
  "TELEGRAM_BOT_TOKEN",
  "GMGN_API_KEY",
  "JUPITER_API_KEY",
  "LPAGENT_API_KEY",
  // Per-provider LLM keys, so switching provider does not mean re-pasting into
  // a generic slot and losing the previous one.
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
]);

/** Never echo a secret. Show only enough to confirm which key is loaded. */
function maskSecret(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

function readEnvFile() {
  try {
    if (!fs.existsSync(ENV_PATH)) return {};
    const out = {};
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Rewrite .env preserving comments, ordering and unmanaged keys.
 * Writes 0600 so the key is not world-readable on a shared VPS.
 */
function writeEnvValues(updates, envPath = ENV_PATH, { applyToProcess = true } = {}) {
  let lines = [];
  if (fs.existsSync(envPath)) lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  const remaining = { ...updates };
  // envcrypt marks an encrypted value with a "# encrypted" comment on the PRECEDING
  // line. Writing a plaintext value over one of those leaves the marker in place, so
  // envcrypt would then try to decrypt plaintext at boot and hand the agent garbage —
  // a wallet key that silently stops working. Drop the marker with the value.
  const isEncryptedMarker = (l) => String(l).trim().toLowerCase() === "# encrypted";

  const next = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      const key = m[1];
      const value = remaining[key];
      delete remaining[key];
      // Remove a marker we already emitted for this key.
      if (next.length > 0 && isEncryptedMarker(next[next.length - 1])) next.pop();
      next.push(`${key}=${value}`);
      continue;
    }
    next.push(line);
  }

  for (const [key, value] of Object.entries(remaining)) next.push(`${key}=${value}`);

  const body = next.join("\n").replace(/\n{3,}$/, "\n");
  fs.writeFileSync(envPath, body, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch { /* best effort on Windows */ }

  if (!applyToProcess) return;

  // Apply to the live process so the change takes effect without a restart, except
  // WALLET_PRIVATE_KEY which is cached inside tools/wallet.js and needs a restart.
  for (const [key, value] of Object.entries(updates)) {
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
}

function readUserConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch { /* fall through */ }
  return {};
}

function writeUserConfig(next) {
  const tmp = `${USER_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, USER_CONFIG_PATH);
}

// ─── settings whitelist ─────────────────────────────────────────
// Only these may be written from the browser. An open-ended setter would let the panel
// (or anything that reaches it) rewrite arbitrary config.

const EDITABLE = buildEditable(PROVIDER_IDS);

function coerce(spec, raw) {
  switch (spec.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error("not a number");
      if (spec.min != null && n < spec.min) throw new Error(`below minimum ${spec.min}`);
      if (spec.max != null && n > spec.max) throw new Error(`above maximum ${spec.max}`);
      return n;
    }
    case "boolean":
      return raw === true || raw === "true" || raw === 1 || raw === "1";
    case "enum":
      if (!spec.values.includes(String(raw))) throw new Error(`must be one of ${spec.values.join(", ")}`);
      return String(raw);
    case "string": {
      const s = String(raw).trim();
      if (spec.max && s.length > spec.max) throw new Error(`longer than ${spec.max} chars`);
      // These land in an LLM request and in JSON config; keep them boring.
      if (/[<>`\r\n]/.test(s)) throw new Error("contains disallowed characters");
      return s;
    }
    case "csv": {
      // Comma-separated list -> array. Accepts an array too, so a round-trip through
      // the API does not corrupt the value.
      const items = (Array.isArray(raw) ? raw : String(raw).split(","))
        .map((v) => String(v).trim())
        .filter(Boolean);
      for (const item of items) {
        if (item.length > 64) throw new Error(`entry "${item.slice(0, 20)}…" is too long`);
        // These land in prompts and in filter comparisons; keep them inert.
        if (/[<>`\r\n"']/.test(item)) throw new Error(`entry "${item}" contains disallowed characters`);
      }
      if (items.length > 50) throw new Error("too many entries (max 50)");
      return items;
    }
    case "url": {
      const s = String(raw).trim();
      if (!s) return "";                       // blank = fall back to the provider default
      if (spec.max && s.length > spec.max) throw new Error(`longer than ${spec.max} chars`);
      let u;
      try { u = new URL(s); } catch { throw new Error("not a valid URL"); }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("must be http or https");
      // The API key is sent to this host. Plaintext HTTP is only tolerable to a local
      // server; to anything else it would put the key on the wire in the clear.
      const local = ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(u.hostname);
      if (u.protocol === "http:" && !local) {
        throw new Error("plaintext HTTP is only allowed for a localhost endpoint — the API key would be sent unencrypted");
      }
      return s;
    }
    default:
      throw new Error("unsupported type");
  }
}

function setDeep(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

/**
 * Read a nested value by "a.b.c" or ["a","b","c"].
 *
 * Accepts both forms deliberately: it previously took a string only, and a later caller
 * passed an already-split array, which threw "dottedKey.split is not a function" and
 * turned the entire settings endpoint into a 500 — the whole Settings tab went blank
 * with no clue why.
 */
function getDeep(obj, key) {
  const parts = Array.isArray(key) ? key : String(key).split(".");
  return parts.reduce((n, k) => (n == null ? undefined : n[k]), obj);
}

// ─── request helpers ────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Constant-time token comparison. A plain === leaks length and prefix through timing,
 * which matters here because the token is the only thing between the internet and a
 * wallet key when the operator binds to a public interface.
 */
function tokenMatches(provided, expected) {
  if (!expected) return true;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reject requests carrying a cross-origin Origin header. Browsers always send Origin
 * on cross-site POSTs, so this blocks CSRF and DNS-rebinding without needing cookies.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, same-origin GET
  try {
    const url = new URL(origin);
    return isLoopback(url.hostname);
  } catch {
    return false;
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.join(PUBLIC_DIR, rel);
  // Path traversal guard: the resolved path must stay inside PUBLIC_DIR.
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(full)] || "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // No remote origins at all: everything the panel needs is inlined.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  fs.createReadStream(full).pipe(res);
}

// ─── API ────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  // ---- read-only ----
  if (route === "GET /api/status") {
    const [{ getWalletBalances }, { getMyPositions }, { riskGuard }, { getPerformanceSummary }, { getLearningStatus }] =
      await Promise.all([
        import("../tools/wallet.js"),
        import("../tools/dlmm.js"),
        import("../risk.js"),
        import("../lessons.js"),
        import("../self-learning.js"),
      ]);

    const [wallet, positions] = await Promise.all([
      getWalletBalances().catch((e) => ({ error: e.message, sol: 0, tokens: [] })),
      getMyPositions({ silent: true }).catch((e) => ({ error: e.message, positions: [], total_positions: 0 })),
    ]);

    const learning = getLearningStatus();
    let spot = null;
    try {
      const { getSpotPositions, getSpotSummary, isSpotEnabled } = await import("../venues/spot.js");
      spot = { enabled: isSpotEnabled(), ...getSpotPositions(), summary: getSpotSummary() };
    } catch (e) { spot = { enabled: false, error: e.message, open: [], closed: [] }; }

    return json(res, 200, {
      dry_run: process.env.DRY_RUN === "true",
      venue: config.venue,
      wallet: {
        address: wallet.wallet ?? null,
        sol: wallet.sol ?? 0,
        sol_price: wallet.sol_price ?? 0,
        total_usd: wallet.total_usd ?? 0,
        tokens: (wallet.tokens || []).filter((t) => (t.usd ?? 0) >= 0.5).slice(0, 20),
        error: wallet.error ?? null,
      },
      positions: positions.positions ?? [],
      performance: getPerformanceSummary(),
      risk: riskGuard.status(),
      spot,
      learning: { screens_since_deploy: learning.screens_since_deploy, starvation_at: learning.starvation_at, last_evolved_at: learning.last_evolved_at },
      playbook: learning.playbook,
      schedule: config.schedule,
      timestamp: new Date().toISOString(),
    });
  }

  if (route === "GET /api/calendar") {
    const days = Math.min(370, Math.max(1, Number(url.searchParams.get("days") || 90)));
    const { getPerformanceHistory } = await import("../lessons.js");
    const history = getPerformanceHistory({ hours: days * 24, limit: 5000 });

    // Bucket realized PnL by UTC day for the calendar heat map.
    const byDay = {};
    for (const p of history.positions || []) {
      const day = String(p.closed_at || "").slice(0, 10);
      if (!day) continue;
      if (!byDay[day]) byDay[day] = { day, pnl_usd: 0, fees_usd: 0, closes: 0, wins: 0 };
      byDay[day].pnl_usd += Number(p.pnl_usd) || 0;
      byDay[day].fees_usd += Number(p.fees_earned_usd) || 0;
      byDay[day].closes += 1;
      if (Number(p.pnl_usd) > 0) byDay[day].wins += 1;
    }
    for (const d of Object.values(byDay)) {
      d.pnl_usd = Math.round(d.pnl_usd * 100) / 100;
      d.fees_usd = Math.round(d.fees_usd * 100) / 100;
    }
    return json(res, 200, { days, calendar: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)), totals: { pnl_usd: history.total_pnl_usd, closes: history.count, win_rate_pct: history.win_rate_pct } });
  }

  if (route === "GET /api/settings") {
    const env = readEnvFile();
    const uc = readUserConfig();
    const values = {};
    for (const key of Object.keys(EDITABLE)) {
      values[key] = getDeep(uc, key) ?? liveConfigValue(key);
    }
    return json(res, 200, {
      values,
      editable: EDITABLE,
      secrets: Object.fromEntries(
        [...SECRET_ENV_KEYS].map((k) => {
          const v = env[k] || process.env[k] || "";
          return [k, { set: !!v, preview: maskSecret(v) }];
        }),
      ),
      warnings: buildWarnings(env),
      llm: (() => {
        const r = resolveLlm(uc);
        return {
          provider: r.provider, label: r.label, baseUrl: r.baseUrl,
          ok: r.ok, problems: r.problems, exampleModel: r.exampleModel, note: r.note,
          providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, {
            label: PROVIDERS[id].label, baseUrl: PROVIDERS[id].baseUrl,
            keyEnv: PROVIDERS[id].keyEnv, exampleModel: PROVIDERS[id].exampleModel,
            note: PROVIDERS[id].note ?? null,
          }])),
        };
      })(),
    });
  }

  if (route === "GET /api/swarm") {
    const { getStrategyIntel } = await import("../hivemind.js");
    return json(res, 200, getStrategyIntel());
  }

  if (route === "GET /api/decisions") {
    const { getRecentDecisions } = await import("../decision-log.js");
    return json(res, 200, getRecentDecisions({ limit: 30 }));
  }

  // ---- mutations ----
  if (req.method === "POST" && !originAllowed(req)) {
    return json(res, 403, { error: "cross-origin request rejected" });
  }

  if (route === "POST /api/settings") {
    const body = await readBody(req);
    const uc = readUserConfig();
    const applied = {};
    const errors = {};

    for (const [key, raw] of Object.entries(body.values || {})) {
      const spec = EDITABLE[key];
      if (!spec) { errors[key] = "not an editable setting"; continue; }
      try {
        const value = coerce(spec, raw);
        setDeep(uc, key, value);
        applied[key] = value;
      } catch (e) {
        errors[key] = e.message;
      }
    }

    if (Object.keys(applied).length > 0) {
      writeUserConfig(uc);
      const { reloadScreeningThresholds } = await import("../config.js");
      reloadScreeningThresholds();
      log("web", `Settings updated from control panel: ${Object.keys(applied).join(", ")}`);
    }
    return json(res, Object.keys(errors).length ? 207 : 200, {
      applied,
      errors,
      note: "Interval and model changes take effect on the next cycle. Wallet key changes need a restart.",
    });
  }

  if (route === "POST /api/secrets") {
    const body = await readBody(req);
    const updates = {};
    for (const [key, value] of Object.entries(body.secrets || {})) {
      if (!SECRET_ENV_KEYS.has(key)) return json(res, 400, { error: `${key} is not a managed secret` });
      const v = String(value ?? "");
      // Refuse the mask back: the UI shows a preview, and a careless save would
      // otherwise write "sk-a****cdef" into .env as if it were the real key.
      if (/^\*+$/.test(v) || /\*{4,}/.test(v)) continue;
      if (/[\r\n]/.test(v)) return json(res, 400, { error: `${key} contains a newline` });
      updates[key] = v;
    }
    if (Object.keys(updates).length === 0) return json(res, 200, { applied: [], note: "nothing to change" });
    writeEnvValues(updates);
    log("web", `Secrets updated from control panel: ${Object.keys(updates).join(", ")}`);
    return json(res, 200, {
      applied: Object.keys(updates),
      restart_required: Object.keys(updates).includes("WALLET_PRIVATE_KEY") || Object.keys(updates).includes("RPC_URL"),
      note: "Written to .env with 0600 permissions. Wallet/RPC changes need a process restart.",
    });
  }

  if (route === "POST /api/risk/halt") {
    const body = await readBody(req);
    const { riskGuard } = await import("../risk.js");
    return json(res, 200, riskGuard.halt(String(body.reason || "halted from control panel").slice(0, 200)));
  }

  if (route === "POST /api/risk/resume") {
    const { riskGuard } = await import("../risk.js");
    return json(res, 200, riskGuard.resume("resumed from control panel"));
  }

  if (route === "POST /api/llm/test") {
    // Proves the endpoint resolves and the key authenticates BEFORE a cycle depends on
    // it. Without this, a wrong provider/key pair first surfaces as a raw 401 in the
    // middle of a management run, after the agent has already decided to act.
    const body = await readBody(req).catch(() => ({}));
    const uc = readUserConfig();
    // Allow testing an unsaved key without persisting it first.
    const probe = { ...uc };
    if (body.provider) probe.llmProvider = String(body.provider);
    if (body.baseUrl) probe.llmBaseUrl = String(body.baseUrl);
    if (body.apiKey && !/\*{4,}/.test(String(body.apiKey))) probe.llmApiKey = String(body.apiKey);

    const result = await testLlmConnection(probe);
    // Never echo the key back, even inside an error string from the vendor.
    if (result.error && probe.llmApiKey) {
      result.error = String(result.error).split(probe.llmApiKey).join("<key>");
    }
    return json(res, 200, result);
  }

  if (route === "POST /api/spot/close") {
    const body = await readBody(req);
    const { closeSpot } = await import("../venues/spot.js");
    const id = String(body.id || "").slice(0, 80);
    if (!id) return json(res, 400, { error: "id is required" });
    return json(res, 200, await closeSpot(id, "closed from control panel"));
  }

  if (route === "POST /api/swarm/pull") {
    const { pullHiveMindLessons } = await import("../hivemind.js");
    const lessons = await pullHiveMindLessons();
    return json(res, 200, { pulled: lessons?.length ?? 0 });
  }

  return json(res, 404, { error: `no route for ${route}` });
}

/**
 * Resolve a panel setting to its current live value.
 *
 * DERIVED, not hand-listed. This used to be a manual key -> config.section.key table;
 * when the schema grew to 152 entries the table went stale and nine settings rendered
 * as empty inputs — which in this codebase is indistinguishable from "not configured",
 * the exact signature of the risk-control bugs this project keeps producing.
 *
 * Panel names that differ from config names are aliased explicitly; everything else is
 * found by searching the config tree in a fixed section order.
 */
const CONFIG_ALIASES = {
  screeningSource:  ["screening", "source"],
  llmProvider:      ["llm", "provider"],
  llmBaseUrl:       ["llm", "baseUrl"],
  hiveMindPullMode: ["hiveMind", "pullMode"],
  strategy:         ["strategy", "strategy"],
};

// Fixed order so a leaf name present in two sections resolves deterministically.
const CONFIG_SECTION_ORDER = [
  "risk", "management", "screening", "schedule", "llm", "strategy",
  "spot", "venue", "darwin", "gmgn", "hiveMind", "indicators", "web", "pnl", "opportunity",
];

function liveConfigValue(key) {
  if (key.includes(".")) {
    const v = getDeep(config, key);
    return v === undefined ? null : v;
  }
  if (CONFIG_ALIASES[key]) {
    const v = getDeep(config, CONFIG_ALIASES[key]);
    return v === undefined ? null : v;
  }
  for (const section of CONFIG_SECTION_ORDER) {
    const bucket = config[section];
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, key)) {
      const v = bucket[key];
      return v === undefined ? null : v;
    }
  }
  return null;
}

function buildWarnings(env) {
  const w = [];
  if (process.env.DRY_RUN !== "true") {
    w.push({ level: "warn", text: "LIVE MODE — transactions are real. Set DRY_RUN=true to simulate." });
  }
  if (!env.WALLET_PRIVATE_KEY && !process.env.WALLET_PRIVATE_KEY) {
    w.push({ level: "error", text: "No wallet key configured. The agent cannot trade." });
  }
  if (!env.HELIUS_API_KEY && !process.env.HELIUS_API_KEY) {
    w.push({ level: "warn", text: "HELIUS_API_KEY missing — wallet balances will read as zero, which also blanks the risk breaker's equity feed." });
  }
  if (!config.risk.enabled) {
    w.push({ level: "error", text: "Risk breaker is DISABLED. Nothing will stop a losing streak." });
  }
  const sharing = config.hiveMind.share || {};
  if (sharing.poolAddress || sharing.poolName || sharing.baseMint) {
    w.push({ level: "warn", text: "Position identity is being shared with the swarm. Others can reconstruct which pools this wallet is in." });
  }
  w.push(...assertRiskRewardSanity(config));
  return w;
}

// ─── lifecycle ──────────────────────────────────────────────────

export function startControlPanel() {
  if (!config.web?.enabled) return null;
  if (_server) return _server;

  const host = config.web.host || "127.0.0.1";
  const port = Number(config.web.port || 4141);
  const token = config.web.token;

  if (!isLoopback(host) && !token) {
    log(
      "web_error",
      `Refusing to bind the control panel to ${host} without web.token — it exposes wallet and LLM keys. ` +
      `Set web.token (or HIVEMIND_WEB_TOKEN), or keep host at 127.0.0.1 and use an SSH tunnel.`,
    );
    return null;
  }

  _server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (token && !tokenMatches(req.headers["x-hivemind-token"] || url.searchParams.get("token"), token)) {
        return json(res, 401, { error: "unauthorized" });
      }

      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      return serveStatic(res, url.pathname);
    } catch (error) {
      log("web_error", `${req.method} ${req.url}: ${error.message}`);
      if (!res.headersSent) json(res, 500, { error: error.message });
    }
  });

  _server.listen(port, host, () => {
    log("web", `Control panel on http://${host}:${port}${token ? " (token required)" : ""}`);
  });
  _server.on("error", (e) => log("web_error", `Control panel failed: ${e.message}`));
  return _server;
}

export function stopControlPanel() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

export { EDITABLE, maskSecret, coerce, isLoopback, tokenMatches, originAllowed, setDeep, getDeep, writeEnvValues };
