# Non-Goals and Future Architecture

This document answers "why isn't X built" and records future ERP concepts that are deliberately
**not** committed to, and not implemented. Everything in this document is either a non-goal
(WoWSync should not build this) or future/exploratory material (WoWSync might build this
eventually, but has not). **No sentence here describes shipped code.** For what actually ships
today, see [`CURRENT_STATE.md`](CURRENT_STATE.md); for what is actively planned next, see
[`ROADMAP.md`](ROADMAP.md).

The guiding principle: **WoWSync should not rebuild a mature external system merely because it
needs that system's evidence.** Where a mature tool already solves a problem well, the right
integration is to consume or reference its evidence, not to reimplement its reasoning inside
WoWSync.

## Boundary with mature external systems

### TSM (TradeSkillMaster)

TSM is Retail's mature market-data/auctioning system. It is a plausible **future market-evidence
source** for WoWSync — e.g. informing disposition policy with a price signal. It is explicitly
**not** a demand source: market evidence cannot create demand. This constraint is already enforced
in Slice 1's allocation code today — no pricing input exists anywhere in `allocation.ts` or
`demand.ts` — and must remain true of any future TSM integration. A price can inform what to do
with a confirmed surplus; it can never manufacture a demand that wasn't explicitly stated.

### CraftSim

CraftSim is a sophisticated Midnight crafting-math system (recipe costing, profit optimization,
crafting-order economics). WoWSync should **consume or reference** relevant CraftSim evidence
where useful, never reimplement a crafting optimizer of its own. Crafting queue/recipe planning is
explicitly out of scope for Azeroth ERP Slice 1 and is not implemented.

### Journalator

Journalator is a candidate future source for **personal** auction-house/economic-outcome evidence
(what a player actually bought/sold/earned), as distinct from TSM's **general market** evidence.
Integration needs research before any commitment — nothing here is a plan, only a boundary:
personal observed outcomes must stay distinct from general market evidence, and neither currently
exists as an input to WoWSync.

## Future ERP concepts (not committed, not implemented)

All of the following are clearly future and exploratory. None of them is Azeroth ERP Slice 1,
which is the only ERP work implemented today (see
[`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md)).

- **Capability-before-demand/allocation, extended further.** Slice 1 already separates capability
  (what the account could use) from demand (what the player said they want) — see
  `ARCHITECTURE_INVARIANTS.md`, ERP §1. A future layer might extend this further (e.g. richer
  capability modeling across professions), but nothing beyond Slice 1's current separation exists.
- **Account utility, including possible BoE-upgrade evaluation before disposition.** Deciding
  whether an item is more valuable kept/equipped than sold is a future question Slice 1 does not
  ask. It would need the exact-item identity Slice 1 deliberately did not build (bonus IDs, gems,
  per-instance properties — see `AZEROTH_ERP_ARCHITECTURE.md` §11).
- **Richer reserve/allocation policy, independently testable from disposition policy.** Slice 1
  currently computes allocation arithmetic and disposition in one function
  (`buildAllocationResult`). This is already self-documented in `AZEROTH_ERP_ARCHITECTURE.md` §15
  as an open question, not a hidden defect — a future slice may split disposition into its own
  pure, independently testable policy function if disposition rules grow beyond the conservative
  UNKNOWN gate.
- **Economic recommendation vs. player-selected strategy as genuinely different concepts.** See
  `ARCHITECTURE_INVARIANTS.md`, PLAYER INTENT, for the full statement: a player who deliberately
  farms a material because they find it relaxing should have planning respect that choice rather
  than repeatedly suggesting the cheaper `BUY` path. A future strategy axis might distinguish `BUY`
  vs. `FARM` vs. `FARM_OTHER_AND_SELL` vs. `USE_STOCK` as player-selectable strategies rather than
  a single "optimal" recommendation. None of this exists in Slice 1.
- **Gold as an account resource.** Not modeled as an allocation input today.
- **Idle-inventory opportunity cost.** The "unallocated/unexplained inventory" category Slice 1
  already names (see `AZEROTH_ERP_ARCHITECTURE.md` §4) is the right place for a future insight
  layer to eventually phrase something like "500 units are unallocated and represent approximately
  X gold of potentially tied-up capital" — explicitly as an *insight*, never silently reclassified
  into surplus, and never implemented today.
- **Player time as a resource.** Not modeled today.
- **Exact/equipment identity**, for when commodity identity `(version, baseItemId)` is not
  sufficient (bonus IDs, gems, per-instance properties). Slice 1's `CommodityIdentity` carries a
  `kind: "commodity"` discriminator specifically so a future `kind: "exact-item"` variant can be
  added without this slice having built it, and without commodity reasoning silently becoming the
  wrong tool for equipment reasoning later (see `AZEROTH_ERP_ARCHITECTURE.md` §11).

## What this document is not

This is not a design document for any of the above. It exists to give a future reader (or a future
implementer) a correct place to stand — and to make clear, when someone asks "why doesn't WoWSync
do X yet," that the answer is usually "it's a recognized future direction with a named boundary,
not an oversight." If you are about to start implementing any item above, that is Azeroth ERP
Slice 2+ work: stop, and get it explicitly scoped and approved first, consistent with
[`ROADMAP.md`](ROADMAP.md)'s deferred/exploratory framing.
