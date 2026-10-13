#!/usr/bin/env bash
# Installs a per-user systemd timer that runs refresh-host.sh daily (and 10 minutes after boot).
# No sudo: uses `systemctl --user`; the account needs lingering enabled to run while logged out.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
home="${WOWSYNC_KNOWLEDGE_HOME:-$HOME/wowsync-knowledge}"
mkdir -p "$home" "$HOME/.config/systemd/user"
install -m 0700 "$here/refresh-host.sh" "$home/refresh-host.sh"

cat > "$HOME/.config/systemd/user/wowsync-forever-knowledge.service" <<UNIT
[Unit]
Description=Rebuild and install the private WoWSync Forever knowledge bundle (DEV)

[Service]
Type=oneshot
Environment=WOWSYNC_KNOWLEDGE_HOME=$home
ExecStart=$home/refresh-host.sh
TimeoutStartSec=2h
Nice=10
UNIT

cat > "$HOME/.config/systemd/user/wowsync-forever-knowledge.timer" <<UNIT
[Unit]
Description=Daily WoWSync Forever knowledge refresh

[Timer]
OnBootSec=10min
OnCalendar=*-*-* 05:30:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now wowsync-forever-knowledge.timer
systemctl --user list-timers wowsync-forever-knowledge.timer --no-pager
