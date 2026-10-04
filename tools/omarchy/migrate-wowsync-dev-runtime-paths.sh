#!/usr/bin/bash
set -euo pipefail
umask 077

# Installed root-owned by the reviewed bootstrap. Supports only fixed DEV units
# and the fixed source/release paths; no arbitrary path or unit arguments.
test_root=${WOWSYNC_MIGRATION_TEST_ROOT:-}
test_mode=0
if [[ $(/usr/bin/id -u) -eq 0 ]]; then
  [[ -z "$test_root" ]] || { echo 'Fixture mode is forbidden to root.' >&2; exit 64; }
else
  [[ -n "$test_root" && "$test_root" == /* && "$test_root" != / ]] || { echo 'This operation requires root.' >&2; exit 77; }
  test_mode=1
fi
if [[ "$test_mode" -eq 1 ]]; then
  unit_dir="$test_root/etc/systemd/system"
  state_dir="$test_root/etc/wowsync/dev/runtime-path-migration"
  source_root="$test_root/src/WoWSync-Dashboard"
  release_root="$test_root/releases"
else
  unit_dir=/etc/systemd/system
  state_dir=/etc/wowsync/dev/runtime-path-migration
  source_root=/home/wowsync-dev/src/WoWSync-Dashboard
  release_root=/home/wowsync-dev/releases
fi
readonly target_sha=81f66eeb8a035acf3c633f6fa9d8693cc4f9a009
readonly units=(wowsync-dev-dashboard.service wowsync-dev-mcp-tunnel.service)
mode=${1:-}

die() { echo "runtime-path migration: $*" >&2; exit 1; }
validate_release() {
  [[ -L "$release_root/current" ]] || die 'releases/current must point at the target release before unit migration.'
  [[ $(/usr/bin/readlink -f "$release_root/current") == "$release_root/$target_sha" ]] || die "current does not resolve to required same-SHA release $target_sha."
  [[ -r "$release_root/$target_sha/release.json" ]] || die 'release metadata is missing.'
  /usr/bin/grep -Fq "\"sha\": \"$target_sha\"" "$release_root/$target_sha/release.json" || die 'release metadata SHA mismatch.'
}
validate_old_unit() {
  local file=$1
  /usr/bin/grep -Fqx "WorkingDirectory=$source_root" "$file" || die "Unexpected old WorkingDirectory in $file."
}
make_proposal() {
  local unit=$1 input=$2 output=$3
  /usr/bin/sed "s|$source_root|$release_root/current|g" "$input" > "$output"
  if [[ "$unit" == wowsync-dev-dashboard.service ]]; then
    /usr/bin/sed -i "s|^ExecStart=/usr/bin/node packages/server/src/index.ts$|ExecStart=/usr/bin/node $release_root/current/packages/server/src/index.ts|" "$output"
    /usr/bin/grep -Fqx "ExecStart=/usr/bin/node $release_root/current/packages/server/src/index.ts" "$output" || die 'Dashboard ExecStart substitution did not match.'
  else
    /usr/bin/grep -Fq "$release_root/current/packages/mcp/src/index.ts" "$output" || die 'MCP entry path substitution did not match.'
    /usr/bin/grep -Fqx "Environment=WOWSYNC_MCP_RESEARCH_ROOT=$release_root/current/docs" "$output" || die 'MCP research-root substitution did not match.'
  fi
  /usr/bin/grep -Fqx "WorkingDirectory=$release_root/current" "$output" || die "New WorkingDirectory validation failed for $unit."
  if /usr/bin/grep -Fq "$source_root" "$output"; then die "Old source path remains in proposed $unit."; fi
  if [[ "$test_mode" -eq 0 ]]; then /usr/bin/chown root:root "$output"; fi
  /usr/bin/chmod 0644 "$output"
  systemd_analyze verify "$output"
}
backup_id() { printf '%s-%s' "$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)" "$$"; }
install_root_file() {
  if [[ "$test_mode" -eq 1 ]]; then /usr/bin/install -m "$1" "$2" "$3"; else /usr/bin/install -o root -g root -m "$1" "$2" "$3"; fi
}
install_root_dir() {
  if [[ "$test_mode" -eq 1 ]]; then /usr/bin/install -d -m "$1" "$2"; else /usr/bin/install -d -o root -g root -m "$1" "$2"; fi
}
systemd_analyze() { if [[ "$test_mode" -eq 1 ]]; then "$test_root/bin/systemd-analyze" "$@"; else /usr/bin/systemd-analyze "$@"; fi; }
systemctl_cmd() { if [[ "$test_mode" -eq 1 ]]; then "$test_root/bin/systemctl" "$@"; else /usr/bin/systemctl "$@"; fi; }
curl_cmd() { if [[ "$test_mode" -eq 1 ]]; then "$test_root/bin/curl" "$@"; else /usr/bin/curl "$@"; fi; }
move_file() {
  if [[ "$test_mode" -eq 1 && -f "$test_root/fail-replace-once" && "$2" == "$unit_dir/wowsync-dev-mcp-tunnel.service" ]]; then
    /usr/bin/rm -f "$test_root/fail-replace-once"
    return 1
  fi
  /usr/bin/mv -fT "$1" "$2"
}

case "$mode" in
  apply)
    [[ $# -eq 1 ]] || die 'usage: migrate-wowsync-dev-runtime-paths.sh apply'
    validate_release
    install_root_dir 0700 "$state_dir"
    id=$(backup_id)
    backup="$state_dir/$id"
    [[ ! -e "$backup" ]] || die "Refusing to reuse existing migration backup $id."
    install_root_dir 0700 "$backup"
    staged=$( /usr/bin/mktemp -d "$unit_dir/.wowsync-migration.XXXXXX" )
    trap '/usr/bin/rm -rf -- "${staged:-}"' EXIT
    # Validate both old files and both complete proposals before any replacement.
    for unit in "${units[@]}"; do
      original="$unit_dir/$unit"
      [[ -f "$original" ]] || die "Missing installed unit $original."
      validate_old_unit "$original"
      install_root_file 0600 "$original" "$backup/$unit"
      make_proposal "$unit" "$original" "$staged/$unit"
    done
    /usr/bin/printf '%s\n' "$target_sha" > "$backup/target-sha"
    if [[ "$test_mode" -eq 0 ]]; then /usr/bin/chown root:root "$backup/target-sha"; fi
    /usr/bin/chmod 0600 "$backup/target-sha"
    link_tmp="$state_dir/.current.$$"
    /usr/bin/ln -s "$backup" "$link_tmp"
    /usr/bin/mv -Tf "$link_tmp" "$state_dir/current"
    installed=()
    restore_originals() {
      local unit
      for unit in "${units[@]}"; do
        install_root_file 0644 "$backup/$unit" "$unit_dir/.$unit.restore.$$"
        move_file "$unit_dir/.$unit.restore.$$" "$unit_dir/$unit"
      done
      systemctl_cmd daemon-reload || true
    }
    for unit in "${units[@]}"; do
      if ! move_file "$staged/$unit" "$unit_dir/$unit"; then
        restore_originals
        die "Unit replacement failed; originals restored from $backup."
      fi
      installed+=("$unit")
    done
    if ! systemctl_cmd daemon-reload; then
      restore_originals
      die "daemon-reload failed; original units restored from $backup."
    fi
    echo "Unit paths migrated transactionally. Backup ID: $id. Services were not restarted."
    ;;
  restore)
    [[ $# -eq 2 && ( "$2" == CURRENT || "$2" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ) ]] || die 'usage: migrate-wowsync-dev-runtime-paths.sh restore {CURRENT|BACKUP_ID}'
    if [[ "$2" == CURRENT ]]; then backup=$(/usr/bin/readlink -f "$state_dir/current") || die 'No current migration backup is recorded.'; id=CURRENT
    else backup="$state_dir/$2"; id=$2; fi
    [[ -d "$backup" && $(/usr/bin/stat -c %u "$backup") == 0 ]] || die "Root-owned backup $2 not found."
    for unit in "${units[@]}"; do [[ -f "$backup/$unit" ]] || die "Incomplete backup: $unit missing."; done
    for unit in "${units[@]}"; do
      install_root_file 0644 "$backup/$unit" "$unit_dir/.$unit.restore.$$"
      move_file "$unit_dir/.$unit.restore.$$" "$unit_dir/$unit"
    done
    systemctl_cmd daemon-reload
    systemctl_cmd --job-mode=ignore-dependencies start "${units[@]}"
    systemctl_cmd is-active --quiet "${units[0]}" "${units[1]}" || die 'Old topology units did not both become active.'
    for unit in "${units[@]}"; do
      pid=$(systemctl_cmd show -p MainPID --value "$unit")
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || die "$unit has no running process after topology restore."
      [[ $(/usr/bin/readlink -f "/proc/$pid/cwd") == "$source_root" ]] || die "$unit did not return to the source-checkout runtime."
    done
    curl_cmd --fail --silent --show-error --max-time 5 http://127.0.0.1:4174/ >/dev/null || die 'Restored source-checkout Dashboard HTTP validation failed.'
    curl_cmd --fail --silent --show-error --max-time 5 http://127.0.0.1:4174/api/versions >/dev/null || die 'Restored API validation failed.'
    echo "Restored original source-checkout units from backup $id; Dashboard/MCP active and HTTP validated. Herdr was not touched."
    ;;
  *) die 'usage: migrate-wowsync-dev-runtime-paths.sh {apply|restore BACKUP_ID}' ;;
esac
