# Forever quest DEV preparation checkpoint — 2026-10-11

## Candidate and scope

- Previous candidate: `383ed0e7dc67c90bc1b06411229b930bb9b2627e`.
- Freshness-test fix commit: `0ee95e3f5aaaa61c0fc4f184e6cfe126cb246981` (`test(forever): keep freshness fixture current`).
- DEV baseline: `2d8dc391715576e88adc27923d7d357d09127950`.
- The fix changes only `packages/server/test/characters.test.ts`; it makes the “current observation” fixture recent relative to the test clock, asserts `OBSERVED` and `recent`, and checks that the Forever quest endpoint rejects a same-name Retail identity. Production freshness rules are unchanged.

## Validation and prepare

- The stale fixed timestamp caused the earlier full staging test run to classify the fixture as `LAST_SEEN`; the test expected a current `OBSERVED` item. This was corrected without changing that expectation or weakening the three-day production freshness threshold.
- Focused server and Forever quest/gear tests passed. The full `npm test`, TypeScript check, web build, browser suite, and deploy-tool suites passed using the repository's documented private network namespace where loopback test servers are required. The standalone deploy-tool workflow reported 52/52 passing. A direct combined deploy-tool invocation in the managed sandbox exposed the known namespace/euid mismatch in its installer-permission test; that test passes under the ordinary host identity and the preparation's staging validation passed.
- Focused independent review: PASS. The reviewer confirmed the relative timestamp stays within the freshness window, the test explicitly asserts recent OBSERVED evidence, and Forever/Retail route isolation is exercised.
- Guarded `prepare` for `0ee95e3f5aaaa61c0fc4f184e6cfe126cb246981` completed as `PREPARED`.
- Schema plan: `NONE`; added, removed, and changed objects are all empty; `user_version` is `0 -> 0`.
- Post-prepare guarded status confirmed DEV remained at `2d8dc391715576e88adc27923d7d357d09127950`, healthy, with Dashboard and MCP active and `/` plus `/api/versions` returning 200.
- Prepare did not create a deployment backup, switch releases, or restart services. The guarded deployment workflow takes an online SQLite backup and checks integrity before a deployment switch; code rollback uses the guarded `rollback <previous-full-sha>` command. No rollback was run in this checkpoint.
- No deployment, import, or project mutation was performed. Rordin's SavedVariables replay remains an operator action. To preview without sending, use `npm run import:saved -- --character Rordin --realm "Classic Beta PvP 2" --file "<exact GearExport.lua path>" --dry-run`. The supported eventual import sends the exact persisted latest export through `POST /api/import` and does not modify SavedVariables; it has not been executed.

## Authorization boundary

This is a prepared, no-schema candidate only. It is not deployed. Do not import Rordin's capture or change project data until separately authorized. Before deployment, verify the remote candidate SHA, DEV status, and required backup/rollback readiness again.

## Environment limitation

The canonical `D:\dev\wow-stuff\truth\` checkout is not mounted on Omarchy, and no Linux truth checkout was found under `/home/thmastin`. This version-controlled repository checkpoint records the verified state; synchronize it to canonical truth when that checkout is available.
