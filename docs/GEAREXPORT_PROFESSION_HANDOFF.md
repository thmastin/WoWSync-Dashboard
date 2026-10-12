# GearExport profession-intelligence handoff (Windows, consolidated)

Status: **requires Tate authorization** to modify GearExport (`D:\dev\wow-addons\GearExport`). Nothing here has been implemented in the addon. Prepared 2026-10-12 from the Omarchy copies of GearExport `adef680` (`feature/retail-gear-candidate-evidence`) and `24fc5de` (`feature/forever-recipe-evidence`), Dashboard `feature/profession-intelligence`, and the persisted Rordin snapshot 180 fixture.

This is the single Windows request for profession intelligence. It replaces piecemeal API experiments: every live check is consolidated into the one validation session in §7.

## 1. Problems and evidence

| # | Problem | Evidence |
|---|---|---|
| P1 | Classic Era and TBC Anniversary export **no recipe rows at all**. Only `[PROFESSIONS]` name/skill/max. | No `GetTradeSkillInfo`/`GetNumTradeSkills`/`GetCraftInfo` calls in either branch (`grep` across `*.lua`). Dashboard `normalizeRecipeSection` is Retail-only; Forever uses `foreverGearObservation.professionRecipes`. |
| P2 | A recipe section is only produced when the profession panel is open at `/wowsync` time. Rordin's snapshot 190 had none, so Dashboard had to carry snapshot 180 forward. | Rordin 180 has the section (507 candidates, 5 learned); 190 does not. `WoWSyncForeverRecipes.lua` reads `C_TradeSkillUI` only while the panel is populated. |
| P3 | Trainer services cannot be joined to recipes. Forever records `name, status, requiredLevel, cost` only; Classic records name/rank/status plus skill requirement, but no recipe/spell/item ID. | `WoWSyncForeverTrainers.lua` (texture is display-only; no ID); `WoWSyncCollectors.lua:434-440`. |
| P4 | Required profession skill, tool, and facility (anvil/forge) for a recipe are not captured, so craftability stays `NOT_ESTABLISHED` everywhere. | Rordin fixture rows have reagents and output only; `maxTrivialLevel` is explicitly not a minimum requirement (`FOREVER_PROFESSION_RECIPE_WORKFLOW.md`). |
| P5 | Character bank is `UNKNOWN` unless the bank was opened in that session; reagent availability can only use bags. | Rordin 180/190 `bank.completeness = unknown`. |
| P6 | Classic Enchanting (and Hunter Beast Training) use the Craft API, not TradeSkill; collapsed headers and active filters hide rows. Any Classic capture must handle both or declare partial coverage. | Agent API research; Blizzard Classic UI uses `GetCraftInfo` for Enchanting. |
| P7 | Recipe sources (vendor, drop, quest, reputation) are not available from any client API. | No API exists; this is an external-data gap, not an addon bug (see §9). |

## 2. Data contracts (additive; no existing field changes)

All new data is a versioned sidecar section in the existing SavedVariables record (`sections.<name>` with `capture`, `revision`, `changedAt`, `source`, `data`). Dashboard rejects anything malformed and keeps it UNKNOWN.

### 2.1 `sections.professionRecipes` for Classic Era / TBC (`formatVersion: 1`, `clientFamily` absent → version from client version)

Same shape Forever already emits, so Dashboard can reuse one resolver:

```
data = {
  formatVersion = 1, ownerScope = "CHARACTER",
  coverage = { state = "PARTIAL", candidateCompleteness = "UNKNOWN", enumeration = "OBSERVED",
               filteredEnumerationUsed = <bool>, collapsedHeadersSeen = <int>, returnedRecipeCount = <int> },
  professions = { {
    professionName = "Blacksmithing", api = "TRADESKILL" | "CRAFT",
    skill = <int>, maxSkill = <int>, evidence = "OBSERVED", observedAt = <epoch>,
    coverage = { ...same fields, per profession... },
    recipes = { {
      recipeKey = "spell:<id>" | "name:<localized name>",   -- spell ID when resolvable from the recipe link
      recipeID = <spellID or nil>, name = <string>,
      learned = true, learnedState = "OBSERVED_TRUE", evidence = "OBSERVED",  -- Classic lists only known recipes
      difficulty = "optimal"|"medium"|"easy"|"trivial"|nil,
      outputItemID = <int|nil>, outputQuantityMin = <int|nil>, outputQuantityMax = <int|nil>,
      reagentSlots = { { slotIndex = n, quantityRequired = n, reagents = { { itemID = <int|nil>, name = <string> } } } },
      tools = { <string> ... } | nil,           -- GetTradeSkillTools / GetCraftSpellFocus
      toolsState = "OBSERVED" | "UNKNOWN",
    } },
  } },
}
```

Classic tradeskill lists only learned recipes, so every row is `OBSERVED_TRUE`; never emit `OBSERVED_FALSE` for Classic.

### 2.2 `sections.trainerOffers` (all versions)

```
data = { formatVersion = 1, trainerName = <string|nil>, trainerNpcID = <int|nil>, observedAt, mapID = <int|nil>,
  filters = { available = <bool|nil>, unavailable = <bool|nil>, used = <bool|nil> },
  complete = <bool>,      -- true only if all three filters were on and no header was collapsed
  services = { { index, name, status, cost, requiredLevel,
                 skillLine = <string|nil>, requiredSkill = <int|nil>, requiredSkillMet = <bool|nil>,
                 serviceLinkKind = "spell"|"item"|"none", serviceSpellID = <int|nil>, serviceItemID = <int|nil> } } }
```

`serviceSpellID` lets the Dashboard join a trainer offer to a recipe row by ID instead of by name.

### 2.3 Recipe requirements (extend existing Forever/Retail recipe rows; optional fields)

`requiredSkill = <int|nil>`, `requiredSkillState = "OBSERVED"|"UNKNOWN"`, `facility = <string|nil>`, `facilityState`. Emit only when an API returns them; never derive from `maxTrivialLevel`.

### 2.4 Persistent recipe cache marker

When the panel is not opened in a session, keep the previous section in SavedVariables unchanged and add `lastAttemptStale = true` with `staleReason = "PANEL_NOT_OPENED"`. Do **not** emit an empty section; Dashboard already treats a missing section as "carry forward as LAST_SEEN".

## 3. Version-specific API research and limits

| Version | Recipes | Trainer | Notes / hypotheses |
|---|---|---|---|
| Retail / Midnight | Existing `C_TradeSkillUI` capture (`GetAllRecipeIDs`, `GetRecipeInfo`, `GetRecipeSchematic`) | Existing trainer collector | Add §2.3 fields only if `GetRecipeSchematic`/`GetRecipeRequirements` return them. |
| Forever 1.60.1 (70338) | Existing `WoWSyncForeverRecipes.lua` (candidate list includes OBSERVED_FALSE rows) | `WoWSyncForeverTrainers.lua` | Hypothesis: `GetTrainerServiceItemLink(i)` or `GetTrainerServiceSkillReq(i)` exist in 1.60.1. Probe in §7 with `type(fn) == "function"` guards; fall back to name-only. |
| Classic Era 1.15.x | **New**: `GetNumTradeSkills`, `GetTradeSkillInfo`, `GetTradeSkillItemLink`, `GetTradeSkillRecipeLink`, `GetTradeSkillNumReagents`, `GetTradeSkillReagentInfo`, `GetTradeSkillReagentItemLink`, `GetTradeSkillTools`, `GetTradeSkillLine`; Enchanting via `GetNumCrafts`/`GetCraftInfo`/`GetCraftReagentInfo`/`GetCraftSpellFocus` | Existing collector + new `GetTrainerServiceItemLink`, `GetTrainerServiceSkillReq` | Only while the window is open. Expand collapsed headers is **not** allowed (it mutates UI state); record `collapsedHeadersSeen` and mark partial. |
| TBC Anniversary 2.5.x | Same as Classic Era | Same | Jewelcrafting uses TradeSkill API. |
| Hardcore / SSF | Same as Classic Era | Same | Quarantine ambiguous identity (existing rule). |

## 4. Implementation scope

1. New module `WoWSyncClassicRecipes.lua` implementing §2.1 for Classic Era/TBC, driven by `TRADE_SKILL_SHOW`/`TRADE_SKILL_UPDATE` and `CRAFT_SHOW`/`CRAFT_UPDATE`. It must never change filters or expand headers.
2. Trainer offers (§2.2) in the shared trainer collector, with per-version tuple adapters (the Forever and Classic tuples differ).
3. Optional requirement fields (§2.3) in the existing Retail and Forever recipe collectors.
4. Stale-marker behavior (§2.4) for every recipe collector.
5. TOC/load order for the new module in the Classic/TBC TOCs only. Forever and Retail TOCs are unchanged except for the shared trainer collector.
6. `WOWSYNC_SCHEMA.md` updated with every new field and its UNKNOWN semantics.

Out of scope: recipe sources (vendor/drop/quest/reputation), cross-character data, any automation of crafting or UI interaction.

## 5. Fixtures and automated tests (existing `tests/*.lua` harness)

- Classic Blacksmithing panel with 2 learned recipes (one with a tool requirement), one collapsed header, and a filter on. Expect partial coverage and `collapsedHeadersSeen = 1`.
- Classic Enchanting via the Craft API, with a spell focus.
- TBC Jewelcrafting, to check the version label.
- Trainer, with all filters on and none collapsed. Expect `complete = true` and IDs present.
- Trainer with "unavailable" filtered out. Expect `complete = false`.
- Forever trainer tuple where the item-link API is absent. Expect name-only and `serviceLinkKind = "none"`.
- Panel not opened. The previous section must be retained and marked stale, never emptied.
- Truncation, where reagent info is nil while loading. The row should get `identityState` UNKNOWN, not quantity 0.
- Regression: all existing Retail/Forever/Classic tests pass byte-identically for unchanged sections.

## 6. Compatibility and regression requirements

- All changes are additive. The SavedVariables record version is unchanged, and existing sections are byte-stable.
- Every API call is guarded by `type(fn) == "function"` and `pcall`. A missing API means UNKNOWN, never zero.
- There must be no taint: no secure-frame calls in combat, and no UI mutation.
- The Forever 70291 and 70338 profiles keep working, and Retail behavior is unchanged.

## 7. Installation and one consolidated live-validation session

1. Close every WoW client. Install the reviewed GearExport SHA with `scripts/deploy-forever.ps1` (Forever) and the normal Classic/TBC deploy.
2. **Forever, Rordin:** open Blacksmithing and wait for the list to populate, then visit a Blacksmithing trainer with all filters on. Run `/wowsync`, then log out normally.
3. **Forever API probe:** run the one-shot diagnostic in the same session, which prints `type(GetTrainerServiceItemLink)`, `type(GetTrainerServiceSkillReq)` and one sample return. Record the results in `FOREVER_PROFESSIONS.md`.
4. **Classic Era character with a profession:** open the profession window, plus Enchanting if available. Visit a trainer, run `/wowsync`, then log out.
5. **TBC Anniversary character:** do the same as step 4.
6. Confirm the Windows watcher imported each export, then hand over to Dashboard validation (§8).

## 8. Dashboard integration expectations

These Dashboard changes are already implemented on `feature/profession-intelligence`:
- The recipe evidence resolver (`packages/core/src/recipeEvidence.ts`) carries the freshest compatible section forward as LAST_SEEN.
- MCP tools `get_character_professions`, `get_forever_crafted_upgrade_assessment`, `find_recipe_crafters` and `get_recipe_reagent_availability` read resolved evidence.

Still to do after the addon lands (next Dashboard pass):
- Accept the Classic/TBC `professionRecipes` section, using `recipeKey` (spell or name) for identity.
- Ingest `trainerOffers` and join offers to recipe rows by `serviceSpellID`, falling back to a name match labeled DERIVED.
- Surface `requiredSkill`/`facility` in craftability.
- Treat `lastAttemptStale` like a missing section.

## 9. UNKNOWN and partial-coverage semantics

- A missing section or a stale marker means recipe knowledge is UNKNOWN for that snapshot. It never means unlearned, and the Dashboard may carry older evidence forward as LAST_SEEN.
- Classic rows are learned-only. Absence from the list never proves a recipe is unlearned.
- `complete = false` on a trainer means "these offers were seen". It is not the full offering.
- Recipe sources (vendor, drop, quest, reputation) are an **external research/data gap**. They need a version-correct static catalogue in the Dashboard research store, not addon capture.

## 10. Copyable Codex prompt

```
Repository: D:\dev\wow-addons\GearExport (authorized by Tate for this task only).
Do not modify BankCleanup, Herdr, or the Dashboard.

Implement docs handoff "GearExport profession-intelligence handoff" (copy of
WoWSync-Dashboard docs/GEAREXPORT_PROFESSION_HANDOFF.md) sections 2-6:

1. New WoWSyncClassicRecipes.lua for Classic Era / TBC Anniversary / Hardcore:
   capture sections.professionRecipes exactly per §2.1 from the TradeSkill API and,
   for Enchanting/Beast Training, the Craft API, only while the window is open.
   Never change filters or expand/collapse headers; count collapsed headers and
   mark coverage PARTIAL. Rows are learned-only (OBSERVED_TRUE). Reagent identity
   from reagent item links; nil while loading => identityState UNKNOWN, not 0.
2. sections.trainerOffers per §2.2 in the shared trainer collector with separate
   Forever and Classic tuple adapters; serviceSpellID/serviceItemID only from link
   APIs that exist (type()+pcall guarded), else serviceLinkKind = "none".
3. Optional requiredSkill/facility fields per §2.3 in Retail and Forever recipe
   collectors, only when an API returns them. Never derive from maxTrivialLevel.
4. §2.4 stale marker: when the panel was not opened, keep the previous section and
   set lastAttemptStale = true; never emit an empty recipe section.
5. Load the new module only from the Classic/TBC TOCs. Update WOWSYNC_SCHEMA.md.
6. Add the §5 fixtures/tests to tests/*.lua and keep all existing tests passing
   byte-identically for unchanged sections.
7. Add a one-shot, chat-only diagnostic command for the §7 step 3 Forever API probe.

Constraints: additive only; no taint; UNKNOWN is never zero; do not invent recipe
sources. Run the full Lua test suite. Commit to a feature branch, push, and report
SHA, test output, and any API you could not confirm. Do not deploy; Tate runs the
single live-validation session in §7.
```
