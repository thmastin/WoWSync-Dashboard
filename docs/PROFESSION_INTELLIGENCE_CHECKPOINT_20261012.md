# Profession intelligence checkpoint — 2026-10-12

Branch: `feature/profession-intelligence`. It is based on `feature/forever-gear-observation` `2440bd4`, which is DEV-deployed at `e936d4f`. Nothing has been deployed from this branch.

## What was broken and why

1. **Rordin's latest assessment was UNKNOWN.** `getForeverCraftedUpgradeAssessment`, `getCharacterProfessions` and `buildAccountFacts` each read recipe rows from the selected or latest snapshot only. Snapshot 190 had no `foreverGearObservation.professionRecipes`, so snapshot 180's observed learned recipes (2663, 12260) were invisible. Neither import nor the store carried Forever recipe evidence across snapshots: the Forever sidecar merge only reconciles duplicate imports of the same export.
2. **Lost parallel work.** `feature/forever-recipe-intelligence` (deployed to DEV 2026-10-11) stored Forever recipes in `characterState` and had import-time LAST_SEEN carry-forward. The next deployment, from sibling branch `feature/forever-gear-observation`, replaced it with a different storage path (`foreverGearObservation.professionRecipes`), and the two were never reconciled. Real snapshot 180 data is in the second path. That branch was therefore **not** merged. Merging it would create two storage contracts. Its progression-metadata validation (`7ca19e2`) remains unported; see Remaining gaps.
3. **Blacksmithing hardcode.** The crafted-upgrade assessment always looked up "Blacksmithing" skill, whatever profession the recipe belonged to.
4. **No cross-character or reagent-location answers.** MCP had no way to ask "which characters can make X" or "where are this recipe's reagents".

## What changed

- `packages/core/src/recipeEvidence.ts` is a shared resolver. It picks the freshest compatible recipe section at or before the selected snapshot and relabels carried rows LAST_SEEN with `sourceSnapshotId`. It refuses to carry rows across client versions (Forever) or differing character GUIDs. It excludes a profession scope that a newer, non-partial observed profession list contradicts, matching Retail tier names by containment. Older pins never borrow newer evidence.
- The crafted-upgrade assessment combines LAST_SEEN recipes with the selected snapshot's own bags, equipment, item evidence and profession skill. It adds `recipeEvidence` plus per-candidate `recipe.evidence`, `sourceSnapshotId` and `profession`, and resolves skill from the recipe's own profession.
- `getCharacterProfessions` (MCP `get_character_professions`) and account facts (`get_account_overview`, `get_profession_coverage`, AccountContext) use the resolver for Forever and Retail.
- New MCP tool `find_recipe_crafters`, by recipeID, outputItemID or name. Results are split into learned, observed-not-learned and unresolved. Characters with no recipe capture are listed separately, never as "unable".
- New MCP tool `get_recipe_reagent_availability`. Reagent OR-alternatives are kept separate, never summed. Holdings are reported per owner: crafter bags (usable), crafter bank (move required) and other characters (transfer not assumed). Each holding carries its own provenance and freshness, and craftability stays `NOT_ESTABLISHED`.
- Ask My Account inherits the fixes through AccountContext. No Ask-specific work was done.

## Coverage matrix

| Capability | Retail | Forever | Classic Era | TBC Anniv. | HC/SSF |
|---|---|---|---|---|---|
| Profession skill | OBSERVED | OBSERVED | OBSERVED | OBSERVED | OBSERVED (quarantine rules) |
| Learned recipes | OBSERVED + LAST_SEEN carry | OBSERVED + LAST_SEEN carry | **UNKNOWN (addon P1)** | **UNKNOWN (addon P1)** | UNKNOWN |
| Observed-not-learned candidates | yes (partial) | yes (partial) | n/a | n/a | n/a |
| Trainer offers | observed list, no recipe join | observed list, no recipe join | observed list | observed list | observed list |
| External sources (vendor/drop/quest/rep) | external data gap | external data gap | external data gap | external data gap | external data gap |
| Reagents + quantities | yes | yes | UNKNOWN (P1) | UNKNOWN (P1) | UNKNOWN |
| Required skill / tools / facility | UNKNOWN (P4) | UNKNOWN (P4) | UNKNOWN | UNKNOWN | UNKNOWN |
| Reagent location by owner | bags/bank/others; Warband+guild via `get_shared_storage` | bags/bank/others | n/a | n/a | n/a |
| Who can craft X | `find_recipe_crafters` | `find_recipe_crafters` | UNKNOWN | UNKNOWN | UNKNOWN |
| Crafted equipment upgrade | existing Retail gear tools | assessment (upgrade UNKNOWN without stats) | — | — | — |

The question "what should I craft next" gets evidence, not a recommendation. The tools return learned recipes, reagent readiness and candidate upgrades with provenance, and the MCP client composes the advice.

## Remaining gaps and blockers

- **GearExport (needs authorization):** Classic/TBC recipe capture, trainer→recipe IDs, requirement/facility fields, and stale markers. See [`GEAREXPORT_PROFESSION_HANDOFF.md`](GEAREXPORT_PROFESSION_HANDOFF.md).
- **External data gap:** a version-correct recipe source catalogue (vendor, drop, quest, reputation). This needs a research-store dataset. It is not available from any client API.
- **Genuine client limits:** recipe lists exist only while the profession panel is open; Classic lists only learned recipes; filters and collapsed headers hide rows.
- **Dashboard follow-ups:**
  - Port the progression-metadata validation from `7ca19e2` (difficulty enum).
  - Join trainer offers to recipe rows by name as DERIVED until IDs arrive.
  - `buildAccountFacts` calls `listSnapshots` for each character whose latest snapshot lacks recipes; add a bounded recipe-section query if this shows up in profiling.
  - Fold the four separate recipe readers into the resolver everywhere. `erpProjects` RECIPE needs still read the latest snapshot only.

## Ask My Account: dependencies and safe removal plan (next checkpoint)

**UI:**
- `packages/web/src/components/AskAccountModal.tsx`
- its entry point in `packages/web/src/App.tsx`
- `askAccount` in `packages/web/src/api.ts`
- the matching types in `packages/web/src/types.ts`

**Server:**
- `POST /api/ask` in `packages/server/src/app.ts`
- `packages/server/src/llm.ts` (OpenAI call)
- `packages/server/src/systemPrompt.ts`
- `OPENAI_API_KEY` wiring in `packages/server/src/index.ts`
- the provider host allow-list in `packages/server/src/net.ts`

**Core:** `packages/core/src/llmContext.ts` (`buildLlmContext`), used only by `llm.ts`.

**Keep:** AccountContext (`accountContext.ts`, `GET /api/account-context`), the read model and evidence resolution. MCP depends on these.

Removal order:
1. Hide the UI entry point.
2. Delete `/api/ask`, `llm.ts`, `systemPrompt.ts` and the OpenAI env/egress wiring.
3. Delete `llmContext.ts` and its tests. Before that, confirm with `grep` that nothing outside these files imports it.
4. Remove the Ask-specific test assertions, `apiReliability` ask cases and the docs references.

Each step is independently revertible. No schema or data migration is involved.

**Simplification opportunities:**
- Retiring Ask removes the only LLM-provider dependency and the compact-context projection, a second representation of AccountContext that had to be kept in sync with MCP.
- MCP tools could share one per-character "resolved evidence view" (recipes, bags, bank, equipment with per-fact provenance) instead of each method re-deriving from the latest snapshot.

## Validation

- Core 891/891, MCP 9/9, Server 276 + 1 skip, Web 317/317, and `npm run typecheck` all pass on `5222612`.
- The Rordin 180→190 acceptance fixture is `packages/core/test/recipeEvidence.test.ts`. The MCP stdio protocol test calls `find_recipe_crafters`.
- An independent adversarial review found no correctness defects. Its fallback-naming and partial-list findings were fixed, and the performance note is recorded above.
- **Not done:** DEV deployment, connected ChatGPT MCP acceptance, live game capture.

## Live validation (one session, after authorized DEV deploy)

1. Deploy the branch head with the guarded `wowsync-dev-deploy` from baseline `e936d4f`. The schema plan should be `none`.
2. Through connected ChatGPT MCP, run each of these and check the expected result:

   | Call | Expected result |
   |---|---|
   | `get_forever_crafted_upgrade_assessment` for Rordin Longbraid (Forever, Classic Beta PvP 2), no `snapshotId` | `snapshot.snapshotId = 190`; `recipeEvidence.state = LAST_SEEN` with source 180; candidates 2663 and 12260; reagent availability from 190's bags; upgrade still UNKNOWN |
   | Same call pinned to `snapshotId: 180` | `recipeEvidence.state = OBSERVED` |
   | `get_character_professions` for Rordin | `recipeKnowledge.evidence.sourceSnapshotId = 180`; all rows LAST_SEEN |
   | `find_recipe_crafters` with `version: forever, outputItemID: 2853` | Rordin is listed as learned (LAST_SEEN); characters without captures appear under `charactersWithoutRecipeEvidence` |
   | `get_recipe_reagent_availability` for Rordin, recipe 12260 | Copper Bar slot: bags quantity as observed; bank UNKNOWN; other characters listed separately |

3. Do not craft, move items or edit the Rordin ERP project.

## DEV deployment — 2026-10-12

- `wowsync-dev-deploy prepare` built and tested the release; schema plan `none`. `deploy` promoted `4ed2590e909ed4d6e20fa1fb345bbd867dbcd2fa` from the verified baseline `e936d4f941efb350ed79b3cdbc1fc62f9a1e5e2d` (an ancestor). The audit result was `PROMOTE_SUCCESS` at 2026-10-12T15:46:53Z.
- Backup: `/var/lib/wowsync-dev/backups/deploy/20261012T154645.239Z-22a9232a-e936d4f941efb350ed79b3cdbc1fc62f9a1e5e2d-to-4ed2590e909ed4d6e20fa1fb345bbd867dbcd2fa.sqlite`, integrity `ok`. The SHA-256 was not printed and the file is not readable from the operator shell.
- Schema unchanged. Dashboard healthy (`/` 200, `/api/versions` 200), MCP healthy, Herdr untouched, no journal warnings. The MCP tunnel process restarted at deploy time from `releases/current`.
- The resolver is active on real DEV data. `GET /api/characters/forever%3A%3Aclassic%20beta%20pvp%202%3A%3Arordin/forever-crafted-upgrade-assessment` (no pin) returned snapshot 190, `recipeEvidence.state = LAST_SEEN` from snapshot 180, and candidates 2663 and 12260 tagged LAST_SEEN/Blacksmithing. Snapshot 190's complete current bag scan holds no Copper Bars (2840), so both candidates show `OBSERVED_INSUFFICIENT` and `BLOCKED_BY_OBSERVED_REAGENTS`. Bank and upgrade conclusions remain UNKNOWN.
- The new MCP tools `find_recipe_crafters` and `get_recipe_reagent_availability` are in the deployed SHA. The release's prepare-time protocol test asserts both in `tools/list` and calls `find_recipe_crafters`. The running DEV MCP instance could not be queried directly from the operator shell (stdio behind the tunnel; release and DB are owner-only), so connected ChatGPT MCP acceptance is still pending.
- No ERP project, gameplay data, GearExport, Herdr, or BankCleanup change. Rollback: `wowsync-dev-deploy rollback e936d4f941efb350ed79b3cdbc1fc62f9a1e5e2d`.
