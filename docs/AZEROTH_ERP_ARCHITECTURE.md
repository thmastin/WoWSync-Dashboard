# Azeroth ERP Architecture

This document is the durable architecture contract for the Azeroth ERP work: what it means, what it
does and does not persist, and the invariants every future extension (gear/BoE utility, market evidence,
execution) must preserve. It is not a development diary — implementation trivia (exact tool counts,
acceptance-run dates, tunnel ids) belongs in `docs/MCP_DEVELOPMENT.md` and other reference docs instead.

## 1. Purpose and scope

Azeroth ERP answers one question deterministically: given what the account actually holds and what the
player has explicitly said they want, what is satisfied, what is short, what is uncertain, and what
(non-executing) action follows? It is not a general project-management system, not a pricing engine, and
it does not act on the player's behalf. **Vertical Slice 1** (this milestone) proves the smallest useful
version of that question for one Retail stackable commodity against one explicit demand. **Vertical
Slice 2** (§23) adds the account-wide Account Allocation Review over the same projection and allocator.
**Vertical Slice 3** (§24, shipped and live-validated at
`81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`) adds held-item identity and binding gates so base-item
arithmetic and the sale recommendation are withheld when the evidence cannot support them.

## 2. Central flow

```
observation -> durable truth -> capability + explicit demand -> allocation -> surplus/deficit -> disposition -> explanation
```

- **Observation / durable truth**: the character-storage and shared-storage evidence WoWSync already
  captures and persists (see §5). Unchanged by this work.
- **Capability + explicit demand**: capability is what the account *could* use (it is observed, not
  wanted); demand is what the player *says* they want (§3, §10). Allocation needs both.
- **Allocation -> surplus/deficit -> disposition -> explanation**: all derived, computed fresh on every
  read (§12). Nothing in this chain is itself a durable record in Slice 1.

## 3. CAPABILITY != DEMAND

Observed possession of an item is a fact about the account, not a reason to keep it, use it, or sell it.
An account holding 500 of an item that nobody has declared any use for is just that — 500 observed, with
no demand-driven conclusion available (§13, Scenario 6). Capability is read from existing evidence
(§5/§8); demand is a separate, explicit, durable record a person created (§10). The allocator never
infers demand from capability, and never infers capability from demand.

## 4. MISSING DEMAND != DEMAND ZERO

A commodity with no active demand is not the same as a commodity with a demand of zero. The allocation
result type makes this a structural distinction, not a convention: `NO_ACTIVE_DEMAND` is a separate
branch of the result that carries no `allocated`/`confirmedDeficit`/`confirmedSurplus` fields at all —
not zero-valued fields, *absent* fields (see `packages/core/src/allocation.ts`,
`AllocationResult`/`NoActiveDemandResult`). A caller cannot mistake "nobody asked" for "fully satisfied,
rest is surplus."

**Clarification: `NO_ACTIVE_DEMAND` means "surplus cannot yet be determined," not "there is nothing
interesting to report."** These are different claims. Slice 1 is correct to refuse a surplus
determination when no modeled demand exists — but the inventory itself does not stop being real or
stop being worth asking about. An account holding 500 of an item with no active demand is:

- **not** `confirmedSurplus = 500` (no demand-driven conclusion is available at all — §3, §4 above), but
- **confirmed observed inventory that no modeled demand currently explains or reserves.**

That second framing is a distinct category from a known surplus, worth naming so a future layer has
clean footing to build on without Slice 1 having to guess at its shape:

- **KNOWN SURPLUS** — inventory remaining *after* explicit modeled demand/allocation accounted for some
  of it (§13, §14). This requires an active demand to exist; it is what `confirmedSurplus` on a
  `RESOLVED` result means today.
- **UNALLOCATED / UNEXPLAINED INVENTORY** — inventory for which *no* modeled demand currently exists at
  all. Slice 1 did not name it (no field in `AllocationResult` computes it; a `NO_ACTIVE_DEMAND` result
  only carries the raw `evidence`/`guildContext`). **Slice 2 (§23) names and lists it** as the
  `unallocated` half of the Account Allocation Review: evidence only — confirmed and potential quantities
  and where they are held — with no surplus, no allocation numbers, and no disposition.

A future insight/exception layer may ask *"why are we holding this?"* about unallocated/unexplained
inventory — and, once economic evidence exists in a later slice, may eventually phrase that as something
like *"500 units are currently unallocated by known account demand and represent approximately X gold of
potentially tied-up capital."* That remains an **insight**, not a disposition: it does not answer *"we
should sell it"*, it is not `SEND_HELLOMAGS` or any other `Disposition` value, and producing it is
explicitly out of scope (§20, §23) — no thresholds, no market valuation, no automatic reclassification
into surplus. Slice 2 lists unallocated inventory as evidence; it does not value it, rank it by value, or
draw any conclusion about what to do with it.

## 5. Existing evidence sources (reused, not duplicated)

Slice 1 introduces no inventory ledger. It reads:

1. **Character-owned storage** — each character's latest bags/bank sections (`packages/core/src/types.ts`
   `InventorySection`), with their own OBSERVED/LAST_SEEN/UNKNOWN section state.
2. **Shared-storage journal** — the immutable Warband/Guild observation journal and its derived
   projection (`packages/core/src/sharedStorage.ts`: `SharedJournal`, `projectJournal`, `OwnerProjection`).
3. **Item metadata** — enrichment facets keyed by (version, base item id) (`packages/core/src/itemMetadata.ts`).
   Used only for display/classification, never as an input to allocation arithmetic (§11).

## 6. Why there is no duplicate inventory ledger

Every quantity the allocator uses is projected, on read, from the sources in §5 by a small adapter in
`packages/core/src/allocation.ts`: `projectAccountOwnedEvidenceMap` reads every account-owned scope once and
tallies it by base item id, and `evidenceForItem` is the per-item lookup into that map
(`projectAccountOwnedEvidence`, the Slice 1 entry point, is now exactly that composition — see §23). This mirrors the shared-storage
module's own principle: current state is *derived*, never stored, so it can never drift from the
evidence it was computed from and can never be resurrected or invalidated independently of that
evidence. The only new durable table this milestone adds is `demands` (§10) — intent, not inventory.

## 7. Ownership semantics

Ownership and storage *location* are different concepts and are never collapsed:

- **Character Bank** — owned by the character. Never attributed to the account or another character.
- **Warband** — owned by the account (this Dashboard installation's undifferentiated Retail account
  scope; see `sharedStorage.ts`'s `AccountScope` comment on its known limitation). Eligible for account
  demand.
- **Guild Bank** — owned by the guild. **Never** eligible to satisfy account demand and **never** counted
  toward account surplus, no matter how large the observed quantity. It is reported as context only
  (`AllocationResult.guildContext`), a field the allocation arithmetic structurally never reads from
  (§13, Scenario 5).

## 8. OBSERVED / LAST_SEEN / UNKNOWN

These three states remain distinct all the way through the allocation result:

- **OBSERVED** -> `CONFIRMED` evidence. Contributes to `confirmedAvailable`.
- **LAST_SEEN** -> `POTENTIAL` evidence. Historical/replayed, kept in a separate total
  (`potentialAdditionalAvailable`) that can never satisfy demand or create confirmed surplus.
- **UNKNOWN** (a character's bags/bank never observed, or a Warband never observed at all) ->
  `UNRESOLVED` evidence. Carries **no quantity at all** (never `0`) and is surfaced explicitly
  (`hasUnresolvedEvidence`, `unresolvedScopes`). `unresolvedCause: "STORAGE_UNKNOWN"`; explained by the
  `UNRESOLVED_STORAGE_PRESENT` reason.
- **A present item row with no reported quantity** (the export's quantity cell is `?`) is also never `0`.
  The scope's reported rows still form its tier quantity, now a floor, and the contribution carries
  `unknownQuantityRowCount`. The two tiers are handled differently, and neither invents a quantity:
  - In a `CONFIRMED` scope the **storage was observed; only the item quantity is unknown**. It produces a
    companion `UNRESOLVED` contribution (`unresolvedCause: "ITEM_QUANTITY_UNKNOWN"`, no quantity), so the
    conservative gate (§14) withholds `SEND_HELLOMAGS` exactly as it does for unknown storage. Its reason is
    `ITEM_QUANTITY_UNKNOWN_PRESENT`, **never** `UNRESOLVED_STORAGE_PRESENT`: observed storage is never
    reported as unknown storage, and when both causes occur both reasons appear separately.
  - In a `POTENTIAL` (LAST_SEEN) scope it produces no `UNRESOLVED` contribution and gates nothing:
    historical evidence never reaches confirmed numbers, never satisfies demand, and never adds to
    `potentialAdditionalAvailable`, which counts known quantities only. It is still reported: the
    `LAST_SEEN_INVENTORY_PRESENT`/`LAST_SEEN_NOT_ADMISSIBLE` reasons appear even when the known LAST_SEEN
    quantity is 0, with a detail stating that `potentialAdditionalAvailable` is a floor; the Slice 2 review
    entry carries `potentialUnknownQuantityRowCount` (§23).
  (Before Slice 2 such a row was summed as `0`; that was an UNKNOWN-as-zero defect, corrected in §23.)

## 9. Observation age vs. allocation admissibility

These are deliberately different questions. An OBSERVED section is `CONFIRMED` regardless of how old the
observation is; this milestone does not introduce an "older than N hours is stale" rule anywhere. Age is
freshness information the Dashboard already surfaces elsewhere (`classifyFreshness`); it does not change
whether a piece of evidence may be counted toward confirmed allocation.

## 10. Explicit Demand: ownership and lifecycle

**Explicit Demand is the one new durable domain concept this milestone adds.** It is user *intent*
("I want N of this commodity"), never a WoW observation, and it is kept structurally separate from
everything in §5.

- **Ownership**: GearExport/the addon owns observation capture (unchanged). The Dashboard owns durable
  explicit demand (new: `packages/core/src/demand.ts`, `demands` table, Dashboard server API). Core owns
  deterministic allocation reasoning (`allocation.ts`). MCP reads and explains the result; **MCP never
  authors demand** — enforced structurally, not by convention (§14).
- **Lifecycle**: demand persistence represents **CURRENT USER INTENT**, not an audit/event history. A
  row is mutated in place (`requiredQuantity`, `purpose`, `status`, `updatedAt`); there is no immutable
  superseding chain in Slice 1. `status` is `ACTIVE` or `INACTIVE`; deactivation is a status transition,
  never a hard delete, so the record and its timestamps remain.
- **Conflict**: at most one `ACTIVE` demand may exist per (version, demand type, commodity) key. This is
  enforced at the database layer (a partial unique index on `status = 'ACTIVE'`) and at the API layer
  (HTTP 409 on a conflicting create) — never resolved by silently picking a winner. The pure allocator
  defends independently: if it is ever handed more than one active demand for one commodity directly, it
  returns an explicit `CONFLICTING_DEMAND` result rather than choosing one.
- **Future history**: approval history, execution correlation, Journalator outcomes, and economic
  learning are explicitly deferred (§16). When needed, they belong in separate durable records that
  reference a demand by its stable id — this milestone does not build that now.

## 11. Commodity identity vs. future exact-item identity

Slice 1's commodity identity is `(version, base item id)` — sufficient for stackable-commodity reasoning,
and deliberately **not** promoted to a universal item-identity model. A future BoE/equipment slice will
need *exact*-item identity (bonus ids, gems, and other properties that distinguish individual equipped
instances of the same base item) — a materially different question from "how many of this stackable item
exist." `CommodityIdentity` in `demand.ts` carries a `kind: "commodity"` discriminator precisely so a
future `kind: "exact-item"` variant can be added to the identity union without this slice having built
it, and without commodity reasoning silently becoming the wrong tool for equipment reasoning later.
Slice 3 (§24) does not build that identity either: it only detects, from captured item strings, when
base-item aggregation is **not proven** valid, and then withholds the arithmetic.

## 12. Derived allocation model

Everything that isn't `ExplicitDemand` itself is **derived on every read**, not persisted:
`AllocationResult`, its evidence contributions, its reasons, and its disposition recommendation. The
current Slice 1 preference is explicit: *persist observations + persist user intent; derive decisions*.
Decision/outcome persistence (needed for approval history, execution correlation, learning) is a
deliberate future extension (§16), not built now, because nothing in Slice 1's proof requires it.

## 13. Confirmed vs. historical/potential availability

`confirmedAvailable` sums only `CONFIRMED` (OBSERVED-admissible) evidence. `potentialAdditionalAvailable`
sums `POTENTIAL` (LAST_SEEN) evidence separately and is never added into `confirmedAvailable`,
`allocated`, or `confirmedSurplus`. A reader can see that historical evidence exists without it ever
being mistaken for current inventory.

## 14. Confirmed floor arithmetic vs. disposition certainty (the conservative UNKNOWN gate)

This is the central policy decision of Slice 1, and it deliberately treats two questions as different:

- **"What do we know for certain?"** — arithmetic. A confirmed floor (`confirmedAvailable`, `allocated`,
  `confirmedDeficit`, `confirmedSurplus`) may be computed and reported precisely even while some
  account-owned scope remains UNKNOWN, because that floor is built entirely from evidence that already
  *is* OBSERVED — an unresolved scope can only ever add to it later, never retroactively shrink it.
- **"What are we willing to act on?"** — disposition. Regardless of how confident the arithmetic is,
  disposition **never** recommends `SEND_HELLOMAGS` while any relevant account-owned evidence remains
  UNRESOLVED. It recommends `REQUIRES_REVIEW` instead, with the confirmed floor surplus still visible and
  explicitly flagged as gated (`SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE`).

There is no global "stale after N hours" rule (§9) and no silent collapsing of these two questions into
one boolean or status field — see `buildAllocationResult` in `allocation.ts`.

Slice 3 adds a second, independent disposition gate (§24): confirmed bound or binding-unknown rows also
withhold `SEND_HELLOMAGS` from a confirmed surplus (`SALE_DISPOSITION_GATED_BY_BINDING`). Binding is not
unresolved evidence and never sets `hasUnresolvedEvidence`; both gates' reasons may coexist.

## 15. Allocation before disposition

The allocation numbers (`allocated`, `confirmedDeficit`, `confirmedSurplus`) are computed first, from
demand and evidence alone. Disposition is a policy decision layered on top of that already-computed
arithmetic (§14) — it never influences the arithmetic itself. In code this is currently one function
(`buildAllocationResult`) with disposition decided immediately after the arithmetic, not a separate
persisted step. Whether disposition should become its own pure policy function, callable independently
of allocation, is an open question future slices may need to revisit if disposition policy grows more
rules than the conservative gate alone.

## 16. Recommendation vs. approval vs. execution

Slice 1 produces a **recommendation** only. `SEND_HELLOMAGS` means confirmed, unallocated account surplus
is *eligible* for the Retail sale-inventory pipeline — it is not an instruction, and nothing in this
milestone mails, moves, vendors, posts, or otherwise executes anything. Approval (a person or a future
system deciding to act on a recommendation) and execution (actually doing it, e.g. `/bankx`) are
out of scope and are explicitly deferred to later work (§17). No execution code exists anywhere in this
milestone.

## 17. Hellomags sale-pipeline semantics

"Hellomags" names the approved Retail sale-inventory location/pipeline. `SEND_HELLOMAGS` as a disposition
value means exactly: *this confirmed surplus quantity is approved-to-recommend for that pipeline*. It
does not mean the item has been moved there, and Hellomags itself is never treated as unresolved storage
or as a location whose contents need to be observed by this slice.

## 18. Structured explanation / reason contract

`AllocationResult.reasons` is a list of stable, typed `AllocationReasonCode` values (with an optional
free-text `detail`), not prose. The same deterministic result — demand, confirmed/potential/unresolved
evidence, allocation numbers, disposition, and reasons — is intended to be consumed identically by the
Dashboard UI (not built in Slice 1, see §19), Ask My Account, MCP, future scheduled exception detection,
and tests. An LLM consumer explains this structured truth; it does not reconstruct the arithmetic from
prose, and it cannot author demand (§14, §20).

## 19. Current Slice 1 scope

- Retail only; one demand type (`STOCK_TARGET`); one commodity per demand; account-scoped (no character
  scope); stackable-commodity reasoning only.
- New durable state: the `demands` table only (§10). No allocation/surplus/deficit/disposition/decision
  history table exists.
- Server API: minimal demand CRUD (create/list/update/deactivate; no hard delete) — see
  `packages/server/src/demandRoutes.ts`.
- No demand-management UI. The proof is the API plus deterministic tests; a UI was judged premature
  before the allocator itself was proven (see the Slice 1 implementation report for the tradeoff).
- Read model: `DashboardReadModel.getItemAllocation` is the one new orchestration method.
- MCP: one new read-only tool, `get_item_allocation` (see `docs/MCP_DEVELOPMENT.md`).

## 20. Explicit non-goals (this milestone)

Not implemented in Slice 1, and not accidentally reachable by it: TSM pricing/market evidence,
Journalator integration, sale/outcome history, CraftSim, crafting queues/recipe planning, BoE
scoring/gear-upgrade decisions, `POTENTIAL_UPGRADE`, automated Warband refresh, `/bankx` execution,
automatic mail/auction posting, scheduled ChatGPT tasks, autonomous agents, market-learning models, a
generalized Projects/ERP UI, and any change to GearExport or BankCleanup (both separate repositories,
untouched).

## 21. Future extension seams

These are documented as **future** constraints this architecture must accommodate, not built now:

- **Gear/BoE utility**: will need the exact-item identity this slice deliberately did not build (§11).
- **TSM market evidence**: must remain unable to *invent* demand (§3) — it may inform disposition policy
  later, but a price is never a substitute for an explicit demand record.
- **Journalator outcomes / decision history**: separate durable records keyed by a demand's stable id,
  added only when approval history, execution correlation, or economic learning actually need it (§10,
  §12).
- **Scheduled exception detection**: a consumer of the same deterministic `AllocationResult` shape (§18),
  not a new calculation path. Slice 2's on-demand Account Allocation Review (§23) is the read such a
  scheduler would consume; scheduling, alerting, and any valuation of unallocated inventory remain future
  work and must never reclassify unallocated inventory into surplus.
- **Execution / BankX**: a strictly later, explicitly separate concern from recommendation (§16).

## 22. Cross-cutting invariants future ERP work must preserve

1. Never mix WoW versions.
2. UNKNOWN != zero, anywhere in the chain.
3. OBSERVED / LAST_SEEN / UNKNOWN remain distinct all the way to the final result.
4. Observation age is never automatically equated with invalidity (§9).
5. LAST_SEEN historical evidence never silently becomes current inventory.
6. Character Bank = character-owned; Warband = account-owned; Guild Bank = guild-owned, and the three are
   never collapsed into one ownership concept (§7).
7. Guild-owned evidence can never satisfy or inflate account demand/surplus.
8. Inaccessible/unobserved storage is never represented as empty (§8).
9. Item metadata remains enrichment; it never becomes inventory observation or an age/obsolescence
   signal (`expansionID` is a content tag, never an age signal).
10. Capability != demand; missing demand != demand zero (§3, §4).
11. Market evidence cannot invent demand (§21).
12. Allocation is computed before disposition, and disposition policy never changes the arithmetic (§14, §15).
13. Recommendation, approval, and execution remain three separate concepts (§16).
14. MCP remains a constrained, structurally read-only reasoning boundary: it never initializes, migrates,
    backfills, or mutates SQLite, and it never authors demand — enforced by `SqliteSnapshotReadStore`
    never implementing any write method, not merely by convention (§10, §14, §20).
15. MCP account-state requests require an explicit version; nothing defaults to Retail.
16. Unallocated inventory is not surplus: an item with no active demand never carries surplus, allocation
    numbers, a disposition, or a sale recommendation (§4, §23).
17. One evidence projection: every ERP read (per-item or account-wide) derives its quantities from the
    same `projectAccountOwnedEvidenceMap`/`evidenceForItem` path and every demanded result from the same
    `buildAllocationResult` — never a parallel allocator or a second inventory aggregation (§6, §23).
18. Base-item arithmetic is performed only when the confirmed rows' item strings prove aggregation valid;
    otherwise the result structurally omits allocation numbers (`BASE_ITEM_AGGREGATION_UNPROVEN`, §24).
    A bare `item:<id>` is unknown identity, never "no modifiers"; no modifier/bonus/context value is
    safe-listed.
19. `bound=no` never certifies transferability; bound or unknown binding can only withhold a sale
    recommendation, never invent one. LAST_SEEN identity/binding facts never gate confirmed results (§24).

## 23. Vertical Slice 2: Account Allocation Review

**Implemented.** One account-wide, read-only ERP view answering: *which explicit active demands have
allocation results needing attention, and which account-owned inventory has no modeled active demand?*

- **Read model**: `DashboardReadModel.getAllocationReview({ version, demandedOffset?, demandedLimit?,
  unallocatedOffset?, unallocatedLimit? })`. Retail-only and explicit-version, exactly like
  `getItemAllocation` (a recognized non-Retail version returns `UNKNOWN` provenance and no data; a missing or
  unrecognized version is rejected). Pure assembly lives in `packages/core/src/allocationReview.ts`
  (`buildAllocationReview`).
- **MCP**: one new read-only tool, `get_allocation_review` (see `docs/MCP_DEVELOPMENT.md`). No mutation.
- **Result**:
  - `unresolvedStorage` / `hasUnresolvedStorage` — whole account-owned scopes whose contents are UNKNOWN
    (a character's bags/bank, or a Warband never observed). Reported once; they apply to every item.
  - `unidentifiedItemRowCount` — account-owned item rows with no parseable base item id. Counted, never
    silently dropped, but not attributable to any item.
  - `demanded` — every ACTIVE `STOCK_TARGET` demand's `AllocationResult`, **identical** to what
    `getItemAllocation` returns for that item (same projection, same `buildAllocationResult`; two active
    demands for one item still produce `CONFLICTING_DEMAND`). Ordered `HOLD_ALLOCATED`, `REQUIRES_REVIEW`,
    `SEND_HELLOMAGS`, `NO_ACTION`, then base item id — a fixed attention order, not a score.
    `dispositionCounts` covers every demanded item, not only the returned page.
  - `unallocated` — every base item held in a `CONFIRMED`/`POTENTIAL` account-owned scope (character bags,
    character bank, Warband) with no ACTIVE demand, ascending base item id. Each entry
    (`UnallocatedInventoryEntry`, `allocationState: "UNALLOCATED"`) exposes `baseItemId`, an observed
    `name`, `confirmedQuantity`, `potentialQuantity` (never summed together; both count known quantities
    only), `potentialUnknownQuantityRowCount` (LAST_SEEN rows of unknown quantity — when > 0,
    `potentialQuantity` is a known floor, not a known historical total, and never a historical zero),
    `hasUnresolvedEvidence` and `unresolvedScopes` (evidence that could change the confirmed quantity:
    unknown storage, or unknown item quantity in observed storage — not LAST_SEEN uncertainty), `holdings`
    (the contributions that actually hold the item), and `guildContext`.
    It **structurally has no** `surplus`/`confirmedSurplus`/`allocated`/`confirmedDeficit`/`disposition`
    field. Item metadata (`metadataState`, `metadata`) is attached after paging, for presentation only; it
    never selects, filters, or orders entries, so unknown metadata never hides held inventory.
- **Ownership**: guild-owned evidence never enters any account quantity; an item held only by a guild never
  becomes an unallocated account item (it appears only as `guildContext` on entries the account also holds
  or demands).
- **Identity**: entries are keyed by base item id, the same identity Slice 1 uses. That is not a claim that
  every held item is a stackable or auction-house commodity; exact-item identity is still future (§11).
  `CommodityIdentity` is unchanged on `AllocationResult` for Slice 1 compatibility.
- **One projection, no drift**: `projectAccountOwnedEvidenceMap` reads each character's latest snapshot once
  and the shared-storage projection once, tallying every scope by base item id; `evidenceForItem` is the
  per-item lookup both `getItemAllocation` and the review use. The review never re-reads storage per item.
  It does not use `AccountFacts.InventoryFacts`, whose `totalKnownQty` merges OBSERVED with LAST_SEEN and
  omits the Warband.
- **Paging**: `demanded` and `unallocated` are independent `BoundedPage`s (default limit 50, maximum 100,
  the read model's standard `pageBounds`) over a total, deterministic order; `totalCount`/`truncated`
  report what lies beyond the page. Nothing is dropped to fit a bound.
- **Unknown item quantity**: corrected as described in §8. This also applies to `getItemAllocation`: a
  confirmed floor surplus whose item has an unreported-quantity row in observed storage is now
  `REQUIRES_REVIEW` (reason `ITEM_QUANTITY_UNKNOWN_PRESENT`), never `SEND_HELLOMAGS`; an unreported quantity
  in LAST_SEEN storage changes no number and no disposition, and is reported through the LAST_SEEN reasons.
- **New durable state**: none. The review is derived on every read and never persisted.
- **Hellomags**: unchanged — an ordinary account-owned Retail character for allocation purposes. No special
  sale-inventory designation exists; that needs explicit design before it is built.
- **Not in Slice 2**: valuation, prices, vendor-value ranking, TSM/CraftSim/Journalator, thresholds or any
  rule turning unallocated inventory into surplus, dispositions or sale recommendations for unallocated
  inventory, new demand types, demand-authoring UI, MCP demand mutation, character-scoped demand,
  exact-equipment allocation, transfer plans, `/bankx` or any execution, scheduling/alerts, persisted review
  results, non-Retail allocation, a Dashboard UI for the review, and any special Hellomags policy.
- **Validation**: automated (`packages/core/test/readModelAllocationReview.test.ts`, plus the MCP
  protocol test) and live-validated end to end on 2026-10-03 — see
  [Live validation record: Azeroth ERP Slice 2](#live-validation-record-azeroth-erp-slice-2).

## 24. Vertical Slice 3: Held-item identity and binding

**Shipped and live-validated at `81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`.** Slices 1–2
aggregated every held row by base item id. Two demonstrated cases made that unsafe: a confirmed **bound**
Hearthstone under `STOCK_TARGET 0` produced surplus 1 and `SEND_HELLOMAGS`, and two equipment rows of one
base item with materially different item strings collapsed into one quantity with a surplus. Slice 3 adds
two independent questions, answered from evidence already captured (no new persistence, no schema change):

- **Can confirmed held evidence be aggregated by base item id?** Each row's captured `itemRef` is parsed by
  `packages/core/src/heldItemIdentity.ts`. A full item string is normalized by blanking **only** linkLevel
  and specID (they describe the viewing character, not the item) and stripping trailing empty fields; every
  other represented field is preserved exactly (`""` and `"0"` stay distinct, bonus IDs are not reordered,
  no modifier/bonus/context value is treated as harmless). A bare `item:<id>` (GearExport's fallback when no
  hyperlink exists) is **incomplete**: its other fields are UNKNOWN, not empty. Per tier, CONFIRMED and
  POTENTIAL independently, the class is `UNIFORM_ITEM_STRING` (every row full, all normalize identically),
  `ITEM_STRING_VARIANTS` (two or more distinct normalized full strings; takes precedence),
  `ITEM_STRING_INCOMPLETE` (a bare row and no variants), or `NONE_HELD`; `distinctItemStringCount` counts
  distinct normalized full strings only. This is not "exact" or "instance" identity: it only establishes
  whether base-item aggregation is **not proven**.
- **Does binding evidence require withholding the sale recommendation?** `bound` is the renderer's mapping of
  `C_Container.GetContainerItemInfo(...).isBound` for character bags, character bank, and Warband:
  `yes` (currently bound, any form including account/Warbound — soulbound and Warbound are not
  distinguished, so the unit **may be restricted**), `no` (not currently bound — certifies nothing about
  mailability, auctionability, or Hellomags eligibility), and `?`/missing/anything else (UNKNOWN). Facets
  `confirmedBinding`/`potentialBinding` count **rows**, not quantities: `boundRowCount`, `unboundRowCount`,
  `unknownRowCount`.

Result semantics (`buildAllocationResult`, precedence `NO_ACTIVE_DEMAND` → `CONFLICTING_DEMAND` →
`BASE_ITEM_AGGREGATION_UNPROVEN` → `RESOLVED`; the first two are unchanged):

- **`BASE_ITEM_AGGREGATION_UNPROVEN`** — an active, otherwise-allocatable demand whose
  `confirmedItemStringIdentity` is `ITEM_STRING_VARIANTS` or `ITEM_STRING_INCOMPLETE`. Carries `demand`,
  `confirmedQuantity`, `potentialQuantity`, `hasUnresolvedEvidence`, `unresolvedScopes`, `evidence`,
  `guildContext`, `reasons`, the four facets, and `disposition: "REQUIRES_REVIEW"`. It **structurally
  omits** `allocated`, `confirmedDeficit`, and `confirmedSurplus` (no zero or approximate stand-ins).
- **Binding gate** — on a `RESOLVED` result with `confirmedSurplus > 0`, any confirmed bound or
  binding-unknown row turns `SEND_HELLOMAGS` into `REQUIRES_REVIEW` (`SALE_DISPOSITION_GATED_BY_BINDING`).
  Arithmetic is unchanged. Without positive surplus, binding is reported but changes no disposition.
- Every read-model result (all four variants) carries `confirmedItemStringIdentity`,
  `potentialItemStringIdentity`, `confirmedBinding`, and `potentialBinding`. POTENTIAL (LAST_SEEN) facets
  are reported and never gate anything. Guild rows never contribute to any facet.
- New reasons — facts (CONFIRMED tier only): `ITEM_STRING_VARIANTS_PRESENT`, `ITEM_STRING_INCOMPLETE`,
  `BOUND_INVENTORY_PRESENT`, `BINDING_UNKNOWN_PRESENT`; effects: `BASE_ITEM_AGGREGATION_UNPROVEN`,
  `SALE_DISPOSITION_GATED_BY_BINDING`. They are separate from unknown storage, unknown quantity, LAST_SEEN,
  and `SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE`, and may coexist with them.
- **One projection**: `ItemTally.heldRows` accumulates normalized strings, bare-row count, and binding
  counts per scope inside `projectAccountOwnedEvidenceMap`; `heldItemFacetsForItem` reads them, and
  `allocationForItem` is the single per-item path used by both `getItemAllocation` and the review, so a
  demanded review entry is the same result by construction.
- **Review**: `BASE_ITEM_AGGREGATION_UNPROVEN` sorts in the `REQUIRES_REVIEW` group and counts there.
  Unallocated entries gain the four facets (still no allocation/surplus/disposition/recommendation fields),
  and `unallocatedItemStringIdentityCounts` (`confirmed`/`potential`, per class) covers the whole
  unallocated list, not the page. Unallocated entries are never filtered or reordered by class.
- `buildAllocationResult` requires `guildContext` and the `HeldItemFacets`; there is no call shape that
  omits them, and every result variant carries all four facets.
- **Practical consequence**: an item captured only as a bare `item:<id>` can no longer be allocated until a
  full item string is captured for every confirmed row.
- **Validation**: automated (`heldItemIdentity.test.ts`, `allocation.test.ts`,
  `readModelAllocation.test.ts`, `readModelAllocationReview.test.ts`, MCP protocol test); implementation
  suite passed 1,055/1,055 before deployment, followed by independent review and targeted re-review.
  The deployed result was checked locally and then through a blind external ChatGPT MCP conversation;
  binding-only isolation remains covered by automated tests because the real binding case also had
  unresolved storage evidence. See the Slice 3 live-validation record below.

## Live validation record: Azeroth ERP Slice 3

**Validated source:** `81f66eeb8a035acf3c633f6fa9d8693cc4f9a009` on
`feature/erp-slice3-held-item-identity`, later fast-forwarded to `main`.
Blind external ChatGPT validation passed through the refreshed WoWSync DEV MCP connection in a fresh
conversation. The conversation received Retail, item IDs 244752 and 8529, and instructions to inspect
allocation and allocation review; it did not receive expected quantities, classes, dispositions, reasons,
or arithmetic. Both item results matched the deployed production read model, and allocation-review
entries matched the corresponding `get_item_allocation` results. The review contained two demanded items,
both `REQUIRES_REVIEW`, and neither item remained in the unallocated/no-demand set.

- **Case A — Evercore Shade (244752):** real OBSERVED Virek bag evidence, quantity 3, three normalized
  item strings (modifiers 29:32, 29:36, 29:40), class `ITEM_STRING_VARIANTS`, and three unbound rows.
  With `STOCK_TARGET 0`, the result was `BASE_ITEM_AGGREGATION_UNPROVEN` / `REQUIRES_REVIEW`; `allocated`,
  `confirmedDeficit`, and `confirmedSurplus` were structurally absent. Reasons included
  `EXPLICIT_DEMAND_EXISTS`, `ITEM_STRING_VARIANTS_PRESENT`, `BASE_ITEM_AGGREGATION_UNPROVEN`, and
  `UNRESOLVED_STORAGE_PRESENT`. The two UNKNOWN character-bank scopes (Groit and Hallo) remained UNKNOWN
  and were not refreshed for validation.
- **Case B — Noggenfogger Elixir (8529):** real OBSERVED bag evidence, quantity 18, one uniform normalized
  item string, and five bound rows. With `STOCK_TARGET 0`, confirmed surplus was 18 and disposition was
  `REQUIRES_REVIEW` with both unresolved-storage and binding gates. Reasons included
  `EXPLICIT_DEMAND_EXISTS`, `CONFIRMED_INVENTORY_MEETS_DEMAND`, `UNRESOLVED_STORAGE_PRESENT`,
  `BOUND_INVENTORY_PRESENT`, `SURPLUS_CONFIRMED`, `SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE`, and
  `SALE_DISPOSITION_GATED_BY_BINDING`. This deliberately demonstrates the composed gates; it does not
  isolate binding. `bound=yes` does not establish soulbound status, account/Warbound status, or auction,
  mail, or Hellomags transferability. Automated tests establish binding-only gate behavior.

The review reported two demanded items (244752 and 8529), both in `REQUIRES_REVIEW` (all other
disposition counts 0). Its unallocated/no-demand set contained 685 entries across pages; neither
demanded item appeared there. Potential/LAST_SEEN identity and binding facets were reported as context
only and did not gate; Guild rows remained separate context and were excluded from account allocation
arithmetic.

Before the temporary demands, confirmed/OBSERVED Retail evidence represented 496 held base items:
481 `UNIFORM_ITEM_STRING`, 15 `ITEM_STRING_VARIANTS`, and 0 `ITEM_STRING_INCOMPLETE`. Across 643 confirmed
rows, 0 were bare/incomplete (0%). Potential/LAST_SEEN evidence is separate: 243 base items, all
`UNIFORM_ITEM_STRING` (0 variants, 0 incomplete), across 251 rows (239 character-bank and 12 Warband),
with 0 bare item references. LAST_SEEN is contextual and not current. Groit and Hallo account-owned
character banks remained UNKNOWN; UNKNOWN was not converted to zero. The two temporary Slice 3 demands
were subsequently deactivated through the normal Dashboard API and retained as inactive records.

## Live validation record: Azeroth ERP Slice 1

**This section is a historical acceptance record, not a description of current demand state.**
It documents one real-data event that proved the full Slice 1 chain end-to-end, on 2026-10-02. The
demand it describes was later deactivated (see below); do not read this section as "the current
active demand" at any later date.

**What was tested:** one Retail stackable commodity, item "Void-Tempered Leather", base item ID
`238511`.

**Observed account-owned inventory at the time** (character-bank evidence, `CONFIRMED`):

| Character | Quantity |
|---|---|
| Squashpot | 435 |
| Virek | 27 |
| Janne | 5 |
| **Total confirmed** | **467** |

**Demand used:** a temporary validation `STOCK_TARGET` demand, required quantity **450**, created
through the normal demand API (not inserted directly into the database).

**Result, via the live ChatGPT DEV MCP path** (`get_item_allocation`, through the real Secure MCP
Tunnel, not a local test fixture):

| Field | Value |
|---|---|
| Resolution | `RESOLVED` |
| Confirmed available | 467 |
| Allocated | 450 |
| Confirmed deficit | 0 |
| Confirmed surplus | 17 |
| Potential additional available | 0 |
| Unresolved evidence | `character-bank` |
| Disposition | `REQUIRES_REVIEW` |

The disposition landed on `REQUIRES_REVIEW` rather than `SEND_HELLOMAGS` precisely because of the
conservative UNKNOWN gate (§14): even with a clean confirmed-floor surplus of 17, unresolved
character-bank evidence elsewhere on the account was enough to withhold the sale recommendation.
This is the gate working as designed, not a defect in the test.

**Cleanup:** the temporary demand was deactivated afterward through the normal API — a `status`
flip to `INACTIVE`, never a delete (§10) — so its record and timestamps remain, but it no longer
participates as an active demand.

**What this proved:** the full chain from raw WoW evidence through to a ChatGPT-visible, correctly
gated ERP decision, with no step bypassed or faked:

```
WoW evidence -> SQLite -> explicit demand (API) -> ERP allocation -> DashboardReadModel
             -> read-only MCP -> Secure MCP Tunnel -> ChatGPT
```

See [`TESTING_AND_VALIDATION.md`](TESTING_AND_VALIDATION.md) for how to record the next such event
using this one as a template, and [`CURRENT_STATE.md`](CURRENT_STATE.md) for the current
(non-historical) summary this record is cross-linked from.

## Live validation record: Azeroth ERP Slice 2

**This section is a historical acceptance record, not a description of current demand state.** It
documents one real-data event, on 2026-10-03, that proved the Slice 2 chain end to end. The demand it
describes was deactivated afterward; do not read it as a current active demand.

**Source under test:** `77f9c95bdeb5d804bc8bdce68f3e25ad1e9083ee`, deployed only to the isolated
Omarchy DEV runtime (Dashboard and MCP tunnel restarted onto it), then fast-forwarded to `main`.

**Item:** Retail "Void-Tempered Leather", base item ID `238511`. Observed account-owned inventory at the
time (all `CONFIRMED`, character bags): Squashpot 435, Virek 27, Janne 5 — **467** confirmed. No
Warband or guild quantity for the item; guild evidence appeared only as context (quantity 0).

**Demand used:** one temporary `STOCK_TARGET` demand, required quantity **450**, created through the
normal demand API (`demand_5a6b833d-49b8-44a9-aded-cce080447f18`).

**Result, via a fresh ChatGPT conversation over the real Secure MCP Tunnel** (blind: the prompt
carried no expected values):

| `get_allocation_review` / `get_item_allocation` (238511) | Value |
|---|---|
| Resolution | `RESOLVED` |
| Confirmed available | 467 |
| Potential additional available | 0 |
| Unresolved evidence / scopes | true / `character-bank` |
| Allocated | 450 |
| Confirmed deficit | 0 |
| Confirmed surplus | 17 |
| Disposition | `REQUIRES_REVIEW` |
| Reasons | `EXPLICIT_DEMAND_EXISTS`, `CONFIRMED_INVENTORY_MEETS_DEMAND`, `UNRESOLVED_STORAGE_PRESENT`, `SURPLUS_CONFIRMED`, `SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE` |

- The demanded review entry matched `get_item_allocation` **field for field**.
- Review level: `demanded` totalCount 1 (not truncated); `dispositionCounts` HOLD_ALLOCATED 0,
  REQUIRES_REVIEW 1, SEND_HELLOMAGS 0, NO_ACTION 0; `unresolvedStorage` = the character banks of
  `retail::stormrage::groit` and `retail::tichondrius::hallo` (the cause of the conservative gate, §14).
- `unallocated`: totalCount 686 (687 before the demand; 238511 left the list). The first page at limit 3
  was 117 Tough Jerky (confirmed 4), 769 Chunk of Boar Meat (3), 858 Lesser Healing Potion (1), each with
  `potentialQuantity` 0, `potentialUnknownQuantityRowCount` 0, `hasUnresolvedEvidence` true, and
  **structurally no** `surplus`/`confirmedSurplus`/`allocated`/`confirmedDeficit`/`disposition`/
  `recommendation` field. Unallocated inventory stayed evidence only.
- The real data contained no unknown-quantity rows, so the §8 unknown-quantity handling was proven by
  automated tests only, not by this event.

**Cleanup:** the temporary demand was deactivated afterward through the normal API (status `INACTIVE`,
never deleted; no direct SQLite write). No ACTIVE validation demand remained.

**What this proved:**

```
WoW evidence -> DEV SQLite -> explicit demand (API) -> DashboardReadModel.getAllocationReview
             -> read-only MCP get_allocation_review -> Secure MCP Tunnel -> ChatGPT
```
