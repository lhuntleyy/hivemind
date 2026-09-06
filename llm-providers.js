/**
 * llm-providers.js — provider registry for any OpenAI-compatible LLM endpoint.
 *
 * WHY
 * ---
 * Meridian hard-coded OpenRouter as the base URL with a single `LLM_BASE_URL` escape
 * hatch, and read both URL and key ONCE at module load. That meant:
 *   - switching provider required editing .env and restarting
 *   - a key entered in the control panel did nothing until a restart
 *   - nothing validated that the model name matched the provider, so a wrong pair
 *     failed at the first tool call, mid-cycle, with a raw 401 from the vendor
 *
 * Every provider here speaks the OpenAI chat-completions shape, so `agent.js` needs no
 * per-vendor branching — only the right baseURL and key. Anthropic and Google are
 * included through their own OpenAI-compatibility endpoints rather than their native
 * SDKs, for the same reason.
 *
 * Resolution order for each field (first non-empty wins):
 *   1. explicit user-config (llmProvider / llmBaseUrl / llmApiKey)
 *   2. the provider's conventional env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...)
 *   3. the generic LLM_API_KEY / OPENROUTER_API_KEY
 */

export const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: ["OPENROUTER_API_KEY", "LLM_API_KEY"],
    keyPrefix: "sk-or-",
    exampleModel: "anthropic/claude-sonnet-4.5",
    note: "Routes to many vendors. Model names are namespaced: vendor/model.",
  },
  anthropic: {
    label: "Anthropic",
    // Anthropic's OpenAI-compatibility layer. The native /v1/messages shape is NOT
    // what the OpenAI SDK sends, so this suffix matters.
    baseUrl: "https://api.anthropic.com/v1/",
    keyEnv: ["ANTHROPIC_API_KEY", "LLM_API_KEY"],
    keyPrefix: "sk-ant-",
    exampleModel: "claude-sonnet-4-5",
    note: "Uses Anthropic's OpenAI-compatible endpoint.",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: ["OPENAI_API_KEY", "LLM_API_KEY"],
    keyPrefix: "sk-",
    exampleModel: "gpt-4.1",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: ["GROQ_API_KEY", "LLM_API_KEY"],
    keyPrefix: "gsk_",
    exampleModel: "llama-3.3-70b-versatile",
    note: "Very fast; good fit for the 3s-cadence roles.",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
    exampleModel: "deepseek-chat",
    note: "Thinking-mode models reject tool_choice; agent.js already retries without it.",
  },
  together: {
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: ["TOGETHER_API_KEY", "LLM_API_KEY"],
    exampleModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  xai: {
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: ["XAI_API_KEY", "LLM_API_KEY"],
    keyPrefix: "xai-",
    exampleModel: "grok-4",
  },
  google: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "LLM_API_KEY"],
    exampleModel: "gemini-2.5-pro",
    note: "Uses Gemini's OpenAI-compatible endpoint.",
  },
  local: {
    label: "Local (LM Studio / Ollama / vLLM)",
    baseUrl: "http://localhost:1234/v1",
    keyEnv: ["LLM_API_KEY"],
    exampleModel: "your-local-model-name",
    // Most local servers ignore the key but the OpenAI SDK refuses to construct
    // without one, so a placeholder is supplied rather than failing at boot.
    defaultKey: "local",
    note: "Ollama's OpenAI shim is http://localhost:11434/v1.",
  },
  custom: {
    label: "Custom endpoint",
    baseUrl: null, // must be supplied
    keyEnv: ["LLM_API_KEY"],
    exampleModel: "",
    note: "Any OpenAI-compatible /chat/completions endpoint.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

function firstEnv(names = []) {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function nonEmpty(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Guess the provider from an explicit base URL, so an operator who only sets
 * LLM_BASE_URL still gets the right key lookup and validation.
 */
export function detectProviderFromUrl(baseUrl) {
  const u = String(baseUrl || "").toLowerCase();
  if (!u) return null;
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("api.anthropic.com")) return "anthropic";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("api.groq.com")) return "groq";
  if (u.includes("api.deepseek.com")) return "deepseek";
  if (u.includes("api.together.xyz")) return "together";
  if (u.includes("api.x.ai")) return "xai";
  if (u.includes("generativelanguage.googleapis.com")) return "google";
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/.test(u)) return "local";
  return "custom";
}

/**
 * Resolve the live LLM connection. Called on EVERY request in agent.js, not once at
 * import, so a key saved through the control panel takes effect on the next cycle.
 *
 * @param {object} userConfig  raw user-config.json object
 * @returns {{provider, baseUrl, apiKey, label, ok, problems: string[]}}
 */
export function resolveLlm(userConfig = {}) {
  const explicitUrl = nonEmpty(userConfig.llmBaseUrl, process.env.LLM_BASE_URL);
  const providerId =
    nonEmpty(userConfig.llmProvider, process.env.LLM_PROVIDER) ||
    detectProviderFromUrl(explicitUrl) ||
    "openrouter";

  const spec = PROVIDERS[providerId] || PROVIDERS.custom;
  const baseUrl = explicitUrl || spec.baseUrl;
  const apiKey =
    nonEmpty(userConfig.llmApiKey) ||
    firstEnv(spec.keyEnv) ||
    firstEnv(["LLM_API_KEY", "OPENROUTER_API_KEY"]) ||
    spec.defaultKey ||
    null;

  const problems = [];
  if (!baseUrl) {
    problems.push(`Provider "${providerId}" needs an explicit base URL (llmBaseUrl).`);
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    problems.push(`Base URL "${baseUrl}" is not an http(s) URL.`);
  } else if (/^http:\/\//i.test(baseUrl) && detectProviderFromUrl(baseUrl) !== "local") {
    // Plaintext HTTP to a remote host sends the API key in the clear.
    problems.push(`Base URL "${baseUrl}" is plaintext HTTP to a non-local host — the API key would travel unencrypted.`);
  }
  if (!apiKey) {
    problems.push(`No API key found. Set one of ${spec.keyEnv.join(" / ")} in .env, or enter it in the control panel.`);
  } else if (spec.keyPrefix && !apiKey.startsWith(spec.keyPrefix)) {
    // A warning, not a hard failure: vendors do rotate key formats.
    problems.push(`Key does not start with "${spec.keyPrefix}" — it may belong to a different provider.`);
  }

  return {
    provider: providerId,
    label: spec.label,
    baseUrl,
    apiKey,
    exampleModel: spec.exampleModel,
    note: spec.note || null,
    ok: !!(baseUrl && apiKey),
    problems,
  };
}

/**
 * Live reachability + auth check. Used by the control panel's "Test connection"
 * button and at boot, so a bad key surfaces immediately instead of at the first
 * tool call in the middle of a management cycle.
 */
export async function testLlmConnection(userConfig = {}, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const r = resolveLlm(userConfig);
  if (!r.ok) return { ok: false, provider: r.provider, error: r.problems.join(" "), problems: r.problems };

  const url = `${r.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${r.apiKey}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, provider: r.provider, error: `Authentication rejected (HTTP ${res.status}). The key is wrong for ${r.label}.` };
    }
    if (!res.ok) {
      // Some compatible endpoints do not implement /models. Reaching them at all
      // still proves the URL resolves and TLS works.
      return { ok: true, provider: r.provider, warning: `Endpoint reachable but /models returned HTTP ${res.status}; the provider may not implement it.`, models: null };
    }
    const body = await res.json().catch(() => null);
    const models = Array.isArray(body?.data) ? body.data.map((m) => m.id).filter(Boolean) : null;
    return { ok: true, provider: r.provider, label: r.label, baseUrl: r.baseUrl, models: models ? models.slice(0, 200) : null, model_count: models?.length ?? null };
  } catch (error) {
    const msg = error.name === "AbortError" ? `No response within ${timeoutMs}ms` : error.message;
    return { ok: false, provider: r.provider, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
