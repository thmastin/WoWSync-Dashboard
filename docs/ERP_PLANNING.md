# ERP projects, resource requirements, reservations, and work orders

Status: implemented on `feature/forever-gear-observation`; automated-tested; not deployed or browser-validated.

This feature adds persistent player intent to the existing import/read-model architecture. It does not create a second inventory database and it does not execute game actions.

## Data and APIs

- SQLite stores one version-scoped project document in `erp_projects`, with an optimistic revision number. Schema changes are additive.
- Writable Dashboard/import initialization creates `erp_projects` and `erp_project_events`; as with other required tables, a legacy database opened directly by the read-only MCP consumer fails closed until the normal writable initialization path has created the additive schema.
- Every successful create/update writes an atomic append-only revision event in `erp_project_events`. It records changed field names and status transitions, not full prior project text or inferred game outcomes. REST/UI expose the 50 most recent events and an explicit total/truncation flag; the backing ledger retains the full event sequence. AccountContext schema 8 carries project revision and event count.
- Work-order readiness is a read-time projection shared by REST, MCP, and UI. It checks only explicit dependencies and linked needs: current linked shortfalls block; historical, stale, incomplete, unsupported, or missing evidence waits; otherwise it says “no recorded plan blockers; review manually.” Completed dependencies are player-recorded intent, not independently verified game outcomes. Readiness never executes an action or implies access, eligibility, upgrade value, or craftability.
- `ErpResourceNeed`, `ErpReservation`, and `ErpWorkOrder` represent intent. They are not observations or proof of possession. A need chooses exactly one explicit character source or, for Retail only, one shared storage owner key.
- `GET/POST /api/versions/:version/erp/projects`, `PUT /api/versions/:version/erp/projects/:id`, and `PATCH .../:id/status` serve the Dashboard. The core validates supported versions, explicit character identities, dependency graphs, quantities, and required completion notes.
- MCP exposes a read-only, version-scoped `get_erp_projects` page (10 by default, at most 20) through the existing read-only store. It returns page totals/truncation; each project exposes up to 50 recent revision events. Mutations remain in the local Dashboard UI/API.
- AccountContext schema 8 includes a compact project/revision summary while detailed, evidence-qualified needs remain available from the same core read model used by REST and MCP.

## Evidence rules

Character projections use only the explicitly selected character's evidence. Supported supply checks are exact itemString, declared base item ID, gold in copper, observed profession skill by exact profession name, explicitly observed character-scoped Retail currency IDs, and an exact explicitly reported Retail learned-recipe state. A listed zero currency quantity is an observed zero; a currency absent from the list is UNKNOWN. Account-wide currency balances do not establish character access and remain UNKNOWN for character needs. Currency evidence in other versions remains UNKNOWN until those versions have supported structured captures. Recipe catalogs are partial: only an exact current learned-state row can report learned/not learned. Missing rows stay UNKNOWN, historical rows stay LAST_SEEN, and other versions remain unsupported. Learned state does not establish current skill, unlock conditions, reagent supply, or craftability.

Retail item needs may instead select one explicit shared-storage owner key. The evaluator reuses the immutable Warband/Guild observation projection; exact item variants are preserved. A complete absence can establish a source-scoped shortfall only when coverage is exhaustive. Partial, inaccessible, unconfirmed, conflicting, and LAST_SEEN evidence remains UNKNOWN or potential. Warband is installation-local rather than a Battle.net account identity. Guild holdings remain guild-owned. A positive source quantity identifies location and quantity but never proves character access or a transfer route.

Item quantity uses only exact matching rows. UNKNOWN sections and unknown row identities/quantities remain unresolved. A potential LAST_SEEN quantity never becomes current supply. A shortfall is definitive only when both personal bags and bank are OBSERVED and marked complete; enough directly observed quantity can establish a lower bound even when another section is unknown. Character gold keeps its own state and timestamp.

Resource changes compare adjacent imports for the same explicit character. Item deltas are per storage section and require complete OBSERVED rows with known identities and quantities; gold deltas require OBSERVED character sections. Deltas say only that an observation changed. They do not attribute a transfer, purchase, craft, or project action.

Reservations are explicit planning claims, never inventory mutations. Active reservations aggregate across projects only when version, explicit source character or owner, and resource scope overlap. Character inventory cannot consume a Warband/Guild reservation, and those owner scopes cannot consume each other's reservations. Exact item variants remain distinct; a base-item reservation overlapping an exact variant makes the assessment UNKNOWN because quantities cannot safely be reconciled. Partial/unobserved storage prevents an over-reservation conclusion when the unseen section could contain supply. Profession/recipe capability is not quantity-reservable. Currency reservations are enabled only when the source has an observed character-scoped Retail balance; account-wide currency is not assigned to the reporting character. A reservation is shown against observed supply as a lower bound and does not imply account membership or transfer access.

Work orders are manual steps. The player can record PLANNED, IN_PROGRESS, or WAITING_FOR_EVIDENCE in the Dashboard; these are saved plan statuses, not game actions or observations. A player-entered note is required to mark a work order or project complete. Inventory changes never auto-complete tasks.

Project history records saved intent changes, including resource needs, reservations, work orders, title/objective, priority, and status. Observation deltas remain a separate evidence view, explicitly non-causal. History never asserts that a described player action happened in game.

When adding a manual work order, the player can link resource needs and prerequisite work orders. A readiness projection makes those recorded relationships visible and conservatively gates the workbench wording; it is not an automatic scheduler or game-action authorization.

## User workflow

Open **Projects & Work Orders** from a version tab. Create a project, add an explicit resource requirement and source character or observed Retail shared owner, record a manual task, and optionally reserve a quantity from directly observed supply. The UI shows evidence date/freshness, current versus historical coverage, cross-project reservations, and section-level changes since the previous complete export. A reservation can be explicitly released. The feature never issues equip, transfer, mail, bank, craft, purchase, or sell operations.

## Known limitations and next work

- Character identity validation proves that the referenced character exists in that version, not that multiple characters share an account or can transfer items.
- Character bank remains character-scoped. Shared owner projections support only existing Retail Warband/Guild item observations; they do not assign a shared owner to a player character.
- Profession matching is localized exact-name matching and compares observed current skill with an explicit threshold only.
- Crafting feasibility/reagent consumption, procurement/market prices, persistent observation-reconciliation events, project dependency scheduling, and REST/MCP write tools are not implemented here. Recipe knowledge is Retail-only and only as explicit learned-state evidence; other versions and craftability remain UNKNOWN. Retail account-wide currency availability remains UNKNOWN for character-source plans.
- Automated tests use existing real import fixtures plus synthetic project plans. No live browser or in-game planning session was performed.

See the current branch checkpoint in `CURRENT_STATE.md` and the durable architecture invariants before extending these contracts.
