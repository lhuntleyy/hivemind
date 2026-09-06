/**
 * provider-compat.test.js — surviving OpenAI-compatible gateways that are not OpenAI.
 *
 * Real failure that motivated this file: a LiteLLM gateway in front of GLM rejected
 * every single request with
 *
 *   400 ... The request is invalid: temperature参数非法：限制小数点[2]位
 *   ("temperature is invalid: limited to 2 decimal places")
 *
 * because Meridian's default temperature is 0.373. Three decimals. Every cycle died on
 * the first call, and the only symptom was one red line in the log.
 *
 * "OpenAI-compatible" means the shape is compatible, not that the validation is. These
 * tests pin the two defences: never send a value we know some gateways refuse, and when
 * one names a parameter as invalid, drop it and continue instead of losing the cycle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { roundTemperature, rejectedParameter } from "../agent.js";
import { config } from "../config.js";

// ─── temperature precision ──────────────────────────────────────

test("temperature is rounded to 2 decimals", () => {
  assert.equal(roundTemperature(0.373), 0.37, "the exact value that broke GLM via LiteLLM");
  assert.equal(roundTemperature(0.7), 0.7);
  assert.equal(roundTemperature(0.999), 1);

  // 1.005 rounds DOWN to 1, not up to 1.01. That is not a bug here: 1.005 has no exact
  // binary representation, so 1.005 * 100 is 100.49999999999999 and Math.round takes
  // it to 100. (Number(1.005).toFixed(2) gives "1.00" for the same reason.) The
  // contract this function owes the caller is "at most 2 decimals, inside [0,2]",
  // which is what the next test asserts — not exact decimal rounding.
  assert.equal(roundTemperature(1.005), 1);
});

test("temperature is clamped to a valid range", () => {
  assert.equal(roundTemperature(-1), 0);
  assert.equal(roundTemperature(5), 2);
  assert.equal(roundTemperature(2.5), 2);
});

test("a non-numeric temperature falls back rather than sending NaN", () => {
  // NaN serialises to null in JSON and every provider 400s on it.
  for (const bad of ["abc", undefined, {}, NaN, Infinity]) {
    const t = roundTemperature(bad);
    assert.ok(Number.isFinite(t) && t >= 0 && t <= 2, `${String(bad)} -> ${t}`);
  }
  assert.equal(roundTemperature(null), 0);
});

test("every rounded value survives a 2-decimal validator", () => {
  for (let i = 0; i <= 200; i++) {
    const t = roundTemperature(i / 200 * 2);
    const decimals = String(t).split(".")[1]?.length ?? 0;
    assert.ok(decimals <= 2, `${t} has ${decimals} decimals`);
  }
});

test("the shipped default would pass that validator", () => {
  const decimals = String(config.llm.temperature).split(".")[1]?.length ?? 0;
  assert.ok(decimals <= 2, `config default ${config.llm.temperature} has ${decimals} decimals`);
});

// ─── parameter rejection ────────────────────────────────────────

test("recognises the exact LiteLLM/GLM rejection", () => {
  const msg = "400 litellm.BadRequestError: OpenAIException - The request is invalid: temperature参数非法：限制小数点[2]位. Please check the request body, required fields, and request format.. Received Model Group=glm-5.2";
  assert.equal(rejectedParameter({ message: msg }), "temperature");
});

test("recognises other named-parameter rejections", () => {
  assert.equal(rejectedParameter({ message: "400 Bad Request: max_tokens exceeds the model limit" }), "max_tokens");
  assert.equal(rejectedParameter({ message: "Invalid value for 'top_p'" }), "top_p");
  assert.equal(rejectedParameter({ message: "400 invalid parameter: parallel_tool_calls unsupported" }), "parallel_tool_calls");
});

test("reads a nested error shape", () => {
  assert.equal(rejectedParameter({ error: { message: "400 invalid: temperature out of range" } }), "temperature");
});

test("does NOT fire on unrelated failures", () => {
  // Dropping a parameter in response to a rate limit or an auth failure would hide a
  // real problem and keep retrying a request that can never succeed.
  for (const msg of [
    "429 Too Many Requests",
    "401 Unauthorized",
    "503 Service Unavailable",
    "Connection timed out",
    "400 Bad Request: messages array is empty",
  ]) {
    assert.equal(rejectedParameter({ message: msg }), null, `should not fire on: ${msg}`);
  }
});

test("handles null, undefined and non-error inputs", () => {
  for (const bad of [null, undefined, "", 0, {}, []]) {
    assert.equal(rejectedParameter(bad), null);
  }
});

test("only ever names a parameter it is safe to drop", () => {
  // Dropping `messages` or `model` would produce a malformed request, so those must
  // never be returned no matter what the gateway says.
  const dangerous = ["messages", "model", "tools", "stream"];
  for (const p of dangerous) {
    const got = rejectedParameter({ message: `400 invalid: ${p} is not allowed` });
    assert.ok(!dangerous.includes(got), `must not offer to drop "${p}" (got ${got})`);
  }
});

// ─── tool-calling capability ────────────────────────────────────

import { probeToolSupport } from "../llm-providers.js";

const ENDPOINT = { baseUrl: "https://x.test/v1", apiKey: "k", model: "some-model" };

test("a 404 on a tools request is read as 'no function calling', not a missing model", () => {
  // The real failure: glm-5.2 IS in /models and answers plain requests, but the same
  // request carrying `tools` returns 404. Reading that literally sends you hunting for
  // a typo that does not exist.
  return probeToolSupport(ENDPOINT, {
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "{'error': 'Not found'}" }),
  }).then((r) => {
    assert.equal(r.supported, false);
    assert.match(r.reason, /function-calling support/);
    assert.match(r.reason, /some-model/);
  });
});

test("a 400 on a tools request is treated the same way", async () => {
  const r = await probeToolSupport(ENDPOINT, {
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => "tools not supported" }),
  });
  assert.equal(r.supported, false);
});

test("a successful tools request means supported", async () => {
  const r = await probeToolSupport(ENDPOINT, { fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.supported, true);
});

test("other statuses report UNKNOWN, never a false negative", async () => {
  // A 429 or 500 says nothing about capability. Claiming "no tool calling" there would
  // send the operator to change a model that was fine.
  for (const status of [429, 500, 502, 503]) {
    const r = await probeToolSupport(ENDPOINT, { fetchImpl: async () => ({ ok: false, status, text: async () => "" }) });
    assert.equal(r.supported, null, `HTTP ${status} must be inconclusive`);
    assert.match(r.reason, /unknown/i);
  }
});

test("a network failure is inconclusive, not a negative", async () => {
  const r = await probeToolSupport(ENDPOINT, {
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(r.supported, null);
  assert.match(r.reason, /ECONNRESET/);
});

test("the probe times out instead of hanging a connection test", async () => {
  const started = Date.now();
  const r = await probeToolSupport(ENDPOINT, {
    timeoutMs: 60,
    fetchImpl: (u, init) => new Promise((_, rej) =>
      init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  assert.equal(r.supported, null);
  assert.match(r.reason, /no response within/);
  assert.ok(Date.now() - started < 2000);
});

test("the probe actually sends a tool — otherwise it proves nothing", async () => {
  let sent = null;
  await probeToolSupport(ENDPOINT, {
    fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200 }; },
  });
  assert.ok(Array.isArray(sent.tools) && sent.tools.length === 1, "must carry a tool definition");
  assert.equal(sent.model, "some-model");
  assert.ok(sent.max_tokens <= 16, "keep the probe cheap");
});

test("the API key goes in the header, never the URL", async () => {
  let url = "", headers = null;
  await probeToolSupport(ENDPOINT, {
    fetchImpl: async (u, init) => { url = u; headers = init.headers; return { ok: true, status: 200 }; },
  });
  assert.ok(!url.includes("k"), "key must not appear in the URL");
  assert.equal(headers.authorization, "Bearer k");
});

// ─── output-budget truncation ───────────────────────────────────

import { MAX_EMPTY_RESPONSES, MAX_TOKEN_BUDGET } from "../agent.js";

test("the empty-response retry is bounded", () => {
  // Meridian declared an `emptyStreak` counter for this and never incremented or read
  // it, so `continue` ran with no cap and no delay: two empty responses burned all 20
  // steps in under a second, then reported "Max steps reached" as if it had worked.
  assert.ok(Number.isInteger(MAX_EMPTY_RESPONSES) && MAX_EMPTY_RESPONSES >= 1 && MAX_EMPTY_RESPONSES <= 10,
    `MAX_EMPTY_RESPONSES should be a small positive integer, got ${MAX_EMPTY_RESPONSES}`);
});

test("the auto-grown token budget is bounded", () => {
  // Growth exists so a reasoning model can finish thinking; the ceiling exists so a
  // runaway cannot bill an unbounded response.
  assert.ok(MAX_TOKEN_BUDGET >= 8192, "must leave room for a reasoning model to think and then answer");
  assert.ok(MAX_TOKEN_BUDGET <= 65536, "must stay bounded");
});

test("doubling from the cycle budget reaches the ceiling in few steps", () => {
  // The screening/management cycles pass 2048. If growth were too slow the run would
  // exhaust its step budget before the model could ever answer — which is exactly what
  // happened with claude-sonnet-5 at 2048 (finish_reason=length, empty content).
  let budget = 2048;
  let doublings = 0;
  while (budget < MAX_TOKEN_BUDGET && doublings < 20) { budget = Math.min(MAX_TOKEN_BUDGET, budget * 2); doublings++; }
  assert.ok(doublings <= 4, `should reach the ceiling within 4 doublings, took ${doublings}`);
  assert.equal(budget, MAX_TOKEN_BUDGET);
});

test("config.llm.maxTokens is at least the cycle budget", () => {
  // agentLoop falls back to this when no per-call budget is given.
  assert.ok(config.llm.maxTokens >= 2048, `maxTokens ${config.llm.maxTokens} is too small for a tool-calling cycle`);
});
