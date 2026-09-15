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
Dashboard UI                   packages/web (React/Vite)
        │                     served by packages/server (Express)
        ▼
   (future) LLM analysis      — reads the diff engine's factual output,
                                 never the raw export or the database
                                 directly. Not implemented in this
                                 milestone.
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
