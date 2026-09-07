# Deploying Hivemind to a VPS

Written for a fresh Ubuntu box that has only had `apt update && apt upgrade`.

---

## The one rule

**Never expose the control panel to the internet.**

That UI reads and writes your wallet private key. `web/server.js` refuses to bind a
non-loopback interface without a token, but the correct answer is not "set a token" —
it is "do not open the port at all". Reach it through SSH:

```bash
ssh -N -L 4141:127.0.0.1:4141 youruser@YOUR_SERVER_IP
```

Leave that running, then open `http://127.0.0.1:4141` in your own browser. The traffic
goes over SSH; nothing listens publicly.

---

## Setup

```bash
# on the VPS
curl -fsSL https://raw.githubusercontent.com/lhuntleyy/hivemind/main/deploy/vps-setup.sh -o vps-setup.sh
less vps-setup.sh        # read it first — it configures a firewall and a systemd unit
bash vps-setup.sh
```

It installs Node 22, creates an unprivileged `hivemind` user, clones to `/opt/hivemind`,
locks `ufw` to SSH only, and installs a hardened systemd unit.

```bash
sudo systemctl start hivemind
sudo journalctl -u hivemind -f
```

The agent starts in `DRY_RUN=true`. It will run full cycles and make zero transactions.

---

## Dry run vs live

The systemd unit runs `node index.js` with **no flags**, so the mode comes from `.env`.
`vps-setup.sh` writes `DRY_RUN=true`, which is why a fresh box is safe.

Precedence, most authoritative first:

| Source | Example | Beats |
|---|---|---|
| CLI flag | `node index.js --dry-run` | everything |
| `.env` | `DRY_RUN=true` | inherited env |
| inherited env | whatever systemd or PM2 leaked in | — |

**Always confirm from the log rather than assuming.** The first lines name the mode and
where it came from:

```bash
sudo journalctl -u hivemind -n 50 | grep Mode:
```

```
[STARTUP] Mode: DRY RUN (from DRY_RUN in .env) — paper wallet 1.1 SOL (real balance ignored; no transaction is sent)
```

If it ever reads `Mode: *** LIVE ***` when you did not intend that, stop the unit before
anything else:

```bash
sudo systemctl stop hivemind
```

### Paper balance

A dry run substitutes a paper SOL balance so it can reach the deploy path on an unfunded
wallet — otherwise the model reads the real balance, correctly refuses to fund a
position, and the run tests nothing. The real figure is still shown, the dashboard
labels it `(paper)`, and the risk ledger is always fed the real number.

A dry-run deploy leaves **no position**, by design: writing one would put fictional
inventory in the same `state.json` the live agent reads. Look for it under
**Recent decisions** (type `dry_run`) instead of on the Positions tab.

### A one-off dry run while the unit is live

The flag beats `.env`, so this is safe even on a box configured for live trading — but
stop the service first, or two processes will fight over the same JSON state files:

```bash
sudo systemctl stop hivemind
sudo -u hivemind node /opt/hivemind/index.js --dry-run
# Ctrl-C when done, then:
sudo systemctl start hivemind
```

---

## Before you go live

Harden SSH first — a box holding a hot wallet should not accept passwords:

```bash
# from your machine, if you have not already
ssh-copy-id youruser@YOUR_SERVER_IP

# on the VPS
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

Confirm the firewall is closed except SSH:

```bash
sudo ufw status verbose      # expect: deny incoming, allow OpenSSH, nothing else
sudo ss -tlnp                # the panel should show 127.0.0.1:4141, never 0.0.0.0:4141
```

That second command is the one that matters. If you ever see `0.0.0.0:4141`, stop the
agent and fix `web.host` before doing anything else.

---

## Going live

```bash
sudo -u hivemind sed -i 's/^DRY_RUN=true/DRY_RUN=false/' /opt/hivemind/.env
sudo systemctl restart hivemind
sudo journalctl -u hivemind -n 30 | grep Mode:      # confirm it actually flipped
```

Note what that `sed` leaves behind: `DRY_RUN=false` stays in `.env` permanently. Any
later run with no flag is live. Use `--dry-run` explicitly when you want a rehearsal.

Start with a small wallet. The risk breaker limits how fast you can lose it, not
whether you can.

---

## Operating

```bash
sudo systemctl status hivemind
sudo journalctl -u hivemind -f
sudo systemctl restart hivemind

sudo -u hivemind node /opt/hivemind/cli.js risk status
sudo -u hivemind node /opt/hivemind/cli.js risk halt      # panic button
sudo -u hivemind node /opt/hivemind/cli.js llm test
sudo -u hivemind node /opt/hivemind/cli.js spot list
```

`risk halt` blocks new deploys immediately and never auto-clears. Closing and claiming
stay available — a breaker that traps you in a position is worse than none.

Updating:

```bash
cd /opt/hivemind
sudo -u hivemind git pull
sudo -u hivemind npm install
sudo systemctl restart hivemind
```

---

## Backups

Two files are irreplaceable and are gitignored on purpose:

| File | Why it matters |
|---|---|
| `.env` | the wallet key |
| `lessons.json` | everything the agent has learned |

`risk-state.json`, `learning-state.json`, `state.json`, `spot-positions.json` and
`pool-memory.json` are rebuildable but losing them resets the breaker's memory and the
playbook.

```bash
sudo tar czf ~/hivemind-backup-$(date +%F).tar.gz \
  -C /opt/hivemind .env lessons.json state.json risk-state.json \
  learning-state.json pool-memory.json spot-positions.json 2>/dev/null
```

Copy it off the box. A snapshot on the same VPS is not a backup.

---

## If something looks wrong

| Symptom | Check |
|---|---|
| Panel unreachable through the tunnel | `sudo ss -tlnp \| grep 4141` — is it listening on 127.0.0.1? |
| `Refusing to bind the control panel` in logs | `web.host` is non-loopback with no token. Set it back to `127.0.0.1`. |
| Agent restarts in a loop | `sudo journalctl -u hivemind -n 100` — usually a missing key or a bad `user-config.json` |
| Blank values in the Overview tab | a risk control may not be wired. Do not go live until they read as numbers. |
| `RISK BREAKER TRIPPED` | working as intended. `cli.js risk status` for the reason. |
