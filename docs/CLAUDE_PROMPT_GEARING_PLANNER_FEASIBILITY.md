# Implementation prompt for Claude — WoWSync Gearing Planner

Implement a **snapshot-based Retail Midnight gearing planner** for WoWSync. Do not attempt remote live visibility of every Warband character and do not execute upgrades, transfers, crafting orders, or game actions.

Read `docs/MIDNIGHT_12_1_ENDGAME_RESEARCH.md` first. Treat it as product context, not an API specification. Verify all current Retail API signatures against Gethe `wow-ui-source` branch `live` before coding.

## Goal

Add an explainable dashboard view that imports a logged-in character snapshot and shows:

1. Equipped average ilvl and each slot's item link/current ilvl.
2. Known item track/rank when directly obtainable; otherwise `Unknown`, never infer it only from ilvl.
3. Mistcrest/currency quantity, weekly cap/progress, account-wide/transferable flags.
4. Great Vault row/pane progress, activity tiers, claim availability and snapshot timestamp.
5. Campaign/Coiled Isle/Prey milestone completion from an explicit maintained quest-ID catalogue.
6. Major-faction Renown and account-unlock/reward collected state.
7. Profession skill/known recipe/KP-related snapshot data when the profession UI data is available.
8. A rule-based “readiness” explanation: weak slots, unfinished weekly opportunities, and a conservative recommended activity band. Show evidence/reason text and confidence, never claim an optimization is a server fact.

## Collection boundary

Use and test current APIs, including:

- item/inventory APIs including `C_Item.GetCurrentItemLevel(ItemLocation)`;
- `C_CurrencyInfo.GetCurrencyInfo` for quantity, weekly fields, `isAccountWide`, `isAccountTransferable`; use account-character currency fetch only for eligible IDs;
- `C_WeeklyRewards` for activities, sorted progress, available/claimable reward state and next-increase helpers;
- `C_QuestLog.IsQuestFlaggedCompleted` and `IsQuestFlaggedCompletedOnAccount`;
- `C_MajorFactions` for Renown and account-unlock/collected flags;
- `C_TradeSkillUI` only after loading/opening the relevant profession data;
- current M+ APIs only after signature verification.

Persist a schema-versioned SavedVariables snapshot per character keyed by stable GUID/realm, with `capturedAt`, game build, and per-section freshness. Export it to the dashboard's existing data path. A character not logged in since a change must display stale/unknown—not fabricated current state.

## UX constraints

- Separate **Character** facts from **Warband/account** facts and from **inferences**.
- Every planner suggestion names the observation/rule used (for example, “World Vault: 4/8; highest Tier 7; two more T7+ Delves unlock another Champion4 choice”).
- Include an explicit `UNRESOLVED/Unknown` presentation where the game API or rule catalogue cannot establish a state.
- Do not hard-code mutable reward ilvls as a source of truth. Prefer API activity/reward data. Put any season tables in versioned data with build/patch applicability and tests.
- No external AH pricing, group availability, simulation result, or craft commission prediction without a separately authorized external integration/manual entry.

## Deliverables

1. A written API audit mapping every displayed field to API, SavedVariables, inference, or manual input.
2. Schema migration and fixture snapshots for empty, fresh-90, active main, stale alt, and unsupported/missing-API cases.
3. Tests for weekly reset/staleness, no cross-character Vault leakage, transferable-currency flag behaviour, and unknown item-track handling.
4. A compact UI/product note explaining scope and non-goals.

Do not write a generic “what should I do next” coach. Make the output a transparent planning aid whose rules can be updated when Season 3 changes.
