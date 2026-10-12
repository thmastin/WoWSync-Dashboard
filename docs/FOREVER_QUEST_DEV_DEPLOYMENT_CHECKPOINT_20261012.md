# Forever quest DEV deployment checkpoint — 2026-10-12

## Promotion

- Result: guarded DEV deployment succeeded.
- Authorized and deployed release SHA: `25e9f7e165547bb2da085d3f38a71c8286ab0d2c`.
- Expected and observed pre-deployment DEV SHA: `2d8dc391715576e88adc27923d7d357d09127950`.
- Deployment completed at `2026-10-12T03:59:27.532Z`.
- Guarded preparation was repeated immediately before promotion and returned `PREPARED` for the exact SHA.
- Schema plan: `NONE`; no added, removed, or changed objects; `user_version` 0 → 0. No migration ran.

## Backup and deployment checks

- Online SQLite backup: `/var/lib/wowsync-dev/backups/deploy/20261012T035912.279Z-d18dc3da-2d8dc391715576e88adc27923d7d357d09127950-to-25e9f7e165547bb2da085d3f38a71c8286ab0d2c.sqlite`.
- Backup SHA-256: `42fd630650146666916f8efc5bc7ba45db9d90a79c6bec643ceecf51ed02a04f`.
- Backup `PRAGMA integrity_check`: `ok`. The guarded deployment also reported integrity `ok` and schema compatibility before and after promotion.
- Post-deploy guarded status: healthy at the exact deployed SHA. Dashboard and MCP tunnel are active/running with zero restarts; `/` and `/api/versions` return HTTP 200.
- Herdr remained active/running with the same PID (`2937229`) and zero restarts. It was not included in the restart operation.
- No rollback was needed or run.

## Data and read-only smoke checks

- Read-only MCP calls succeeded for version-scoped character listings and ERP project retrieval. The connected DEV view returned 3 Classic Era, 3 TBC Anniversary, 16 Retail, and 8 Forever characters.
- ERP project listing returned two Forever projects and none in the other three versions. Rordin's Forever project (`project_goal_30357e44148dd5dbc3dcbca4ca8afc98a73898c5dc8b039d70f41baa68fe7bde`) remains ACTIVE at revision 5. The guarded workflow made no data/schema changes; deployment record validation passed.
- Rordin's latest observed character record remains level 6 with 19 snapshots and latest generation `1791764829`. No SavedVariables import/replay was run.
- Read-only REST request to `/api/characters/forever%3A%3Aclassic%20beta%20pvp%202%3A%3Arordin/forever-quests` returned HTTP 200 and `FOUND`, with quest provenance state `UNKNOWN`. Missing quest evidence remains acceptable until separately authorized replay.
- The connected MCP catalog successfully served other WoWSync DEV read tools but did not expose `get_forever_character_quests` at checkpoint time. The MCP service itself is healthy; a quest-specific call through the connected tool catalog could not be made.
- GearExport, BankCleanup, and Herdr were not modified. No ERP project was edited by this deployment.

## Remaining gap and next action

Refresh or resynchronize the connected WoWSync DEV MCP tool catalog so `get_forever_character_quests` is available, then make a read-only quest call for Rordin and record its `UNKNOWN`/missing-evidence result as appropriate. Keep SavedVariables replay/import separate and wait for its own authorization.
