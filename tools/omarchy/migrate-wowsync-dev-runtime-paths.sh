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
  canonical_test_root=$(/usr/bin/readlink -f "$test_root") || { echo 'Fixture root must already exist.' >&2; exit 64; }
  case "$canonical_test_root" in /tmp/*|/var/tmp/*) ;; *) echo 'Fixture mode is limited to private temporary directories.' >&2; exit 64 ;; esac
  [[ "$canonical_test_root" == "$test_root" && $(/usr/bin/stat -c %u "$test_root") == "$(/usr/bin/id -u)" ]] || { echo 'Fixture root must be a real directory owned by the invoking user.' >&2; exit 64; }
  fixture_mode=$(/usr/bin/stat -c %a "$test_root")
  (( (8#$fixture_mode & 077) == 0 )) || { echo 'Fixture root permissions must exclude group and other access.' >&2; exit 64; }
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
readonly production_ready_timeout_ms=30000
readonly production_poll_interval_ms=250
readonly production_settle_ms=1500
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
sleep_cmd() { if [[ "$test_mode" -eq 1 && -x "$test_root/bin/sleep" ]]; then "$test_root/bin/sleep" "$1"; else /usr/bin/sleep "$1"; fi; }
move_file() {
  if [[ "$test_mode" -eq 1 && -f "$test_root/fail-replace-once" && "$2" == "$unit_dir/wowsync-dev-mcp-tunnel.service" ]]; then
    /usr/bin/rm -f "$test_root/fail-replace-once"
    return 1
  fi
  /usr/bin/mv -fT "$1" "$2"
}
restore_ready_timeout_ms=$production_ready_timeout_ms
restore_poll_interval_ms=$production_poll_interval_ms
restore_settle_ms=$production_settle_ms
if [[ "$test_mode" -eq 1 ]]; then
  # Fixture-only timing overrides are available only to non-root tests using a
  # private temp root. Production values above remain fixed.
  restore_ready_timeout_ms=${WOWSYNC_MIGRATION_TEST_TIMEOUT_MS:-1000}
  restore_poll_interval_ms=${WOWSYNC_MIGRATION_TEST_INTERVAL_MS:-25}
  restore_settle_ms=${WOWSYNC_MIGRATION_TEST_SETTLE_MS:-100}
fi
restore_validate_services() {
  local unit active result pid cwd
  for unit in "${units[@]}"; do
    active=$(systemctl_cmd show -p ActiveState --value "$unit") || die "Could not inspect restored $unit ActiveState."
    result=$(systemctl_cmd show -p Result --value "$unit") || die "Could not inspect restored $unit Result."
    pid=$(systemctl_cmd show -p MainPID --value "$unit") || die "Could not inspect restored $unit MainPID."
    [[ "$active" == active && "$result" == success ]] || die "$unit is not active/successful after restore (ActiveState=$active Result=$result)."
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || die "$unit has no running process after topology restore (MainPID=$pid)."
    if [[ "$test_mode" -eq 1 ]]; then
      cwd=$(/usr/bin/readlink -f "/proc/$pid/cwd") || die "Could not inspect restored $unit working directory (PID $pid)."
    else
      cwd=$(/usr/bin/readlink -f "/proc/$pid/cwd") || die "Could not inspect restored $unit working directory (PID $pid)."
    fi
    [[ "$cwd" == "$source_root" ]] || die "$unit did not return to the source-checkout runtime (cwd=$cwd)."
  done
}
restore_http_probe() {
  local route=$1 status
  status=$(curl_cmd --silent --show-error --connect-timeout 1 --max-time 3 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:4174$route" 2>&1) || {
    RESTORE_LAST_HTTP_ERROR="GET $route failed: $status"
    return 1
  }
  [[ "$status" == 200 ]] || { RESTORE_LAST_HTTP_ERROR="GET $route returned HTTP $status, expected 200"; return 1; }
}
restore_wait_http_ready() {
  local started now settle_until
  started=$(/usr/bin/date +%s%3N)
  RESTORE_LAST_HTTP_ERROR='no successful HTTP response'
  while :; do
    if restore_http_probe / && restore_http_probe /api/versions; then break; fi
    now=$(/usr/bin/date +%s%3N)
    if (( now - started >= restore_ready_timeout_ms )); then
      die "Dashboard HTTP readiness timed out after ${restore_ready_timeout_ms}ms: $RESTORE_LAST_HTTP_ERROR"
    fi
    sleep_cmd "$(awk -v ms="$restore_poll_interval_ms" 'BEGIN { printf "%.3f", ms/1000 }')"
  done
  now=$(/usr/bin/date +%s%3N)
  settle_until=$((now + restore_settle_ms))
  while (( now < settle_until )); do
    sleep_cmd "$(awk -v ms="$restore_poll_interval_ms" 'BEGIN { printf "%.3f", ms/1000 }')"
    restore_http_probe / || die "Dashboard HTTP stability check failed after readiness: $RESTORE_LAST_HTTP_ERROR"
    restore_http_probe /api/versions || die "Dashboard API stability check failed after readiness: $RESTORE_LAST_HTTP_ERROR"
    now=$(/usr/bin/date +%s%3N)
  done
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
    if [[ "$test_mode" -eq 1 ]]; then
      [[ "$backup" == "$state_dir/"* && -d "$backup" && $(/usr/bin/stat -c %u "$backup") == "$(/usr/bin/id -u)" ]] || die "Fixture-owned backup $2 not found inside the private fixture root."
    else
      [[ -d "$backup" && $(/usr/bin/stat -c %u "$backup") == 0 ]] || die "Root-owned backup $2 not found."
    fi
    for unit in "${units[@]}"; do [[ -f "$backup/$unit" ]] || die "Incomplete backup: $unit missing."; done
    for unit in "${units[@]}"; do
      install_root_file 0644 "$backup/$unit" "$unit_dir/.$unit.restore.$$"
      move_file "$unit_dir/.$unit.restore.$$" "$unit_dir/$unit"
    done
    systemctl_cmd daemon-reload
    systemctl_cmd --job-mode=ignore-dependencies restart "${units[@]}"
    restore_wait_http_ready
    restore_validate_services
    echo "Restored original source-checkout units from backup $id; Dashboard/MCP active/successful and HTTP stable. Herdr was not touched."
    ;;
  *) die 'usage: migrate-wowsync-dev-runtime-paths.sh {apply|restore BACKUP_ID}' ;;
esac
