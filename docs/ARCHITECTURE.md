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
AccountContext                 packages/core/src/accountContext.ts
        │                     — every version's AccountFacts embedded
        │                       wholesale, plus per-character snapshot
        │                       history/transitions/trainer summaries.
        │                       The canonical "Export Dashboard Context"
        │                       JSON — GET /api/account-context and the
        │                       web UI's Copy/Download buttons share this
        │                       one serialization.
        ▼
Dashboard UI                   packages/web (React/Vite)
        │                     served by packages/server (Express)
        ▼
Ask My Account (POC)           packages/server/src/llm.ts, app.ts
        │                     — POST /api/ask: fetches the SAME
        │                       GET /api/account-context (self-loopback
        │                       HTTP call, not a second code path), sends
        │                       it + a system prompt + the question to
        │                       an LLM provider, returns the answer.
        │                       Stateless — no history, no memory.
        ▼
   LLM provider (OpenAI-compatible, configured via env vars)
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
    number (`1.x` / `2.x`) when no `ClientFamily` is present; Retail
    and Forever are only ever identified by the addon's `ClientFamily:`
    field (`Retail` / `Forever`, case-insensitive). `ClientFamily` is
    checked first because Forever's client number (1.60.x) would otherwise
    be mistaken for Classic Era's. Anything else is quarantined as
    `unknown-version` rather than guessed into a real space.
    `WOW_VERSIONS` (same file) is the single list the store, AccountContext,
    and the API iterate; `VERSION_LABELS` is typed `Record<VersionOrUnknown,
    string>` so a version without a label is a compile error.
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
  - `professionCatalog.ts` — the version-aware profession list used to
    tell "nobody has this profession" (a fact) apart from "we never
    checked" (see "None vs. unknown" below).
  - `accountFacts.ts` — the deterministic account-level facts layer (see
    "AccountFacts" and "Realm scoping" below). Pure: takes already-fetched
    characters/snapshots/diffs and a `now` value, returns structured
    facts, realm-partitioned where that's the safe default. Also exports
    `diffToChangeSummary()`, the one `SnapshotDiff` → flat-summary mapping
    shared by `recentChanges` and `accountContext.ts`'s per-character
    transition history.
  - `accountContext.ts` — the "Export Dashboard Context" developer tool's
    canonical document (see below). Pure assembly only: embeds each
    version's `AccountFacts` wholesale and reuses `diffSnapshots`/
    `summarizeTrainerCategory` for per-character history — no new account
    logic lives here.
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
- **Professions** — per-character list plus a *catalog-aware* coverage
  view: every profession that actually exists in the version's ruleset
  (`professionCatalog.ts`) is marked `covered` / `none` / `unknown` (see
  "None vs. unknown" below), not just the ones somebody happens to have.
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

## None vs. unknown (profession coverage)

Before this milestone, `ProfessionFacts.coverage` only ever listed
professions somebody actually had — there was no way to tell "my TBC
roster covers Mining/Skinning/Tailoring/Enchanting/Cooking/First Aid/
Fishing" from "my roster also has zero Alchemists" (the latter is a real,
useful fact; the former just silently omits Alchemy). `professionCatalog.ts`
fixes this with a version-aware, hardcoded (not database-driven) list of
every profession that exists in that version's ruleset — safe to hardcode
because Classic Era and TBC Anniversary are frozen rulesets, not moving
targets (Jewelcrafting is TBC-only, Inscription/Archaeology don't exist
yet, First Aid is Retail-only-if-your-expansion-still-has-it — the real
Ezaller/Stoneharry captures corroborate that modern Retail doesn't).

For a given scope (a realm, or the whole account for Retail),
`buildProfessionCoverage()` classifies every catalog profession as:

- **`covered`** — at least one character in scope has it (skill/max shown,
  every character listed, never combined into a meaningless sum).
- **`none`** — every character in scope has an `OBSERVED`/`LAST_SEEN`
  professions section, and none of them has it. This is a fact, not a
  guess: we've checked everyone who could plausibly have it.
- **`unknown`** — at least one character's professions were never
  observed, so absence can't be established. `unknown` never quietly
  becomes `none` just because nobody currently covers it.

An observed profession *not* in the catalog (an unrecognized name) is
still appended as `covered` — the catalog only adds facts, it never
suppresses real data. `unknown-version` has no catalog at all (we don't
know enough about an unrecognized client to assert "nobody has X"), so
its coverage degrades to "only what's actually observed", matching the
pre-catalog behavior exactly.

## Forever (Classic beta client)

Forever (`ClientFamily: Forever`, client 1.60.x, product `wow_classic_beta`)
is a first-class version, added without a Forever-only export format or
parallel code path — it goes through the same parser, store, AccountFacts,
AccountContext, and LlmContext as every other version. Decisions specific
to it, each grounded in what its real exports contain:

- **Scope: realm-partitioned.** Nothing in a Forever export establishes
  account-wide/warband sharing, so it follows Classic Era/TBC
  (`REALM_PARTITIONED_VERSIONS`), never Retail's model.
- **Profession coverage has no hardcoded catalog.** Forever is a
  still-evolving beta ruleset, and its addon only exports the player
  profession enums (no Cooking/Fishing/First Aid rows), so applying the
  Classic/TBC list would assert "nobody has Cooking" for something the
  export cannot observe. Coverage is built from what exports contain; a
  profession absent from every export is not listed — never "none".
- **0/0 profession rows are indeterminate.** The Forever addon lists every
  player profession, reporting skill 0 / maxSkill 0 for professions that
  are not learned *and* (per the addon's own docs) possibly for data not
  yet loaded — the API cannot tell them apart. `professionEntryIsEvidence()`
  (`professionCatalog.ts`, a no-op for every other version) makes only a
  positive skill/maxSkill count as "covered"; a Forever profession seen
  only at 0/0 is coverage `unknown`. The character's own raw entries are
  preserved unchanged; LlmContext marks such entries `indeterminate: true`;
  the character page labels them "not confirmed learned".
- **UNKNOWN stays UNKNOWN.** Current Forever exports leave bank, known
  spells, and trainers UNKNOWN (and playtime `?` in some captures). None
  of it is defaulted: bank shows up in `inventory.unknownBank`, playtime
  as unobserved, and the character page says "Never observed."
- **Client metadata is preserved** in the stored snapshot (`ClientFamily`,
  `Interface`, build) — no schema change; the parsed snapshot JSON already
  carried these fields.

## Realm scoping

Classic Era, TBC Anniversary, and Forever realms are economically isolated from
each other — no shared bank, no shared currency, no cross-realm mail or
auction house. Retail characters, by contrast, can genuinely share
resources across realms today (Warband bank/currencies). `AccountFacts`
reflects this difference directly rather than applying one rule
everywhere:

- `AccountFacts.aggregationScope` is `"realm"` for Classic Era/TBC
  Anniversary/Forever and `"account-wide"` for Retail/`unknown-version`
  (`REALM_PARTITIONED_VERSIONS` in `accountFacts.ts`).
- When `"realm"`, `AccountFacts.realms` holds one `RealmGroup` per
  distinct realm actually present in the data — each with its own gold/
  playtime/progression/professions/inventory, computed only from that
  realm's characters. Two characters on different Classic/TBC realms
  never contribute to the same `RealmGroup`, even though they share a
  `version`.
- The top-level `gold`/`playtime`/`professions`/`inventory` fields are
  still computed for every version (a broader, all-realms view stays
  available if wanted later) — they're just not the recommended default
  for a multi-realm Classic/TBC account. The web app's `scopedFacts.ts`
  picks `realms` for realm-partitioned versions and the top-level fields
  for account-wide ones, so every view (Overview/Characters/Economy)
  automatically renders the correct scope without needing its own
  per-version logic.

This is validated against real, not synthetic, data on both sides: the
real TBC Anniversary roster (Torahn/Voodan/Tenivard, all on Dreamscythe)
proves realm-scoped totals work; the real Retail roster (Ezaller on
Kel'Thuzad, Stoneharry on Thrall — two actually-different realms) proves
Retail's account-wide total genuinely combines across realms rather than
just passing a single realm through unchanged. A synthetic second
Classic/TBC realm (`packages/core/test/realmFacts.test.ts`) covers the one
thing today's real data can't: proving two *different* Classic/TBC realms
stay isolated, since only one has been captured so far.

## Shared storage (Warband + Guild Bank)

Retail's addon exports three storage scopes: the character's own `[BANK]`, the account's `[ACCOUNT BANK]`
(Warband, `Scope: ACCOUNT_WARBAND`) and the guild's `[GUILD BANK]` (`Scope: GUILD`, `GuildClubID`). Current Retail
exports **always** contain the latter two (as `State: UNKNOWN` when never observed), so the parser accepts both.
It keeps the trust states verbatim: UNKNOWN (no tabs, no items, not "known empty"), OBSERVED (complete or partial),
LAST_SEEN (a prior observation, original `observed=` time kept), per-tab OBSERVED / UNKNOWN / INACCESSIBLE, and the
club id as **text**. The sections stay in the exporting character's snapshot exactly as delivered; the design below
is what the Dashboard builds from them.

### Ownership

The character whose export delivers a shared section is only its **carrier** (provenance), never its owner.

| Storage | Owner | Key |
| --- | --- | --- |
| Character Bank | the character (unchanged; stays in its snapshot, outside this model) | `identity_key` |
| Warband | the **installation-local** Retail account scope | `retail::warband::local` |
| Guild Bank | one guild, by its **opaque** `GuildClubID` text | `retail::guild::<GuildClubID>` |

`installation-local` is this Dashboard's single, undifferentiated Retail account scope. It is **not** a Battle.net
account id: the export carries no verified account identifier, so two accounts imported into one Dashboard cannot be
told apart (a known limit; the owner type has an extension point for a real discriminator, which must come from the
addon). The guild id is never parsed as a number (it can exceed 2^53), never case-folded, and never inferred from the
guild name, which is display data only.

### Evidence: an immutable journal

`packages/core/src/sharedStorage.ts` is the pure domain model; `sqliteStore.ts` only persists it. An **observation**
is one fact: "this owner's storage looked like this at time T", identified by `(owner, claimed observed time, canonical
content hash)`. The carrier state (OBSERVED / LAST_SEEN), the carrying export, `SnapshotVisit` and other transport noise
are deliberately **not** part of that identity, so a LAST_SEEN replay of one record (how most observations first
arrive, because the bank is closed by the time `/wowsync` runs) is the same observation with another **source**, never a
new observation, and a carrier's export time never replaces the observation time. Each observation stores its
content-hash **version** (a changed canonicalization needs a version bump and an explicit re-hash migration).
UNKNOWN, unattributable (a guild without a `GuildClubID`) and unanchored (no `observed=`) sections are never journaled,
so they can never erase anything. Sources (`shared_observation_sources`) keep provenance: the carrying export, carrier
state, visit metadata, and a denormalized character label.

### Selection: a read-time DERIVED projection

Nothing about the *current* state is stored; `projectJournal` selects it on read, deterministically and independent of
import order:
- `current` is the newest **informative complete** observation (else the newest informative partial).
- A **newer partial** never displaces a complete one; it is exposed as `latestPartial`.
- An **informationless** capture (nothing scanned, e.g. every guild tab inaccessible) is recorded but can never be
  current; an owner with only such captures has no `current` (contents unknown, not empty).
- A newer **narrower** guild observation stays current; an earlier **broader** one is exposed as
  `broaderCoverageEarlier`. Observations are never spliced, so no synthetic composite is ever produced or called OBSERVED.
- Same-time observations with different content are a reported **conflict**; the tie-break is by content, not arrival.
- Effective time is `min(claimed, every carrying export's own time)`, so a section cannot be observed after the export
  that carries it.

"Derived" therefore means "the Dashboard chose which real observation is current"; it never means guessed contents.

### Persistence

- Additive tables only (`shared_observations`, `shared_observation_sources`, `shared_owner_clears`, `store_meta`),
  created with `IF NOT EXISTS`; no migration framework. The journal references neither `characters` nor `snapshots`.
- Import admits shared sections **in the same transaction** as the snapshot: both are stored or neither.
- An existing database is backfilled **once** by an idempotent pass (`backfillSharedStorage`, guarded by a `store_meta`
  marker) that runs the same admission code over stored snapshots. It never edits snapshots, never relabels LAST_SEEN
  as OBSERVED, never advances an observation time, and never removes journal rows.
- **Deleting a character never deletes a shared observation or its provenance** (the journal can be the only copy).

### Deletion

| Operation | Shared observations | Provenance | Snapshots / characters |
| --- | --- | --- | --- |
| Delete a **character** | **kept** | **kept** (including that character's label) | that character's are deleted |
| Delete an **owner** (explicit) | that owner's all deleted | that owner's all deleted | **never touched** |

Owner deletion (`deleteSharedStorageOwner(owner)`) takes the typed owner, is one transaction, matches the key as data,
rejects a malformed owner, and never parses journal content. Nothing else implies it: not a character or snapshot
deletion, a character changing guild, or a newer UNKNOWN / partial / inaccessible section. It is **not a tombstone**:
a later export carrying a valid observation admits it normally and recreates the owner (the addon keeps replaying what
it last saw, so cleared history can reappear with the next export; an already-stored export is a duplicate and restores
nothing). What must not happen is **automatic resurrection from snapshots that were already stored**, because the
backfill re-scans every snapshot each time it runs. Each deletion therefore records, per owner, a cutoff in
`shared_owner_clears`: the highest snapshot id ever allocated (`sqlite_sequence` survives deleted snapshots; ids are
never reused). Backfill skips that owner's admissions from snapshots at or below it; import never consults it.

### Integrity

Corrupt journal rows **fail loudly** (`SharedStorageIntegrityError`, naming every damaged owner); they are never
skipped or partially shown. An import that touches a damaged owner is refused and rolled back; an import with nothing
to reconcile still works. Because deletion never parses content, a damaged owner can still be explicitly cleared.

### HTTP API

(`packages/server/src/sharedStorageRoutes.ts`; response types and the pure serializer in `packages/core/src/sharedStorageApi.ts`,
mirrored in `packages/web/src/types.ts` with client functions in `api.ts`.) The server reconciles nothing and queries no
tables: it serializes `store.projectSharedStorage()` and calls the typed `deleteSharedStorageOwner`.
- `GET /api/shared-storage` -> `{schema: "shared-storage-1", asOf, warband, guilds[]}`; empty is a normal answer
  (`warband: null`, `guilds: []`). Each owner has `owner` (Warband: `accountScope: "installation-local"`; guild: the exact
  `guildClubId` string plus a display-only `guildName`), `basis: "DERIVED"`, `current` / `latestPartial` /
  `broaderCoverageEarlier` / `conflict` (each `null` when absent) and `observationCount`. An observation view is ONE real
  observation: claimed and effective time, `ageSeconds` and `freshness` by the single freshness rule, completeness,
  `informative`, `liveAtExport`, `carrierStates`, `coverage`, `content` (an UNKNOWN scalar is an omitted key, never 0)
  and bounded `provenance` (exact totals, the newest 10 sources, `truncated`). No database ids.
- A damaged journal answers **500** `SHARED_STORAGE_INTEGRITY` with `damagedOwners`; no stack or SQL.
- `DELETE /api/shared-storage/warband` and `DELETE /api/shared-storage/guilds/:guildClubId` **clear stored history; a later
  export may add it again**. A JSON body `{"confirmOwnerKey": "<key from GET>"}` must match the owner the URL names:
  400 (`CONFIRMATION_REQUIRED` / `CONFIRMATION_MISMATCH` / `INVALID_GUILD_CLUB_ID`), 404 `SHARED_OWNER_NOT_FOUND` when
  there is nothing to clear, 200 with counts. The guild id is used exactly as decoded (never `Number`/`BigInt`); empty,
  padded, control-character and over-long ids are rejected, not changed. Owners are built server-side from the route.
- Security is the existing baseline, unchanged: Host guard on every request, Origin guard on state-changing ones, no CORS,
  default loopback bind.

### UI

`packages/web/src/sharedStorage.ts` holds every wording and trust decision as pure, unit-tested functions; the
components only render them.
- **Account level:** a **Shared Storage** tab on the Retail view, one card per owner, never inside a character. A card
  states when the storage was observed and its freshness (the age of the observation, independent of how it was
  carried; "recent" and "last seen" are not contradictory), its completeness, which exports carried it ("one
  observation, carried by N exports"), capacity, contents, guild tab coverage, and bounded provenance.
- **Unknown stays unknown:** no readable observation, an inaccessible tab or an unconfirmed tab is "contents unknown",
  never empty. A newer partial, an earlier broader observation and a conflict are each surfaced and openable as
  separately labelled observations, never merged. Item rows are aggregated, and the UI says no tab is implied.
- **Character pages** show what each export *carried* ("Warband Bank carried by this export"), as historical evidence,
  with a link to the owner view.
- **Clearing** an owner's history is an explicit dialog (typed "Warband" or the exact GuildClubID) carrying "Clears stored
  shared-storage history. A later WoWSync export may add it again."; a damaged journal has its own screen with a recovery
  action per damaged owner.

### Exclusions and known limits

Shared storage is deliberately **not** in AccountFacts inventory/totals, global item search, snapshot diffs,
AccountContext or the LLM / Ask My Account context (tests pin byte-identical facts and LLM context with and without
shared sections). A future consumer must count each owner exactly once (one projection per owner key, however many
characters carried it) and label shared totals as asynchronous observations.

Known limits: the Warband scope is installation-local (no stable account discriminator); whether `GuildClubID` alone is
unique across regions is open; item rows carry no tab attribution, so there is no per-tab item reconciliation; an owner
with only informationless observations exposes a display name but no tab detail; the import dialog does not yet surface
`ImportResult.sharedStorage`; and there is no "delete all Dashboard data" operation (it would have to clear the journal
and `shared_owner_clears` together).

## Item metadata (enrichment, not observation)

Inventory rows carry a full `itemRef` and a name but nothing about what an item *is*. The addon's additive
`[ITEM METADATA]` section (GearExport `a94288e`; WOWSYNC stays v1) supplies raw, static, per-base-item facts from the
game client, and the Dashboard keeps them as **enrichment**: it never becomes part of what a snapshot or a
shared-storage observation says.

### The producer contract

One tab-separated row per base item id referenced by equipment, bags, Character Bank, Warband Bank or Guild Bank,
ascending, after a header row of exactly:

`baseItemID  classID  subclassID  bindType  expansionID  isCraftingReagent`

`?` is UNKNOWN for that facet; `isCraftingReagent` is `yes` / `no` / `?`. `expansionID` is the client's raw
number: the addon maps, reinterprets and infers nothing (not from a name, an id or a class). The addon may fill
class/subclass from the instant item tuple while full item info is still loading; the other facets stay `?` until it
arrives. The parser (`parseItemMetadata`, `packages/core/src/parser.ts`) is strict: exactly six columns, the exact
header, canonical non-negative integers, `yes`/`no`/`?` only, a positive base id, no duplicate id. A malformed value
rejects the whole import (HTTP 422) rather than being coerced. An export with no section (every historical export)
parses exactly as before and its parsed form has no `itemMetadata` key. (Any *other* unrecognized section is still
rejected; only this one was added.) Values are undefined for `?`, following the model's usual convention: `bindType: 0`
and `isCraftingReagent: false` are known values, distinct from unknown.

### Identity and storage

Metadata is keyed by **game version + base item id** - never by the id alone, because ids overlap across products
(*Hearthstone* is 6948 in Classic Era and Retail). The game version is the one the export's client already routes to
(`detectVersion`); a client that cannot be routed records nothing. Item facts are stored in `item_metadata_evidence`, a
separate additive table with **no reference to characters or snapshots**:

- one row per distinct KNOWN value of a facet, per source (today only `game-client`), with order-independent
  provenance (earliest / latest observation time, the set of client builds that reported it);
- UNKNOWN is **absence** - it is never stored, so it can never overwrite a known value, and a later export that knows
  a facet simply fills it in;
- the same value replayed (a duplicate export, or a new export reporting it again) adds no row and only widens
  provenance; the result is identical in any import order;
- two different KNOWN values for one facet are kept as two rows and resolved to **CONFLICT** at read time - never
  "latest wins", never a chosen label; the values and builds are exposed for diagnosis;
- a snapshot is never rewritten when metadata arrives later, an observation's identity and content hash never include
  metadata (a Warband observation carried by an export with and without metadata is one observation), and deleting a
  character keeps the item facts (they are game data, not that character's).

The section is also kept verbatim in the carrying snapshot's parsed form (as a record of what that export said), but
nothing reads it back from there: the evidence table is the only source.

### Resolution and labels

`packages/core/src/itemMetadata.ts` (pure) resolves evidence into a per-item view: each facet is KNOWN (with sources),
UNKNOWN or CONFLICT. The **expansion label is derived there, at read time, never stored**, from an explicit table
scoped to a game version. Only values seen directly in the live Retail client are mapped, each with its evidence:
4 Mists of Pandaria (Mote of Harmony), 8 Shadowlands (Progenitor Essentia), 9 Dragonflight (Elemental Mote), 10 The War
Within (Bismuth), 11 Midnight (Mote of Light). The numbering is deliberately not extrapolated from that sequence, and
Retail's table is not applied to any other client. Every other number - including `0` and `254`, which are not
assumed to mean Classic - renders as **"Expansion unknown (client value N)"**; a conflict renders as unknown with both
values; an unreported expansion is "Expansion unknown".

**What the number means.** It is the client's own tag on the item record, not a statement of when the item was
introduced, and the first live export with metadata showed why that distinction matters. Old evergreen items can carry
the *current* tag (the 2004 holiday items *Snowball* and *Winter Veil Cookie* are reported as 11, Midnight), while some old
items are reported as `0` (*Grilled Shark*, *Cask of Aged Dalaran Red*), matching the client bug reported for
`GetItemInfo`. The Dashboard therefore labels only what the client said, refuses to read `0` as Classic, and any future
"is this item obsolete?" logic must not treat the expansion tag as an item's age.

### API and presentation

`GET /api/versions/:version/item-metadata` returns `{schema: "item-metadata-1", version, items[]}`: one view per item
that has any evidence (an absent item has every facet UNKNOWN; empty is a normal answer). It is a pure read. The web
app words what the server resolved and derives no label itself (a test pins this). One lookup (`ItemInfoLookup`, built
from that response) serves every item list: bags, Character Bank, the carried Warband and Guild Bank on a character
page (compact suffix, only when something is known), and the Shared Storage table (an **Item info** column, shown only
when the Dashboard holds metadata for Retail, with "?" for unreported items and a note). A failed metadata request is
not an error: lists render as they did before metadata existed.

### What it does not do

- It does not decide ownership or reconcile anything: that remains the shared-storage journal.
- It is **not** used by AccountFacts totals, global item search, recent-change diffs, AccountContext or the LLM /
  Ask My Account context, and it has no keep / vendor / mail recommendation logic. Tests pin those consumers
  byte-identical with and without metadata.
- Blizzard Game Data API enrichment does **not** exist. The design leaves room for it as a second `source` (the
  Game Data API item document has no expansion field, so it could add names, icons and class/subclass names but not
  expansion); it needs Blizzard credentials and would run asynchronously, never during import.
- Known limits: the remaining expansion numbers are unmapped until verified; a conflict is shown as unknown rather
  than resolved by build; there is no backfill because no stored snapshot carries the section; and item facts are not
  removed by any delete operation (a future "delete all data" would have to clear them too).

## SavedVariables developer bridge

`npm run import:saved` (`packages/server/src/importSaved.ts`, entry `importSavedCli.ts`) sends the export GearExport has already
persisted (`WoWSyncDB.characters[guid].latestExport.text`) through the ordinary `POST /api/import`. It is **transport only**, and
the boundaries are deliberate:

- **One importer.** The bridge has no parser of its own for exports and never touches SQLite. The server keeps parsing,
  validation, snapshot storage, shared-storage reconciliation, item-metadata ingestion and idempotence. (The core WOWSYNC parser
  is used only to report what is about to be sent and to refuse text the server would reject anyway.)
- **Exact text.** The text is taken from SavedVariables as a string and posted as `{text}`. It is never reconstructed from the
  saved tables. The tool reports its length and SHA-256 and compares it with the text the server says it stored.
- **A data-only Lua reader** (`packages/core/src/savedVariables.ts`, pure): a small recursive-descent reader for what WoW's
  serializer writes (`Name = { ["key"] = value, ... }` with strings, numbers, booleans, nil, nested tables). It has no interpreter and
  no `eval`; any function call, identifier used as a value, operator, concatenation, long-bracket string or block comment is an
  error with a position, so a hostile or damaged file can neither run code nor be half-read. String escapes are decoded exactly,
  nesting is bounded, other top-level variables (the legacy `GearExportDB`) are skipped lexically, and a file caught mid-write fails
  loudly. Only `WoWSyncDB` (schema 1) is read.
- **Read-only.** The bridge uses only read APIs on the WoW folder (a test pins that the source contains no write, spawn or eval call, and
  that a full run leaves the file and folder byte- and mtime-identical). It cannot make WoW flush SavedVariables; the developer runs
  `/reload` or logs out first.
- **No guessing.** The WoW location is never built in: `--file`, `--wow-dir`, or `WOWSYNC_SAVED_VARIABLES` / `WOWSYNC_WOW_DIR`. More than
  one candidate file, or a character name on several realms, stops with what to specify. The saved export must agree with the request
  (name, realm) and with itself (the record's identity and `generatedAt` against the export text) before anything is sent. A character
  GUID is read to walk the file but never printed or sent.
- **Default target** is what the server itself would bind (`resolveHost` / `resolvePort`, i.e. `http://127.0.0.1:4173`), overridable by
  `--url` / `WOWSYNC_URL`; a non-loopback target warns.

It is not the desktop companion (see the roadmap): it does not watch files, monitor WoW, force a save, run in the background or
start the server.

## SavedVariables watcher (desktop companion, Slice 1)

`watch:saved` may poll **multiple** `GearExport.lua` files when `--wow-dir` is the install root (or otherwise finds several): each file gets its own watcher state so Retail and Classic never share `lastSent`. `import:saved` still refuses ambiguity.

`npm run watch:saved` (`packages/server/src/watchSaved.ts`, entry `watchSavedCli.ts`) is the developer bridge driven by a foreground poll
loop; design and decisions are in [DESKTOP_COMPANION_FEASIBILITY.md](DESKTOP_COMPANION_FEASIBILITY.md). It adds no listener, no parser, no
database and no import logic:

```
GearExport.lua ──stat every 2s──▶ stable? (size+mtime unchanged 3s) ──read once──▶ parseSavedExports (core data-only reader)
   ──▶ newest latestExport by generatedAt ──▶ describeExport + consistencyProblems ──▶ (generatedAt, sha256) already sent? skip
   ──▶ postImport({text}) ──▶ POST /api/import (existing; loopback) ──▶ server: parse, dedupe, snapshots, shared storage, item metadata
```

- **Shared with the bridge, not copied.** `importSaved.ts` exports the pieces both use: `discoverSavedVariables`, `parseSavedExports`,
  `describeExport`, `consistencyProblems`, `resolveDashboardUrl`, `postImport` (the one POST; throws `ImportPostError` with `unreachable` or
  `refused`) and `describeImportResult`. `watchSaved.ts` contributes only the timing and state: stable-file detection, newest-export
  selection, the in-memory last-sent `(generatedAt, sha256)`, and retry policy. A test pins that its source has no parser, no SQLite, no
  `importSnapshot` and no copy of the POST.
- **A step machine with injected effects.** `createWatcher(config, deps).tick()` is one deterministic poll; the filesystem (`stat`, `readText`),
  the clock, `fetch` and output are injected, so tests drive a fake clock over a fake filesystem (a file "still changing" is exact, not a
  race) and a real server for the end-to-end case. The CLI supplies the real ones and a `sleep`.
- **Trigger on content, not mtime.** Any change to size or mtime means "look after it is quiet"; whether to send is decided by the newest
  export's `generatedAt` and SHA-256, because WoW rewrites the whole file on every save. mtime is never shown as an observation time; the
  export's own `Generated` is what the Dashboard orders by.
- **Failure handling.** A partial or non-data file is rejected by the reader (nothing sent; wait for the next change). A transient read error
  (a Windows sharing violation) is retried up to 3 times. An unreachable Dashboard is retried with capped backoff (5 s doubling to 60 s); a
  Dashboard that answers and refuses is reported once. `--once` makes a single attempt.
- **Read-only, loopback-only, no token.** Only `stat` and `read`; the source-scan test covers these files, and a test pins that a watch run
  leaves the file and folder byte- and mtime-identical. It refuses a non-loopback target rather than warning. No token is used in this slice
  (a same-user local process can already read the file and call the whole API); revisit per the feasibility doc if that changes.
- **Timing.** SavedVariables reach disk at `/reload`, logout and exit, so an export is delivered then, not at `/wowsync`. That is an accepted,
  not yet measured, assumption.
- **Known limits.** One file; a deleted character can reappear if its export is the newest (no tombstone); only the newest export per save is
  sent; no folder-product-vs-export-version warning yet.

## Snapshot chronology and idempotent import

One rule orders snapshots everywhere (`packages/core/src/chronology.ts`):
**observation time** = `COALESCE(generated_at, imported_at)`, then row id.
The SQLite queries behind "latest"/"previous" (`ORDER BY` in
`sqliteStore.ts`), recent changes, `listVersions().lastUpdatedAt`, and
`accountContext.ts`'s transition history all use it, so the store, AccountFacts and
the LLM context can never describe different snapshot pairs. (Previously the
queries ordered by `imported_at` while AccountContext used `generatedAt`, so an
older export imported late became "current" and produced a reversed diff.) No
schema change or migration: it is an `ORDER BY` only.

`importSnapshot` runs in one `BEGIN IMMEDIATE` transaction (shared `inTransaction`
helper with `deleteCharacter`; re-entrant via `db.isTransaction`):
1. find or create the character; 2. **duplicate check** — a snapshot of the same
character with the same `generated_at` (`IS ?`, so NULL matches NULL) whose export
text is equal after CRLF/trailing-whitespace normalisation is a duplicate: nothing
is inserted, updated or reordered and `ImportResult.isDuplicate` is true; 3. insert;
4. locate the new row in chronological order — its **predecessor** (not merely "the
previous import") is `previousSnapshot`, so the diff always runs forward in time;
`isLatest` says whether it became current state, and class/faction are only updated
when it did. The check is by content, never by `generated_at` alone (one-second
resolution: two different exports can share it) and never via a UNIQUE index (an
existing database may already contain duplicates, which would make the index fail
at startup). Rows already duplicated by older versions are left untouched.

## Freshness-aware totals

`GoldFacts`/`PlaytimeFacts` (version-wide and per `RealmGroup`) gained
`staleCharactersWithKnownGold`/`…Playtime` and `oldestKnown…ObservedAt`, derived from
the already-computed `CharacterFacts` (same `classifyFreshness` rule, same
`lastObservedAt`; no second freshness implementation, no configurable threshold).
`totalKnownCopper` stays a number but is documented as meaningful only alongside
its known-count (0 known = a sum over nothing = unknown, not zero); `VersionSummary`
totals are absent (not 0) when nothing is known. `LlmContext` ("llm-2") projects a
scope-shaped `goldSummary`: `{scope:"realm", byRealm:[…]}` for realm-partitioned
versions (each entry read from its `RealmGroup.gold`; **no** version-wide total),
`{scope:"account-wide", …}` for Retail. AccountContext is schema "3" (additive).

## Server network configuration

`packages/server/src/net.ts` (pure helpers, tested by really listening on sockets):
`resolveHost` (`WOWSYNC_HOST` only; empty → 127.0.0.1 because an empty string
binds every interface; `localhost` → 127.0.0.1 because Node 24 resolves it to
`::1` first), `resolvePort`, `listenOnce` (friendly EADDRINUSE/EACCES/EADDRNOTAVAIL
errors), `loopbackOrigin` (`/api/ask`'s request to its own `/api/account-context`
uses the real bind address), and `hostGuard` (Host/Origin allow-list, enabled for
loopback binds). Every API failure is JSON — unknown `/api/*` paths are a JSON 404,
a final error handler returns `{error}` without stack traces, invalid
`recent-changes?limit` is a 400. The web client (`api.ts`) turns every failure
into a classified `ApiError` (`network | http | parse | shape`), `asyncState.ts`
ignores replies to superseded requests, and `deleteFlow.ts` only treats the
server's own `CHARACTER_NOT_FOUND` 404 as "already gone".

## Deleting a character

`SnapshotStore.deleteCharacter(identityKey)` removes one character and all
of its snapshots in a single `BEGIN IMMEDIATE` … `COMMIT` transaction
(children first: the `snapshots.character_id` foreign key is declared but
SQLite does not enforce it unless `PRAGMA foreign_keys` is on, so the
delete is explicit rather than relying on cascade). A failure part-way rolls
everything back. It returns what was removed, or `undefined` for an unknown
key (a safe no-op). The key is matched with `=` as data, so wildcards and
injection-shaped strings match nothing; the key embeds version + realm +
name, which is what keeps version/realm isolation intact.

No cache or derived table exists to invalidate — AccountFacts, AccountContext,
LlmContext, recent changes, inventory and profession aggregation, and
freshness are all computed on demand from the remaining rows. That is tested
directly: a store after deleting X produces a byte-identical AccountContext
and LlmContext to one that never imported X.

HTTP: `DELETE /api/characters/:identityKey` requires a JSON body
`{"confirmIdentityKey"}` equal to the URL's key (400 otherwise, 404 if the
character does not exist). The UI additionally requires typing the
character's exact name (`packages/web/src/deleteConfirmation.ts`, unit
tested). There is no bulk/"delete all" operation.

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

## Export Dashboard Context (the developer tool)

`accountContext.ts` assembles one deterministic document covering the
whole dashboard — every WoW version, in one JSON payload:

```ts
interface AccountContext {
  schemaVersion: "3"; // v3: freshness fields, observedAt, scopeNote (additive over v2)
  generatedAt: number; // the `now` this was built with
  currency: { unit: "copper"; conversion: string; note: string }; // in-band unit documentation - see below
  versions: {
    "classic-era": VersionContext;
    "tbc-anniversary": VersionContext;
    retail: VersionContext;
    forever: VersionContext; // present (possibly with zero characters) whenever the others are
  };
}
interface VersionContext {
  version: WowVersion;
  aggregationScope: "realm" | "account-wide";
  facts: AccountFacts; // embedded wholesale - the authoritative source
  characters: CharacterContext[]; // history AccountFacts doesn't carry
}
```

**Schema v2** (bumped from v1) came directly out of a real LLM-evaluation
pass on Ask My Account — three concrete gaps a model actually hit, fixed
at the data layer rather than by patching the system prompt:

- **`currency`** — every `*Copper` field (`goldCopper`, `moneyCopper`,
  `deltaCopper`, `costCopper`, ...) is a raw copper integer; a model
  reading `goldCopper: 102815` with no unit context reported it as
  "102.8 gold" (it's 10g 28s 15c). The conversion rule now travels with
  the document itself, not just with one prompt that happens to mention
  it.
- **`CharacterProfessions.status` → `observationStatus`**,
  **`ProfessionCoverageEntry.status` → `coverageStatus`** — two fields
  named identically (`status`) at different nesting levels of the same
  document, with disjoint vocabularies (`OBSERVED`/`LAST_SEEN`/`UNKNOWN`
  vs. `covered`/`none`/`unknown`, answering "was this ever observed?" vs.
  "does anyone have this?"). A model correctly read one and then
  self-contradicted on the other within the same answer. Renamed in
  `accountFacts.ts` (the single source AccountContext embeds wholesale),
  so the fix applies everywhere this data appears — the web UI's
  Economy/Overview profession panels included.
- **`AccountChangeSummary.inventoryItemChanges`** — `transitions`
  previously carried only boolean flags (`inventoryChanged: true`) with
  no item-level detail, even though `diffSnapshots()` already computes
  full `bagsItems`/`bankItems` deltas; they were just discarded before
  reaching the export. A model asked "what changed in your bags"
  correctly said the detail wasn't in its context — which was true, and
  is now fixed by adding a compact `{storage, itemKey, name, deltaQty}[]`
  (never the full `fromQty`/`toQty`/raw-`itemRef` `ItemDelta` shape) to
  `AccountChangeSummary`, present whenever `inventoryChanged` is true and
  omitted (not an empty array) otherwise. Shared by both
  `AccountFacts.recentChanges` and `AccountContext`'s per-character
  `transitions` via the same `diffToChangeSummary()` — one mapping, both
  consumers benefit.

This is explicitly **not** a second implementation of account logic —
every number in it either comes straight from an already-built
`AccountFacts` (embedded as-is, not re-derived) or is assembled by
reusing existing pure functions:

- `CharacterContext.snapshotHistory` — every stored snapshot for that
  character (via the existing `SnapshotStore.listSnapshots`), reshaped
  into a compact chronological list (level/gold/XP/playtime/zone per
  snapshot), sorted oldest-first for a natural reading order.
- `CharacterContext.transitions` — one entry per *consecutive* snapshot
  pair (not just the latest "meaningful" one `AccountFacts.recentChanges`
  covers), computed by calling `diffSnapshots()` — the same function the
  rest of the app uses — and reshaping it with the newly-extracted
  `diffToChangeSummary()` helper, which `recentChanges` itself now also
  calls. One mapping, two call sites, not two implementations.
- `CharacterContext.trainer` — the character's latest snapshot's trainer
  categories, each run through the existing `summarizeTrainerCategory()`.
  The raw, hundreds-of-services array is deliberately never included here
  (see "Presentation vs. data" above) — full per-service drill-down
  remains available, unchanged, via the existing
  `GET /api/characters/:identityKey/snapshots` endpoint.

**Determinism.** `buildAccountContext()` is pure (no I/O, no clock read);
`SqliteSnapshotStore.buildAccountContext(now?)` does the one round of
querying and hands everything to it along with an explicit `now`
(defaulting to the wall clock only at that boundary). The same DB state
plus the same `now` always produces byte-identical JSON — verified
directly with `JSON.stringify` equality in
`packages/core/test/accountContext.test.ts`, not just "looks the same."

**API.** `GET /api/account-context` returns the `AccountContext` object
directly (no `{key: ...}` envelope) — this is the literal JSON the web
UI's Copy/Download buttons serialize, so there is exactly one canonical
serialization path, not one for the API and another for the UI. An
optional `?now=<unix seconds>` override exists for reproducible
debugging; omitted, it uses the real clock.

**UI.** A small "Developer" button in the header (deliberately unstyled/
low-emphasis next to the primary "Import WoWSync" button — this is a
debugging/workflow tool, not a headline feature) opens a modal with
**Copy Account Context** and **Download JSON**. Copy uses
`navigator.clipboard.writeText`; Download creates a local `Blob` and a
throwaway `<a download>` click — both entirely client-side. Neither
button, nor anything else in this feature, makes a network call to
anything other than this app's own `localhost` server.

## LLM boundary — Ask My Account (experimental POC)

```
Structured account data → AccountContext (GET /api/account-context) → POST /api/ask → LLM provider → Answer
```

**Route.** `POST /api/ask` (`packages/server/src/app.ts`) validates the
question (non-empty, ≤ `MAX_QUESTION_LENGTH`), confirms
`OPENAI_API_KEY` is configured, then makes a real HTTP request to this
same server's own `GET /api/account-context` — not a second, divergent
serialization — before calling `askOpenAI()`
(`packages/server/src/llm.ts`). This is deliberate: it guarantees the
context an LLM sees can never drift from what "Export Dashboard Context"
produces, and it means a context-build failure fails the whole request
(no silent fallback to stale data).

**Provider client.** `llm.ts` is a small `fetch`-based OpenAI Chat
Completions client — no SDK dependency. `chatCompletionsUrl()` reads
`OPENAI_BASE_URL` (default `https://api.openai.com/v1`), which exists
both as a legitimate Azure-OpenAI/proxy escape hatch and as the seam
`packages/server/test/ask.test.ts` uses to point at a local mock HTTP
server instead of a live provider. Errors are normalized into a typed
`AskError` (message + HTTP status) covering timeout, network failure,
401/403 (rejected key), 429 (rate limit), 5xx (provider outage), a
non-2xx response, an unparsable body, and a response missing
`choices[0].message.content` — each mapped to a specific, non-leaking
message; the raw provider error body (which can echo the key) is never
forwarded to the client or logged.

**System prompt.** `packages/server/src/systemPrompt.ts` is a fixed,
version-controlled string (`ASK_MY_ACCOUNT_SYSTEM_PROMPT`) establishing
the assistant's role, the OBSERVED-vs-UNKNOWN distinction (UNKNOWN is
never zero/empty), realm/version isolation, and the
observed-change-vs-inferred-cause distinction. It is not user-editable
and not stored per-request.

**Statelessness.** No conversation table, no session, no server-side or
client-side history. Every `POST /api/ask` call is a fresh
system-prompt + context + question triple; nothing from a previous
question is carried forward.

**Web UI.** `packages/web/src/components/AskAccountModal.tsx` — a
question textarea, an Ask button (disabled while a request is in flight,
so a fast double-click can't fire two requests), a compact
"Context: N characters · M WoW versions" indicator (computed from a
lightweight `GET /api/account-context` fetch on open, never rendering the
full ~hundreds-of-KB document), and the answer rendered through
`packages/web/src/markdownLite.tsx` — a small hand-written Markdown
subset (headings, bold/italic/inline-code, bulleted/numbered lists) that
only ever produces React elements from plain-text children. It never
uses `dangerouslySetInnerHTML`, so arbitrary HTML/script content in a
model's answer can't execute — verified by asking the mock provider to
return `<script>`/`onerror`/`onclick` payloads and confirming zero such
DOM nodes are created.

**Testing.** `packages/server/test/ask.test.ts` runs the real Express
route (via `createApp`) against a local `node:http` mock OpenAI server
reached through `OPENAI_BASE_URL`, covering every error path above plus
a check that a deliberately fake API key never appears in any response
body or captured `console.error` output. None of this requires network
access or a real API key, so it runs as part of `npm test`. A separate,
opt-in live-smoke-test procedure (`packages/server/test/README-live-smoke-test.md`)
exists for verifying real grounding behavior against the actual OpenAI
API and real imported character data — intentionally not automated,
since it costs money and depends on a live account.
