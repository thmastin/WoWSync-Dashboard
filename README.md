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

Four completely isolated data spaces, selected by a version tab in the UI:

- **Classic Era**
- **TBC Anniversary**
- **Retail**
- **Forever** (the Classic beta client — `ClientFamily: Forever`, e.g. 1.60.1)

The client identified in each export (`Client:` / `ClientFamily:` fields)
routes the import into the matching version space. Forever's client number
starts with `1.` just like Classic Era's, so `ClientFamily` is always
checked first — a Forever export is never routed into Classic Era. Characters, gold,
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

Nothing is transmitted anywhere unless you explicitly use **Ask My
Account** (below), an experimental, opt-in feature that sends one
question and the current account context to an LLM provider you
configure. Everything else in this app makes zero outbound network
calls.

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

## Deleting a character (local data cleanup)

Open a character and use **Delete character…** at the bottom of its page
to remove a test or mistaken import. The dialog names exactly what will be
removed (the character, its realm and version, and how many stored
snapshots) and only enables **Delete permanently** once you type the
character's exact name. Cancel is the default.

- **Scope:** exactly one character and its entire snapshot history, in one
  atomic database transaction. Other characters, realms, and versions —
  including an identically named character in another version — are
  untouched. There is deliberately no "delete everything" or bulk delete.
- **Everything derived follows automatically.** AccountFacts, the
  Characters/Economy/Overview views, recent changes, inventory and
  profession coverage, freshness, `GET /api/account-context`, and Ask My
  Account's context are all computed from the rows that remain, so nothing
  further needs cleaning up.
- **API:** `DELETE /api/characters/:identityKey` with a JSON body
  `{"confirmIdentityKey": "<same identity key>"}`. Missing/malformed body
  or a non-matching confirmation → 400 (nothing deleted); unknown or
  already-deleted character → 404; success → 200 with what was removed.
  The key is matched exactly — never as a pattern.
- Re-importing an export afterwards starts a fresh history for that
  character.

## Real fixtures

`packages/core/test/fixtures/classic-era/`, `.../retail/`, and
`.../tbc-anniversary/` contain real WOWSYNC v1 exports captured from actual
clients — Classic Era (Bromrik), Retail (Ezaller and Stoneharry, on two
different realms), TBC Anniversary (Torahn, Voodan, and Tenivard, all
on Dreamscythe), and Forever (two captures of Hallo Emberstone on Classic
Beta PvP 2) — stored byte-for-byte. They caught genuine bugs no
amount of synthetic data did — see `packages/core/test/fixtures/README.md`
for the details (a header-framing bug, addon-version skew between
installs, copy/paste whitespace mangling, a diff-engine item-matching
issue, and gaps in profession coverage). Voodan's real trainer data (180
services on one class-trainer visit alone) is also what drove the trainer
presentation redesign — see "Trainer presentation" below. There is no
synthetic placeholder fixture file anymore; every WoW version now has real
captures, and any remaining synthetic data lives only as narrow inline
edge cases inside the test files themselves.

## Trainer presentation

A single trainer visit can carry hundreds of observed abilities (mostly
`unavailable` — things you can't train yet). The character page shows a
compact per-category summary instead: available-now count, a "Next
Training" callout (the lowest-level group of upcoming abilities and its
total cost), and a collapsed drill-down that groups everything else by its
known required level — expandable per level, and further down to each
ability's cost and prerequisite text. Nothing is ever dropped: the full
observed service list is still there underneath, in both the stored
snapshot and the API response. An ability with no recorded required level
goes in its own "Unknown Unlock Level" bucket — never guessed from spell
ID, rank, or the character's current level.

## Account overview, economy, and AccountFacts

Beyond individual characters, each version has an **Overview** (character
count, total *known* gold/`/played`, recently updated characters, recent
changes, progression, profession coverage, and data freshness) and an
**Economy** tab (per-character gold/playtime tables, a full profession
coverage table, and a known-inventory item search). All of it is computed
by a single deterministic layer, `AccountFacts`
(`packages/core/src/accountFacts.ts`) — the same input always produces the
same output, with no hidden clock reads or network calls. It's scoped to
exactly one WoW version at a time, same as everything else in this app.

"Known" is meaningful here: a character whose bank was never opened
contributes nothing to inventory totals (and is listed separately, not
counted as empty); gold/playtime/profession totals only ever sum over
characters where the value was actually observed. The item search results
say "known total," never implying that's necessarily everything you own.

A character not seen in a while is flagged **stale** rather than shown as
if its last snapshot were current — see `packages/core/src/freshness.ts`
for the (documented, 3-day) threshold.

**Realm scoping.** Classic Era, TBC Anniversary, and Forever characters on
different realms don't share an economy — no shared bank, no shared
currency — so gold/playtime/professions/inventory are scoped **per
realm** by default there (a "Realm:" selector appears whenever a version
has one). Retail, where Warband-era account-wide sharing is real,
continues to aggregate across realms — confirmed with actual data: the
real Ezaller (Kel'Thuzad) and Stoneharry (Thrall) characters, on two
different Retail realms, correctly combine into one account-wide total.

**Profession coverage** shows both what's covered *and* what isn't, using
a version-aware profession catalog (`packages/core/src/professionCatalog.ts`)
rather than just listing whatever happens to be observed. A profession
nobody has is either **none** (every relevant character's professions
were actually observed, and confirmed none of them has it) or **unknown**
(at least one character's professions were never observed, so absence
can't be established) — collapsed under a compact "N not covered" toggle
so it doesn't overwhelm the page.

## Snapshot history

Every import adds a new snapshot; nothing is overwritten. This is what
lets the dashboard eventually answer things like "how long did it take to
get from level 20 to 30?" using the addon's raw `PlayedSeconds` /
`LevelPlayedSeconds` fields — the dashboard computes all derived metrics
(time played, gold gained, XP, skill deltas, location changes) deterministically;
it never asks an LLM to do arithmetic. A snapshot history table on each
character's detail page shows every captured snapshot with level, gold,
`/played`, and zone at that point in time.

## Future automatic snapshot ingestion

The addon may eventually capture snapshots automatically (on login, etc.)
and write them to `SavedVariables` without a manual `/wowsync` export. This
project doesn't implement or assume any particular future format for that
— the core data model (`parseWowSyncExport` → `SnapshotStore.importSnapshot`)
only depends on receiving WOWSYNC v1 text, not on *how* that text arrived.
Manual paste, a dropped `.txt` file, and a hypothetical future
auto-generated snapshot file all go through the exact same importer.

## Export Dashboard Context (developer tool)

A small **Developer** button in the header (next to Import WoWSync, but
deliberately low-key — this is a workflow/debugging tool, not a headline
feature) opens a modal with two actions:

- **Copy Account Context** — copies a complete, deterministic JSON
  snapshot of everything the dashboard knows — every WoW version (Classic Era, TBC Anniversary, Retail, Forever),
  every character's economy/professions/profession-coverage/inventory/
  progression/snapshot-history/trainer summary, recent changes, and
  freshness — to your clipboard.
- **Download JSON** — saves the same document as
  `wowsync-account-context.json`.

This exists so you can hand the dashboard's actual structured state to an
external LLM conversation (ChatGPT, Claude, etc.) for analysis, without
screenshots and without waiting for the eventual "Ask My Account" feature.
**It is local-only**: the dashboard itself never contacts any LLM
provider, never stores an API key, and never transmits your data anywhere
— clicking Copy or Download is the only thing that happens, and pasting
the result into another service is entirely your own explicit choice.

The export doesn't reimplement any account logic — it's `AccountFacts`
for each version embedded as-is, plus per-character snapshot history and
trainer summaries built by reusing the same `diffSnapshots`/
`summarizeTrainerCategory` functions the rest of the app already uses. It
is also available directly at `GET /api/account-context` — the exact same
JSON the UI copies/downloads, so there is one canonical export, not a
separate API shape and UI shape. See `docs/ARCHITECTURE.md` for the full
structure.

## Ask My Account (experimental LLM POC)

```
WoWSync addon → Dashboard SQLite → AccountFacts → GET /api/account-context → LLM consumer → Answer
```

A small **Ask My Account** button in the header (next to Developer)
opens a box: type a question, click **Ask**, get an answer. This is the
**first and only** feature in this app that talks to an external service
— everything described above (import, overview, economy, Developer
export) stays 100% local. Treat this feature as an experimental proof of
concept, not a polished product surface.

**Setup.** Requires an OpenAI API key. Create `.env` at the repo root
(gitignored, never committed) with:

```
OPENAI_API_KEY=sk-...
# Optional overrides:
# WOWSYNC_LLM_MODEL=gpt-4o-mini        (default)
# OPENAI_BASE_URL=https://api.openai.com/v1   (Azure/proxy-compatible override)
```

Restart the server after setting it (`process.loadEnvFile()` reads `.env`
once at startup). Without a key configured, the button still exists and
still opens, but asking a question returns a clear "OPENAI_API_KEY is not
configured" error rather than crashing or silently doing nothing.

**Exact data boundary.** Each request sends exactly three things to the
configured LLM provider, once, over HTTPS:

1. A fixed system prompt (`packages/server/src/systemPrompt.ts`) defining
   the assistant's role and grounding rules.
2. The current `GET /api/account-context` document — the same JSON the
   Developer export's Copy/Download buttons produce. Nothing more.
3. Your question, verbatim.

Never sent: filesystem paths, the SQLite file or its location, the
OpenAI/any API key, machine or OS info, environment variables other than
what's needed to make the request, source code, or browser state. The
server also never logs the full account context, the API key, or full
prompts — only short operational messages on failure (see
`packages/server/src/app.ts` and `llm.ts`).

**How context retrieval works.** The server handling `POST /api/ask`
makes a real HTTP call to its own `GET /api/account-context` — the exact
same code path the Developer export uses — rather than recomputing facts
a second way. If that call fails, the whole request fails with an error;
it never silently answers from a stale or partial context.

**Conversation model.** Fully stateless. Each question is answered
independently with a fresh copy of the current account context; nothing
is remembered between questions, no history is stored anywhere (not in
the database, not in the browser), and there's no multi-turn memory.

**Grounding rules.** The system prompt requires the model to:

- Distinguish what was actually **observed** (present in the context)
  from what's simply **unknown** (never seen) — unknown must never be
  treated as zero, empty, or absent.
- Respect realm and WoW-version boundaries exactly as the rest of the
  dashboard does (Classic Era/TBC Anniversary are realm-scoped; Retail is
  account-wide).
- Distinguish an **observed change** (e.g. "gold decreased by 40s
  between two snapshots") from an **inferred cause** (e.g. "you bought
  something at auction") — it may speculate about a cause, but only
  clearly labeled as a guess, never stated as fact.
- Say what's missing rather than guess when the context doesn't answer
  the question.

**What this is not.** No autonomous agent, no tool/function calling, no
MCP, no memory, no RAG/vector DB, no scheduled or background jobs, no
WoW API access, no addon write-back, no gameplay automation. It answers
one question with one provider call and stops.

**Errors.** Missing/rejected API key, provider timeout/rate-limit/outage,
a malformed provider response, an empty or oversized question, and a
failed context fetch all produce a specific, non-leaking error message in
the UI rather than a generic failure or a stack trace.

**Testing.** `packages/server/test/ask.test.ts` covers the whole
`/api/ask` route (valid question, empty/oversized question, missing key,
provider 401/429/5xx, malformed/non-JSON provider response, context-fetch
failure, and an explicit check that a fake API key never leaks into a
response body or logged output) against a local mock HTTP server — no
live OpenAI account is required to run `npm test`. See
`packages/server/test/README-live-smoke-test.md` for a separate, opt-in
procedure to exercise this against the real OpenAI API with your own key
and real imported character data.

## Privacy

- Local-first: your character data lives in a SQLite file on your disk.
- No analytics, no telemetry.
- Every feature except **Ask My Account** (above) makes zero network
  calls. Ask My Account is opt-in per question and sends only a system
  prompt, the account context JSON, and your question to the provider you
  configure — see the data boundary above for the full list of what is
  and isn't sent.

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
`packages/core/test/fixtures/README.md` for the real vs. synthetic fixture
split.
