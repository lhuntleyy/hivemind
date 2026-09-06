#!/usr/bin/env bash
#
# vps-setup.sh — provision a fresh Ubuntu VPS to run Hivemind.
#
# Usage (on the VPS, as a sudo-capable user):
#   curl -fsSL https://raw.githubusercontent.com/lhuntleyy/hivemind/main/deploy/vps-setup.sh -o vps-setup.sh
#   less vps-setup.sh          # read it before you run it
#   bash vps-setup.sh
#
# What it does:
#   - installs Node 22 LTS, git, ufw, fail2ban
#   - creates an unprivileged `hivemind` user (the agent never runs as root)
#   - clones the repo into /opt/hivemind and installs dependencies
#   - configures ufw to allow SSH ONLY — the control panel stays on loopback
#   - installs a systemd unit so the agent survives reboots
#
# What it deliberately does NOT do:
#   - open the control-panel port to the internet. That UI reads and writes the wallet
#     private key. You reach it over an SSH tunnel:
#         ssh -N -L 4141:127.0.0.1:4141 <user>@<vps-ip>
#     then open http://127.0.0.1:4141 on your own machine.
#   - write any key for you. Keys go in via the panel or .env, by you.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/lhuntleyy/hivemind.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/hivemind}"
RUN_USER="${RUN_USER:-hivemind}"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[!]\033[0m %s\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

# ── 1. base packages ────────────────────────────────────────────
log "Updating apt and installing base packages"
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git build-essential python3 ufw fail2ban

# ── 2. Node ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
log "Node $(node -v), npm $(npm -v)"

# ── 3. service user ─────────────────────────────────────────────
# The agent holds a wallet key. Running it as root means any RCE in a dependency is
# root on the box; as an unprivileged user with no shell it is contained to its own
# directory.
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "Creating service user ${RUN_USER}"
  $SUDO useradd --system --create-home --home-dir "/home/${RUN_USER}" --shell /usr/sbin/nologin "$RUN_USER"
fi

# ── 4. code ─────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Updating existing checkout at ${INSTALL_DIR}"
  $SUDO git -C "$INSTALL_DIR" pull --ff-only
else
  log "Cloning ${REPO_URL} into ${INSTALL_DIR}"
  $SUDO mkdir -p "$INSTALL_DIR"
  $SUDO git clone "$REPO_URL" "$INSTALL_DIR"
fi

$SUDO chown -R "${RUN_USER}:${RUN_USER}" "$INSTALL_DIR"

log "Installing npm dependencies"
$SUDO -u "$RUN_USER" bash -lc "cd '$INSTALL_DIR' && npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund"

# ── 5. first-run config ─────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/user-config.json" ]]; then
  log "Seeding user-config.json from the example"
  $SUDO -u "$RUN_USER" cp "$INSTALL_DIR/user-config.example.json" "$INSTALL_DIR/user-config.json"
fi
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  log "Creating an empty .env (0600) — fill it via the control panel"
  $SUDO -u "$RUN_USER" bash -c "printf 'DRY_RUN=true\n' > '$INSTALL_DIR/.env'"
fi
# The wallet key lives here. Nobody but the service user reads it.
$SUDO chmod 600 "$INSTALL_DIR/.env"
$SUDO chmod 700 "$INSTALL_DIR"

# ── 6. firewall ─────────────────────────────────────────────────
# SSH only. The control panel is NOT exposed; see the header of this file.
log "Configuring ufw: SSH in, everything else denied"
$SUDO ufw --force reset >/dev/null
$SUDO ufw default deny incoming
$SUDO ufw default allow outgoing
$SUDO ufw allow OpenSSH
$SUDO ufw --force enable
$SUDO ufw status verbose

$SUDO systemctl enable --now fail2ban >/dev/null 2>&1 || warn "fail2ban did not start; continuing"

# ── 7. systemd ──────────────────────────────────────────────────
# Chosen over PM2 for a headless box: it starts before login, restarts on failure,
# and its sandboxing directives (NoNewPrivileges, ProtectSystem, PrivateTmp) are the
# cheapest hardening available for a process that holds a private key.
log "Installing systemd unit"
$SUDO tee /etc/systemd/system/hivemind.service >/dev/null <<UNIT
[Unit]
Description=Hivemind DLMM agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/index.js
Restart=always
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=120

Environment=NODE_ENV=production
# Loopback only. Binding this to a public interface would publish the wallet key;
# web/server.js refuses to start on one without a token, by design.
Environment=HIVEMIND_WEB_HOST=127.0.0.1

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

StandardOutput=append:${INSTALL_DIR}/logs/service.log
StandardError=append:${INSTALL_DIR}/logs/service.log

[Install]
WantedBy=multi-user.target
UNIT

$SUDO -u "$RUN_USER" mkdir -p "$INSTALL_DIR/logs"
$SUDO systemctl daemon-reload
$SUDO systemctl enable hivemind

log "Setup complete."
cat <<EOF

Next steps
──────────
1. Start it in DRY RUN (the .env this script wrote sets DRY_RUN=true):
     sudo systemctl start hivemind
     sudo journalctl -u hivemind -f

2. From YOUR machine, tunnel to the control panel:
     ssh -N -L 4141:127.0.0.1:4141 \$(whoami)@<this-server-ip>
   then open http://127.0.0.1:4141

3. In the panel: Settings -> LLM provider (pick one, paste key, Test connection),
   then Secrets (wallet key, RPC URL, Helius key).

4. Watch it for a few days in dry run. Check the Overview tab for blank or "—"
   values: in this codebase that is the signature of a risk control that is not
   actually wired.

5. Only then, go live:
     sudo -u ${RUN_USER} sed -i 's/^DRY_RUN=true/DRY_RUN=false/' ${INSTALL_DIR}/.env
     sudo systemctl restart hivemind

Updating later:
     cd ${INSTALL_DIR} && sudo -u hivemind git pull && sudo -u ${RUN_USER} npm install --omit=dev && sudo systemctl restart hivemind

EOF
