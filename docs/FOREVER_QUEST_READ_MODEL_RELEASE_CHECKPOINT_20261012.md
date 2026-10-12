# Forever Quest Read Model Release Checkpoint — 2026-10-12

## Guarded deployment

- Feature ref: `refs/heads/feature/forever-gear-observation`
- Deployed release SHA: `5ac7976b0c8f3415e3d7751c0debfc514e88d50f`
- Expected pre-deployment DEV SHA: `25e9f7e165547bb2da085d3f38a71c8286ab0d2c` (matched).
- Guarded prepare immediately before promotion: `PREPARED` for the exact SHA; schema plan `NONE`; no added, removed, or changed objects; `user_version` 0 → 0.
- Guarded deployment result: `DEPLOYED` / `PROMOTE_SUCCESS` at `2026-10-12T05:18:41.307Z`. No migration ran.
- Previous release: `25e9f7e165547bb2da085d3f38a71c8286ab0d2c`. No rollback was needed.

## Online backup

- Path: `/var/lib/wowsync-dev/backups/deploy/20261012T051837.464Z-17a5caeb-25e9f7e165547bb2da085d3f38a71c8286ab0d2c-to-5ac7976b0c8f3415e3d7751c0debfc514e88d50f.sqlite`
- SHA-256: `77a29fcc40efd34ea8567e3690d5c0b42e961d77ccd08ac943a7f83331cef7ba`
- Guarded workflow result: backup integrity `ok`; schema compatibility unchanged; `user_version` 0.

## Runtime and data preservation

- Post-deployment status: Dashboard and MCP tunnel active/running and healthy; HTTP `/` and `/api/versions` return 200.
- Herdr remained active/running with PID `2937229`, zero restarts, unchanged before/after. It was outside the restart boundary.
- Character counts remain Classic Era 3, TBC Anniversary 3, Retail 16, Forever 8, unknown-version 0 (unchanged from the prior checkpoint).
- Rordin remains at 19 snapshots; snapshot 180 is readable with generation `1791764829`. No SavedVariables were imported or replayed.
- Forever ERP projects: Rordin's project `project_goal_30357e44148dd5dbc3dcbca4ca8afc98a73898c5dc8b039d70f41baa68fe7bde` remains ACTIVE at revision 5 with seven work orders. The second Forever project remains ACTIVE at revision 1. Other version project lists remain empty. No project mutation occurred.

## Quest projection and UI validation

Read-only GET `/api/characters/forever%3A%3Aclassic%20beta%20pvp%202%3A%3Arordin/forever-quests?snapshotId=180` returned HTTP 200 and `FOUND`:

- Provenance: `OBSERVED`, Forever identity `forever::classic beta pvp 2::rordin`, snapshot 180, observation time `1791764792`, `recent` freshness.
- Six active IDs: 384, 400, 96629, 98321, 98322, 99158.
- Completed-history list contains 29 IDs.
- Quest 98322 has `objectiveState: OBSERVED` and `objectives: []`.
- Quest 96629 preserves `isComplete: false`, objective `finished: false`, and progress 1/1.
- Waypoint state is `UNKNOWN` on all six quests.
- AccountContext quest resolution exactly matches the REST response. The live AccountContext was projected with the production `buildLlmContext` function; its Rordin quest resolution exactly matches REST. No model-provider request was sent.
- A headless browser smoke on the live Dashboard rendered all six quest titles, completed-history count, observed-empty objectives, and UNKNOWN waypoints with no page errors.

## MCP verification boundary

- The deployment starts the MCP tunnel from the deployed release and the service reports healthy.
- The local stdio MCP protocol test passed on the deployed candidate source: `tools/list` exposes `get_forever_character_quests`, and a call returns the canonical snapshot-180 projection from the realistic regression fixture.
- The connected ChatGPT WoWSync DEV catalog has independently been checked by the project owner and exposes the quest tool. A connected ChatGPT tool invocation has not been made in this deployment session; do not treat local protocol testing as connected-host acceptance.

Exact read-only connected query for final acceptance:

> Using the WoWSync DEV MCP tool `get_forever_character_quests`, read Forever character Rordin on realm Classic Beta PvP 2 at snapshotId 180. Return the provenance state and freshness, active quest IDs, completed-history ID count, quest 98322 objective state/list, quest 96629 completion and objective progress flags, and waypoint states. Do not import or replay SavedVariables.

## Validation and limits

- Post-deployment live REST, AccountContext, and LLM projection assertions passed.
- Post-deployment browser smoke passed: HTTP 200, six quest titles and history visible, no page errors.
- Focused stdio MCP protocol tests passed: 2/2. These validate registration and projection agreement with realistic fixture data, not a connected ChatGPT invocation.
- Pre-deployment validation: 317 workspace unit tests passed; typecheck, production build, and all 25 browser tests passed; deploy-tool suite 92/92 passed.
- Gear GUID guard was unchanged. No SavedVariables, ERP project, GearExport, BankCleanup, or Herdr changes were made.
- The deployment is live and healthy. Final independent connected ChatGPT MCP acceptance remains pending the read-only query above.
