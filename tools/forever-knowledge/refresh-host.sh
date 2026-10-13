#!/usr/bin/env bash
# Rebuilds the private Forever knowledge bundle on the DEV host and installs it into the DEV Dashboard.
#
# Runs as an ordinary user (no sudo): it reads the account's observed IDs and installs the bundle through
# the loopback Dashboard API, so it never touches the wowsync-dev data directory directly.
#   - QuestieDB is cloned/updated under $WOWSYNC_KNOWLEDGE_HOME (default ~/wowsync-knowledge).
#   - The builder comes from the Dashboard SHA that DEV is running (wowsync-dev-deploy status), so the
#     bundle format always matches the deployed reader.
#   - Wowhead tooltips are cached under cache/; reruns fetch only new IDs.
#   - The bundle is installed only when its content changed. Status goes to status.json.
set -euo pipefail
umask 077

home="${WOWSYNC_KNOWLEDGE_HOME:-$HOME/wowsync-knowledge}"
dashboard_url="${WOWSYNC_DEV_URL:-http://127.0.0.1:4174}"
repo_url="${WOWSYNC_DASHBOARD_REPO:-https://github.com/thmastin/WoWSync-Dashboard.git}"
questie_url="${WOWSYNC_QUESTIE_REPO:-https://github.com/Questie/QuestieDB.git}"
mkdir -p "$home/cache"
cd "$home"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

write_status() {
  printf '{"startedAt":"%s","finishedAt":"%s","outcome":"%s","detail":"%s","dashboardSha":"%s","questieRevision":"%s"}\n' \
    "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${sha:-}" "${questie_rev:-}" > status.json
}
trap 'write_status failed "line $LINENO"' ERR

if [[ -d QuestieDB/.git ]]; then
  git -C QuestieDB fetch --quiet --depth 1 origin
  git -C QuestieDB reset --quiet --hard FETCH_HEAD
else
  git clone --quiet --depth 1 "$questie_url" QuestieDB
fi
questie_rev="$(git -C QuestieDB rev-parse HEAD)"

sha="$(wowsync-dev-deploy status 2>/dev/null | awk '/^SHA:/ {print $2; exit}')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { write_status failed "could not read the deployed DEV SHA"; exit 1; }
if [[ ! -d dashboard/.git ]]; then git clone --quiet --filter=blob:none "$repo_url" dashboard; fi
git -C dashboard fetch --quiet origin
git -C dashboard checkout --quiet --detach "$sha"

node --disable-warning=ExperimentalWarning dashboard/tools/forever-knowledge/build-bundle.ts \
  --questie QuestieDB --out bundle.new.json --cache cache --observed-url "$dashboard_url" > build.log 2>&1

# Content hash without the build timestamp decides whether anything changed.
content_hash() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); delete b.builtAt; process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(b)).digest("hex"))' "$1"; }
new_hash="$(content_hash bundle.new.json)"
old_hash="$(cat installed.sha256 2>/dev/null || true)"
remote_installed="$(curl -fsS -m 30 "$dashboard_url/api/versions/forever/knowledge" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).installed===true)))')"
if [[ "$new_hash" == "$old_hash" && "$remote_installed" == "true" ]]; then
  rm -f bundle.new.json
  write_status unchanged "content $new_hash already installed"
  exit 0
fi
curl -fsS -m 300 -X PUT -H 'content-type: application/octet-stream' --data-binary @bundle.new.json \
  "$dashboard_url/api/versions/forever/knowledge" > install.json
mv bundle.new.json bundle.json
printf '%s' "$new_hash" > installed.sha256
write_status installed "content $new_hash"
