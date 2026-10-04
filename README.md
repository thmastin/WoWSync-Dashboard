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

**Documentation entry point:** [`docs/START_HERE.md`](docs/START_HERE.md) routes design,
implementation, operations, testing, and roadmap questions to the right document — read it before
the rest of this README if you're navigating the docs rather than just running the app.

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

The Dashboard itself runs on your machine:

- **Storage:** SQLite (Node's built-in `node:sqlite`), one file at
  `data/wowsync.sqlite` by default. No hosted backend, no telemetry, no
  automatic cloud sync.
- **Server:** a small Express API (`packages/server`) that wraps the
  storage layer and serves the built UI.
- **UI:** a React/Vite single-page app (`packages/web`).
- **Parser/diff engine:** `packages/core` — pure TypeScript, no I/O beyond
  the storage abstraction it's handed.

The ordinary Dashboard does not synchronize data to a hosted service. Two
separate, explicitly configured features can send selected information
outbound: **Ask My Account** sends its request context to the configured LLM
provider, and the optional read-only MCP integration sends only requested MCP
tool results through OpenAI Secure MCP Tunnel. The MCP server and Dashboard
remain local; the tunnel is a separate process and does not expose the
Dashboard's HTTP API. See [MCP development and operations](docs/MCP_DEVELOPMENT.md).

## Architecture and research references

The core data model keeps Retail, Classic Era, TBC Anniversary, Forever, and
unrecognized-version data isolated. Values retain their evidence state:
`OBSERVED`, `DERIVED`, `LAST_SEEN`, or `UNKNOWN`; unknown is not zero and
historical `LAST_SEEN` data is not presented as current. The optional external
retrieval path has a separate strict read-only SQLite store and a registered
research index; it does not reuse the writable Dashboard API as an integration
boundary.

- [Start here](docs/START_HERE.md) — the fixed documentation entry point and routing table.
- [Architecture invariants](docs/ARCHITECTURE_INVARIANTS.md) — the durable rules (observation,
  version, ownership, metadata, ERP, mutation/security); highest authority for design decisions.
- [System reference](docs/SYSTEM_REFERENCE.md) — current implementation reference, including the
  two separate read-projection pipelines (Dashboard UI/Ask My Account vs. MCP).
- [Azeroth ERP architecture](docs/AZEROTH_ERP_ARCHITECTURE.md) — demand/allocation semantics and
  the Slice 1, Slice 2, and Slice 3 live-validation records.
- [Architecture](docs/ARCHITECTURE.md) — the long-form historical/narrative packages, storage,
  provenance, and read-boundary doc.
- [Read/research retrieval design](docs/READ_RETRIEVAL_ARCHITECTURE.md) —
  provider-neutral deterministic queries and registered Markdown research.
- [MCP development, Secure MCP Tunnel runbook, and acceptance history](docs/MCP_DEVELOPMENT.md) —
  optional ChatGPT connection. MCP is not required to run the Dashboard.
- [Operations runbook](docs/OPERATIONS_RUNBOOK.md) — DEV systemd topology and deployment.
- [Testing and validation](docs/TESTING_AND_VALIDATION.md) — automated tests, parity testing, and
  how to record a live-validation event.
- [Roadmap](docs/ROADMAP.md) — current implementation status and open work.
- [Non-goals and future architecture](docs/NON_GOALS_AND_FUTURE_ARCHITECTURE.md) — explicit
  boundaries (TSM/CraftSim/Journalator) and exploratory future ERP ideas.
- [Midnight research index](docs/MIDNIGHT_12_1_ENDGAME_RESEARCH.md) — current
  game research and linked profession/Renown references.

## Import workflow

Click **Import WoWSync**, then either paste an export (copy from
`WOWSYNC v1` through `[END]` in-game) or drop a `.txt` file. The importer:

1. Validates the export starts with `WOWSYNC v1`.
2. Parses the currently supported export sections deterministically (including the optional additive item-metadata section; not with loose regexes).
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

## Developer bridge: import a saved export from WoW's SavedVariables

The normal workflow above is unchanged. For development and integration testing there is also one supported command
that takes the export GearExport has **already saved to disk** and sends it through the same `POST /api/import`:

```
npm run import:saved -- --list
npm run import:saved -- --character Virek --dry-run
npm run import:saved -- --character Virek
```

GearExport keeps the exact text of each character's last `/wowsync` export in its SavedVariables file
(`WTF/Account/<account>/SavedVariables/GearExport.lua`, under `WoWSyncDB.characters[...].latestExport.text`). WoW only
writes that file when it saves, so the flow is:

1. Run `/wowsync` in WoW.
2. **`/reload` or log out**, so the export reaches disk. The command reads what WoW persisted; it cannot make WoW save.
3. Run the command (the Dashboard server must be running: `npm start`).

**Telling it where the file is** (the smallest set that works; nothing is guessed and no path is built in):

| Option | Meaning |
| --- | --- |
| `--file <path>` | the `GearExport.lua` file itself (env `WOWSYNC_SAVED_VARIABLES`) |
| `--wow-dir <path>` | the WoW folder, or one product folder such as `_retail_` (env `WOWSYNC_WOW_DIR`); the command finds `WTF/Account/<account>/SavedVariables/GearExport.lua` under it and under `_retail_`, `_classic_era_`, `_classic_`, `_anniversary_`, `_classic_beta_` |

Put the environment variables in `.env` (the same file the server reads) to avoid retyping. If more than one
`GearExport.lua` matches (several accounts or products), the command lists them and stops: point `--wow-dir` at one
product folder or pass `--file`.

**Options**

- `--list`: show each saved character with realm, when its export was generated, and whether it has `[ITEM METADATA]`.
  Contacts nothing.
- `--character <name>`: which character to import. If that name exists on several realms, add `--realm <realm>`; it never picks
  one for you. A character with no saved export is an error, never a substitute. If two saved records exist for the same
  name and realm (a re-created character), the newest export is used and a warning says so.
- `--dry-run`: do everything except send: find the file, pick the character, and report the export's character, realm, client
  build, generated time, length, SHA-256 and whether it has `[ITEM METADATA]`. Contacts nothing.
- `--url <url>`: the Dashboard's address. Default: what the server itself would use (`PORT` / `WOWSYNC_HOST`, so
  `http://127.0.0.1:4173`); env `WOWSYNC_URL`. A non-loopback address prints a warning.

**What it guarantees**

- **Read-only.** It never writes to SavedVariables, the addon or WoW's folders, and never asks WoW to save.
- **Data, not code.** `GearExport.lua` is Lua, but it is read by a small data-only reader that accepts just the tables, strings,
  numbers and booleans WoW writes. It never evaluates the file: a file containing a function call or any other code is refused.
  A truncated or garbled file fails loudly (if WoW was writing it, wait and retry).
- **The exact export.** The persisted `latestExport.text` is what is sent, unchanged. Nothing is rebuilt from tables, rewritten or
  regenerated. It prints the SHA-256 of what it sent and, after the import, whether the stored text has the same hash.
- **No second importer.** The server does all parsing, validation, snapshot storage, shared-storage reconciliation and item-metadata
  ingestion, exactly as for a pasted export; importing the same export again is a harmless duplicate.
- **It stops rather than guess.** It refuses when the saved export is for a different character or realm than asked, when WoW's
  saved `generatedAt` disagrees with the export's own `Generated` line, or when the Dashboard would reject the text.

**Troubleshooting**

- *"N GearExport.lua files were found ... refusing to guess"*: several accounts or products. Use `--wow-dir <WoW>/_retail_` or `--file`.
- *"has no saved export"*: run `/wowsync` on that character and `/reload`.
- *"is not a SavedVariables file this tool can read as data"*: the file is truncated or is not GearExport's; if WoW was just
  writing it, retry.
- *"Can't reach the Dashboard"*: start the server (`npm start`), or give `--url` / `WOWSYNC_URL`.

This is a **developer convenience, not the desktop companion**. It runs when you run it; it does not watch files, react to WoW,
force a save or run in the background. To have the same import happen when WoW saves, see the
[watcher](#watcher-and-windows-capture-transport) below.

## Watcher and Windows capture transport

`npm run watch:saved` is the foreground development form of the watcher. For the persistent Windows → Omarchy DEV setup, use the hidden
Task Scheduler supervisor and systemd operator in [WINDOWS_CAPTURE_SETUP.md](docs/WINDOWS_CAPTURE_SETUP.md). The real Windows setup,
reboot, outage, browser and ChatGPT acceptance is still required before calling the infrastructure operational.

```
npm start                                                          # the Dashboard, in one terminal
npm run watch:saved -- --wow-dir "C:\Games\World of Warcraft"   # all products; or ...\_retail_ for one
npm run watch:saved -- --wow-dir "C:\Games\World of Warcraft" --once   # catch-up import from every product file, then exit
```

**Bridge vs watcher.** They share the same file reader and checks. Local mode uses `POST /api/import`; capture mode uses the authenticated
receiver protocol. `import:saved` imports **one character you name, when you run it**. `watch:saved` polls **every matching GearExport.lua**
(install root = all products; one product folder = that client) and, whenever WoW saves it, imports **the single newest export in it**, without
you naming anyone. Neither has an importer of its own.

**When it can act.** WoW writes SavedVariables on `/reload`, logout and exit, **not** when you run `/wowsync` (the addon holds the export
in memory until then). So the flow is: `/wowsync`, then `/reload` or log out, and the watcher sends it within a few seconds. It cannot
see a `/wowsync` while you stay logged in, cannot make WoW save, and never asks it to. It prints only what it knows: when WoW last
wrote the file and when the newest export in it was generated, never a "synced at" time. (This timing is an accepted assumption that
has not yet been measured against a live client.)

**What it does**

- Resolves SavedVariables with the same discovery roots as the bridge (`--file`, `--wow-dir`, or `WOWSYNC_SAVED_VARIABLES` /
  `WOWSYNC_WOW_DIR`). Unlike `import:saved`, several accounts or products are **all watched** (each file has its own last-sent state).
  Point `--wow-dir` at the install root for every product, at one product folder for a single client, or use `--file` for one path.
- Polls the file's size and modified time every 2 s. After a change it waits until the file has been unchanged for 3 s (WoW may still
  be writing), reads it **once** as data, and rejects a partial or non-data file (nothing is sent; it waits for the next change).
- Picks the **newest** `latestExport` by its own generated time (equal times with different text are refused), checks it is consistent
  with its record and that the Dashboard would accept it, and sends the exact persisted text. It remembers the last export sent (in memory
  only), so the many saves that do not change the export send nothing; a restart at worst sends once more and the server reports a duplicate.
- **Ignores the file as it was at startup**: only a save that happens while it runs is imported. `--once` is the catch-up: import the
  newest saved export now, then exit (exit code 0 imported or already imported, 1 otherwise).
- Persistent `--service` mode waits for SavedVariables files to appear, discovers new product/account files, and catches up the newest
  persisted export after restart. It writes credential-free status to `WOWSYNC_CAPTURE_STATUS_PATH`.
- If the Dashboard is not running it says so and retries with backoff (5 s, 10 s, 20 s, up to 60 s); the file is the source, so nothing is
  lost. If the Dashboard answers and **refuses** the export, it reports it once and waits for the next save.

**DEV remote receiver.** The watcher sends to the dedicated authenticated `POST /api/captures` endpoint and retains each immutable capture
in a local outbox until the receiver returns a matching durable receipt. The Windows supervisor maintains private loopback SSH forwards for
capture (`4175`) and the Dashboard browser (`4174`). Neither port is exposed to the LAN. Step-by-step Windows and Omarchy instructions are
in [WINDOWS_CAPTURE_SETUP.md](docs/WINDOWS_CAPTURE_SETUP.md).

For one-off development only, create a private SSH local forward manually:

```powershell
ssh -N -L 127.0.0.1:4175:127.0.0.1:4175 <ssh-user>@<omarchy-host>
```

The persistent Windows instructions retrieve and protect the DEV token without
printing it; do not set it in an interactive command or repository `.env`.

On the DEV Dashboard service, set `WOWSYNC_CAPTURE_TARGET=DEV`, `WOWSYNC_CAPTURE_TOKEN` to the same DEV-only token, and
`WOWSYNC_CAPTURE_DIR` to a private writable directory on the same host as its SQLite database. The receiver is disabled unless all three are
configured; it starts a separate loopback-only listener on port 4175 by default (`WOWSYNC_CAPTURE_PORT` can change it). That listener serves
only the capture endpoint, so the tunnel does not expose Dashboard read/delete/Ask routes. For a later cloud host, put this receiver behind an
HTTPS reverse proxy and use the same sender protocol with an HTTPS `WOWSYNC_URL` and a distinct target token. Keep DEV and LIVE
spool, token, receipt directories and databases separate.

**Transport guarantees.** The sender writes a capture to disk before sending and removes it only after the receiver acknowledges the same
capture ID, target and SHA-256. The receiver stages the exact payload, imports through the ordinary parser/store transaction, then writes a
durable receipt. If the response is lost, retrying the same ID is safe; a reused ID with different content is refused. Receiver storage is
separate from the Dashboard database but lives on the same host. The general browser import API is unchanged. The receiver should be reachable
from Windows through a private tunnel now or HTTPS at a cloud host later; do not expose the unauthenticated Dashboard API to a LAN.

**Read-only guarantee.** The watcher still only stats and reads WoW's SavedVariables file. It never writes, renames, locks or spawns anything
in the WoW folder. The restricted Lua reader never evaluates the file; the server remains the only parser/importer/database writer.

**Known limits.**

- The persistent supervisor starts after Windows user sign-in and requires non-interactive OpenSSH authentication.
- A character you deleted in the Dashboard can **reappear** if its export is the newest in the file (deleting is not a tombstone). Accepted for
  this slice; see the ROADMAP's Needs Decision table.
- Only the newest export is sent per save. A `/wowsync` on character A followed by one on character B before a single `/reload` sends B; A
  reaches the Dashboard by pasting it, `import:saved --character A`, or a later `/wowsync` and save.
- Remote capture requires `--capture-target` (or `WOWSYNC_CAPTURE_TARGET`), `WOWSYNC_CAPTURE_TOKEN` and an absolute `--spool-dir` (or
  `WOWSYNC_CAPTURE_SPOOL_DIR`). Non-loopback URLs require HTTPS. A loopback URL is appropriate for the SSH forward shown above.
- Infrastructure remains pending real Windows reboot/outage/browser acceptance and a normal ChatGPT MCP call after startup changes.

## What the totals mean (unknown, zero, and stale)

Gold and `/played` totals sum each character's **last observed** value; they
are not live balances. Every total says what it is made of:

- **Unknown is not zero.** A character whose gold was never observed
  contributes nothing and is listed as "not observed (not counted)". If *no*
  character's gold is known the headline is `?`, never `0c`. A character
  observed at exactly 0 copper is a real, known 0.
- **Stale contributions are stated, not hidden.** A total reports how many of
  its contributors were last synced more than 3 days ago (the fixed freshness
  window — deliberately not configurable) and how old the oldest one is. A
  stale character's gold is still in the sum; the total just tells you so.
- **Realms are separate economies** (Classic Era, TBC Anniversary, Forever).
  The Overview and Economy views scope to one realm at a time. Ask My Account
  is given gold **per realm** for those versions, with no version-wide total it
  could mistake for a single balance; Retail, which shares gold account-wide,
  keeps one total. The developer export (`GET /api/account-context`, schema
  "3") still contains the cross-realm sums under `facts`, and says in-band
  (`scopeNote`) that `facts.realms[]` is the per-realm view.
- **Shared storage is not in any total.** The Warband Bank and Guild Banks have their own
  [Shared Storage](#shared-storage-warband-and-guild-bank) view; their contents are not added to a character's or the
  account's totals.

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

## Shared storage (Warband and Guild Bank)

Some Retail storage is shared rather than belonging to one character: the **Warband Bank** (account-level) and **Guild
Banks** (one per guild). The addon carries what it last saw of them in every Retail export, so the same bank can arrive
with many characters. The Dashboard therefore treats each one as owned by **the Warband or the guild**, never by the
character whose export happened to carry it.

- **Where it appears.** Retail → **Shared Storage** tab: one card per owner. A character page shows only what its
  own export *carried* ("Warband Bank carried by this export") as historical evidence, with a link to the owner's card.
- **What you see.** When the storage was actually observed and how fresh that is; whether the observation was complete;
  what is in it (items are listed together: an observation does not record which guild tab held each item); which
  exports carried it ("one observation, carried by N exports"); and, for a guild, which tabs were observed, inaccessible
  to the observing character, or not confirmed. **Unknown is never shown as empty.** A newer partial observation, an
  earlier observation with broader tab visibility, or a conflict at the same time is shown alongside, never merged into
  the current one. "Derived" only means the Dashboard chose which real observation is current.
- **Ownership.** The Warband is this Dashboard's local Retail account scope: it is *not* a Battle.net account, so two
  accounts imported into one Dashboard cannot be told apart. A guild is identified by its exact `GuildClubID` (opaque
  text); the guild name is only a label.
- **Not part of any total (yet).** Shared storage is not counted in gold or inventory totals, item search, recent
  changes, the developer export, or Ask My Account.
- **Clearing history.** Deleting a character never removes shared storage. Each owner has **Clear stored history…**
  (type `Warband` or the guild's exact ID to confirm). **This clears stored shared-storage history. A later WoWSync
  export may add it again**, because the addon keeps carrying what it last saw; importing an export that is already
  stored restores nothing.
- **Integrity.** If stored shared data fails validation, the tab says so, names the affected owners and lets you clear
  them; nothing is skipped or guessed.
- **API.** `GET /api/shared-storage`; `DELETE /api/shared-storage/warband` and
  `DELETE /api/shared-storage/guilds/:guildClubId` with a JSON body `{"confirmOwnerKey": "<owner key from GET>"}`
  (404 `SHARED_OWNER_NOT_FOUND` when there is nothing to clear). Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Allocation (Retail stock targets)

> **Status:** implemented on `feature/erp-allocation-tab`, awaiting independent review and DEV validation. Not yet
> live-validated or merged.

Retail → **Allocation** tab (`#/retail/allocation`): say how many of an item the whole account should keep, and see
how the account's observed storage (character bags and banks plus the Warband bank) measures up. Nothing here moves,
mails, sells, or posts anything; a sale suggestion is a recommendation only.

- **Your targets.** Each target reads like "Keep 100 · Have 40 · Short 60", "On target", "17 surplus · Eligible for
  Hellomags", or "At least 17 surplus · Needs review". **Edit** changes the quantity or purpose; **Remove target**
  deactivates it (kept as history, never deleted), after which the item has no target and its surplus is unknown again.
- **Keep 0 is a real target** ("I want none of this"): confirmed holdings above 0 can become surplus. It is different
  from removing the target, which means you have not said what you want.
- **Held with no target.** No target means surplus is unknown, so these items are **not surplus** and show no surplus
  or disposition. Search by name or exact item ID; pages through every match. **Set target** starts a target from a row.
- **Add a target by item ID** for something the account does not hold yet (it shows as short by the full amount).
- **Honest uncertainty.** Unseen account-owned storage is stated once at the top. Unknown stack quantities show as a
  minimum ("Seen ≥ 12"); last-seen (historical) quantities are shown separately and never counted; Guild Bank holdings
  are shown as "Guild-owned, not counted". When held rows of one item have different item strings, allocation is
  **not computed** and the target needs review; no zero is shown in its place.
- **API.** `GET /api/versions/retail/allocation-review` (optional `demandedOffset`, `demandedLimit`,
  `unallocatedOffset`, `unallocatedLimit`, `q`) and the demand routes under `/api/versions/retail/demands`. Design:
  [docs/AZEROTH_ERP_ARCHITECTURE.md](docs/AZEROTH_ERP_ARCHITECTURE.md) §25.

## Item info (expansion and crafting reagents)

Current WoWSync exports carry an additive `[ITEM METADATA]` section: what the game client itself reported about each
item (its type, binding, expansion number and whether it is a crafting reagent). The Dashboard shows it as **Item info**:

- **Where.** In the Shared Storage table (an **Item info** column) and, as a short suffix, in the bag, bank, Warband and
  Guild Bank lists on a character page - for example *Mote of Light × 13 — Midnight · Reagent*.
- **What it means.** The expansion is the game client's own number, named only where the Dashboard has verified it in the
  live Retail client (Mists of Pandaria, Shadowlands, Dragonflight, The War Within, Midnight). Any other number is shown as
  "Expansion unknown (client value N)" - never guessed, and never assumed to be "Classic". A reagent is "Reagent" or
  "Not a reagent" only when the client said so. The expansion is the client's own tag for the item, not proof of when it
  was introduced: a very old holiday item can carry the current expansion, and some old items report 0.
- **Unknown stays unknown.** "?" means the client did not report it (for example an item that was not cached when the
  export was made). Nothing is inferred from an item's name or number. An older export has no item info at all, and lists
  then look exactly as before; the column only appears once the Dashboard holds metadata.
- **It is enrichment.** It never changes what an export or a stored Warband / Guild Bank observation says, and later exports
  can fill in what an earlier one did not know. If two exports disagree about an item, it is shown as unknown rather than
  picking one.
- **Not used elsewhere (yet).** Item info is not part of gold or inventory totals, item search, recent changes, the developer
  export or Ask My Account. There is no keep / vendor / mail advice. Blizzard-API lookups are not implemented; the
  Dashboard still makes no outbound calls for this.
- **API.** `GET /api/versions/:version/item-metadata`. Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ("Item metadata").

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

Every new export adds a snapshot; nothing is overwritten. This is what
lets the dashboard eventually answer things like "how long did it take to
get from level 20 to 30?" using the addon's raw `PlayedSeconds` /
`LevelPlayedSeconds` fields — the dashboard computes all derived metrics
(time played, gold gained, XP, skill deltas, location changes) deterministically;
it never asks an LLM to do arithmetic. A snapshot history table on each
character's detail page shows every captured snapshot with level, gold,
`/played`, and zone at that point in time.

**Which snapshot is "latest"?** The one whose game state existed most
recently — the export's own `Generated` timestamp — not the one imported
most recently (an export with no `Generated` value falls back to its import
time; ties go to the later import). A state cannot have been observed after
it was imported, so an export whose `Generated` value lies in the future (a
wrong clock) is treated as observed when it was imported — otherwise one such
export would outrank every real export after it. So importing an older export after a
newer one adds it to the history without making it the current state, and
the import summary says so instead of showing a reversed "change".
"Recent changes", "last synced", and the current level/gold all follow the
same rule.

**Importing the same export twice is harmless.** An export that was already
imported (same character, same `Generated` value, same text — line-ending
and trailing-whitespace differences from copy/paste are ignored) is reported
as "already imported" and changes nothing. Two *different* exports that
happen to share a `Generated` second are both kept (an export with no
`Generated` value, imported twice unchanged, also counts as a duplicate). Imports are atomic: a
failure never leaves a half-imported character. Databases created before
this rule keep working with no migration; a duplicate that was stored by an
older version stays as it was (delete the character and re-import if it
bothers you).

## Future automatic snapshot ingestion

The addon may eventually capture snapshots automatically (on login, etc.)
and write them to `SavedVariables` without a manual `/wowsync` export. This
project doesn't implement or assume any particular future format for that
— the core data model (`parseWowSyncExport` → `SnapshotStore.importSnapshot`)
only depends on receiving WOWSYNC v1 text, not on *how* that text arrived.
Manual paste, a dropped `.txt` file, and a hypothetical future
auto-generated snapshot file all go through the exact same importer. The one thing that exists today is the
[developer bridge](#developer-bridge-import-a-saved-export-from-wows-savedvariables), a command you run by hand that reads what
GearExport already saved and sends it to the same endpoint, and the [watcher](#watcher-and-windows-capture-transport)
(`npm run watch:saved` or the persistent Windows setup) runs the same import when WoW saves the file.

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
**first feature in the Dashboard UI** that talks to an external service
— everything described above (import, overview, economy, Developer
export) stays local. The separate MCP/Tunnel process is documented below and
is not used by this UI flow. Treat this feature as an experimental proof of
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

**What this Ask My Account feature is not.** No autonomous agent, no
tool/function calling in this route, no MCP in this route, no memory, no RAG/vector DB, no scheduled or background jobs, no
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
- Ask My Account is opt-in per question and sends its documented prompt,
  account-context JSON, and question to the provider you configure.
- The optional WoWSync MCP connection is separately opt-in: when the local
  `tunnel-client` runs, it makes outbound HTTPS connections to OpenAI and
  relays requested, bounded results from the dedicated read-only MCP process.
  It does not make the Dashboard API public or upload the SQLite database.
- Without either feature being used, the Dashboard's account data remains on
  this machine. See [MCP operations](docs/MCP_DEVELOPMENT.md) for the local
  process and trust boundary.

## Network exposure

**The server listens on this machine only by default** (`127.0.0.1`).
WoWSync has no authentication — it is a personal, local-first tool — so
anything that can reach the port can read your character data, import or
**delete** characters, and use Ask My Account (spending your
`OPENAI_API_KEY`). Keeping the server on loopback is the security model.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4173` | Port to listen on (integer 1–65535; anything else is an error, not a random port). |
| `WOWSYNC_HOST` | `127.0.0.1` | Address to bind. Empty/unset means loopback. `localhost` is treated as `127.0.0.1`. |

To reach the dashboard from another device (a phone, another PC, a
container/port-forward setup), set `WOWSYNC_HOST=0.0.0.0` (all interfaces) or a
specific address, e.g. in `.env` or the shell:

```sh
WOWSYNC_HOST=0.0.0.0 npm start      # PowerShell: $env:WOWSYNC_HOST="0.0.0.0"; npm start
```

**Doing that exposes the whole API to your local network with no
protection.** Only do it on a network you trust; the server prints a warning
at startup when the bind is not loopback. An invalid `WOWSYNC_HOST` makes the
server refuse to start rather than guess a wider bind. (Only `WOWSYNC_HOST`
is read — never the generic `HOST`/`HOSTNAME` variables.)

The optional WoWSync MCP integration does not require a LAN bind: keep the
Dashboard on loopback and use its separate outbound Secure MCP Tunnel process.
Do not widen `WOWSYNC_HOST` as a ChatGPT connectivity workaround.

**Upgrading from an older build:** stop any running WoWSync server first. Older
builds listened on every network interface, and the new server refuses to start
while another process answers on its port (rather than silently running beside
it) — but until you stop the old one, it keeps serving your data to the network.

On a loopback bind the server additionally rejects requests whose `Host` (or,
for state-changing requests, `Origin`) is not `localhost`/`127.0.0.1`/`::1`,
which blocks "DNS rebinding" attacks from web pages you visit. This is not
authentication: any program running on your machine can still call the API.

## Development setup

Requires Node.js 24+ (uses `node:sqlite` and native TypeScript execution —
no build step for the server/core code).

```sh
npm install

# run the parser/diff/storage test suite
npm test

# run the API server (reads/writes data/wowsync.sqlite)
npm run start        # or: node packages/server/src/index.ts

# frontend dev server (proxies /api to the server above on 127.0.0.1:$PORT, default 4173)
npm run dev:web

# build the frontend once, then `npm start` serves it from the same port
npm run build:web
```

See `docs/ARCHITECTURE.md` for the data flow and package layout, and
`packages/core/test/fixtures/README.md` for the real vs. synthetic fixture
split.
