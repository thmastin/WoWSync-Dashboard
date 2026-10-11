# WoWSync co-pilot data capability audit

Audit basis: Dashboard `2d8dc391715576e88adc27923d7d357d09127950`; GearExport
Forever live-validation input `79b3e1961bba13a00a3ee38b33ac701a9caa595b` plus the accepted
recipe capture source on `origin/feature/forever-recipe-evidence` (`24fc5de`). DEV is currently
healthy at Dashboard `2d8dc391`. The accepted Forever recipe milestone is a fixed baseline: the
connected MCP read returned Rordin Longbraid snapshot 178, generation 1791754559, Mining 3/75,
Blacksmithing 1/75, and five learned Blacksmithing recipes. This audit does not reopen that
milestone.

`LIVE_VALIDATED` means real game evidence traversed the identified client/export/ingestion path;
`IMPLEMENTED_NOT_LIVE_VALIDATED` means code and automated coverage exist but no real-client result
is established for that exact capability; `PARTIAL` means a usable but bounded/incomplete path;
`MISSING` means no supported path was found; `NOT_APPLICABLE` means the mechanic is not shared by
the client/version; `UNKNOWN` means the evidence is insufficient to classify. A deployed schema,
fixture, or UI label alone does not establish a working collector.

## Evidence path and version boundary

GearExport creates version-specific TOCs and selects a client profile before collecting data.
Common observations travel as the WoWSync text export; selected richer records use typed sidecars.
Dashboard parsing and persistence distinguish Retail's character-state sidecar from Forever recipe
evidence. `SnapshotStore.importSnapshot()` is the common write path. `AccountFacts -> AccountContext
-> LlmContext` powers Dashboard and Ask My Account; `DashboardReadModel` powers MCP. These are
separate projections over the same stored evidence, not a shared UI/MCP endpoint. Version is
explicit in read tools, Forever uses realm-partitioned facts, and no WoW account identifier is
captured. A list of Dashboard characters is not proof of common Battle.net account ownership.

## Retail versus Forever capability matrix

The table describes usable behavior end-to-end. “Dashboard/API” covers parsing, persistence,
AccountContext, MCP, and UI; the accompanying note distinguishes any narrower consumer.

| Capability | Retail | Forever 1.60.1 | Current evidence path, use, and gap |
|---|---|---|---|
| Identity, level, XP, location, played time | `LIVE_VALIDATED` | `LIVE_VALIDATED` | GearExport shared collectors export name/realm/class/level, XP, money, location and playtime where supported; Dashboard retains snapshot timestamps/history and exposes summaries. Forever live capture validates identity, level/XP/location/played time. Use for progression context; it is still a point-in-time observation. |
| Class, specialization, talents, spellbook, abilities | `PARTIAL` | `PARTIAL` | Retail character-state sidecar carries structured specialization/talent investment and spellbook observations; Forever spellbook capture is version-specific and live-evidenced, but no equivalent complete talent/spec build model was found. Dashboard/MCP expose observed spells and specialization where present, not every learnable/off-spec/pet ability. No reliable “how should I play” answer without versioned class research and complete current build/ability evidence. |
| Equipment, item stats, restrictions, eligibility | `PARTIAL` | `PARTIAL` | Retail equipment/item metadata and optional spec-equipment observations feed candidate checks for a defined subset of rules; limits are explicit. Forever has a separate observed-equipment and candidate pipeline; item/API interpretation and eligibility/upgrade evidence remain narrower and must never fall back to Retail rules. A visible slot/item is not proof of character eligibility or upgrade value. |
| Bags, bank, guild/shared storage, mail | `PARTIAL` | `PARTIAL` | Retail bags, personal bank and owner-keyed Warband/Guild journals are distinct; guild access/incomplete tabs remain UNKNOWN. Forever bags and character bank observations have live evidence; no Forever Warband/Guild shared-storage projection exists. Mail is not a reliable owned-inventory ledger. Character location does not imply transfer access. |
| Item identity, binding, ownership, transferability | `PARTIAL` | `PARTIAL` | Exact item links/IDs, location and selected binding evidence are stored; Retail held-item identity/binding gates apply to supported consumers. Forever shows observed carried item identity and binding facets, but physical ownership, account membership, eligibility and cross-character transferability remain UNKNOWN unless separately proven. “In a bag” is not “available to another character.” |
| Cross-character roster and freshness | `PARTIAL` | `PARTIAL` | Version-isolated roster summaries and per-observation `OBSERVED`/`LAST_SEEN`/`UNKNOWN` freshness are available; Retail account-wide context is broader, while realm-partitioned versions remain realm-scoped. Forever has no verified account-membership key. Stale snapshots remain historical and roster membership is not account proof. |
| Quests, completed quests, campaigns, objectives | `MISSING` | `MISSING` | No supported GearExport quest/objective collector or Dashboard evidence projection was found. The APIs/mechanics differ by client family and are not presumed interchangeable. Without current log/completion evidence the co-pilot cannot reliably say what quest objective is available or completed. |
| Trainer visits and available training | `PARTIAL` | `PARTIAL` | Retail generic trainer sections preserve point-in-time services and freshness; a visit does not prove later training and is not exhaustive. Forever has raw/window-scoped trainer evidence in its evidence adapter, but no end-to-end canonical Forever trainer-service view was verified through Dashboard/MCP. Do not treat absence as no trainer options. |
| Reputation, currencies, progression systems | `PARTIAL` | `PARTIAL` | Retail has structured currency and reputation/progression sidecar support, with ownership scope and UNKNOWN distinctions; Renown is explicitly UNKNOWN in the current product. Forever level/XP and profession progression are available, but the broad Retail currency/reputation model is not established for Forever. No absent record is treated as zero or complete. |
| Professions, skills, recipes, reagents | `PARTIAL` | `LIVE_VALIDATED` for observed recipe evidence; catalog remains `PARTIAL` | Retail learned-state observations and Forever 1.60.1 build 70338 recipe candidates are separately exposed by `get_character_professions`. Rordin snapshot 178 proves five learned Blacksmithing recipes and exact captured outputs/reagents. Coverage is partial; skill, learned recipe, recipe candidate, materials, and craftability have separate evidence and no one implies another. |
| Consumables, buffs, readiness | `PARTIAL` | `PARTIAL` | Bag/equipment items and spell observations support limited inventory context; no complete buff/readiness collector or effect engine was found. A consumable in inventory does not establish active buff, suitability, remaining duration, or encounter readiness. |
| Gear upgrades and cross-character allocation | `PARTIAL` | `PARTIAL` | Retail candidate/provenance tools have more deterministic rule coverage; Forever has an isolated screening path using observed items and explicitly uncertain rules. Use can identify candidates requiring review, not reliably recommend a final upgrade or transfer when stats, eligibility, account membership, specialization or access are unknown. |
| Gameplay goals, projects, evidence reconciliation | `PARTIAL` | `PARTIAL` | Dashboard project/work-order lifecycle, evidence reconciliation, revisions, immutable proposals and player approval are implemented. These record planning intent and observed evidence; they do not execute gameplay. Forever recipe evidence is available to query, but recipe selection/material planning/project completion is not a full automated craft lifecycle. Rordin's project is not modified by this audit. |
| Economy observations and AH | `PARTIAL` | `MISSING` for a reliable economy model | Character money, item vendor facets, and some Retail storage are observable; no AH-price feed, mail ledger, TSM, or market state is supported here. Forever has no sound AH/economy observation path. This mission intentionally makes no AH/economy implementation. |
| Version-correct research and advice | `PARTIAL` | `PARTIAL` | MCP can retrieve registered research, but the current registered game research is not a complete Forever 1.60.1 class/quest/profession knowledge base. Retrieved Retail advice must not be used as Forever semantics. Useful next-step answers need version-tagged source evidence plus the character observations above. |

### Data-chain detail

| Concern | Retail | Forever | Tests and live evidence |
|---|---|---|---|
| Export shape | Common WoWSync v1 text plus typed Retail-specific sidecars such as character state/equipment observations. | Common version-scoped text plus a strict Forever structured recipe sidecar; recipe observations retain client build/interface, owner scope, observation times, partial-candidate declaration and row provenance. | Parser/store tests cover fixtures and malformed/partial sidecars. Forever recipe baseline additionally has the real 1.60.1 build 70338 Rordin capture exposed through MCP and Dashboard; no candidate catalogue completeness claim. |
| Import and persistence | Text and accepted sidecars converge on the single snapshot import transaction; SQLite journal/history and additive tables/columns preserve snapshots. | Same import transaction after version-specific parsing; recipe evidence is retained separately from profession skill provenance and can remain historical when newer exports omit it. | Extensive unit, server, MCP and browser tests exist. Synthetic tests prove deterministic validation only; snapshot 178 is the real recipe evidence. |
| AccountContext and UI | AccountFacts, histories, trainers, inventory, selected currency/reputation facts; product views are not all equally complete. | Realm-scoped summaries, gear/profession readouts and evidence provenance; recipe candidate visibility is present, but no complete quest/talent/readiness co-pilot view. | Dashboard UI and AccountContext tests exist; a rendered page is not proof of connected MCP parity. |
| MCP access | Read-only explicit-version tools for character summaries/state/history/spells/trainer/equipment/storage/currencies/professions plus scoped gear and planning tools. | Same explicit-version retrieval; Forever gear and profession observations have distinct handlers and no Retail fallback. Recipe rows accessible via `get_character_professions`. | Connected MCP live query returned Rordin snapshot 178 and five learned recipe rows. Other collectors remain subject to the capability status above. |

## Representative gameplay questions

| Question | Personal evidence and versioned knowledge needed | Available read surface / reliable today? |
|---|---|---|
| What should I do next on this character? | Fresh location, level/XP, quests/objectives, learned/available abilities, equipment/inventory, goals and version-specific progression routes. | MCP summary/account context and approved projects provide partial context. **Not reliably as a complete next-action answer**: quests/objectives and Forever class/progression guide coverage are absent. Reliable answer needs those facts and dated Forever 1.60.1 research. |
| How should I play this class/spec? | Current specialization/talents/action-relevant spells plus version-correct class mechanics/rotation. | Known spellbook and some Retail specialization evidence exist. **Partial**; no complete Forever talent/build or validated rotation knowledge model. |
| What abilities and talents do I currently have? | Complete current spell/talent state and explicit capture coverage. | `get_character_spells` returns bounded observed known spells; Retail spec sidecar exists. **Partial**; never infer missing spells/talents as absent. |
| Is this item an upgrade? | Current equipped alternatives, candidate stats/restrictions, player class/spec/level, comparison rules for exact client. | Retail candidates support guarded comparisons; Forever screening remains partly UNKNOWN. **Can surface a candidate or rule-out; cannot generally certify upgrade** without validated metadata and complete eligible comparisons. |
| Can another character use this item? | Recipient identity, class/race/level/spec restrictions, binding/transfer rules, access and account membership. | Recipient screens can establish checked rules and UNKNOWNs. **Not reliably across characters** because roster/account ownership and transferability are not established. |
| What quests and progression are available? | Current quest log/objectives/completions plus version-specific task/progression sources. | No quest MCP/read model. **No**; quests are the largest blocker to grounded “what next?” advice. |
| What can I craft or learn next? | Observed learned recipes, trainer visits, skill, exact requirements, current materials/access, item output and eligibility. | Forever recipe observations and trainer visit statuses are accessible. **Partial**: recipe candidate catalogue is partial; no inference from absent recipe or trainer visit, and materials/access need fresh observations. |
| What materials do I already own and where? | Item identity/quantity, observed containers, owner, accessibility and freshness. | Item search/storage tools return character bags/bank and separate Retail shared storage; Forever bags/bank only. **Partial and evidence-scoped**; no cross-character transfer/access assumption. |
| What should I keep, sell, or transfer? | Demand/project intent, exact held item/binding, location/access, market price and transfer permissions. | Retail allocation handles bounded explicit demands with uncertainty gates; no AH prices. Forever support is narrower. **Not reliable for disposition**; no auction/economy decision in this mission. |
| What is blocking an existing project? | Project revisions/needs/orders, source evidence and its freshness/access, dependencies and approvals. | ERP read models and approval workflows can answer supported requirements. **Partial**: arbitrary gameplay dependencies and full Forever craft requirements are not modeled; project edits still require player approval. |

## Retail reuse and Forever-specific limits

Reusable unchanged: the WoWSync envelope, common identity/snapshot history, section freshness vocabulary,
SQLite import transaction, AccountFacts/AccountContext/MCP adapter patterns, read-only tool policy,
UNKNOWN/LAST_SEEN handling, test harnesses and evidence/approval boundary. Reuse a model only if its
meaning is version-neutral.

Forever adapters are required for client APIs, profession/spell/trainer semantics, item/equipment
interpretation and mechanics. Retail C_ APIs or talent/economy assumptions must not be used as a
Forever fallback. Retail Warband/Guild storage, Renown/modern progression and Retail recipe/catalog
completeness are not implied to exist for Forever. Treat every unobserved domain as UNKNOWN until a
Forever-specific collector and evidence path are proven.

The addon repository includes version-tagged API-contract notes and fixtures. The accepted real
Rordin 70338 recipe export is stronger evidence for the captured recipe fields than a synthetic
fixture; it does not establish complete recipe coverage or all client builds. Windows remains the
authoritative client for any new addon API claim. The broader source audit found the local GearExport
checkout on an unrelated Retail branch, so Forever conclusions were checked against the remote
reviewed/live-validated `79b3e19` history and recipe branch `24fc5de`, not inferred from that stale
working tree. The full build-69913 completion snapshot and the live recipe fixture history are not
silently treated as the same current capture profile.

## Priorities

| Rank | Category | Work | Value / effort and risk |
|---:|---|---|---|
| 1 | Essential co-pilot foundation | Quest log/completion/objective evidence, version-specific API audit, freshness and MCP/UI exposure. | Highest impact on “what next”; medium-high effort and client/API risk. Requires GearExport authorization before implementation. |
| 2 | Essential co-pilot foundation | Current abilities/talents/spec capture with explicit coverage; Forever adapter separately sourced. | High class-advice value; medium effort, high version-leakage risk. Addon authorization needed for new observations. |
| 3 | Important gameplay improvement | Close read-surface parity for already stored facts and make provenance/freshness obvious across AccountContext, MCP, and Dashboard. | High reliability per effort; low-medium risk and Dashboard-only where no new capture is needed. First batch below corrects MCP profession description. |
| 4 | Important gameplay improvement | Better exact item eligibility/equipment comparison for Forever once item facets and restrictions are actually evidenced. | High value for Rordin; medium effort, high false-positive risk. Keep UNKNOWN when unsupported. |
| 5 | Important gameplay improvement | Trainer/profession next-step view grounded in visit-time services, skill thresholds, observed recipe candidates and current material ownership. | Medium-high value; medium effort; never imply trainer list exhaustiveness or craftability from recipe knowledge. |
| 6 | Economy prerequisites (deferred) | Ownership/access-aware cross-character holdings and freshness before any market/disposition workflow. | Required prerequisite only; no AH/economy work in this phase. |
| 7 | Economy prerequisites (deferred) | Version-correct price/auction observations and explicit source/time/market scope. | High effort and high staleness/integration risk; intentionally deferred. |
| 8 | Optional / low-value | Complete historical trainer/spell diffs, elaborate statistics and additional cosmetic dashboards. | Lower immediate gameplay value; do after current-state evidence and question coverage. |
| 9 | Forever-inapplicable or adapter-specific | Retail Warband bank, modern Retail profession specialization trees/knowledge, Renown and modern trait systems. | Do not port as if Forever had the same mechanics; only implement a Forever equivalent if the client exposes one. |

### GearExport proposal (read-only audit; no addon files changed)

First proposed addon batch after explicit authorization: Forever-only quest log and objective/completion
observations, using APIs verified against Forever 1.60.1 client source/runtime. Candidate files would
be `GearExport-Forever.toc`, `WoWSyncForever*.lua` (a dedicated
`WoWSyncForeverQuests.lua` adapter plus shared serializer hookup), Forever tests/fixtures under
`tests/`, and a Forever-specific evidence contract document. It would export bounded observed
quest IDs/status/objective counters with capture time/coverage, never infer completion from absence,
and never call Retail APIs. API availability, exact return structures, whether data requires opening
the quest log, and any protected/combat restrictions must be established before implementation;
this audit does **not** assert those details are already proven. This is the highest-value next
capture because it can ground the player's next action. It requires new explicit authorization under
the current GearExport boundary.

## First implementation batch in this mission

Dashboard-only MCP contract correction: publish that `get_character_professions` returns both
Retail learned-state and Forever 1.60.1 build 70338 recipe observations, while making partial
candidate coverage, separate skill/recipe provenance, no-craftability inference, and strict version
isolation explicit. Add a protocol-level assertion against the actual registered tool description.
This prevents the connected consumer from being told Forever recipes are Retail-only. It does not
change parsing, persistence, migrations, Rordin's project, or the real DEV deployment.

## Source map

- GearExport package/version isolation and common collectors: `GearExport-Retail.toc`,
  `GearExport-Forever.toc`, `WoWSyncCollectors.lua`, `WoWSyncCompat.lua`, `WoWSyncCore.lua`,
  `WOWSYNC_SCHEMA.md`, `RETAIL_COMPATIBILITY.md`.
- Forever live profile/evidence: GearExport remote commit `79b3e1961bba13a00a3ee38b33ac701a9caa595b`
  (`GearExport-Forever.toc`, `WoWSyncForever70291.lua`, `WoWSyncForeverEvidence70291.lua`,
  `WoWSyncForeverBank.lua`, `WoWSyncForeverSpells.lua`, `WoWSyncForeverProfessions.lua`). Recipe
  collector lineage is `origin/feature/forever-recipe-evidence` at `24fc5de`; its partial-candidate
  and provenance constraints are represented in the accepted Rordin export described above.
- Dashboard parse/import/storage: `packages/core/src/parser.ts`, `types.ts`, `sqliteStore.ts`,
  `characterState.ts`, `foreverGearObservation.ts`; `packages/server/src/app.ts` and `importSaved.ts`.
- Projection and user surfaces: `packages/core/src/accountFacts.ts`, `accountContext.ts`,
  `readModel.ts`; `packages/mcp/src/server.ts`; `packages/web/src/components/` profession, trainer,
  character, and storage views.
- Regression evidence: `packages/core/test/`, `packages/server/test/importSaved.test.ts`,
  `packages/mcp/test/protocol.test.ts`, `packages/mcp/test/foreverGoalProject.test.ts`, and
  `packages/web/test/`.

Validation target: MCP protocol tests, full workspace tests, TypeScript, web build, and a focused
independent source review. Automated coverage is synthetic; the live recipe evidence remains the
accepted Rordin snapshot 178 described above.
