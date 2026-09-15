# Fixtures

These `.txt` fixtures are generated from `fixtureBuilder.ts`, which implements
the exact same algorithm as `GearExport/WoWSyncRender.lua` (escaping rules,
field order, section structure). They are **format-accurate**, not real
gameplay data — no real export text was available at the time this milestone
was built.

**Replace or supplement these with real WoWSync exports as they become
available** (Torahn, Voodan, Tenivard on TBC Anniversary; Bromrik on Classic
Era; Retail once that port is validated). Real fixtures are strongly
preferred over generated ones — see the project instructions this repo was
built from.

To regenerate: `node test/fixtures/generate.ts`.
