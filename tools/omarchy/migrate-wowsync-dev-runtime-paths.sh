#!/usr/bin/bash
set -euo pipefail

# One-time root action after preparing the release and taking the requested
# backup. Modify only source-root path strings in the installed app unit files.
# This deliberately preserves the live MCP ExecStart tunnel-ID configuration.
if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this one-time migration as root through an administrator terminal.' >&2
  exit 77
fi
if [[ $# -ne 0 ]]; then
  echo 'This migration accepts no arguments.' >&2
  exit 64
fi

sha="${WOWSYNC_DEV_MIGRATION_SHA:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Set WOWSYNC_DEV_MIGRATION_SHA to the full prepared SHA.' >&2
  exit 64
fi
release="/home/wowsync-dev/releases/$sha"
if [[ ! -r "$release/release.json" ]] || ! /usr/bin/grep -Fq "\"sha\": \"$sha\"" "$release/release.json"; then
  echo "No prepared exact-SHA release found at $release" >&2
  exit 1
fi

readonly old_root='/home/wowsync-dev/src/WoWSync-Dashboard'
readonly new_root='/home/wowsync-dev/releases/current'
readonly unit_dir='/etc/systemd/system'
for unit in wowsync-dev-dashboard.service wowsync-dev-mcp-tunnel.service; do
  source="$unit_dir/$unit"
  [[ -f "$source" ]] || { echo "Missing installed unit: $source" >&2; exit 1; }
  if /usr/bin/grep -Fq "$old_root" "$source"; then
    temporary="$(/usr/bin/mktemp "$unit_dir/.${unit}.runtime-path.XXXXXX")"
    trap '/usr/bin/rm -f -- "${temporary:-}"' EXIT
    /usr/bin/sed \
      -e "s|$old_root|$new_root|g" \
      -e "s|^ExecStart=/usr/bin/node packages/server/src/index.ts$|ExecStart=/usr/bin/node $new_root/packages/server/src/index.ts|" \
      "$source" > "$temporary"
    /usr/bin/chown root:root "$temporary"
    /usr/bin/chmod 0644 "$temporary"
    /usr/bin/mv -f -- "$temporary" "$source"
    trap - EXIT
  elif ! /usr/bin/grep -Fq "$new_root" "$source"; then
    echo "Could not find either source or release path in $source; refusing to guess." >&2
    exit 1
  fi
done

/usr/bin/grep -Fqx "WorkingDirectory=$new_root" "$unit_dir/wowsync-dev-dashboard.service"
/usr/bin/grep -Fqx "ExecStart=/usr/bin/node $new_root/packages/server/src/index.ts" \
  "$unit_dir/wowsync-dev-dashboard.service"
/usr/bin/grep -Fqx "WorkingDirectory=$new_root" "$unit_dir/wowsync-dev-mcp-tunnel.service"
/usr/bin/grep -Fq "$new_root/packages/mcp/src/index.ts" "$unit_dir/wowsync-dev-mcp-tunnel.service"
/usr/bin/grep -Fqx "Environment=WOWSYNC_MCP_RESEARCH_ROOT=$new_root/docs" \
  "$unit_dir/wowsync-dev-mcp-tunnel.service"

/usr/bin/systemctl daemon-reload
echo 'Updated Dashboard/MCP source paths only. No service was restarted.'
