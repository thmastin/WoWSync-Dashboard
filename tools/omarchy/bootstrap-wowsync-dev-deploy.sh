#!/usr/bin/bash
set -euo pipefail
umask 077

# This script may only be run from a root-owned immutable export of the exact
# reviewed commit. Never invoke it from /home/wowsync-dev/src.
[[ $(/usr/bin/id -u) -eq 0 ]] || { echo 'Run as administrator from the trusted export.' >&2; exit 77; }
[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || { echo 'Usage: bootstrap-wowsync-dev-deploy.sh FULL_REVIEWED_SHA' >&2; exit 64; }
readonly root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
readonly expected=$1
[[ $(/usr/bin/stat -c %u "$root") == 0 ]] || { echo 'Trusted export root is not administrator-owned.' >&2; exit 1; }
if /usr/bin/find "$root" -xdev \( ! -uid 0 -o -perm /022 \) -print -quit | /usr/bin/grep -q .; then
  echo 'Trusted export contains non-root-owned or group/world-writable content.' >&2
  exit 1
fi
[[ -f "$root/.reviewed-source-sha" && $(<"$root/.reviewed-source-sha") == "$expected" ]] || { echo 'Trusted export SHA marker does not match requested reviewed SHA.' >&2; exit 1; }
[[ -f "$root/ops/privileged-artifact-sha256.txt" ]] || { echo 'Pinned privileged artifact manifest is missing.' >&2; exit 1; }
(cd "$root" && /usr/bin/sha256sum --check --strict ops/privileged-artifact-sha256.txt)

readonly helper_src="$root/tools/omarchy/wowsync-dev-app-services"
readonly migration_src="$root/tools/omarchy/migrate-wowsync-dev-runtime-paths.sh"
readonly sudoers_src="$root/ops/sudoers/wowsync-dev-deploy"
readonly libexec=/usr/local/libexec/wowsync-dev
readonly helper=/usr/local/sbin/wowsync-dev-app-services
readonly sudoers=/etc/sudoers.d/wowsync-dev-deploy

/usr/bin/install -d -o root -g root -m 0755 "$libexec"
for pair in "$helper_src:$helper" "$migration_src:$libexec/migrate-runtime-paths"; do
  src=${pair%%:*}; dst=${pair#*:}
  tmp="${dst}.install.$$"
  /usr/bin/install -o root -g root -m 0755 "$src" "$tmp"
  /usr/bin/mv -fT "$tmp" "$dst"
done

# Validate the exact staged sudoers bytes, then atomically activate that file.
sudo_tmp="/etc/sudoers.d/.wowsync-dev-deploy.$$"
cleanup() { /usr/bin/rm -f -- "$sudo_tmp"; }
trap cleanup EXIT
/usr/bin/install -o root -g root -m 0440 "$sudoers_src" "$sudo_tmp"
/usr/sbin/visudo -cf "$sudo_tmp"
sudo_previous=""
if [[ -e "$sudoers" ]]; then
  sudo_previous="/etc/sudoers.d/.wowsync-dev-deploy.previous.$$"
  /usr/bin/install -o root -g root -m 0440 "$sudoers" "$sudo_previous"
fi
/usr/bin/mv -fT "$sudo_tmp" "$sudoers"
if ! /usr/sbin/visudo -cf /etc/sudoers; then
  if [[ -n "$sudo_previous" ]]; then /usr/bin/mv -fT "$sudo_previous" "$sudoers"; else /usr/bin/rm -f "$sudoers"; fi
  /usr/sbin/visudo -cf /etc/sudoers || true
  exit 1
fi
if [[ -n "$sudo_previous" ]]; then /usr/bin/rm -f "$sudo_previous"; fi
trap - EXIT
echo "Installed reviewed WoWSync DEV deployment helper from $expected."
