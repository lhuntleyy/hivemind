/**
 * smoke-panel.mjs — start the control panel and exercise it over real HTTP.
 * Runs with DRY_RUN=true and no wallet, so nothing touches the chain.
 *
 *   DRY_RUN=true node scripts/smoke-panel.mjs
 */

process.env.DRY_RUN = "true";

const { startControlPanel, stopControlPanel } = await import("../web/server.js");
const { config } = await import("../config.js");

const PORT = 4199;
config.web.enabled = true;
config.web.host = "127.0.0.1";
config.web.port = PORT;
config.web.token = null;

const server = startControlPanel();
if (!server) {
  console.error("FAIL: control panel refused to start");
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 400));

const base = `http://127.0.0.1:${PORT}`;
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name} — ${e.message}`);
  }
}

const get = async (p, init) => {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
};

console.log("\nControl panel smoke test\n");

await check("serves the dashboard", async () => {
  const r = await get("/");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!String(r.body).includes("Hivemind")) throw new Error("body is not the dashboard");
});

await check("sets a strict CSP with no remote origins", async () => {
  const r = await get("/");
  const csp = r.headers.get("content-security-policy") || "";
  if (!csp.includes("default-src 'none'")) throw new Error("missing default-src 'none'");
  if (!csp.includes("frame-ancestors 'none'")) throw new Error("missing frame-ancestors");
});

await check("blocks path traversal out of the public dir", async () => {
  for (const p of ["/../config.js", "/..%2fconfig.js", "/../../.env"]) {
    const r = await get(p);
    if (r.status === 200 && String(r.body).includes("WALLET_PRIVATE_KEY")) {
      throw new Error(`leaked a file via ${p}`);
    }
  }
});

await check("GET /api/status responds with the expected shape", async () => {
  const r = await get("/api/status");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  for (const k of ["wallet", "positions", "risk", "dry_run", "venue"]) {
    if (!(k in r.body)) throw new Error(`missing ${k}`);
  }
  if (r.body.dry_run !== true) throw new Error("dry_run should be true");
});

await check("GET /api/settings never returns a raw secret", async () => {
  const r = await get("/api/settings");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const raw = JSON.stringify(r.body);
  if (/"[A-Za-z0-9_-]{40,}"/.test(raw.replace(/\*/g, ""))) {
    // Nothing that looks like a full-length key should appear anywhere.
    throw new Error("response contains something key-shaped");
  }
  for (const v of Object.values(r.body.secrets)) {
    if (v.preview && !v.preview.includes("*") && v.preview.length > 8) {
      throw new Error(`unmasked preview: ${v.preview}`);
    }
  }
});

await check("GET /api/calendar buckets by day", async () => {
  const r = await get("/api/calendar?days=30");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.body.calendar)) throw new Error("calendar is not an array");
});

await check("POST from a foreign Origin is rejected", async () => {
  const r = await get("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ values: { maxPositions: 99 } }),
  });
  if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
});

await check("POST /api/settings rejects out-of-range and unknown keys", async () => {
  const r = await get("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ values: { positionSizePct: 99, notARealSetting: 1, stopLossPct: 50 } }),
  });
  if (![200, 207].includes(r.status)) throw new Error(`status ${r.status}`);
  if (Object.keys(r.body.applied).length !== 0) throw new Error(`applied something it should not: ${JSON.stringify(r.body.applied)}`);
  for (const k of ["positionSizePct", "notARealSetting", "stopLossPct"]) {
    if (!r.body.errors[k]) throw new Error(`${k} was not rejected`);
  }
});

await check("POST /api/secrets refuses a masked value echoed back", async () => {
  const r = await get("/api/secrets", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ secrets: { OPENROUTER_API_KEY: "sk-o********cdef" } }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.applied.length !== 0) throw new Error("wrote a mask into .env");
});

await check("POST /api/secrets rejects an unmanaged key", async () => {
  const r = await get("/api/secrets", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ secrets: { PATH: "/evil" } }),
  });
  if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

await check("risk halt and resume round-trip", async () => {
  const h = await get("/api/risk/halt", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ reason: "smoke test" }),
  });
  if (!h.body.halted) throw new Error("halt did not take");

  const s1 = await get("/api/status");
  if (!s1.body.risk.halted) throw new Error("status does not reflect the halt");

  const r = await get("/api/risk/resume", { method: "POST", headers: { origin: `http://127.0.0.1:${PORT}` } });
  if (!r.body.resumed) throw new Error("resume did not take");

  const s2 = await get("/api/status");
  if (s2.body.risk.halted) throw new Error("still halted after resume");
});

await check("a tripped breaker actually blocks deploy_position", async () => {
  const { riskGuard } = await import("../risk.js");
  const { executeTool } = await import("../tools/executor.js");
  riskGuard.halt("smoke test — verifying the gate");
  const result = await executeTool("deploy_position", {
    pool_address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6d",
    amount_y: 1, bins_below: 50, bins_above: 0,
  });
  riskGuard.resume("smoke test cleanup");
  if (!result.blocked) throw new Error(`deploy was not blocked: ${JSON.stringify(result).slice(0, 160)}`);
  if (!/RISK BREAKER/.test(result.reason || "")) throw new Error(`blocked for the wrong reason: ${result.reason}`);
});

await check("unknown API route 404s cleanly", async () => {
  const r = await get("/api/nope");
  if (r.status !== 404) throw new Error(`status ${r.status}`);
});

stopControlPanel();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
