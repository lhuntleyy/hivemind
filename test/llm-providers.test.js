/**
 * llm-providers.test.js — provider resolution and its guardrails.
 *
 * Meridian hard-coded OpenRouter and read the key once at import. Two consequences
 * worth pinning: a wrong provider/key pair must be caught BEFORE a cycle depends on it,
 * and the base URL must never be allowed to send the API key over plaintext HTTP to a
 * remote host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  PROVIDER_IDS,
  resolveLlm,
  detectProviderFromUrl,
  testLlmConnection,
} from "../llm-providers.js";

// Env vars leak between tests otherwise — resolveLlm reads process.env by design.
function withEnv(vars, fn) {
  const saved = {};
  const touched = new Set([
    ...Object.keys(vars),
    "LLM_API_KEY", "OPENROUTER_API_KEY", "LLM_BASE_URL", "LLM_PROVIDER",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY",
  ]);
  for (const k of touched) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) if (v != null) process.env[k] = v;
  try { return fn(); }
  finally {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("every registered provider has what the SDK needs", () => {
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    assert.ok(p.label, `${id} missing label`);
    assert.ok(Array.isArray(p.keyEnv) && p.keyEnv.length, `${id} missing keyEnv`);
    if (id !== "custom") assert.ok(p.baseUrl, `${id} missing baseUrl`);
    if (p.baseUrl && id !== "local") {
      assert.match(p.baseUrl, /^https:\/\//, `${id} base URL must be https`);
    }
  }
});

test("defaults to OpenRouter when nothing is configured", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-abc" }, () => {
    const r = resolveLlm({});
    assert.equal(r.provider, "openrouter");
    assert.equal(r.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(r.ok, true);
  });
});

test("user-config beats env", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-env" }, () => {
    const r = resolveLlm({ llmProvider: "groq", llmApiKey: "gsk_fromconfig" });
    assert.equal(r.provider, "groq");
    assert.equal(r.apiKey, "gsk_fromconfig");
  });
});

test("each provider picks up its own conventional env var", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-x" }, () => {
    const r = resolveLlm({ llmProvider: "anthropic" });
    assert.equal(r.apiKey, "sk-ant-x");
    assert.equal(r.ok, true);
  });
  withEnv({ GEMINI_API_KEY: "gk" }, () => {
    assert.equal(resolveLlm({ llmProvider: "google" }).apiKey, "gk");
  });
});

test("a bare LLM_BASE_URL still resolves the right provider", () => {
  withEnv({ LLM_BASE_URL: "https://api.groq.com/openai/v1", LLM_API_KEY: "gsk_x" }, () => {
    const r = resolveLlm({});
    assert.equal(r.provider, "groq", "an operator who only sets a URL should still get the right key lookup");
  });
});

test("detectProviderFromUrl covers the registry and falls back to custom", () => {
  assert.equal(detectProviderFromUrl("https://openrouter.ai/api/v1"), "openrouter");
  assert.equal(detectProviderFromUrl("https://api.anthropic.com/v1/"), "anthropic");
  assert.equal(detectProviderFromUrl("http://localhost:11434/v1"), "local");
  assert.equal(detectProviderFromUrl("http://127.0.0.1:1234/v1"), "local");
  assert.equal(detectProviderFromUrl("https://llm.mycompany.internal/v1"), "custom");
  assert.equal(detectProviderFromUrl(""), null);
});

test("a missing key is reported, not silently defaulted", () => {
  withEnv({}, () => {
    const r = resolveLlm({ llmProvider: "openai" });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(" "), /No API key found/);
  });
});

test("custom without a base URL is refused", () => {
  withEnv({ LLM_API_KEY: "k" }, () => {
    const r = resolveLlm({ llmProvider: "custom" });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(" "), /needs an explicit base URL/);
  });
});

test("plaintext HTTP to a REMOTE host is flagged — the key would be on the wire", () => {
  withEnv({}, () => {
    const r = resolveLlm({ llmProvider: "custom", llmBaseUrl: "http://llm.example.com/v1", llmApiKey: "sk-secret" });
    assert.match(r.problems.join(" "), /plaintext HTTP/);
  });
});

test("plaintext HTTP to localhost is fine — nothing leaves the machine", () => {
  withEnv({}, () => {
    const r = resolveLlm({ llmProvider: "local", llmApiKey: "local" });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });
});

test("a local server gets a placeholder key so the SDK can construct", () => {
  withEnv({}, () => {
    // Most local servers ignore the key, but the OpenAI SDK throws without one — which
    // would make "local model" fail at boot for no real reason.
    const r = resolveLlm({ llmProvider: "local" });
    assert.ok(r.apiKey, "local must resolve to something");
    assert.equal(r.ok, true);
  });
});

test("a key with the wrong vendor prefix is warned about but not blocked", () => {
  withEnv({}, () => {
    const r = resolveLlm({ llmProvider: "anthropic", llmApiKey: "sk-or-v1-wrongvendor" });
    assert.equal(r.ok, true, "vendors do rotate key formats — warn, do not block");
    assert.match(r.problems.join(" "), /may belong to a different provider/);
  });
});

// ─── connection test ────────────────────────────────────────────

test("testLlmConnection reports auth failure clearly", async () => {
  const r = await testLlmConnection(
    { llmProvider: "openai", llmApiKey: "sk-bad" },
    { fetchImpl: async () => ({ status: 401, ok: false }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /Authentication rejected/);
});

test("testLlmConnection treats a missing /models as reachable, not broken", async () => {
  // Several compatible endpoints do not implement /models. Reaching them still proves
  // the URL resolves and TLS works, which is what the operator is checking.
  const r = await testLlmConnection(
    { llmProvider: "custom", llmBaseUrl: "https://x.test/v1", llmApiKey: "k" },
    { fetchImpl: async () => ({ status: 404, ok: false }) },
  );
  assert.equal(r.ok, true);
  assert.match(r.warning, /may not implement it/);
});

test("testLlmConnection lists models on success", async () => {
  const r = await testLlmConnection(
    { llmProvider: "openai", llmApiKey: "sk-good" },
    { fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ data: [{ id: "gpt-4.1" }, { id: "gpt-4o" }] }) }) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.model_count, 2);
  assert.ok(r.models.includes("gpt-4.1"));
});

test("testLlmConnection fails fast rather than hanging a cycle", async () => {
  const started = Date.now();
  const r = await testLlmConnection(
    { llmProvider: "openai", llmApiKey: "k" },
    {
      timeoutMs: 60,
      fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /No response within/);
  assert.ok(Date.now() - started < 2000);
});

test("an unconfigured provider fails the test without a network call", async () => {
  let called = false;
  const r = await withEnv({}, () => testLlmConnection({ llmProvider: "openai" }, { fetchImpl: async () => { called = true; } }));
  assert.equal((await r).ok, false);
  assert.equal(called, false, "no point dialling out with no key");
});
