#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev.target" \
  /etc/systemd/system/wowsync-dev.target
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev-dashboard.service.d/90-wowsync-dev-target.conf" \
  /etc/systemd/system/wowsync-dev-dashboard.service.d/90-wowsync-dev-target.conf
sudo install -D -o root -g root -m 0755 \
  "$repo_root/tools/omarchy/wowsync-dev" \
  /usr/local/bin/wowsync-dev
sudo systemctl daemon-reload
sudo systemctl enable wowsync-dev.target
sudo systemctl disable wowsync-dev-dashboard.service
sudo systemctl start wowsync-dev.target
"/usr/local/bin/wowsync-dev" status
