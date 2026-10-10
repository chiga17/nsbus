#!/usr/bin/env bash
# Follow the poller logs on the droplet. Ctrl-C stops tailing; the service keeps running.
#   bash server/deploy/logs.sh
#   bash server/deploy/logs.sh root@1.2.3.4
set -euo pipefail

SERVER=${1:-droplet}

ssh -t "$SERVER" "journalctl -u nsbus -n 50 -f"
