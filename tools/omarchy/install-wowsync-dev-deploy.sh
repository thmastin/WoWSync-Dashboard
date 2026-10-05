#!/usr/bin/bash
# Install the DEV deployment entry points from this checkout (administrator):
#   /usr/local/sbin/wowsync-dev-app-services  stop/start helper for Dashboard + MCP only
#   /usr/local/bin/wowsync-dev-deploy         launcher: any login -> wowsync-dev -> deployed tool
#   /etc/sudoers.d/wowsync-dev-deploy         the two NOPASSWD rules for those files
# Does not start, stop, or deploy anything.
set -euo pipefail
umask 022

[[ $(/usr/bin/id -u) -eq 0 ]] || { echo 'Run as administrator: sudo tools/omarchy/install-wowsync-dev-deploy.sh' >&2; exit 77; }
readonly root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
readonly sudoers=/etc/sudoers.d/wowsync-dev-deploy

# Validate the exact sudoers bytes before touching anything.
/usr/sbin/visudo -cf "$root/ops/sudoers/wowsync-dev-deploy"

for pair in \
  "$root/tools/omarchy/wowsync-dev-app-services:/usr/local/sbin/wowsync-dev-app-services" \
  "$root/tools/omarchy/wowsync-dev-deploy:/usr/local/bin/wowsync-dev-deploy"; do
  src=${pair%%:*}; dst=${pair#*:}
  tmp="${dst}.install.$$"
  /usr/bin/install -o root -g root -m 0755 "$src" "$tmp"
  /usr/bin/mv -fT "$tmp" "$dst"
done

# Activate the sudoers fragment atomically; restore the previous one if the
# full configuration no longer validates, so sudo itself is never left broken.
sudo_tmp="/etc/sudoers.d/.wowsync-dev-deploy.$$"
sudo_previous=""
cleanup() { /usr/bin/rm -f -- "$sudo_tmp"; }
trap cleanup EXIT
/usr/bin/install -o root -g root -m 0440 "$root/ops/sudoers/wowsync-dev-deploy" "$sudo_tmp"
/usr/sbin/visudo -cf "$sudo_tmp"
if [[ -e "$sudoers" ]]; then
  sudo_previous="/etc/sudoers.d/.wowsync-dev-deploy.previous.$$"
  /usr/bin/install -o root -g root -m 0440 "$sudoers" "$sudo_previous"
fi
/usr/bin/mv -fT "$sudo_tmp" "$sudoers"
if ! /usr/sbin/visudo -c >/dev/null; then
  if [[ -n "$sudo_previous" ]]; then /usr/bin/mv -fT "$sudo_previous" "$sudoers"; else /usr/bin/rm -f -- "$sudoers"; fi
  echo 'Full sudoers configuration failed validation; the previous fragment was restored.' >&2
  exit 1
fi
[[ -z "$sudo_previous" ]] || /usr/bin/rm -f -- "$sudo_previous"
echo "Installed WoWSync DEV deploy entry points from $(git -C "$root" rev-parse HEAD 2>/dev/null || echo "$root")."
