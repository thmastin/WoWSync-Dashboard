# Desktop companion: feasibility checkpoint (ROADMAP item 8)

Status: **Slice 1 implemented, awaiting review** (`npm run watch:saved`; see [section 8](#8-smallest-vertical-slice-after-approval-and-stop-for-review-checklist)
and [Review decisions](#review-decisions-recorded-when-slice-1-was-approved)). Nothing beyond Slice 1 exists: no tray, installer,
autostart, multi-file watching or Electron. The rest of this document is the design it was built from.
Written 2026-09-21 against branch `feature/dashboard-integration`.

## Review decisions (recorded when Slice 1 was approved)

Tate approved this document and Slice 1 with these decisions. They are recorded, not re-litigated:

- **Timing:** the assumption stands for now: the export reaches disk on `/reload`, logout or exit, and a watcher cannot see a
  mid-session `/wowsync`. It stays **UNVERIFIED**; the experiment in the checklist is an optional follow-up and did not block coding.
- **Deleted characters:** Slice 1 **accepts** that the newest export may reappear after the character was deleted in the
  Dashboard (point 4 of section 4). No tombstone or persisted watermark in this slice; that would be a server change and its own milestone.
- **Token:** **no token for Slice 1**; the watcher is a loopback-only client (it refuses a non-loopback `--url`).
- **Addon citations:** repo-doc evidence is accepted as-is for this slice; nothing about GearExport's source was verified.

## Scope and evidence basis

- This repository never modifies GearExport. This document was written **without reading GearExport's source**: that
  folder was outside this session's read access. Every statement about addon behavior below is therefore either
  (a) what this repository's own documents say the addon does, or (b) general WoW client behavior that this repo relies on
  (the developer bridge exists because of it). Anything not verified is labelled **UNVERIFIED** and has a test in
  [Stop-for-review checklist](#8-smallest-vertical-slice-after-approval-and-stop-for-review-checklist).
- Repo evidence cited: [README.md](../README.md) ("Developer bridge", lines 80-144), [ROADMAP.md](ROADMAP.md) item 8,
  [ARCHITECTURE.md](ARCHITECTURE.md) ("SavedVariables developer bridge"), `packages/server/src/importSaved.ts`,
  `packages/core/src/savedVariables.ts`, `packages/core/src/identity.ts`, `packages/server/src/net.ts`,
  `packages/server/src/app.ts`.
- Not a legal opinion. The design stays inside "read a file the addon wrote, touch nothing in the game", but check
  Blizzard's current add-on/third-party-tool policy before any public release.

## Recommendation in one paragraph

Build a small **foreground watcher CLI** (not a tray app, not a service) that polls one GearExport `SavedVariables` file,
waits for it to be stable, reads it with the existing data-only Lua reader, takes the exact `latestExport.text` of the
newest export, and POSTs it to the existing `POST /api/import`. Everything else (parsing, dedupe, ordering, storage,
shared-storage reconciliation, item metadata) is the server's, unchanged. It delivers the export **when WoW saves
SavedVariables (`/reload`, logout, exit), not at the instant of `/wowsync`**. That latency is inherent (point 2) and the
design accepts it rather than working around it.

---

## 1. When does GearExport.lua hit disk relative to `/wowsync`?

What the repository documents:

- `/wowsync` builds the export and the addon keeps it in memory as `WoWSyncDB.characters[guid].latestExport`
  (`.text`, `.generatedAt`). README line 91: "GearExport keeps the exact text of each character's last `/wowsync` export in its
  SavedVariables file ... under `WoWSyncDB.characters[...].latestExport.text`."
- README lines 91-96: "WoW only writes that file when it saves", so the required flow is `/wowsync`, then
  "**`/reload` or log out**, so the export reaches disk. The command reads what WoW persisted; it cannot make WoW save."
- ROADMAP item 8: "`latestExport` exists after `/wowsync`, but SavedVariables normally reach disk only on logout/reload."
- Consequence already encoded in the bridge: `--list` shows each record's `generatedAt` and `selectExport` errors with
  "run /wowsync ... then /reload or log out so WoW saves it" (`importSaved.ts`, `selectExport`).

So the ordering is: **`/wowsync` (memory only) ... time passes ... `/reload`, logout or client exit (disk)**. The gap is
unbounded: a user can play for hours after `/wowsync`.

UNVERIFIED here (not read from addon source): the exact event(s) on which the addon assigns `latestExport`, and whether
`latestExport` is assigned at export time or only at some later event. The repo docs say "in-memory on export", and the
bridge's `generatedAt` consistency check (`consistencyProblems`) would catch a mismatch between the record and its text.

## 2. Can a file watcher deliver post-`/wowsync` while the user stays logged in without `/reload`?

**Conclusion: no. A watcher cannot, and nothing in the read-only, ToS-safe envelope can make it.**

Evidence:

1. The file only changes when WoW saves it (README line 92-93, ROADMAP item 8). A watcher observes the file; it does not
   observe the addon's memory. Until WoW writes, there is nothing on disk to observe.
2. WoW addons (Lua) cannot write arbitrary files; SavedVariables are serialized by the client itself at its own save
   points. GearExport cannot make the client flush from Lua short of a reload, and forcing a reload is a non-goal
   (point 7). (General WoW behavior; consistent with why the bridge tells the user to `/reload`.)
3. This repo already works around exactly this by making the human do the `/reload`; the bridge is described as unable to
   "make WoW save".
4. The only remaining routes to fresher data are ruled out: reading process memory, simulating `/reload` keystrokes, or
   scraping the clipboard/screen (point 7).

What a watcher **does** deliver: the export at the next natural flush (`/reload`, logout to character select, or exit).
For the stated problem ("I forget to paste"), that is a real improvement: the user runs `/wowsync` as they already do and
the Dashboard learns of it at the next flush with no paste step. It does **not** deliver "instant".

Empirical confirmation (UNVERIFIED until run; ~10 minutes, in the checklist): with the client idle at a character, note
the file's `size` and `mtime`; run `/wowsync`; wait and re-stat (expect **no change**); `/reload` (expect a change and the new
`latestExport.generatedAt`); repeat with logout and with a full client exit. Record the results in this document.

UX consequence (do not overclaim): the companion cannot know a `/wowsync` happened until the flush. Its status line must
say what it actually knows: "SavedVariables last saved by WoW at T; newest export in it generated at G". It must never
imply "no export since G".

## 3. Recommended ToS-safe architecture ("Dashboard just knows")

```
WoW client ──(writes at /reload, logout, exit)──▶ GearExport.lua (SavedVariables)
                                                        │  read-only stat/poll, never a write handle
                                                        ▼
                                          stable-file detector  (size+mtime unchanged for N s)
                                                        │  read the bytes once
                                                        ▼
                     parseSavedVariables(text, {only:["WoWSyncDB"]})   packages/core/src/savedVariables.ts (existing)
                                                        │  data only; truncated / non-data => rejected, nothing sent
                                                        ▼
                     pick newest latestExport by generatedAt  (readSavedExports/selectExport logic, existing)
                                                        │  consistency check (record vs text; parser accepts text)
                                                        ▼
                     exact latestExport.text  ──POST {text}──▶  /api/import   (existing; loopback)
                                                        │
                                                        ▼
        parseWowSyncExport, version routing, identity, SnapshotStore.importSnapshot, idempotence,
        shared-storage reconciliation, item metadata   (all existing, unchanged)
```

Rules:

- **One importer, one database.** The companion has no export parser, no SQLite, no diff logic. It reuses
  `parseSavedVariables`, `readSavedExports`, `describeExport`, `consistencyProblems` and the POST from `importSaved.ts`
  (extract the POST into a shared function; do not copy it). `parseWowSyncExport` is used only to describe and pre-refuse,
  exactly as the bridge does.
- **Read-only.** Only `stat` and `read`. No write, rename, delete, lock, or spawn of anything in the WoW folder; extend
  the existing source-scan test (`importSaved.test.ts`, "READ-ONLY / NO-CODE by construction") to the new file.
- **Exact text.** `latestExport.text` is posted unchanged. Log its SHA-256 and compare with the stored text as the
  bridge already does.
- **Poll, do not rely on `fs.watch`.** One file, cheap `stat` every ~2 s. `fs.watch` on Windows has known
  coalescing/rename quirks (general Node behavior) and adds nothing for a single known path. Watching the directory is
  unnecessary because discovery gives a full file path.
- **Loopback target only.** The bridge only warns on a non-loopback URL; the companion should **refuse** it unless an
  explicit override is given (point 5).
- **Foreground process.** `npm run watch:saved`, logging to stdout. No tray, installer, autostart, or service in this
  milestone; those are packaging decisions for later.
- **No polling of WoW itself.** It does not detect whether WoW is running (no process inspection). The file is the only
  input.

## 4. Failure modes

| Failure | Behavior |
| --- | --- |
| **Truncated SV mid-write** | Two layers. (1) Stable-file detection: act only when `size` and `mtimeMs` are unchanged across two polls at least a quiet window apart (start with 3 s). (2) The reader **fails loudly on any incomplete table, string or file** (`savedVariables.ts`: "Unexpected end of file ... caught while WoW was writing it"), so a half-written file is rejected, never partly read. On rejection: send nothing, log once, and retry on the next change, not in a tight loop. Untested unknown: whether WoW writes in place or via temp+rename. The design must tolerate both, including a transient sharing violation on Windows (retry the read, bounded). A cut exactly between two complete top-level assignments still yields a complete `WoWSyncDB`; its text is intact and the server validates it (`[END]` required), so that case is harmless. |
| **Reader OOM / hostile file** | Existing 256 MiB cap (`MAX_SAVED_VARIABLES_BYTES`), bounded nesting, no evaluation. Server body limit is 10 MB (`express.json({limit:"10mb"})`, `app.ts:70`); an export over that gets a server error and is reported, not retried forever. |
| **Multi-account paths** | Files are `WTF/Account/<account>/SavedVariables/GearExport.lua`. `findSavedVariablesFiles` skips the account-independent `WTF/Account/SavedVariables`. Different accounts have different files, hence different watch targets. Slice 1 keeps the bridge's rule: exactly one resolved file or refuse with the candidate list. Watching several is a later, explicit choice. |
| **Multi-product** (`_retail_`, `_classic_era_`, `_classic_`, `_anniversary_`, `_classic_beta_`) | Same: one file per product per account, and discovery refuses ambiguity. The product **folder name is not authority**: the Dashboard routes by the export's own `Client` / `ClientFamily` (`detectVersion`), so a mislabelled folder cannot mis-route data. Add a warning (not a block) when the folder's product and the export's detected version disagree. `_classic_beta_` is where Forever lives. |
| **Identical re-import** | The server already dedupes (same character, same `Generated`, same text after CRLF/trailing-whitespace normalisation) and reports `isDuplicate` with no change (README "Importing the same export twice is harmless"; ARCHITECTURE "idempotent import"). The companion keeps an **in-memory** last-sent SHA-256 per `(file, record)` to avoid re-POSTing on every unrelated flush. It persists nothing, so a restart re-POSTs once and the server no-ops. No second store. |
| **Every flush rewrites the file** | WoW rewrites the whole file each save even when `latestExport` is unchanged, so an mtime change does **not** mean a new export. Trigger on content: compare the chosen record's `generatedAt` + SHA-256 with what was last sent, not on mtime. |
| **mtime != observation time** | mtime is only a "look now" trigger. Observation time is the export's own `Generated` (and `latestExport.generatedAt`); the Dashboard orders by it (`chronology.ts`) and treats a future `Generated` as observed at import. The companion never stamps, rewrites or infers a time from mtime, and never displays mtime as "synced at". An export flushed hours after `/wowsync` correctly keeps its old `Generated`. |
| **Deleted-in-Dashboard character reappears** | A record for a character the user deleted from the Dashboard stays in SavedVariables until WoW drops it, so importing "everything" would resurrect it (identity is name+realm; delete is not a tombstone). Slice 1 imports **only the single newest export** and only when the SV **changed after the watcher started**; this still resurrects a deleted character if it is the newest, which is why deletion-vs-companion is an explicit review question. |
| **No export in the file** | `latestExport` absent: nothing to send; say so. Never fall back to rebuilding text from the character's tables. |
| **Dashboard not running** | Clear message, no data lost (the file is the source), retry with backoff on the next change or timer, capped. |
| **Two writers** | The server is the only writer of the database. `POST /api/import` is transactional and idempotent, so the manual paste path and the companion can race harmlessly. |

## 5. Security

Baseline today (`net.ts`, README "Network exposure"): no authentication; default bind `127.0.0.1` (`resolveHost`);
on a loopback bind, `hostGuard` rejects any `Host` not in `localhost` / `127.0.0.1` / `::1` (and the bind address), and
rejects a present-but-foreign `Origin` on non-GET/HEAD/OPTIONS requests. No CORS. Documented as "not authentication: any
program running on your machine can still call the API."

- **Loopback bind: keep.** The companion adds **no listener**; it is a pure HTTP client, so it adds no inbound attack
  surface. It must connect to a loopback address and refuse anything else by default (it would be sending a character's
  export off-machine).
- **Host / Origin: already compatible.** A Node `fetch` to `http://127.0.0.1:4173` sends `Host: 127.0.0.1:4173`, allowed.
  It sends **no `Origin`**, which the guard permits (`origin !== undefined` check). So the guard does **not** distinguish the
  companion from any other local program. It only stops browsers. That is fine for the threat it targets (DNS rebinding /
  hostile web pages; a cross-origin browser POST always carries `Origin`, and `express.json` requires
  `Content-Type: application/json`, which a plain cross-site form cannot send).
- **Is a local token needed? Not for slice 1.** Reasoning: the only new capability a token would protect is "import an
  export". A same-user local process can already read the SavedVariables file and the SQLite file, and can call the whole
  existing API, which includes delete and Ask (spending the API key). A token that the companion has to be able to read
  from a file the same user can read adds no protection against that adversary and adds setup friction. Imports are also
  validated (the parser rejects non-exports) and idempotent.
- **When to revisit (any one of these means add a token/secret):** the server is bound beyond loopback; the machine has
  other users who should not be able to write to the Dashboard (a loopback port is reachable by all local users); the
  companion becomes a background service other apps talk to; or the companion accepts inbound connections. Record the
  decision in ROADMAP "Needs Decision" ("Local companion API authentication") after review; this doc does not change it.
- **Hostile SavedVariables:** the reader is data-only (no evaluation), depth-bounded, size-capped. The companion never
  logs full export text or the GUID, and never sends the GUID (the bridge already reads it only to walk the file).
- **Privacy:** outbound traffic is one loopback POST. No new network destination.

## 6. Identity: SavedVariables GUID keys vs export name/realm

- SavedVariables key characters by GUID (`WoWSyncDB.characters[guid]`); the text export carries none. The Dashboard's
  identity is `version::realm::name` lower-cased (`identity.ts`), and the header comment there already reserves a
  GUID as a future, stronger additional field.
- The companion must **not** invent a new identity. It selects an export from the record and sends the text; the server
  derives identity from the text, as for a paste.
- The GUID is useful **only inside the file walk**: to tell two records of the same name+realm apart (a deleted and
  re-created character). Today's `selectExport` resolves that by newest `generatedAt`, with a warning when several exist and
  an error on a tie with different text. Reuse it.
- Consistency check per record (existing `consistencyProblems`): record `identity.name` / `realm` must match the text's
  character, and `latestExport.generatedAt` must equal the text's `Generated`. A record that fails is not sent.
- Known limits (unchanged by the companion; already in ROADMAP "Needs Decision"): a rename or realm transfer is a new
  Dashboard character (GUID is not carried into the export); the GUID never reaches the Dashboard. If a GUID is ever
  threaded through, it must come from the addon's export, not be read out of SavedVariables by the companion.

## 7. Explicit non-goals

- **No reading WoW process memory**, no reading any game process state, no injection, no debugger/hook.
- **No input simulation** (no synthetic keystrokes, mouse, or macro to type `/reload`).
- **No forcing or triggering a reload/logout/save** by any means. The companion may say "WoW has not saved since T"; it
  must not cause a save.
- **Clipboard is not the primary path.** No clipboard monitoring or scraping as the way exports arrive (paste stays a
  manual fallback in the existing UI).
- **No modification of the addon in this milestone**, and no changes to GearExport, BankCleanup, or anything in the WoW
  folder. Addon-side ideas (e.g., a smaller dedicated handoff artifact, an account identifier) are separate future work
  tracked in ROADMAP and are not assumed here.
- No second parser, second database, or copy of import logic. No Electron/tray/installer/autostart in slice 1. No
  Activity History transport (it is expected to be a separate artifact/channel; ROADMAP item 11). No writing to or moving
  files in WoW folders, and no deletion of Dashboard data.

## 8. Smallest vertical slice after approval, and stop-for-review checklist

### Slice (implemented; awaiting review)

As built: `packages/server/src/watchSaved.ts` (pure core: injected filesystem, clock, fetch and output; `tick()` is one
deterministic step), `watchSavedCli.ts` (thin entry), `packages/server/test/watchSaved.test.ts`, the `watch:saved` script, and the POST /
result-report / file-parse pieces extracted from `importSaved.ts` (`postImport`, `describeImportResult`, `parseSavedExports`) so the bridge and the
watcher share one implementation. Run it with `npm run watch:saved -- --wow-dir <one product folder>` (or `--file`); add `--once` for a single
catch-up import. Deviations from the sketch below: a non-loopback URL is refused with **no override flag** (loopback-only, per the token decision);
the "folder product vs export version" warning from section 4 is not implemented yet.

`npm run watch:saved -- --wow-dir <path-to-one-product-folder>` (or `--file`), foreground:

1. Resolve exactly one `GearExport.lua` with the existing `discoverSavedVariables` (same ambiguity refusal, same env
   vars). "Active product" means the one product folder you pointed at; no process detection.
2. Poll `stat` every ~2 s. On `size`/`mtimeMs` change, wait until unchanged for the quiet window (3 s), then read once.
3. `readSavedExports` (data-only). On a `SavedVariablesParseError` or a sharing/IO error: log, retry on the next change.
4. Choose the **newest `latestExport` by `generatedAt`** across the file's records (ties with differing text refuse).
   Run `describeExport` + `consistencyProblems`.
5. If `(generatedAt, sha256)` equals the last one sent in this process, do nothing. Otherwise POST `{text}` to the loopback
   Dashboard via the shared POST function; print the result (imported / already imported / latest / hash match).
6. Ignore the file's state at startup unless `--once` is given (one catch-up import of the newest export, then exit).
   By default only a change observed after start triggers an import, which limits the deleted-character resurrection
   window described in point 4.

Files (proposal): `packages/server/src/watchSaved.ts` (pure core, injected clock/fs/fetch like `importSaved.ts`),
`watchSavedCli.ts` (thin entry), `packages/server/test/watchSaved.test.ts`, one `package.json` script, and a small extraction
of the POST out of `runImportSaved`. No change to `packages/core`, the store, the API or the web app.

Tests to require: stable-file detection with a fake clock (file still changing = no read); truncated file rejected then
accepted after completion; identical content re-flushed = no POST; new `generatedAt` = one POST with the exact bytes;
older export never displaces a newer one; ambiguity refusal; non-loopback URL refused; Dashboard down = retry not crash;
source contains no write/spawn/eval (extend the existing scan); the file and folder are byte- and mtime-identical after a run.

### Stop-for-review checklist (all must be answered before/while coding; stop and ask if any is "no")

- [ ] **Timing measured, not assumed:** *(accepted as an UNVERIFIED assumption for Slice 1; optional follow-up, not blocking.)* The
  `/wowsync` -> `/reload` -> logout -> exit experiment (point 2) is not done. When it is, write the results into this document. If
  the file changes at `/wowsync` without a reload, the conclusion in point 2 is wrong and the design changes.
- [ ] **Write behavior observed:** in-place write vs temp+rename, and whether a read during the write can fail on Windows. *(Still
  open; the watcher tolerates both: stable-file wait, bounded read retry, data-only reader that rejects a partial file.)*
- [x] **Addon citations:** repo-doc evidence accepted as-is for this slice (decision above); not verified against GearExport.
- [x] **Deleted-character policy decided** (point 4): resurrection of the newest exported character is accepted for Slice 1.
- [x] **Token decision recorded** in ROADMAP "Needs Decision": no token for Slice 1, loopback-only client.
- [x] **Scope confirmed:** one file, one product, foreground CLI; multi-account/multi-product watching, tray/installer and
  autostart are explicitly deferred.
- [ ] **No second implementation:** *(for the reviewer)* confirm in the diff that the watcher contains no parser, no SQLite access,
  and no copy of the import POST. A test pins the absence of the parsers, `importSnapshot`, `JSON.stringify` and the POST literals in the watcher source.
- [ ] **Guarantees intact:** *(for the reviewer)* the no-write/no-spawn/no-eval scan covers `watchSaved.ts` and `watchSavedCli.ts`, and a test
  pins that a watch run leaves the file and folder byte- and mtime-identical. A real run against a real WoW folder has not been done.
- [x] **Docs updated together:** README, ARCHITECTURE, ROADMAP item 8 status.
- [ ] **Human review checkpoint before any packaging** (tray, installer, autostart, multiple accounts): this Slice 1 review.
