# Forever Quest Read Model Release Checkpoint — 2026-10-12

## Candidate and guarded preparation

- Feature ref: `refs/heads/feature/forever-gear-observation`
- Prepared release SHA: `5ac7976b0c8f3415e3d7751c0debfc514e88d50f`
- Expected and observed DEV baseline: `25e9f7e165547bb2da085d3f38a71c8286ab0d2c`
- Guarded command: `wowsync-dev-deploy prepare feature/forever-gear-observation 5ac7976b0c8f3415e3d7751c0debfc514e88d50f --json`
- Result: `PREPARED`; schema plan `NONE`; `user_version` 0 → 0; no declarations or plan problems.
- DEV was healthy before and after preparation. Preparation did not promote code, restart services, mutate snapshots, or create a database backup.
- The online SQLite backup and its integrity check are deployment-time requirements and remain pending deployment authorization. The documented guarded rollback workflow remains the only rollback path; no rollback was needed.

## Validation

- Focused quest/core, REST, and stdio MCP tests: 29 passed, 1 opt-in test skipped.
- Workspace validation (`npm run validate:erp`): 317 unit tests passed; typecheck passed; web build passed; 25 browser tests passed.
- Deploy-tool validation (`npm run test:deploy-tool`): 92 passed.
- `git diff --check`: passed.
- Live DEV status: Dashboard, MCP tunnel, and HTTP `/` plus `/api/versions` healthy at the baseline SHA.

## Snapshot-180 correction

Snapshot 180's canonical Forever character quest sidecar now resolves independently of the gear observation's historical GUID consistency check. The canonical character identity, selected snapshot id, sidecar identity, export generation, freshness, and evidence states are retained. The gear GUID protection was left unchanged and regression tested.

The same read model projection is exposed by the quest REST route, AccountContext, stdio MCP tool `get_forever_character_quests`, and Character Detail. Ask My Account receives the same quest projection through its LLM context. Fixtures cover the six active IDs, 29 completed-history IDs, observed-empty objectives for 98322, contradictory progress/completion data for 96629, and unknown waypoints. No SavedVariables were imported and no DEV data or ERP project was changed.

The active connected-app tool catalog in the development execution environment did not list `get_forever_character_quests`, even though local stdio MCP `tools/list` exposed it and protocol calls returned the canonical projection. The previously reported successful ChatGPT invocation and the latest absent-tool report cannot be reconciled from the local repository: they may reflect different connector instances or catalog snapshots. Host-side protocol exposure remains to be checked after release; local registration alone is not treated as connected-host acceptance.

## Deployment gate

This checkpoint records preparation only. Do not deploy from this checkpoint without separate explicit deployment authorization. On authorization, use the exact prepared SHA and standard guarded workflow; require its online SQLite backup to pass integrity checks before promotion, then verify Dashboard/MCP/HTTP health, preserved data and Rordin's project, Herdr untouched, and read-only quest REST/MCP behavior. Do not import SavedVariables.

Current live quest route behavior remains unvalidated on the candidate because DEV deployment is intentionally stopped at the authorization gate. Until then, the deployed baseline retains the known FOUND/UNKNOWN defect.
