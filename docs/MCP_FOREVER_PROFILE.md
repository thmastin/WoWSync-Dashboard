# MCP Forever-only profile (design)

Status: implemented as a read-only profile selected by process configuration in `packages/mcp/src/server.ts` (`createWoWSyncMcpServer`).

A profile is a second tool set registered by the same factory, selected by process configuration (never a tool input). It is read-only: no `SqliteSnapshotStore`, no `planningApiBaseUrl`, so no ERP write route can exist in it.

## Rules

- Every input schema carries `version: z.literal("forever")` (as `get_forever_*` already do). Tools whose current schema is `versionSchema` are re-registered with the literal and call the same `readModel` method with `version: "forever"`. No tool accepts `unknown-version`, and none combines versions.
- Output keeps the core provenance (`OBSERVED`/`DERIVED`/`LAST_SEEN`/`UNKNOWN`) unmodified. The profile adds no defaults, rollups or zero-fill; a missing value is returned as `UNKNOWN`, never `0` or empty.
- Bounds are those of the existing tools. Where `server.ts` shows no cap (marked †), the bound is enforced inside `readModel`; before shipping, the profile should add one shared guard that rejects a result over `MAX_DOCUMENT_CHARACTERS` (40 000) with `truncated: true`.
- Identity is always `name` + `realm` (realm required, as in `get_forever_gear_observation`) so an ambiguous name returns `AMBIGUOUS` instead of a guess.

## Tools (13)

The original brief capped the profile at 12; 13 is a deliberate decision to keep training cost answerable.

| # | Tool | Inputs (all + `version:"forever"`) | Backing function | Output bound |
|---|------|------|------|------|
| 1 | `list_forever_characters` | `realm?`, `limit?` | `readModel.listCharacters` | limit ≤100 (default 50), `truncated`; race/sex always present, unavailable values are `UNKNOWN` |
| 2 | `get_character_state` | `name`, `realm` | `readModel.getCharacterState` | compact summary †; sections carry provenance and build compatibility verdict; race/sex are present or `UNKNOWN` |
| 3 | `get_forever_gear_observation` | `name`, `realm` | `readModel.getForeverGearObservation` | equipped slots + carried items † (absorbs `get_character_equipment`) |
| 4 | `get_forever_gear_allocation` | `name`, `realm` | `readModel.getForeverGearAllocation` | candidates from observed carried items † |
| 5 | `get_character_professions` | `name`, `realm`, optional `profession`, `includeRecipes` (default false), `offset?`, `limit?` | `readModel.getCharacterProfessions` + `learnSkill` join (existing wrapper `professionsWithCaptureIssue`) | compact skill summary by default (name, skill, maxSkill, observedAt/freshness, recipeCount); recipe rows only when `includeRecipes:true` and one profession is named; recipes are paged; shared 40,000-character guard |
| 6 | `get_recipe_reagent_availability` | `name`, `realm`, exactly one of `recipeID`/`outputItemID`/`recipeName` | `readModel.getRecipeReagentAvailability` | one recipe; ambiguous selectors return candidates |
| 7 | `get_forever_character_quests` | `name`, `realm`, `snapshotId?` | `readModel.getForeverQuestObservation` | † (`completedQuestIDs` lookup of `get_character_quests` is dropped) |
| 8 | `get_character_progression` | `name`, `realm`, `snapshotId?`, `factionQuery?`, `includeTalents?` | `readModel.getCharacterProgression` + `describeForeverTalents` | reputation rows + talents (ranked only unless `includeTalents`) † |
| 9 | `get_forever_items` | `name`+`realm`+`storage` (`bags`\|`bank`), **or** `query` alone; `offset?`, `limit?` | `getCharacterStorage` / `searchItems` (thin merge, one branch per input shape) | limit ≤100, paged |
| 10 | `lookup_forever_knowledge` | `kind`, `id` or `name`, `limit?` | `lookupForeverKnowledge` (unchanged) | ≤10 results |
| 11 | `get_forever_market_prices` | `items` (id or exact name), `character` or `market` | unchanged (`ForeverPriceStore`) | ≤25 items; unscanned item = `UNKNOWN`, stale flagged |
| 12 | `find_recipe_crafters` | one of `recipeID`, `outputItemID`, `nameContains` (≥2 chars) | `readModel.findRecipeCrafters` | † (groups `learned` / `observedNotLearned` / `unresolved`; uncaptured characters listed separately, not proven unable) |
| 13 | `get_character_trainer` | `name`, `realm`, `snapshotId?`, `category?`, `status?` (`known`\|`available`\|`unavailable`\|`other`), `query?`, `offset?`, `limit?` | `readModel.getCharacterTrainer` | limit ≤100, paged; `statusAtVisit` verbatim, earlier-export visits `LAST_SEEN` |

Training cost comes from `get_character_trainer` (#13): observed trainer-visit rows only. A service the character never saw at a trainer has cost `UNKNOWN`, and a trainer row is not evidence of current learnability.

Profession workflow: call `get_character_professions` first for the compact profession/skill summary. When recipe details are needed, name one profession and set `includeRecipes:true`; use `offset` and `limit` to page its recipe rows. The recipe catalogue is partial, so missing rows do not establish that a recipe is unknown.

## Hidden (not registered in the profile)

- **Writes (never):** `create_erp_project_from_goal`, `create_erp_project`, `plan_erp_work_order_batch`, `update_erp_project_plan`, `set_erp_project_status`, `replan_erp_reservations`, `commit_approved_erp_change`.
- **ERP reads:** `get_erp_projects`, `get_erp_operations_context`, `get_erp_project`, `get_erp_change_proposals`, `get_erp_change_proposal`. These are version-parametrised and large, and the profile has no ERP surface.
- **Retail-only:** `get_gear_candidate_evidence`, `analyze_retail_gear_candidate`, `get_gear_candidate_recipient_screen`, `get_renown`, `get_shared_storage` (Warband/guild).
- **Multi-version / duplicate:** `list_versions`, `get_character_summary` (covered by 1+2), `get_character_equipment` (merged into 3), `get_character_quests` (superseded by 7), `get_account_overview`, `get_account_currencies`, `get_account_changes`, `get_character_currencies`, `get_profession_coverage`, `get_item_metadata`, `get_item_allocation`, `get_allocation_review`.
- **Composite advisor:** `ask_forever_copilot`. Hidden because the chat model reasons over the raw tools itself, so a second server-side reasoner would duplicate it and obscure which evidence supports each claim.
- **Deliberately cut for the tool budget (Forever-capable, could return):** `get_character_spells`, `get_character_history`, `get_character_changes`, `get_forever_crafted_upgrade_assessment`.
- **Research registry:** `list_research_documents`, `search_research`, `get_research_section`, `get_research_document` (documents are not version-literal and mix versions).

## Example traces (Hallo)

1. **"Does Hallo have a better main-hand weapon?"**
   `list_forever_characters` → resolve Hallo's realm. `get_forever_gear_allocation(Hallo)` → per-candidate verdict. Per `docs/FOREVER_GEAR_OBSERVATION.md` the Mining Pick (item 2901) comes back `INSUFFICIENT_EVIDENCE` (lower raw DPS, partial coverage, bank `UNKNOWN`). Optional `lookup_forever_knowledge(item, 2901)` for stats/source. The answer must say "unknown", not "no upgrade".

2. **"What is Hallo missing in his talents and what does he learn next?"**
   `get_character_state(Hallo)` → level, freshness, build verdict. `get_character_progression(Hallo, includeTalents:true)` → unspent points, ranked talents, `upcomingAbilities` with level. `get_character_trainer(Hallo, status:"available")` → trainer-visit rows with cost and `statusAtVisit`, `LAST_SEEN` if from an earlier export; no captured visit means cost `UNKNOWN`, not free. Any `LAST_SEEN` domain is reported as stale.

3. **"What's Hallo carrying that I could sell, and for how much?"**
   `get_forever_items(Hallo, bags)` → items with OBSERVED state; bank reported `UNKNOWN`, not empty. `get_forever_market_prices(items:[ids], character:{name:"Hallo", realm})` → market derived from realm ruleset + faction; scanned items give median/lowest with age, unscanned give `UNKNOWN` plus the vendor-sell floor. Auction fees are not deducted (stated in the tool output).
