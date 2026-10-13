#!/usr/bin/env bash
# Installs a per-user systemd timer that refreshes Forever Auction House prices (AHledger) hourly.
# No sudo. Runs refresh-prices.ts from the Dashboard checkout the knowledge job keeps at the deployed SHA.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
home="${WOWSYNC_KNOWLEDGE_HOME:-$HOME/wowsync-knowledge}"
mkdir -p "$home" "$HOME/.config/systemd/user"
install -m 0700 "$here/refresh-prices-host.sh" "$home/refresh-prices-host.sh"

cat > "$HOME/.config/systemd/user/wowsync-forever-prices.service" <<UNIT
[Unit]
Description=Refresh WoWSync Forever Auction House prices from AHledger (DEV)

[Service]
Type=oneshot
Environment=WOWSYNC_KNOWLEDGE_HOME=$home
ExecStart=$home/refresh-prices-host.sh
TimeoutStartSec=20min
Nice=10
UNIT

cat > "$HOME/.config/systemd/user/wowsync-forever-prices.timer" <<UNIT
[Unit]
Description=Hourly WoWSync Forever price refresh

[Timer]
OnBootSec=5min
OnCalendar=hourly
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now wowsync-forever-prices.timer
systemctl --user list-timers wowsync-forever-prices.timer --no-pager
