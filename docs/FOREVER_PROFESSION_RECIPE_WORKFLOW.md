# Forever profession recipe workflow

Forever 1.60.1 recipe records are a version-scoped character-state sidecar attached to ordinary imported snapshots. They retain the snapshot, client build, observation time, per-profession/per-recipe OBSERVED or LAST_SEEN state, and explicitly partial candidate coverage. Invalid, cross-version, duplicate, incomplete, or unhydrated evidence is rejected or remains UNKNOWN; absence from Forever's candidate list never means unlearned. The database stores these records inside the existing snapshot JSON and does not need a schema migration.

`coverage.returnedRecipeCount` describes the client enumeration for that observation. It is not the number of recipe rows stored in the snapshot: GearExport can retain disappeared recipes and other profession scopes as LAST_SEEN, and some enumerated candidates may not have enough association data to store as a recipe row. Consumers must preserve these counts separately from stored rows.

## Retail parity and Forever boundaries

| Capability | Retail today | Forever today | Treatment |
|---|---|---|---|
| Learned recipe candidates and exact schematics | Existing structured recipe sidecar | Captured from the open character profession panel | Shared snapshot sidecar and bounded MCP read model; Forever adapter preserves 1.60.1 build/interface evidence |
| Reagents and alternatives | Existing recipe payload | Exact item/currency alternatives and per-slot quantities when returned | Preserve alternatives; do not sum OR choices |
| Trainer services | Existing trainer projection | Existing Forever raw trainer window observation | Kept separate from recipe identity; service lists are not treated as exhaustive |
| Carried materials | Character bags | Forever structured bags merged into the Forever carried-item read model | Only the selected character's observed bags count; stale/partial/unidentified rows prevent a confirmed shortfall |
| Bank/other characters | Existing version-specific storage views | Bank may be UNKNOWN; another character is a separate owner | Never assume bank access, transfer, or account membership |
| Crafted gear output | Retail item and equipment evidence | `GetItemInfoInstant` output identity/class/location when available | Item location can identify an equipment candidate; upgrade and character eligibility remain UNKNOWN without validated comparative evidence |
| Recipe progression metadata | Retail recipe detail and difficulty fields | Forever `GetRecipeInfo` fields are optional and preserved only with valid primitive types | `relativeDifficulty`, `maxTrivialLevel`, `numSkillUps`, and `canSkillUp` are raw client observations; `maxTrivialLevel` is not a minimum required skill, and no field is inferred when absent |
| Craft completion | Snapshot diffs and explicit project reconciliation | Inventory/equipment/skill changes remain observations | A quantity or skill change alone never identifies a craft; user approval remains required |

`get_character_profession_recipes` returns bounded exact captured rows. `review_forever_recipe_materials` joins one exact recipe with only the same character's current Forever carried inventory and equipment observation. Alternative reagents remain alternatives; currencies and incomplete bag quantities remain UNKNOWN. Equipment output is reported as a candidate, not a verified upgrade. Existing ERP `RECIPE` requirements can use an explicit current learned-state observation, but need coverage does not prove profession skill, reagent availability, or craftability. Project writes continue through the existing immutable proposal, exact revision, Dashboard approval, and commit workflow. No project is changed by these read tools.

## Validation status

Automated fixtures cover parser validation, saved-variable forwarding, Forever version isolation, learned states, output/reagent rows, ERP evidence, and MCP readback. Synthetic data does not establish live game API behavior. Live acceptance requires the real Windows Forever client and connected DEV MCP; no Rordin project change or craft is implied by deployment.

Forever 1.60.1 documents `GetRecipeInfo` metadata including recipe name, relative difficulty (enum 0–3), maximum trivial level, skill-up count, and whether a recipe can skill up. GearExport preserves the name as a fallback when the schematic has no name, validates an included returned recipe ID against the requested ID, and emits the other fields only when their returned primitive values and ranges are valid. Dashboard validates these fields again before accepting the sidecar. They pass through the existing MCP recipe read tool. This does not establish an exact minimum profession requirement, trainer availability, or an exhaustive recipe list. Runtime hydration and actual returned values remain pending Windows capture.

## 2026-10-11 deployment checkpoint

The reviewed implementation at `d7de64b510349d810a3a0da2b98eec43bb0080fa` was promoted to DEV through the guarded launcher. The promotion audit classified the schema as `NONE` (`user_version` 0 to 0), verified backup integrity, and passed Dashboard, MCP, and required HTTP checks. A fresh DEV status check reports the same SHA healthy. The second guarded promotion was from `601e345fcba7a0e02101e1449da2f2140431e99c` to this validation-only fix. Its backup is `/var/lib/wowsync-dev/backups/deploy/20261011T200033.071Z-7f2211aa-601e345fcba7a0e02101e1449da2f2140431e99c-to-d7de64b510349d810a3a0da2b98eec43bb0080fa.sqlite`, SHA256 `2f9c9b35ca6e9222533036aed8fddd3319c0dedf3c4d38613c1b67b94ca18b40`, integrity `ok`.

The final fresh independent review returned PASS WITH NON-BLOCKING NOTES. It verified current scope/root count consistency, allowing retained LAST_SEEN rows and historical scopes to exceed current counts, including multi-scope and Retail coverage. Earlier count-validation findings were fixed before this reviewed SHA. No new schema or migration was added.

### 2026-10-11 recipe progression metadata follow-up

GearExport `24fc5de7fdfdf23bcc863c3e679b82b3bdcdbec1` and Dashboard `7ca19e2d769d2665bcb31f1edfd881329ba35008` were independently reviewed as PASS WITH NON-BLOCKING NOTES. Review caught and the follow-up fixed two provenance issues: recipe-info identity is now checked when the API returns an ID, and relative difficulty must be one of the documented integer enum values 0–3 at both capture and import. The metadata remains optional; `maxTrivialLevel` is not interpreted as a minimum profession requirement.

Dashboard `7ca19e2d769d2665bcb31f1edfd881329ba35008` was promoted to DEV with the guarded launcher on 2026-10-11. Audit result `PROMOTE_SUCCESS`; schema classification `NONE`, no added/removed/changed objects, `user_version` 0 to 0. Backup integrity was `ok`, with SHA256 `2f9c9b35ca6e9222533036aed8fddd3319c0dedf3c4d38613c1b67b94ca18b40`. Post-deploy status reports Dashboard, MCP tunnel, Herdr, and required HTTP checks healthy at that SHA. No project was edited and no database migration occurred.

The Windows client has not yet supplied a profession-panel capture. The connected ChatGPT WoWSync MCP call currently fails because its tunnel client has not been seen within 300 seconds; local MCP tests pass, but this is not live MCP recipe validation. The next acceptance step is a real Windows capture on Rordin: close Forever, install the reviewed GearExport branch with `scripts/deploy-forever.ps1`, launch Rordin on Classic Beta PvP 2, open Blacksmithing and wait for the recipe list, run `/wowsync`, then log out normally to flush SavedVariables. Once the import completes and the connected MCP tunnel is reachable, read Rordin's profession/recipe evidence. Do not craft or modify the project for retrieval validation.

Connected MCP readback after the final promotion still finds Rordin Longbraid on Forever snapshot 165, level 6, Mining 3/75 and Blacksmithing 1/75. Recipe knowledge remains UNKNOWN because the Windows profession-panel capture has not occurred. Rordin's existing project remains ACTIVE at revision 5; it was read only and was not changed by either deployment. No recipe, trainer, crafting, or upgrade evidence is claimed live-validated.

### Required Windows live-validation action

After closing Forever completely, install reviewed GearExport SHA `96fc46b9a151a775dfdb7d5306eae17a4aa356e7` with the guarded PowerShell command documented in the GearExport README. Launch Forever, log into Rordin Longbraid on Classic Beta PvP 2, open Blacksmithing and wait for the profession panel to populate, run `/wowsync`, then log out normally so SavedVariables are flushed and the existing import pipeline can ingest the export. Query `get_character_professions` through connected DEV MCP and verify the recipe sidecar includes observed candidate/learned state, output and reagent fields wherever the client supplied them. Do not craft an item or modify the project to validate retrieval. Record unsupported or UNKNOWN fields as such. The MCP recipe-material review may be used after evidence appears; it reports only Rordin's own carried bags and does not establish craftability or an upgrade.
