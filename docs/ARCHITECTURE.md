# Architecture

```
WoWSync addon (GearExport, separate repo)
        │
        │  WOWSYNC v1 text export (copy/paste or .txt file)
        ▼
Dashboard importer            packages/core/src/parser.ts
        │                     — deterministic line/section parser,
        │                       mirrors WoWSyncRender.lua exactly
        ▼
Version routing               packages/core/src/version.ts
        │                     — classic-era / tbc-anniversary / retail /
        │                       unknown-version, never guessed
        ▼
Character identity            packages/core/src/identity.ts
        │                     — (version, realm, name) key
        ▼
Snapshot database              packages/core/src/sqliteStore.ts
        │                     — SQLite, one row per snapshot, nothing
        │                       overwritten
        ▼
Diff engine                    packages/core/src/diff.ts
        │                     — deterministic facts only: level/gold/
        │                       playtime/profession/inventory/equipment
        │                       deltas. Never fabricates a delta from an
        │                       unknown value.
        ▼
AccountFacts                   packages/core/src/accountFacts.ts
        │                     — deterministic, version-scoped account
        │                       facts (gold/playtime/progression/
        │                       professions/inventory/freshness/recent
        │                       changes) built from the store + diff
        │                       engine. Pure: no I/O, no clock reads.
        ▼
Dashboard UI                   packages/web (React/Vite)
        │                     served by packages/server (Express)
        ▼
   (future) LLM context builder — reads AccountFacts, never the raw
                                   export or the database directly.
                                   Not implemented in this milestone.
```

## Package layout

- **`packages/core`** — no I/O beyond the storage abstraction it owns.
  - `parser.ts` — turns `WOWSYNC v1` text into a typed `ParsedSnapshot`.
    Deterministic section-by-section parsing (not regex soup); throws a
    `WowSyncParseError` with a specific, actionable message on malformed
    input.
  - `escape.ts` — reverses the addon's `Text()` escaping (`\t`, `\r`,
    `\n`, `\\`) and treats `?` as "unknown", never as a default value.
  - `version.ts` — routes a parsed character into a WoW version space.
    Classic Era / TBC Anniversary are inferred from the client version
    number (`1.x` / `2.x`); Retail is only ever inferred from the
    addon's `ClientFamily: Retail` field (the schema documents this as
    Retail-exclusive as of today). Anything else is quarantined as
    `unknown-version` rather than guessed into a real space.
  - `identity.ts` — stable character identity. WOWSYNC v1's text export
    does not include a GUID (see `WoWSyncRender.lua` — the renderer never
    emits one), so identity is `(version, realm, name)`. This still
    guarantees the two hard requirements: same name on different realms
    never collides, and the same name+realm never collides across WoW
    versions.
  - `diff.ts` — pure functions, no storage. Only reports a delta when
    both sides of a comparison are actually known.
  - `trainerSummary.ts` — presentation-oriented grouping of one trainer
    category's raw `services` array (available now / grouped by known
    `requiredLevel` / unknown unlock level / next training), used to keep
    the default character page readable when a single trainer visit
    carries hundreds of observed services (a real Voodan TBC Anniversary
    capture has 180 on its class trainer alone). Never mutates or drops
    anything from `services` — see "Presentation vs. data" below.
  - `freshness.ts` — the single source of truth for the recent/stale/
    unknown convention (see "Freshness convention" below). `now` is
    always a parameter, never read from the system clock internally.
  - `accountFacts.ts` — the deterministic account-level facts layer (see
    "AccountFacts" below). Pure: takes already-fetched characters/
    snapshots/diffs and a `now` value, returns structured facts.
  - `store.ts` / `sqliteStore.ts` — the storage abstraction and its
    SQLite implementation. `SnapshotStore` is the seam: another storage
    engine could implement it without touching the importer, diff
    engine, API, or UI.
- **`packages/server`** — a thin Express layer: REST endpoints that call
  into `SnapshotStore`, plus static hosting for the built UI. No business
  logic lives here.
- **`packages/web`** — React/Vite SPA. Talks to the server only over
  `/api/*`; never imports `packages/core` directly (that package pulls in
  `node:sqlite`, which has no reason to enter a browser bundle). Keeps a
  minimal, hand-copied mirror of the API response shapes in `src/types.ts`.

## Why SQLite via `node:sqlite`

This is a personal, local-first tool — a hosted backend isn't warranted.
`node:sqlite` ships in Node.js 24 itself (this project's runtime), so
there's no native-module build step (a real pain point for `better-sqlite3`
on Windows without build tools installed). The tradeoff: `node:sqlite` is
still flagged experimental upstream. The storage layer is deliberately
kept behind the narrow `SnapshotStore` interface in `store.ts` specifically
so this can be swapped later (for `better-sqlite3`, Postgres, or anything
else) without touching the parser, diff engine, API, or UI.

## Why no build step for the server/core code

Node.js 24 strips TypeScript types natively at load time. `packages/core`
and `packages/server` run their `.ts` files directly — no `tsc` compile
step, no `ts-node`/`tsx` dependency. `tsc --noEmit` is still used for
type-checking (see root `tsconfig.base.json`); it just never produces
output. The one exception is `packages/web`, which needs Vite's bundler
regardless (JSX, CSS, browser target), so it does have a `build` step.

## Data isolation guarantee

`SqliteSnapshotStore` scopes every read by `version` (a column on
`characters`, derived once at import time and never changed after). There
is no query path that sums gold, inventory, or `/played` across two
different `version` values — `listVersions()` computes each version's
totals independently. This is enforced by
`packages/core/test/sqliteStore.test.ts` and
`packages/core/test/fixtureFiles.test.ts`.

## What real fixtures changed

Milestone 1 shipped with only generated fixtures, which — because they
were generated by the same algorithm the parser expects — could not
expose any mismatch between that algorithm and the real, documented
format. Real captures (`packages/core/test/fixtures/classic-era/`,
`.../retail/`) found three classes of bug immediately:

1. **Header framing.** `WoWSyncRender.lua`'s `S.Render` joins its entire
   output array — `"WOWSYNC v1"`, `"Generated: …"`, `"Format: …"`, each
   section, and `"[END]"` — with `"\n\n"`. The three header lines are
   three separate blank-line-separated chunks, not one three-line block.
   `parser.ts`'s `parseWowSyncExport` now reads them as such.
2. **Addon version skew across installs.** A real Classic Era capture
   (client 1.15.9) predates the `PlayedSeconds`/`LevelPlayedSeconds`
   fields entirely (they simply don't appear — not "unknown", *absent*)
   and renders `[TRAINER]` instead of the current `[TRAINERS]`. The
   parser treats both playtime fields as optional and accepts either
   trainer section spelling — different WoW installations won't always
   be running the same addon build, and the parser can't assume they do.
3. **Copy/paste whitespace mangling.** Table rows as received did not
   reliably use literal tab characters, and some trailing columns were
   dropped rather than left empty (a plausible casualty of pasting
   through a clipboard manager, chat box, or editor that trims trailing
   whitespace). `splitFields()` now accepts a tab *or* a run of 2+ spaces
   as a field separator, and a short row is padded with unknown trailing
   fields instead of failing outright. A single space inside a real value
   ("Sinister Strike", "Finger 1") is never touched by this.

A fourth issue surfaced in the **diff engine**, not the parser: Blizzard's
itemString format embeds the observing character's level (confirmed
against real data — the same pair of gloves rendered as
`item:6171::::::::3::::::::::` at level 3 and `...::4::...` at level 4).
Matching items by the full `itemRef` therefore made the diff engine think
almost every equipped item and bag stack "changed" on every level-up.
`diff.ts` now matches items across snapshots by base item ID (`item:6171`)
plus name and bound state — the full `itemRef` is still stored and
displayed untouched everywhere; only the "is this the same tracked item"
decision uses the looser key. See `packages/core/test/realFixtures.test.ts`
for the regression coverage, including the case this fixes (a stack of
Tough Jerky going 2→5 across a level-up reads as one `+3` delta, not a
phantom "lost 2 of the old item, gained 5 of a new one").

## Diff engine coverage

`SnapshotDiff` reports (all facts, never estimates): `level`, `xp`/`xpMax`,
`moneyCopper`, `playedSeconds`, `levelPlayedSeconds`, `location` (zone/
subzone change), `professions`, `bagsItems`, `bankItems`, `equipment`, and
`trainerUnlocks` (abilities that newly became trainable). Every field is
only populated when both sides of the comparison are actually known — an
`UNKNOWN` section on either side yields an empty/absent delta for that
section rather than a fabricated one. XP deltas are reported raw even
across a level-up (XP resets, so the raw delta can be negative) — the diff
engine states what was observed; interpreting *why* (e.g. "this was a
level-up reset") is left to the future LLM analysis layer, not invented
here.

## Presentation vs. data: "store everything, surface what matters"

A real trainer visit can carry hundreds of observed services (Voodan's
class trainer: 180, all `unavailable`, spread across 32 required levels).
Showing that as a flat list is technically complete but practically
useless. The rule this project follows: **the parser, storage, and API
never drop or reshape data for the UI's convenience** — `TrainerService[]`
on every category is exactly what was observed, full stop. Presentation
logic lives in a separate, clearly-named layer:

```
TrainerCategorySnapshot.services[]   (packages/core — authoritative, untouched)
        │
        ▼
summarizeTrainerCategory()           (packages/core/src/trainerSummary.ts — pure, derived)
        │  groups by known requiredLevel; buckets missing/unparseable
        │  levels separately (never inferred); computes "next training"
        │  from the lowest known-level group only
        ▼
category.summary                     (attached by the server per-response, packages/server)
        │
        ▼
TrainerCategoryCard                  (packages/web — compact by default,
                                       <details> drill-down reveals every
                                       group and, inside it, every ability)
```

`requiredLevel` grouping never compares against the character's *current*
level — a service that's still `unavailable` even though the character
has since passed its required level is left exactly where the trainer
said it was (real Voodan data has exactly this shape: several Level 18
abilities are blocked on a prior-rank prerequisite, not on level, and stay
`unavailable`/grouped accordingly rather than being "corrected" to
available).

## AccountFacts

`buildAccountFacts()` (`packages/core/src/accountFacts.ts`) is the
deterministic layer between the database and any future analysis. It is
a pure function: `(AccountFactsInput, now) -> AccountFacts`, with no I/O
and no clock reads of its own — `SqliteSnapshotStore.buildAccountFacts()`
does the querying (latest parsed snapshot per character, a diff against
each character's previous snapshot via a shared `allDiffs()` helper, and
the already-filtered "meaningful changes" list) and hands it all to the
pure builder along with `now`. The same DB state and `now` always produce
byte-identical output — this is what makes it fit to eventually feed an
LLM context builder: the facts are reproducible, not a live/mutable view.

One `AccountFacts` is always scoped to exactly one WoW version — there is
no code path that accepts more than one `version` value or sums across
them. It covers:

- **Characters** — per-character snapshot of level/gold/playtime/XP/bank
  status/freshness, built from the same `StoredCharacterSummary` the rest
  of the app already uses.
- **Gold** — known total (sum only over characters with a known value),
  per-character gold + delta since the previous snapshot, and the largest
  recent changes by magnitude.
- **Playtime** — known total, per-character total/current-level `/played`
  and their deltas. Raw seconds throughout; formatting happens only in
  `packages/web/src/format.ts`.
- **Progression** — per-character level/XP/XP-percent, level deltas (only
  when 2+ snapshots exist — never estimated from one), recent level-ups,
  and the character closest to its next level (by known XP percent only).
- **Professions** — per-character list plus an account-wide view regrouped
  by profession name across characters.
- **Inventory** — every known item aggregated by base item ID (reusing
  `diff.ts`'s `baseItemId()` — never the full, level-linked `itemRef`)
  across every character's *known* bags/bank, plus a `searchInventory()`
  substring search. Characters whose bank or bags were never observed are
  listed separately (`unknownBank`/`unknownBags`) and contribute nothing
  to the totals — see "Known vs. unknown" below.
- **Recent changes** — the existing meaningful-change diff list, reshaped
  into flat booleans/deltas for the UI (level/gold/profession/equipment/
  inventory/location/trainer-unlock changed or not).
- **Freshness** — a per-character and account-wide recent/stale/unknown
  breakdown (see below).

## Known vs. unknown

`AccountFacts` never turns "never observed" into zero, empty, or absent-
from-the-total. This is enforced, not just intended:

- A character with no `MoneyCopper` observation is excluded from
  `gold.totalKnownCopper` and counted in `gold.charactersWithUnknownGold`
  — never added as 0.
- A character whose bank was never opened (`bank.status.state ===
  "UNKNOWN"`) contributes nothing to `inventory.items`, and is listed in
  `inventory.unknownBank` instead — the UI must show that caveat next to
  any "total" for an item, which `hasUnknownStorage` exists to drive.
- A character whose professions section is `UNKNOWN` (`professions.status
  === "UNKNOWN"`) is distinct from one that's `OBSERVED` with zero
  entries (the addon's own "None identified" case) — both are represented
  differently in `ProfessionFacts.byCharacter[].status`.
- Progression deltas (`levelDeltaSincePrevious`) are only present for
  characters with 2+ snapshots; a single-snapshot character always has
  `undefined` there, never a guessed 0.

`packages/core/test/accountFacts.test.ts` has a synthetic-fixture test for
each of these cases specifically (unknown gold, unknown bank, unknown
professions, insufficient history), alongside the real-data tests.

## Freshness convention

Snapshots are point-in-time observations, not live state, so the
dashboard must make their age obvious rather than presenting stale data
as current. `freshness.ts` defines: **recent** (latest observation within
3 days), **stale** (a snapshot exists but is older), **unknown** (no
timestamp at all). The 3-day threshold is a documented constant
(`RECENT_THRESHOLD_SECONDS`), not a magic number scattered through the
UI. `classifyFreshness(lastObservedAt, now)` takes `now` as a parameter
specifically so tests (and, later, any server-side caching) can pin a
reference time instead of depending on the wall clock — see
`packages/core/test/freshness.test.ts`.

## LLM boundary (not implemented)

```
Structured account data  →  Deterministic AccountFacts  →  LLM context builder  →  LLM provider  →  Analysis
```

`AccountFacts` is exactly that middle layer, and it now exists as a real,
tested module — not implied by other structures. No LLM context builder,
provider integration, API key, or "Ask My Account" UI exists yet; the
dashboard is fully usable without them, and no external LLM dependency or
network call has been added. This milestone stops at `AccountFacts`.
