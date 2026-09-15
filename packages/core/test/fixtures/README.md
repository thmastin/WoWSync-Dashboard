# Fixtures

## Real gameplay fixtures

`classic-era/` and `retail/` contain **real WOWSYNC v1 exports captured from
actual WoW clients**, stored byte-for-byte as provided — nothing rewritten,
normalized, or "corrected":

- `classic-era/bromrik-1789170870.wowsync.txt` — Bromrik, Defias Pillager,
  Level 3, Classic Era client 1.15.9 build 69547.
- `classic-era/bromrik-1789171621.wowsync.txt` — Bromrik, same character,
  Level 4, captured ~12.5 minutes later. Together these are a real
  snapshot-history pair (see `test/realFixtures.test.ts`).
- `retail/ezaller-1789477879.wowsync.txt` — Ezaller, Kel'Thuzad, Level 78
  Evoker, Retail client 12.1.0 build 69814.
- `retail/ezaller-1789478317.wowsync.txt` — Ezaller, same character,
  ~7 minutes later (gold, XP, and /played all advanced). Also a real
  snapshot-history pair.

Filenames encode `<character>-<Generated: unix timestamp>.wowsync.txt` so
the capture order is obvious without opening the file.

**`tbc-anniversary/` real fixtures are pending.** WoW servers were down
during this development session, so no real Torahn/Voodan/Tenivard exports
were available yet. Do not add synthetic data there to fill the gap — the
directory stays empty (or absent) until real captures arrive. When they do,
add them here following the same naming convention and update
`test/realFixtures.test.ts`.

These real fixtures already forced two genuine parser fixes that no amount
of synthetic data had caught:

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

## Synthetic fixtures

`synthetic/` contains **generated, format-accurate but non-gameplay**
fixtures, built from `fixtureBuilder.ts` (which implements the same
escaping/field-order algorithm as `WoWSyncRender.lua`). They exist only to
exercise code paths real fixtures don't happen to cover yet — right now,
that's a second TBC Anniversary snapshot (for history/diff tests) since no
real TBC capture exists. The character name (`Synthtest` on
`PlaceholderRealm`) is deliberately not any of the user's real characters,
so it can never be mistaken for real history.

Additional synthetic exports built inline (not as files) inside
`parser.test.ts`, `diff.test.ts`, `version.test.ts`, and `identity.test.ts`
cover narrow parser edge cases — unknown fields, partial/UNKNOWN
combinations, malformed input, multi-category trainers, item variants —
that are awkward or impossible to demonstrate with the limited real data
on hand. Those are synthetic by construction and are treated as such.

To regenerate the synthetic fixtures: `node test/fixtures/generate.ts`.
Never regenerate over the real ones — there is no generator for those, by
design.
