# WoWSync Dashboard

A local-first, personal dashboard that imports [WoWSync](../GearExport) `WOWSYNC v1`
exports and builds a persistent, version-isolated picture of your World of
Warcraft characters and accounts over time.

This is a **separate project and a separate Git repository** from the
WoWSync addon (`GearExport`). It consumes WoWSync's text exports; it does
not share code with the addon and never modifies it.

```
WoW  →  WoWSync addon  →  WOWSYNC v1 export  →  WoWSync Dashboard
```

## What this is (and isn't)

- **Is:** a read-only consumer of WoWSync exports. You paste or drop a
  `.txt` export; the dashboard parses it, stores a timestamped snapshot,
  diffs it against the character's previous snapshot, and shows you the
  result.
- **Isn't:** a WoW automation tool. It never reads WoW process memory,
  injects code, simulates input, or takes any gameplay action. The addon
  captures state; this app only reads what the addon already exported.

## Supported WoW versions

Three completely isolated data spaces, selected by a version tab in the UI:

- **Classic Era**
- **TBC Anniversary**
- **Retail**

The client identified in each export (`Client:` / `ClientFamily:` fields)
routes the import into the matching version space. Characters, gold,
inventory, and history are **never aggregated across versions** — see
`packages/core/src/version.ts`. An export from a client we don't recognize
is quarantined into an `unknown-version` space rather than guessed.

## Local-first architecture

Everything runs on your machine:

- **Storage:** SQLite (Node's built-in `node:sqlite`), one file at
  `data/wowsync.sqlite` by default. No hosted backend, no telemetry, no
  automatic cloud sync.
- **Server:** a small Express API (`packages/server`) that wraps the
  storage layer and serves the built UI.
- **UI:** a React/Vite single-page app (`packages/web`).
- **Parser/diff engine:** `packages/core` — pure TypeScript, no I/O beyond
  the storage abstraction it's handed.

Nothing is transmitted anywhere unless you explicitly invoke a future LLM
feature that requires it (not implemented yet — see below).

## Import workflow

Click **Import WoWSync**, then either paste an export (copy from
`WOWSYNC v1` through `[END]` in-game) or drop a `.txt` file. The importer:

1. Validates the export starts with `WOWSYNC v1`.
2. Parses all eight sections deterministically (not with loose regexes).
3. Detects the WoW version from the client info.
4. Resolves character identity (version + realm + name — see
   `packages/core/src/identity.ts` for why GUID isn't part of the key yet).
5. Stores the snapshot **without deleting prior snapshots**.
6. Diffs it against that character's previous snapshot, if any.
7. Shows you the facts: level/gold/playtime deltas, profession changes,
   and how much history exists so far.

Malformed input fails with a specific message (e.g. "missing `[END]`" or
"missing required section: BANK") rather than silently importing partial
garbage.

## Snapshot history

Every import adds a new snapshot; nothing is overwritten. This is what
lets the dashboard eventually answer things like "how long did it take to
get from level 20 to 30?" using the addon's raw `PlayedSeconds` /
`LevelPlayedSeconds` fields — the dashboard computes all derived metrics
(time played, gold gained, skill deltas) deterministically; it never asks
an LLM to do arithmetic.

## LLM analysis (not implemented yet)

The architecture reserves a place for an "Ask My Account" feature: the
deterministic diff engine produces factual context, and an LLM would only
ever *interpret* those facts — never serve as the database, and never see
a raw export unless a scoped, explicit feature sends it. The dashboard is
fully usable with the LLM layer absent, which is its current state.

## Privacy

- Local-first: your character data lives in a SQLite file on your disk.
- No analytics, no telemetry, no automatic network calls.
- WoWSync export text is never transmitted anywhere by this app today.

## Development setup

Requires Node.js 24+ (uses `node:sqlite` and native TypeScript execution —
no build step for the server/core code).

```sh
npm install

# run the parser/diff/storage test suite
npm test

# run the API server (reads/writes data/wowsync.sqlite)
npm run start        # or: node packages/server/src/index.ts

# frontend dev server (proxies /api to the server above on :4173)
npm run dev:web

# build the frontend once, then `npm start` serves it from the same port
npm run build:web
```

See `docs/ARCHITECTURE.md` for the data flow and package layout, and
`packages/core/test/fixtures/README.md` for a note on the current
(placeholder) test fixtures.
