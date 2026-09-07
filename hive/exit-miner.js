/**
 * exit-miner.js — recover other agents' exit rules from the lessons they publish.
 *
 * WHY THIS EXISTS
 * ---------------
 * The swarm API exposes no preset, no config and no strategy document — /presets/pull
 * returns an empty array. But a FAILED lesson carries the close reason verbatim, and a
 * close reason names the rule that fired *and the number it fired at*:
 *
 *   "FAILED: grail-SOL, ... → PnL -15.06%. Reason: Stop loss: PnL -16.05% = -15%."
 *                                                              ^^^^^^^^^^^^^^^^^^
 *   "... Reason: Rule 3: dumped far below range (loss 29% = 25% max)."
 *   "... Reason: Trailing TP stop loss."
 *
 * The left number is what that agent's position actually did; the right number is the
 * threshold it was configured with. That second number is somebody else's risk setting,
 * published by accident, and it is the only hard evidence in the whole feed about how
 * the rest of the swarm sizes its exits.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a signal to trade on and not an auto-tuner. Nothing here writes config. It answers
 * one operator question — "where does the swarm put its stops, and where do I sit
 * relative to them?" — and the answer always carries its sample size, because the honest
 * sample here is small.
 *
 * COUNTING RULE
 * -------------
 * One vote per agent, not per lesson. The author is recovered from the lesson id
 * ("lesson:agt_<hex>:<ts>"), and an agent that publishes forty lessons about the same
 * -15% stop still counts once. Without that, a single chatty fork sets the median.
 */

/** Recover the publishing agent from a lesson id. Null when the id is not in that form. */
export function agentIdOf(lessonId) {
  const m = /agt_[0-9a-z]+/i.exec(String(lessonId ?? ""));
  return m ? m[0].toLowerCase() : null;
}

// The same test-lesson pattern lesson-quality.js rejects on. Applied here too: a feed
// carrying "test close" three times would otherwise report as 43% of the reason mix and
// make somebody's smoke test look like a strategy the swarm runs.
const TEST_REASON_RE = /^test\b|test close|testing/i;

/** The close reason, if the rule text carries one and it is not test spam. */
export function reasonOf(rule) {
  const m = /Reason:\s*(.+?)\s*$/i.exec(String(rule ?? ""));
  if (!m) return null;
  const text = m[1].replace(/\.$/, "").trim();
  return TEST_REASON_RE.test(text) ? null : text;
}

// Order matters. "Trailing TP stop loss" contains "stop loss", but it is a trailing
// exit — a trailing stop and a fixed stop are different rules carrying different
// numbers, and folding them together would corrupt both medians.
const CLASSES = [
  { id: "trailing_tp",  re: /\btrailing\b/i,                                    loss: false },
  { id: "stop_loss",    re: /\bstop[\s_-]?loss\b|\bSL\b/i,                      loss: true  },
  { id: "take_profit",  re: /\btake[\s_-]?profit\b|\bTP\b/i,                    loss: false },
  { id: "range_dump",   re: /dumped far|far below range|below range/i,          loss: true  },
  { id: "range_pump",   re: /pumped far|far above range|above range/i,          loss: false },
  { id: "out_of_range", re: /\bOOR\b|out[\s_-]?of[\s_-]?range/i,                loss: null  },
  { id: "low_yield",    re: /low[\s_-]?yield|fee[\s_-]?(yield|per[\s_-]?tvl)/i, loss: null  },
  { id: "drawdown",     re: /\bdrawdown\b/i,                                    loss: true  },
  { id: "manual",       re: /\bmanual|operator|by hand\b/i,                     loss: null  },
];

/**
 * Classify one close reason and recover the threshold it fired at.
 *
 * @returns {{class:string, threshold_pct:number|null, actual_pct:number|null, text:string}|null}
 */
export function parseExitReason(reason) {
  const text = String(reason ?? "").trim();
  if (!text) return null;

  const hit = CLASSES.find((c) => c.re.test(text));
  const cls = hit ? hit.id : "other";

  // Percentages in order of appearance. The convention across every reason string seen
  // so far is "<what happened> = <what was configured>", so the LAST one is the
  // threshold and the first is the realised PnL. A percentage that is not on the right
  // of an '=' is an outcome, never a setting — reading it as one would mine our own
  // counterparties' losses and call them stops.
  const pcts = [...text.matchAll(/([+-]?\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  const eqPcts = [...text.matchAll(/=\s*([+-]?\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));

  let threshold = eqPcts.length ? eqPcts[eqPcts.length - 1] : null;
  let actual = pcts.length > (eqPcts.length ? 1 : 0) ? pcts[0] : null;
  if (threshold != null && actual === threshold) actual = null;

  // Reasons are written loosely: "-15%" and "25% max" both mean a loss limit. Normalise
  // the sign from the rule's own direction so a median over the two means something.
  if (threshold != null && hit && hit.loss === true) threshold = -Math.abs(threshold);
  if (threshold != null && hit && hit.loss === false) threshold = Math.abs(threshold);

  return { class: cls, threshold_pct: threshold, actual_pct: actual, text };
}

// toFixed then Number, so 1.005 does not become 1 through a *100/100 round trip.
function round2(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return round2(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/**
 * Mine exit rules out of a corpus of raw swarm lessons.
 *
 * @param {Array<{id?:string, rule?:string}>} lessons
 * @returns {{thresholds:object, reason_mix:Array, samples:number, agents:number}}
 */
export function mineExitRules(lessons) {
  const byClass = new Map();      // class -> agentId -> newest threshold that agent published
  const reasonCounts = new Map();
  const agents = new Set();
  let samples = 0;

  for (const raw of Array.isArray(lessons) ? lessons : []) {
    const reason = reasonOf(raw?.rule);
    if (!reason) continue;
    const parsed = parseExitReason(reason);
    if (!parsed) continue;

    samples++;
    const agent = agentIdOf(raw?.id);
    if (agent) agents.add(agent);

    reasonCounts.set(parsed.class, (reasonCounts.get(parsed.class) ?? 0) + 1);

    // An unattributable id still counts toward the reason mix, but never toward a
    // threshold median — an anonymous vote is an unbounded number of votes.
    if (parsed.threshold_pct == null || !agent) continue;

    // Lesson ids end in a millisecond timestamp. Prefer the agent's most recent value so
    // a fork that retuned its stop is counted at the setting it runs now.
    //
    // Strictly greater, not >=: when two lessons carry the same timestamp — or an id we
    // cannot parse one out of, which scores 0 — the first one encountered wins. The
    // corpus is stored newest-first, so first-encountered is the best available guess at
    // newest. With >= the winner would instead be whichever entry happened to sit last
    // in the array, which is not a recency rule at all.
    const ts = Number(/:(\d+)\s*$/.exec(String(raw.id))?.[1] ?? 0);
    const perAgent = byClass.get(parsed.class) ?? new Map();
    const prev = perAgent.get(agent);
    if (!prev || ts > prev.ts) perAgent.set(agent, { value: parsed.threshold_pct, ts });
    byClass.set(parsed.class, perAgent);
  }

  const thresholds = {};
  for (const [cls, perAgent] of byClass) {
    const values = [...perAgent.values()].map((v) => v.value).sort((a, b) => a - b);
    thresholds[cls] = {
      agents: values.length,
      median_pct: median(values),
      min_pct: values[0],
      max_pct: values[values.length - 1],
      p25_pct: quantile(values, 0.25),
      p75_pct: quantile(values, 0.75),
      values,
    };
  }

  const total = [...reasonCounts.values()].reduce((a, b) => a + b, 0);
  const reason_mix = [...reasonCounts.entries()]
    .map(([cls, count]) => ({ class: cls, count, share_pct: total ? round2((count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  return { thresholds, reason_mix, samples, agents: agents.size };
}

/**
 * Compare mined thresholds against this agent's own settings.
 *
 * Reports the gap and says nothing about what to do with it. A two-agent median is not
 * a recommendation, so the sample size travels with every line.
 */
export function compareToOwnExits(mined, { stopLossPct, takeProfitPct } = {}) {
  const out = [];
  const pairs = [
    ["stop_loss", "Stop loss", stopLossPct],
    ["take_profit", "Take profit", takeProfitPct],
  ];

  for (const [cls, label, ours] of pairs) {
    const t = mined?.thresholds?.[cls];
    if (!t || t.agents < 1 || t.median_pct == null || !Number.isFinite(Number(ours))) continue;
    const mine = Number(ours);
    const gap = round2(Math.abs(mine) - Math.abs(t.median_pct));
    const direction = gap > 0 ? "wider" : gap < 0 ? "tighter" : "same";
    out.push({
      key: cls,
      label,
      ours: mine,
      swarm_median: t.median_pct,
      agents: t.agents,
      range: [t.min_pct, t.max_pct],
      note:
        `${label}: yours ${mine}% vs swarm median ${t.median_pct}% ` +
        `(${t.agents} agent${t.agents === 1 ? "" : "s"}, ${t.min_pct}%…${t.max_pct}%) — ` +
        `${direction === "same" ? "the same" : `${Math.abs(gap)}pp ${direction}`}` +
        (t.agents < 5 ? ". Sample too small to act on alone." : "."),
    });
  }
  return out;
}
