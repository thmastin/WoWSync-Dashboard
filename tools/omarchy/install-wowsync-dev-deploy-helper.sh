#!/usr/bin/bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
helper_source="$repo_root/tools/omarchy/wowsync-dev-app-services"
sudoers_source="$repo_root/ops/sudoers/wowsync-dev-deploy"

sudo visudo -cf "$sudoers_source"
sudo install -o root -g root -m 0755 "$helper_source" \
  /usr/local/sbin/wowsync-dev-app-services
sudo install -o root -g root -m 0440 "$sudoers_source" \
  /etc/sudoers.d/wowsync-dev-deploy
sudo visudo -cf /etc/sudoers

printf 'Installed the fixed WoWSync DEV Dashboard/MCP service helper.\n'
