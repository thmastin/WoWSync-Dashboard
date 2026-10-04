#!/usr/bin/env bash
set -euo pipefail

# Host-only prerequisites this script deliberately does NOT install:
#   - the `wowsync-dev` system user/group and /home/wowsync-dev
#   - /usr/bin/herdr (the herdr binary itself)
#   - /opt/wowsync/dev-tools/tunnel-client/v0.0.15/tunnel-client (the tunnel-client binary)
#   - /etc/wowsync/dev/tunnel-api-key (the real tunnel-client control-plane API key)
#   - /etc/wowsync/dev/mcp-tunnel.env (the real CONTROL_PLANE_TUNNEL_ID value;
#     see ops/systemd/wowsync-dev-mcp-tunnel.env.example for the expected shape)
#   - /etc/wowsync/dev/capture.env (consumed by the dashboard's untracked capture.conf drop-in)
# These must already exist on the host before the corresponding service can
# actually run; this script only lays down unit files.

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime_current='/home/wowsync-dev/releases/current'
if [[ ! -L "$runtime_current" || ! -r "$runtime_current/release.json" ]]; then
  echo 'No active SHA release at /home/wowsync-dev/releases/current; prepare and activate a release before installing/starting the DEV units.' >&2
  exit 1
fi
runtime_sha="$(basename -- "$(readlink -f -- "$runtime_current")")"
if [[ ! "$runtime_sha" =~ ^[0-9a-f]{40}$ ]] || ! grep -Fq "\"sha\": \"$runtime_sha\"" "$runtime_current/release.json"; then
  echo 'The current DEV runtime pointer is not a verified SHA-named release.' >&2
  exit 1
fi
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev.target" \
  /etc/systemd/system/wowsync-dev.target
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev-dashboard.service" \
  /etc/systemd/system/wowsync-dev-dashboard.service
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev-dashboard.service.d/90-wowsync-dev-target.conf" \
  /etc/systemd/system/wowsync-dev-dashboard.service.d/90-wowsync-dev-target.conf
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev-mcp-tunnel.service" \
  /etc/systemd/system/wowsync-dev-mcp-tunnel.service
sudo install -D -o root -g root -m 0644 \
  "$repo_root/ops/systemd/wowsync-dev-herdr.service" \
  /etc/systemd/system/wowsync-dev-herdr.service
sudo install -D -o root -g root -m 0755 \
  "$repo_root/tools/omarchy/wowsync-dev" \
  /usr/local/bin/wowsync-dev

# Note: /etc/wowsync/dev/mcp-tunnel.env is intentionally NOT created here.
# Provision it manually from ops/systemd/wowsync-dev-mcp-tunnel.env.example
# with the real tunnel ID before starting wowsync-dev-mcp-tunnel.service.

sudo systemctl daemon-reload
sudo systemctl enable wowsync-dev.target
sudo systemctl disable wowsync-dev-dashboard.service
sudo systemctl start wowsync-dev.target
"/usr/local/bin/wowsync-dev" status
