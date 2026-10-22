#!/usr/bin/env bash
# Hourly: fetch Forever Auction House prices from AHledger and install them into the DEV Dashboard.
# Uses the Dashboard checkout at the deployed SHA (shared with the knowledge job). Status in prices-status.json.
set -euo pipefail
umask 077
home="${WOWSYNC_KNOWLEDGE_HOME:-$HOME/wowsync-knowledge}"
dashboard_url="${WOWSYNC_DEV_URL:-http://127.0.0.1:4174}"
repo_url="${WOWSYNC_DASHBOARD_REPO:-https://github.com/thmastin/WoWSync-Dashboard.git}"
cd "$home"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status() {
  printf '{"startedAt":"%s","finishedAt":"%s","outcome":"%s","detail":"%s","dashboardSha":"%s"}\n' \
    "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${sha:-}" > prices-status.json
}
trap 'write_status failed "line $LINENO"' ERR

sha="$(wowsync-dev-deploy status 2>/dev/null | awk '/^SHA:/ {print $2; exit}')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { write_status failed "could not read the deployed DEV SHA"; exit 1; }
if [[ ! -d dashboard/.git ]]; then git clone --quiet --filter=blob:none "$repo_url" dashboard; fi
if [[ "$(git -C dashboard rev-parse HEAD)" != "$sha" ]]; then
  git -C dashboard fetch --quiet origin
  git -C dashboard checkout --quiet --detach "$sha"
fi

node --disable-warning=ExperimentalWarning dashboard/tools/forever-prices/refresh-prices.ts \
  --dashboard "$dashboard_url" > prices.log 2>&1
write_status installed "$(tail -1 prices.log | tr -d '"\\' | cut -c1-200)"
