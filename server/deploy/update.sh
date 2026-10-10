#!/usr/bin/env bash
# Upload the poller and restart it. Run from your machine after setup.sh:
#   bash server/deploy/update.sh
#   bash server/deploy/update.sh root@1.2.3.4
#
# Ships server/*.py, stops.json, and requirements.txt.
# Secrets come from server/.env.droplet, which is not in git.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SERVER=${1:-droplet}
APP_DIR=/opt/nsbus
SERVICE=nsbus
ARCHIVE=/tmp/nsbus-deploy.tar.gz
ENV_FILE="$REPO_ROOT/server/.env.droplet"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: missing $ENV_FILE"
  echo "Copy server/.env.example to server/.env.droplet and fill it in."
  exit 1
fi

for key in NSMART_API_URL NSMART_AUTH_HEADER NSMART_AUTH_VALUE CLIENT_TOKEN; do
  if ! grep -Eq "^${key}=.+" "$ENV_FILE"; then
    echo "ERROR: $key is empty in server/.env.droplet"
    exit 1
  fi
done

if ! grep -Eq '^HOST=0\.0\.0\.0[[:space:]]*$' "$ENV_FILE"; then
  echo "ERROR: set HOST=0.0.0.0 in server/.env.droplet so the droplet accepts connections."
  exit 1
fi

PORT=$(grep -E '^PORT=' "$ENV_FILE" | head -n 1 | cut -d= -f2- | tr -d '[:space:]')
PORT=${PORT:-8080}

echo "==> Checking the droplet"
ssh "$SERVER" "test -d $APP_DIR/.venv" || {
  echo "ERROR: $APP_DIR/.venv is missing. Run bash server/deploy/setup.sh first."
  exit 1
}

echo "==> Uploading poller to $SERVER:$APP_DIR"
tar -czf "$ARCHIVE" -C "$REPO_ROOT" \
  server/app.py \
  server/config.py \
  server/nsmart.py \
  server/stops.json \
  server/requirements.txt

scp "$ARCHIVE" "$SERVER:/tmp/nsbus-deploy.tar.gz"
# Drop CR so a file saved on Windows still parses on the droplet.
tr -d '\r' < "$ENV_FILE" | ssh "$SERVER" "cat > $APP_DIR/server/.env"
rm -f "$ARCHIVE"

echo "==> Installing dependencies and restarting"
ssh "$SERVER" "set -euo pipefail
  test -d $APP_DIR/.venv || { echo 'Run server/deploy/setup.sh first'; exit 1; }
  tar -xzf /tmp/nsbus-deploy.tar.gz -C $APP_DIR
  rm -f /tmp/nsbus-deploy.tar.gz
  chmod 600 $APP_DIR/server/.env
  $APP_DIR/.venv/bin/pip install -q -r $APP_DIR/server/requirements.txt
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
    ufw allow ${PORT}/tcp
  fi
  systemctl restart $SERVICE
  systemctl --no-pager -l status $SERVICE
"

echo "==> Done. Poller is listening on port $PORT."
echo "    ssh $SERVER journalctl -u $SERVICE -f"
