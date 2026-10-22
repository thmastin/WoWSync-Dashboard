# Forever crafted-upgrade assessment DEV deployment — 2026-10-12

## Release

- Deployed feature SHA: `e936d4f941efb350ed79b3cdbc1fc62f9a1e5e2d`.
- Previous DEV SHA: `5ac7976b0c8f3415e3d7751c0debfc514e88d50f`.
- Guarded prepare re-verified the exact release as already prepared; schema plan `none`.
- Guarded deployment reported `Schema: unchanged`, Dashboard and MCP healthy, HTTP `/` and `/api/versions` 200, Herdr untouched, and no journal warnings.
- Deployment backup: `/var/lib/wowsync-dev/backups/deploy/20261012T055932.744Z-795fe341-5ac7976b0c8f3415e3d7751c0debfc514e88d50f-to-e936d4f941efb350ed79b3cdbc1fc62f9a1e5e2d.sqlite`; deployment reported SQLite integrity `ok`.
- The deploy command's human-readable result did not print the backup SHA-256. The backup is mode-restricted from the operator shell, so this checkpoint does not invent or claim a checksum. The guarded deployment audit is the operational record for the full backup evidence.
- DEV remains deployed at the feature SHA; no migration, SavedVariables import, ERP mutation, inventory action, or Herdr change was performed.

## Persisted Rordin validation

Read-only REST checks against snapshot 180 (`Forever 1.60.1`, build 70338) returned exactly two positively observed learned equipment recipes and three known learned non-equipment recipes. Recipe catalogue coverage remains partial.

- Copper Bracers: recipe 2663, output 2853, mail wrist (slot 9), 2 Copper Bars (2840); upgrade `UNKNOWN`.
- Rough Copper Vest: recipe 12260, output 10421, mail chest (slot 5), 4 Copper Bars (2840); upgrade `UNKNOWN`.
- The corresponding observed equipped wrist and chest items are returned by the slot projection. Candidate stats and candidate-specific eligibility remain `UNKNOWN`.
- Both Copper Bar observations are `LAST_SEEN`, not current availability. Character bank remains `UNKNOWN`.
- The REST response and AccountContext assessment were structurally identical. Snapshot 180 remained present among 19 Rordin snapshots.
- Rordin's existing Forever ERP project remained `ACTIVE`, revision 5, with seven work orders.

## Validation and limits

- Guarded deployment backup integrity and post-deploy service/HTTP checks passed.
- Focused local stdio MCP protocol test passed: `tools/list` includes `get_forever_crafted_upgrade_assessment`, and its snapshot-180 fixture call agrees with the core projection. This is local protocol acceptance, not connected ChatGPT MCP acceptance.
- Focused Forever Character Detail browser acceptance passed (1/1); no Character Detail regression was observed.
- A live Ask My Account request could not run because the DEV server has no `OPENAI_API_KEY`; AccountContext/LLM context agreement remains covered by the validated release's tests, not a live provider response.
- Connected ChatGPT MCP acceptance remains pending. Do not infer it from local stdio MCP results.
- No live gameplay, recipe craftability, candidate item stats, or eligibility claim is established by this deployment.

## Next action

Have ChatGPT independently call `get_forever_crafted_upgrade_assessment` for Rordin Longbraid, Classic Beta PvP 2, Forever, pinned to snapshot 180. Confirm the two recipe/output/reagent rows and `UNKNOWN` upgrade conclusions. Keep the result read-only and report any tool-catalog or connected-call discrepancy separately.
