#!/usr/bin/env bash
# First-time droplet setup. Run from your machine:
#   bash server/deploy/setup.sh              # SSH host "droplet"
#   bash server/deploy/setup.sh root@1.2.3.4
#
# Installs Python, a virtualenv, and the systemd service. Does not upload code.
# After this, fill in server/.env.droplet and run server/deploy/update.sh.
set -euo pipefail

SERVER=${1:-droplet}

if [ "$(uname -s 2>/dev/null || true)" != "Linux" ] \
  || [ ! -d /etc/systemd/system ] \
  || [ "$(id -u 2>/dev/null || echo 1)" -ne 0 ]; then
  THIS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  echo "==> Setting up SSH host '$SERVER'"
  ssh "$SERVER" "bash -s" < "$THIS"
  exit $?
fi

APP_DIR=/opt/nsbus
SERVICE=nsbus

echo "==> Installing Python"
apt-get update -qq
apt-get install -y python3-venv

echo "==> Creating $APP_DIR"
mkdir -p "$APP_DIR/server"
if [ ! -d "$APP_DIR/.venv" ]; then
  python3 -m venv "$APP_DIR/.venv"
fi

echo "==> Installing systemd service"
cat > /etc/systemd/system/${SERVICE}.service << EOF
[Unit]
Description=nsbus NSmart poller
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python server/app.py
EnvironmentFile=$APP_DIR/server/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"

echo ""
echo "==> Done. From your machine:"
echo "    1. cp server/.env.example server/.env.droplet"
echo "       Set HOST=0.0.0.0, PORT, and CLIENT_ORIGIN to the public site."
echo "    2. bash server/deploy/update.sh"
echo "    Logs: journalctl -u $SERVICE -f"
