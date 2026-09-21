# Fixtures

## Real gameplay fixtures

`classic-era/`, `retail/`, and `tbc-anniversary/` contain **real WOWSYNC v1
exports captured from actual WoW clients**, stored byte-for-byte as
provided — nothing rewritten, normalized, or "corrected". Filenames encode
`<character>-<Generated: unix timestamp>.wowsync.txt` so the capture order
is obvious without opening the file.

- `classic-era/bromrik-{1789170870,1789171621}.wowsync.txt` — Bromrik,
  Defias Pillager, Level 3 → 4, Classic Era client 1.15.9 build 69547.
  ~12.5 minutes apart; a real snapshot-history pair.
- `retail/ezaller-{1789477879,1789478317}.wowsync.txt` — Ezaller,
  Kel'Thuzad, Level 78 Evoker, Retail client 12.1.0 build 69814. ~7 minutes
  apart; gold/XP/`/played` all advance.
- `retail/stoneharry-{1789486499,1789491879}.wowsync.txt` — Stoneharry,
  **Thrall** (a different Retail realm than Ezaller's Kel'Thuzad) — real
  proof that Retail's account-wide aggregation actually combines
  characters across realms, not just a single-realm pass-through. Level
  56 → 66.
- `tbc-anniversary/voodan-{1789484723,1789492666}.wowsync.txt` — Voodan,
  Dreamscythe, Level 16 Priest, client 2.5.6 build 69795. The second
  snapshot was taken deliberately after an Auction House run — see
  `test/realFixtures.test.ts` for what WoWSync actually observed changed
  (gold +3g 60s 62c, `/played` +113s, five bag item quantity changes) and
  what it did *not* claim (no "AH purchase/sale" label anywhere — the diff
  engine only ever reports observed quantities). Voodan's `[CLASS]`
  trainer visit alone carries 180 observed services across 32 required
  levels, plus three profession trainer visits and one unresolved
  `[UNKNOWN]` visit — this is what drove the trainer summarization work in
  `trainerSummary.ts`.
- `forever/hallo-{1789693144,1789731867}.wowsync.txt` — Hallo Emberstone,
  Hunter, Alliance, **Classic Beta PvP 2** (Forever, client 1.60.1,
  `ClientFamily: Forever`, interface 16001). Real captures read from the
  Forever addon's saved data (the addon repo was only read, never
  modified): a level-4 capture (build 69893; equipment/bags/professions
  all UNKNOWN — the addon did not observe them yet) and a level-7 capture
  (build 69913; 291 copper, equipment/bags/professions observed-but-partial,
  Engineering 20/75 and Mining 22/75 with the other player professions at
  0/0). Both leave bank, known spells, and trainers UNKNOWN, and
  PlayedSeconds `?`. The level-4 file was extracted byte-for-byte from the
  addon's Lua test fixture; the level-7 file is the addon's
  `latestExport.text` decoded from its Lua string. The 9,206s /played
  capture reported for a later level-7 export was not available on disk, so
  `test/forever.test.ts` exercises playtime with a clearly labelled
  `[DERIVED]` test (this real text with those two user-reported values
  substituted) rather than an invented fixture file.
- `tbc-anniversary/torahn-1789492498.wowsync.txt` — Torahn, Dreamscythe,
  Level 33 Shaman. Its `[TRAINERS]` section has a `[UNKNOWN]` category
  with 7 services (a trainer visit whose category couldn't be resolved) —
  preserved, not discarded.
- `tbc-anniversary/tenivard-1789492580.wowsync.txt` — Tenivard,
  Dreamscythe, Level 12 Mage. Bank and trainer both genuinely `UNKNOWN`
  (never visited) — a real never-observed-storage test case.

All four TBC Anniversary characters are on the same realm (Dreamscythe),
which is exactly why realm-scoped aggregation (`AccountFacts.realms`) was
worth building — see `test/realmFacts.test.ts`, which validates realm
isolation against this real roster and adds a synthetic second realm only
to prove isolation (the real data alone can't demonstrate two *different*
realms staying separate, since Dreamscythe is the only one captured so
far).

These real fixtures already forced genuine bugs/gaps that no amount of
synthetic data had caught:

1. **Header framing.** `WoWSyncRender.lua`'s `S.Render` joins its entire
   output array — including the `WOWSYNC v1`, `Generated: …`, and
   `Format: …` lines — with `\n\n`. The parser previously assumed those
   three lines formed one block; real exports proved they're three
   separate blank-line-separated chunks.
2. **Addon version skew.** Bromrik's exports predate the `PlayedSeconds`/
   `LevelPlayedSeconds` fields (added to the schema later — see
   `WOWSYNC_ACCEPTANCE.md`) and use the older `[TRAINER]` section name
   instead of the current `[TRAINERS]`. The parser now treats both
   playtime fields as optional and accepts either trainer section
   spelling, rather than assuming every installed addon copy is running
   the latest renderer.
3. **Whitespace-mangled columns.** Table rows in the fixtures as received
   didn't reliably use literal tab characters (a very plausible copy/paste
   casualty), and some trailing columns were dropped outright rather than
   left empty. The parser now accepts a tab **or** a run of 2+ spaces as a
   field separator, and pads a short row with unknown trailing fields
   instead of failing — a single space inside a real value ("Sinister
   Strike", "Finger 1") is never touched.
4. **Level-linked itemRef churn** (diff engine, not the parser). See
   `docs/ARCHITECTURE.md` — item matching keys on base item ID now, not
   the full `itemRef`.
5. **Profession coverage gaps.** Nothing in the real TBC roster has
   Alchemy, Blacksmithing, Engineering, Herbalism, Jewelcrafting,
   Leatherworking, or Tailoring... except Voodan does have Tailoring. The
   point stands for the others: without a version-aware profession
   catalog, "nobody has Alchemy" was indistinguishable from "we never
   checked" — see `professionCatalog.ts` and `test/realmFacts.test.ts`.

## Synthetic fixtures

There is no longer a static synthetic *file* in this repo — the TBC
Anniversary placeholder that used to stand in for missing real TBC data
was removed once real Torahn/Voodan/Tenivard captures arrived. Synthetic
exports now only ever exist as inline `buildWowSyncExport(...)` calls
inside test files (`parser.test.ts`, `diff.test.ts`, `version.test.ts`,
`identity.test.ts`, `trainerSummary.test.ts`, `accountFacts.test.ts`,
`realmFacts.test.ts`) — used only for edge cases real data doesn't happen
to demonstrate (a second Classic/TBC realm to prove isolation, an unknown
`requiredLevel`, malformed input, an uncatalogued profession name, and
similar). Character names in these are always obviously fake (e.g.
`Ghost`, `Alpha`/`Beta`, `Odd`), never a name that could be mistaken for
real history.

## Derived fixtures (`derived/`)

Unlike `classic-era/`, `retail/`, `tbc-anniversary/` and `forever/` above, files here
are **not** live captures. They are real exports with specific sections replaced or
added, so they are labelled `[DERIVED]` in tests and must never be mistaken for
observed data.

- `derived/ezaller-shared-storage-1789478317.wowsync.txt` — the real Ezaller Retail
  export (`retail/ezaller-1789478317.wowsync.txt`) with its `[BANK] State: UNKNOWN`
  block replaced by the three storage sections a current Retail addon emits, in the
  addon's order: an observed character `[BANK]`, an observed `[ACCOUNT BANK]`
  (`Scope: ACCOUNT_WARBAND`) and an observed `[GUILD BANK]` (`Scope: GUILD`) with two
  viewable tabs (one populated, one genuinely empty) and one `INACCESSIBLE` tab. The
  structure, field order, coverage strings, and tab/state vocabulary follow
  `GearExport/WoWSyncRender.lua` and `WoWSyncCollectors.lua` at GearExport `3e9c6bf`
  ("feat: add trusted Retail guild bank capture"); item rows, guild name, and the guild
  club ID (deliberately above 2^53, to prove identifiers are not rounded) are invented
  sample values. No live capture containing `[ACCOUNT BANK]` or `[GUILD BANK]` was
  available when this was written; replace it with a real capture when one exists.
  The UNKNOWN, LAST_SEEN, partial, and all-tabs-inaccessible variants are produced
  inside `test/guildBank.test.ts` by editing this file's Guild Bank block.

- `derived/virek-warband-item-metadata-1789965777.wowsync.txt` - the real sanitized Virek export
  (`sanitized/virek-warband-last-seen-1789965777.wowsync.txt`) kept byte-for-byte, with one `[ITEM METADATA]` block
  inserted before `[END]` in the addon's format (GearExport `a94288e`): the header row, then one row per base item id the
  export references (98, ascending). Only two rows carry facts, and they are the values captured from the live Retail
  (Midnight) client: Mote of Harmony 89112 (class 7, subclass 10, bind 0, expansion 4, reagent) and Mote of Light 236949
  (class 7, subclass 11, bind 0, expansion 11, reagent). The other 96 rows are all `?`, as the addon writes an item whose
  full info was not available. This is not a live capture (it is the older sanitized export plus a block written from the live values).
  A real `a94288e` Virek export has since been imported into the real database, but it is not committed as a
  fixture because it carries the character's full inventory, professions and gold.

## Sanitized real fixtures (`sanitized/`)

Files here come from **real exports** but are deliberately minimal: only what a test needs
is kept verbatim, and everything irrelevant is replaced with `?` / `State: UNKNOWN` so no
unrelated character data is committed. They are neither byte-for-byte captures (those are
the directories above) nor invented data (that is `derived/`).

- `sanitized/virek-warband-last-seen-{1789965184,1789965777}.wowsync.txt` — Virek,
  Cairne, Retail 12.1.0 build 69875. Two exports made ~10 minutes apart, both carrying
  the **same** Warband observation as `State: LAST_SEEN; complete; observed=1789965174`
  (`SnapshotVisit: 1789965173`, NPC Elana, 98 items), each with `[GUILD BANK]` UNKNOWN.
  Kept verbatim: the header, the `[CHARACTER]` name/realm/client lines, the whole
  `[ACCOUNT BANK]` block and the `[GUILD BANK]` block. Replaced with `?`/UNKNOWN: class,
  level, faction, gold, playtime, XP, location, equipment, bags, character bank,
  professions, spells, trainers. They exist to prove that replaying one shared-storage
  observation from several exports must not manufacture several observations
  (`test/sharedStorage.test.ts`).
