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
version of that question for one Retail stackable commodity against one explicit demand.

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

## 5. Existing evidence sources (reused, not duplicated)

Slice 1 introduces no inventory ledger. It reads:

1. **Character-owned storage** — each character's latest bags/bank sections (`packages/core/src/types.ts`
   `InventorySection`), with their own OBSERVED/LAST_SEEN/UNKNOWN section state.
2. **Shared-storage journal** — the immutable Warband/Guild observation journal and its derived
   projection (`packages/core/src/sharedStorage.ts`: `SharedJournal`, `projectJournal`, `OwnerProjection`).
3. **Item metadata** — enrichment facets keyed by (version, base item id) (`packages/core/src/itemMetadata.ts`).
   Used only for display/classification, never as an input to allocation arithmetic (§11).

## 6. Why there is no duplicate inventory ledger

Every quantity the allocator uses is projected, on read, from the sources in §5 by a small adapter
(`projectAccountOwnedEvidence` in `packages/core/src/allocation.ts`). This mirrors the shared-storage
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
  (`hasUnresolvedEvidence`, `unresolvedScopes`).

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
  not a new calculation path.
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
