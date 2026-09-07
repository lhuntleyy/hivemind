/**
 * hive-corpus.test.js — swarm history must accumulate across pulls.
 *
 * WHAT WENT WRONG
 * ---------------
 * The server returns ~12 lessons per call out of a rotating pool, and pullLessons did:
 *
 *     cache.lessons = ingest.accepted.map(...)   // overwrite
 *     cache.bands   = ingest.bands               // computed from THIS batch
 *     cache.intel   = mineStrategies(raw)        // computed from THIS batch
 *
 * So every 30 minutes the agent discarded everything it had learned and recomputed its
 * statistics from a sample of twelve — 48 times a day, forever. Feature bands, strategy
 * weights and mined exit thresholds are all counting exercises; over one batch of twelve
 * none of them mean anything, and the win rates they produced looked authoritative
 * anyway. For an agent whose entire premise is learning from the swarm, throwing the
 * swarm away on a timer is the most expensive bug in the module.
 *
 * The corpus is the fix: raw lessons accumulate, deduped by id, and the full pipeline
 * runs over the accumulation instead of over the latest batch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HiveClient, mergeCorpus, memoryStore } from "../hive/hive-client.js";

const lesson = (n) => ({
  id: `lesson:agt_a${n}:${1_700_000_000_000 + n}`,
  rule: `FAILED: p${n}-SOL, strategy=spot, bin_step=100, volatility=2.7, organic=85 → ` +
        `PnL -15.06%, range efficiency 100%. Reason: Stop loss: PnL -16.05% = -15%.`,
  distinctAgents: 30,
  sampleCount: 40,
});

test("a second pull adds to the corpus rather than replacing it", () => {
  const first = mergeCorpus([], [lesson(1), lesson(2)], { now: 1000 });
  const second = mergeCorpus(first, [lesson(3)], { now: 2000 });
  assert.equal(second.length, 3);
  assert.deepEqual(second.map((l) => l.id).sort(), [lesson(1), lesson(2), lesson(3)].map((l) => l.id).sort());
});

test("re-serving the same lessons does not inflate the corpus", () => {
  // The server hands back an overlapping set on every call. Without dedup, one lesson
  // would accumulate weight in every band and threshold it touches.
  let corpus = [];
  for (let pull = 0; pull < 20; pull++) corpus = mergeCorpus(corpus, [lesson(1), lesson(2)], { now: pull });
  assert.equal(corpus.length, 2);
});

test("the first-seen timestamp is preserved across merges", () => {
  const first = mergeCorpus([], [lesson(1)], { now: 1000 });
  const again = mergeCorpus(first, [lesson(1)], { now: 9999 });
  assert.equal(again[0]._firstSeen, 1000, "a re-served lesson is not new");
});

test("the corpus is capped, evicting the oldest", () => {
  let corpus = [];
  for (let i = 0; i < 10; i++) corpus = mergeCorpus(corpus, [lesson(i)], { max: 4, now: i });
  assert.equal(corpus.length, 4);
  assert.deepEqual(corpus.map((l) => l._firstSeen), [9, 8, 7, 6], "newest first, oldest evicted");
});

test("an id-less lesson is dropped", () => {
  // It cannot be deduped, so keeping it would let one repeated anonymous rule
  // accumulate unbounded weight across pulls.
  const corpus = mergeCorpus([], [{ rule: "FAILED: x → PnL -1%." }, lesson(1)], { now: 1 });
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0].id, lesson(1).id);
});

test("pullLessons analyses the corpus, not just the latest batch", async () => {
  const store = memoryStore();
  let batch = 0;
  const client = new HiveClient({
    baseUrl: "https://example.invalid",
    apiKey: "k",
    agentId: "agt_test",
    store,
    now: () => 1_700_000_100_000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ lessons: [lesson(batch * 2), lesson(batch * 2 + 1)] }),
    }),
  });

  batch = 0; await client.pullLessons();
  assert.equal(store.read().corpus.length, 2);

  batch = 1; await client.pullLessons();
  const cache = store.read();
  assert.equal(cache.corpus.length, 4, "the second pull must not wipe the first");
  assert.ok(cache.exits, "exit rules are mined from the corpus on every pull");
  assert.equal(cache.exits.thresholds.stop_loss.agents, 4, "all four agents' stops are counted");
});

test("the corpus survives a store round trip", () => {
  // fileStore and memoryStore both start from a fixed `empty` shape and spread the file
  // over it. A field missing from that shape is silently dropped on the next write —
  // which is how a persisted corpus would quietly reset to [] on restart.
  const store = memoryStore();
  const cache = store.read();
  assert.ok(Array.isArray(cache.corpus), "corpus must be part of the empty shape");
  assert.ok("exits" in cache, "exits must be part of the empty shape");

  cache.corpus = [lesson(1)];
  store.write(cache);
  assert.equal(store.read().corpus.length, 1);
});

test("getExitRules reports thresholds alongside our own settings", () => {
  const store = memoryStore({ corpus: [lesson(1), lesson(2)] });
  const client = new HiveClient({ baseUrl: "https://x.invalid", apiKey: "k", agentId: "a", store });
  const out = client.getExitRules({ stopLossPct: -50, takeProfitPct: 5 });
  assert.equal(out.thresholds.stop_loss.median_pct, -15);
  assert.equal(out.comparison[0].ours, -50);
});
