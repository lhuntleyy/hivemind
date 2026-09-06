# Hivemind

**Autonomous Meteora DLMM liquidity agent for Solana.** A hardened fork of [Meridian](https://github.com/yunus-0x/meridian) with a portfolio risk breaker, a self-learning playbook, pull-only swarm intelligence, and a local control panel.

---

## What changed from Meridian

| Area | Meridian | Hivemind |
|---|---|---|
| Portfolio risk | none — only per-position stops | daily loss / consecutive-loss / drawdown breaker with cooldown and kill switch |
| Relay signing | deploy path signed blind, close path simulated | both paths simulated, SOL-loss capped, program allow-listed |
| Swarm lessons | ranked by a near-constant server `score`, junk included | ranked by evidence (distinct agents, consensus, recency), test data filtered out |
| Swarm text | injected into `LESSONS LEARNED` (trusted region) | nonce-fenced, marked untrusted, injection-scanned |
| Swarm sharing | pushes pool, mint, PnL, timing keyed to a stable agent id | **pull-only** — every share flag is off by default |
| Own learning | pool-name lessons; one-way threshold ratchet | feature-band playbook with Wilson bounds; bidirectional evolution with a starvation release |
| Control | terminal REPL + Telegram | REPL + Telegram + local web control panel |
| LLM | OpenRouter hard-coded, read once at import | any OpenAI-compatible endpoint, resolved per request, with a connection test |
| Swap slippage | no parameter sent at all | clamped to [50, 500] bps and surfaced in the result |
| Spot | none | GMGN signals + Jupiter execution, inverted payoff, off by default |
| Dry run | a stub that recorded nothing | paper trading in a separate ledger, priced off live quotes |
| Tests | `node --check` (syntax only) | 194 unit tests + an HTTP smoke test |

The measured effect on the swarm feed: of the 4 lessons Meridian injects into its screener prompt, **3 are test data** (`TEST-SOL … Reason: test close`). Run `node scripts/compare-pipelines.js --live` to see it.

---

## Quick start

```bash
npm install
cp user-config.example.json user-config.json
npm run dev          # DRY_RUN=true — no on-chain transactions
```

Then open **http://127.0.0.1:4141** and fill in your keys under **Settings**. Nothing is written to `.env` until you press Save.

Go live only after you have watched a few dry-run cycles:

```bash
npm start
```

---

## Control panel

The panel is served by the agent itself on loopback. It handles the wallet private key, so:

- it binds to `127.0.0.1` by default
- it **refuses to start** on any other interface without `web.token`
- it never returns a secret, only a masked preview
- it rejects cross-origin requests (CSRF / DNS rebinding)
- `.env` is written with `0600`

| Tab | What it shows |
|---|---|
| Overview | wallet, open positions, realized PnL today, drawdown, breaker state, halt/resume |
| Positions | live PnL, range status, unclaimed fees, token balances |
| Calendar | realized PnL per day as a heat map, plus a daily table |
| Learning | your own playbook (which configurations actually work) and evolution history |
| Swarm | mined strategy intel from other agents — read-only, never auto-applied |
| Settings | secrets, risk limits, sizing, exits, screening thresholds, models |

`DRY_RUN` is intentionally **not** a panel toggle: `config.js` applies it with `||=` so an
existing env var wins, and a switch that appears to disarm live trading without doing so is
the most dangerous control in the app. Change it in `.env` and restart.

---

## Running on a VPS

See [deploy/README.md](deploy/README.md). One command on a fresh Ubuntu box:

```bash
curl -fsSL https://raw.githubusercontent.com/lhuntleyy/hivemind/main/deploy/vps-setup.sh -o vps-setup.sh
less vps-setup.sh    # read it first
bash vps-setup.sh
```

It installs Node 22, creates an unprivileged service user, locks ufw to SSH only, and
installs a hardened systemd unit. The agent starts in DRY_RUN.

**Do not expose the panel.** Tunnel to it instead:

```bash
ssh -N -L 4141:127.0.0.1:4141 user@your-vps
```

Then open `http://127.0.0.1:4141` on your laptop. If you genuinely need a public bind, set
`web.host` **and** `HIVEMIND_WEB_TOKEN`, and put it behind TLS — the server will not start
on a public interface without a token.

After changes:

```bash
git pull && npm install && npm run pm2:restart
```

---

## Risk breaker

The one thing Meridian had no equivalent of. It stops a losing **sequence**, not a losing trade.

```json
{
  "risk": {
    "maxDailyLossSol": 0.5,
    "maxDailyLossPct": 12,
    "maxConsecutiveLosses": 4,
    "maxDrawdownPct": 25,
    "cooldownMinutes": 240
  }
}
```

- Gates **only** `deploy_position`. Closing, claiming and swapping always stay available.
- Lives in `risk-state.json` and survives restarts. A corrupt ledger fails **closed**.
- A cooldown expiring does not clear a trip whose cause still holds — the daily loss is still the daily loss.
- Manual `halt()` never auto-clears.
- The LLM cannot argue past it: the gate runs in the tool executor, not the prompt.

Halt from the panel, or:

```bash
node cli.js risk halt
node cli.js risk resume
```

---

## Swarm — pull only

Hivemind reads other agents' lessons and publishes nothing.

```json
{
  "hiveMind": {
    "share": { "lessons": false, "performance": false, "poolAddress": false, "poolName": false, "baseMint": false }
  }
}
```

With these defaults the client issues **zero** write requests — no lesson push, no
performance push, not even the registration heartbeat (which only fingerprints you).
Pulling works regardless. If you later opt into lesson sharing, pool names and addresses
are still redacted unless you separately opt into those.

What arrives is filtered: test records dropped, injection-scanned, ranked by distinct
agents and consensus rather than the server's `score`, then rendered inside a
`[[SWARM_EVIDENCE_…]]` fence that the prompt marks as data.

The `presets` endpoint returns `[]` upstream, so strategies are not shared through the
intended channel — but lesson **tags** carry other forks' strategy names
(`spot_wallet_1h_v1`, `spot_on_dump`, `trinity`, `bid_ask+spot (60/40, 125 bins)`).
The Swarm tab mines them. They are intelligence to read, never config to apply.

---

## How it learns

**Playbook** — every closed position is bucketed into a feature band
(`strategy | volatility | bin_step | mcap`) and scored with a Wilson 95% lower bound, so
2 wins from 2 trades reads as ~34%, not 100%. Bands, not pool names, go into the prompt.

**Bidirectional evolution** — thresholds tighten when losers cluster below the winners,
**and loosen** when the floor is excluding profitable trades. If screening produces no
deploy for 40 cycles, the floors relax automatically. Meridian's ratchet only tightened,
so a bad streak could walk it into a state where nothing qualified and no new data could
ever argue it back.

---

## GMGN (optional)

GMGN powers richer screening: KOL/smart-money analysis, rug and bundler ratios, and a
Supertrend/RSI/Bollinger entry filter.

```bash
# Hivemind reads any of these, in order:
#   1. gmgn-config.json  { "apiKey": "..." }
#   2. GMGN_API_KEY in .env
#   3. ~/.config/gmgn/.env   (GMGN's own location)
```

Then switch candidate sourcing:

```bash
node cli.js config set screeningSource gmgn
```

`GMGN_PRIVATE_KEY` is deliberately **not** read. This build does not sign GMGN
transactions — spot execution is a separate venue that ships disabled.

---

## Venues

```json
{ "venue": { "lp": true, "spot": false } }
```

**LP (Meteora)** is on by default. **Spot** is complete but off.

Spot uses GMGN for signals and Jupiter for execution — deliberately not GMGN's trading
API. A second private key in a third-party config file is a second way to lose the
wallet, and `tools/wallet.js#swapToken` is already the one execution path here with
slippage bounds and a dry-run branch.

The payoff is inverted on purpose:

| | LP (measured on swarm data) | Spot (defaults) |
|---|---|---|
| Typical win | +2.6% | +40% target |
| Typical loss | -15% | -8% stop |
| Break-even win rate | ~85% | ~17% |

Both venues share the same risk breaker — a spot loss counts against the same daily
limit as an LP loss, because it comes out of the same wallet.

Turn it on only after paper trading it:

```bash
node cli.js config set venue.spot true
# with DRY_RUN=true, entries and exits book into spot-positions.paper.json,
# priced off live Jupiter quotes. The real risk ledger is never touched.
node cli.js spot list
```

---

## LLM providers

Any OpenAI-compatible endpoint. Set it in the panel (Settings → LLM provider) with a
**Test connection** button, or in `user-config.json`:

| Provider | Key env | Example model |
|---|---|---|
| `openrouter` (default) | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.5` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `together`, `xai`, `google` | their own | see `cli.js llm providers` |
| `local` | none needed | LM Studio / Ollama / vLLM |
| `custom` | `LLM_API_KEY` | any `/chat/completions` endpoint |

The endpoint is resolved on every request, so a key entered in the panel works on the
next cycle without a restart. Plaintext HTTP to a non-local host is refused — the API
key would otherwise travel in the clear.

```bash
node cli.js llm status      # what resolved, and why not if it did not
node cli.js llm test        # does the key actually authenticate
node cli.js llm providers
```

---

## Tests

```bash
npm test                  # 147 unit tests
npm run smoke:panel       # control panel over real HTTP, including the breaker gate
node scripts/compare-pipelines.js --live   # Meridian vs Hivemind on live swarm data
```

---

## Known limitations

- **Nested CPI** — the relay guard inspects top-level programs. A malicious program
  invoked via CPI from an allow-listed one is caught only by the simulated SOL-loss cap,
  which is why simulation must never be waived on the deploy path.
- **Sybil** — evidence scoring trusts `distinctAgents`. Fake agents can fake consensus;
  the sanitizer, not the scorer, is what keeps a hostile rule out of the prompt.
- **Equity contract** — the drawdown limit only sees what `markPortfolioEquity` is fed.
  It must include open-position value, not just wallet SOL.
- **Relay zap-out still uses 5000 bps** — the swap path is now clamped to 500 bps, but the
  relay-built close transaction sets its own. Only reachable with `lpAgentRelayEnabled`.
- **Paper trading is not a backtest** — it exercises the full loop on live prices, which
  catches wiring bugs, but it cannot tell you whether a strategy is profitable over time.
- **Spot exits depend on a price feed** — Jupiter first, wallet valuation second. A token
  neither can price falls back to the max-hold clock, and the log says so.

---

## Disclaimer

Running an autonomous trading agent carries real financial risk. Start with `DRY_RUN=true`.
Never deploy more than you can afford to lose. This is not financial advice.
