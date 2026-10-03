# Architecture Invariants

This is one of the highest-authority documents in this repository. It consolidates the durable
rules WoWSync Dashboard and Azeroth ERP must never violate. Every statement below is explicitly
tagged:

- **ENFORCED IN CODE TODAY** — a current invariant, checked by the implementation and/or tests. If
  the repository contradicts a statement tagged this way, the repository is correct and this
  document is stale; fix the document.
- **FUTURE DESIGN PRINCIPLE** — an intent for work that has not been built yet. Nothing tagged this
  way describes current behavior. Do not write code that assumes it exists.

If you are making a design decision and are not sure which document to consult, start here. For
narrative explanation of *why*, see [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md) (implementation)
and [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) (ERP semantics in depth).

---

## OBSERVATION

**ENFORCED IN CODE TODAY**

1. Observation feeds durable truth. The only way a fact enters WoWSync is as a captured
   observation from a WoWSync export; nothing is seeded, guessed, or back-filled into existence.
2. Section state is `OBSERVED | LAST_SEEN | UNKNOWN`, extended at the read layer with `DERIVED`.
   - `OBSERVED` — directly captured in the current/latest snapshot.
   - `LAST_SEEN` — an older captured section preserved as history, not a live view.
   - `UNKNOWN` — uncaptured, inaccessible, unsupported, or otherwise not known.
   - `DERIVED` — deterministically calculated from immutable observations (e.g. `AccountFacts`,
     profession coverage, shared-storage projection). Not itself a capture state.
3. **UNKNOWN is never zero.** An absent/unknown field or row is omitted or explicitly flagged —
   never stored or returned as a zero, empty string, `false`, or empty list. Example: allocation's
   `UNRESOLVED` evidence has no `quantity` field at all; it is structurally absent, not `0`.
4. **OBSERVED / LAST_SEEN / UNKNOWN / DERIVED remain distinct all the way through.** A later layer
   may *demote* a state (e.g. `characterState.ts` demoting `OBSERVED` to `LAST_SEEN` as it ages
   relative to a newer snapshot) but never erases or silently merges one state into another.
5. **Observation age is not the same axis as observation currentness.** `freshness.ts` computes
   recent/stale/unknown as a separate concern from section state. An `OBSERVED` section is
   admissible regardless of how old the observation is; there is no global "stale after N hours"
   rule that invalidates evidence.
6. **Pipeline health is not the same thing as fact currentness.** Whether the import/read pipeline
   is working correctly is an operational concern; it does not change what a stored fact means.
7. **Missing or inaccessible storage is never silently empty.** Example: `GuildBankTab`'s
   `INACCESSIBLE` state and the read-only store's refusal to auto-create a missing database file
   both surface the absence explicitly rather than returning an empty/default result.

## VERSION

**ENFORCED IN CODE TODAY**

1. A single `version` column on `characters`, computed once at import time and never changed
   after. Versions are never re-classified retroactively.
2. `WowVersion = classic-era | tbc-anniversary | retail | forever`. These are the only four
   recognized buckets.
3. "Midnight" is **not** a fifth version. It is Retail's current expansion, handled entirely
   inside the `retail` bucket via profession-catalog and item-metadata display logic — never via
   version routing.
4. Unrecognized clients are routed to `UNKNOWN_VERSION` and quarantined rather than guessed into
   one of the four real buckets.
5. Quarantined characters are excluded from `AccountContext`, so they never reach Ask My Account
   or MCP's account-wide views through that pipeline.
6. Versions are never mixed in a calculation. Every stateful account/character operation requires
   an explicit recognized version; nothing defaults to Retail or silently falls back across
   versions.

**FUTURE DESIGN PRINCIPLE**

7. Hardcore/SSF is not a fifth version and is not implemented. It is a stated future intent only
   (see [`ROADMAP.md`](ROADMAP.md), deferred section). When a Hardcore/SSF-aware version is
   eventually modeled, the same quarantine-rather-than-guess discipline used for
   `UNKNOWN_VERSION` today applies: ambiguous Hardcore/SSF input must be quarantined, never
   guessed into Retail or another bucket. No code anywhere in `packages/*/src` currently branches
   on Hardcore/SSF.

## OWNERSHIP

**ENFORCED IN CODE TODAY**

1. Three ownership domains, never collapsed into one concept:
   - **Character Bank** — owned by the character. Never attributed to the account or to another
     character.
   - **Warband** — owned by the account. The current account-scope key is `installation-local`,
     **not** a true Battle.net account identifier — a known, documented limitation. Two Battle.net
     accounts imported into one Dashboard installation are currently indistinguishable and are
     reconciled as one Warband.
   - **Guild Bank** — owned by the guild, keyed by the opaque `guildClubId` string (never parsed
     for structure; no cross-region uniqueness guarantee is assumed from it).
2. **Guild-owned storage is never summed into account-owned assets.** This is enforced
   redundantly at four layers: the domain model (`sharedStorage.ts`), `AccountFacts`, the
   allocation evidence-scope type (which structurally excludes guild from the arithmetic
   entirely, routing it to a separate `guildContext` field the arithmetic never reads), and the
   HTTP route layer.
3. Inaccessible or unobserved guild tabs render as explicitly unknown/inaccessible — never as an
   empty tab.

## METADATA

**ENFORCED IN CODE TODAY**

1. Item metadata is **not an inventory observation**. It is a separate type stored in a separate
   table with no foreign key to characters or snapshots.
2. `expansionID` is a content tag only — the client's own classification of the item — and is
   **never** treated as an obsolescence/age signal. An old item can carry a "new expansion" tag
   and that does not mean the item is new.
3. Conflicting metadata values for the same item produce an explicit `CONFLICT` state exposing
   both values. Metadata conflicts are **never** resolved by latest-wins.
4. One explicit, narrow exception: reputation progress values **are** deduplicated by latest
   `observedAt`. This is a different domain — monotonic game state, not evidentiary item
   metadata — and does not establish a general latest-wins rule. Do not generalize from it.

## ERP

Azeroth ERP Vertical Slice 1 is implemented. See [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md)
for the full semantics; this section lists only the cross-cutting invariants.

**ENFORCED IN CODE TODAY**

1. **Capability != demand.** Observed possession of an item is a fact about the account, not a
   reason to keep, use, or sell it. The allocator never infers demand from capability or
   capability from demand.
2. **Missing demand != demand zero.** `NO_ACTIVE_DEMAND` is a structurally separate branch of
   `AllocationResult` that carries no `allocated`/`confirmedDeficit`/`confirmedSurplus` fields at
   all — not zero-valued, *absent*. A caller cannot mistake "nobody asked" for "fully satisfied."
3. **Known surplus vs. unallocated/unexplained inventory.** `NO_ACTIVE_DEMAND` means "surplus
   cannot yet be determined," not "there is nothing interesting here." Confirmed observed
   inventory with no active demand is real and worth asking about. Slice 2's Account Allocation
   Review lists it as `unallocated` (see 13 below) — as evidence, never as surplus.
4. The only new durable table Slice 1 adds is `demands` — current mutable **intent**, not an
   event/audit history. A row is mutated in place; `status` is `ACTIVE` or `INACTIVE`;
   deactivation is a status transition, never a hard delete.
5. At most one `ACTIVE` demand may exist per `(version, demand type, commodity)` key, enforced at
   the database layer (partial unique index) and the API layer (HTTP 409 on conflict). The pure
   allocator independently defends this: handed two active demands for one commodity, it returns
   `CONFLICTING_DEMAND` rather than silently picking a winner.
6. Commodity identity is `(gameVersion, baseItemId)` only — deliberately not full equipment
   identity (no bonus IDs, gems, or per-instance properties). `STOCK_TARGET` is the only demand
   type, and it is Retail-only in Slice 1.
7. Evidence tiers: character bags/bank `OBSERVED` -> `CONFIRMED`; `LAST_SEEN` -> `POTENTIAL`;
   `UNKNOWN` -> `UNRESOLVED` (no quantity field). Warband evidence follows the same tiers. Guild
   evidence is structurally excluded from arithmetic — contextual only (see OWNERSHIP above). A
   present item row with no reported quantity is never summed as 0: the scope's reported rows are a
   floor flagged by `unknownQuantityRowCount`. In a `CONFIRMED` scope it also yields an `UNRESOLVED`
   (`ITEM_QUANTITY_UNKNOWN`) contribution that engages the disposition gate and is explained as
   `ITEM_QUANTITY_UNKNOWN_PRESENT` — never as unknown storage (`UNRESOLVED_STORAGE_PRESENT` is reserved
   for storage that was not observed). In a `POTENTIAL` scope it gates nothing and adds nothing to any
   quantity, but is still reported (LAST_SEEN reasons; the review's `potentialUnknownQuantityRowCount`).
8. `confirmedAvailable`/`allocated`/`confirmedDeficit`/`confirmedSurplus` are computed from
   `CONFIRMED` evidence only. `POTENTIAL` (historical/`LAST_SEEN`) evidence is tracked separately
   in `potentialAdditionalAvailable` and never added into the confirmed numbers.
9. Disposition gate (computed *after* arithmetic, never changing it): deficit -> `HOLD_ALLOCATED`;
   zero surplus -> `NO_ACTION`; surplus with any unresolved evidence -> `REQUIRES_REVIEW`; clean
   surplus -> `SEND_HELLOMAGS`.
10. **`SEND_HELLOMAGS` is a label/recommendation only.** No mail, vendor, auction, or other
    execute code exists anywhere in this repository. Approval and execution are explicitly
    separate, later concerns.
11. `get_item_allocation` and `get_allocation_review` (the MCP tools) are structurally read-only,
    like every other MCP tool.
    Demand CRUD HTTP routes exist (`packages/server/src/demandRoutes.ts`) but have no caller
    anywhere in this codebase today — no UI, no MCP mutation tool. The only way to manage a
    demand today is a direct HTTP call.
12. Market evidence cannot create demand. No pricing input exists anywhere in `allocation.ts`,
    `allocationReview.ts`, or `demand.ts`.
13. **Unallocated inventory is not surplus.** The Slice 2 review's `unallocated` entries
    (`UnallocatedInventoryEntry`) structurally carry no `surplus`/`confirmedSurplus`/`allocated`/
    `confirmedDeficit`/`disposition` field; they report evidence (confirmed and potential quantities
    kept separate, holdings, unresolved scopes) only. An item held only by a guild is never listed.
    Item metadata enriches entries after paging and never selects or filters them.
14. **One evidence projection, one allocator.** `getItemAllocation` and `getAllocationReview` both
    derive evidence from `projectAccountOwnedEvidenceMap` (each character's latest snapshot and the
    shared-storage projection read once per call) via `evidenceForItem`, and both evaluate demand
    with `buildAllocationResult`. A demanded review entry is identical to `getItemAllocation` for the
    same item (tested). `AccountFacts.InventoryFacts` is not an ERP evidence source: its
    `totalKnownQty` merges OBSERVED with LAST_SEEN and omits the Warband.

## PLAYER INTENT

**FUTURE DESIGN PRINCIPLE — none of this section is implemented in Slice 1 or any shipped code.**

This section describes an intent for future planning layers, not current behavior. It exists so a
future implementer has somewhere correct to stand, without Slice 1 having built it prematurely.

1. Economic *recommendation* and a player's *selected strategy* are different concepts. A player
   who deliberately farms a material because farming is relaxing to them should have planning
   respect that choice rather than repeatedly suggesting the cheaper `BUY` path.
2. A future strategy axis might distinguish `BUY` vs. `FARM` vs. `FARM_OTHER_AND_SELL` vs.
   `USE_STOCK` as genuinely different player-selectable strategies, not just different costs of
   the same recommendation.
3. Gold as an account resource, idle-inventory opportunity cost, and player time as a resource are
   all future inputs to this layer — none exist in Slice 1's allocation arithmetic today.
4. See [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) for the
   fuller reasoning and the TSM/CraftSim/Journalator boundary this layer would eventually need to
   respect.

## MUTATION / SECURITY

**ENFORCED IN CODE TODAY**

1. MCP is structurally read-only at two independent layers:
   - SQLite is opened with `readOnly: true` (OS-level `SQLITE_OPEN_READONLY`) via
     `SqliteSnapshotReadStore`. The MCP process never instantiates the writable
     `SqliteSnapshotStore`.
   - The TypeScript interface given to MCP (`SnapshotReadStore`) has no write methods defined at
     all — this is a compile-time guarantee, not a runtime check or a convention.
2. MCP never initializes, migrates, backfills, or otherwise repairs the database. Schema changes
   belong exclusively to the ordinary writable application/migration path.
3. **MCP never authors demand.** Enforced structurally (no mutation tool exists), not merely by
   convention.
4. Research tools (`list_research_documents`, `search_research`, `get_research_section`,
   `get_research_document`) resolve only fixed registry IDs. They never accept a caller-supplied
   filesystem path.
5. No inbound public MCP listener exists anywhere in this architecture. `tunnel-client` is
   outbound-only HTTPS to the control plane; the MCP process itself communicates only over local
   stdio.
6. Every account-state MCP request requires an explicit version; none defaults to Retail.
7. No live tunnel ID, credential, token, or API key value is ever committed to this repository's
   documentation or source. Where an operational value is needed, documentation points at the
   live service/config as the operational source of truth (see
   [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)) instead of hard-coding it.
