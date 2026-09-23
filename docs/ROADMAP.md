# WoWSync Roadmap

Last updated: 2026-09-21 (milestones refreshed 2026-09-22 ET). Dashboard baseline: branch `feature/dashboard-integration` (not
merged to `main`, which is at `797fc3d`), including the closed shared-storage reconciliation
milestone (C1-C6), the item-metadata consumer (parser, store, API, Shared Storage / inventory
presentation) and the SavedVariables developer bridge. Tests at that baseline: core 471, server 161, web 150; typechecks clean;
production build succeeds.

## How to use this roadmap

- This is the **canonical high-level TODO for the whole WoWSync project**: the GearExport
  addon, the Dashboard, and the work that connects them. It is the one place to look for
  "what is happening, what is next, and what is undecided".
- It is an index, not a design. Detailed design lives in the documents linked from each
  item. Do not copy their content here; link to it.
- Update it when a checkpoint lands: tick the box, move the item, and add a line to
  [Recently Completed](#recently-completed) if it should not be re-added by accident.
- Do **not** treat historical documents as the current TODO. In particular,
  [DASHBOARD_PRODUCT_REVIEW.md](DASHBOARD_PRODUCT_REVIEW.md) is a point-in-time review
  (basis `797fc3d`, 2026-09-19), and unchecked boxes in the addon's older acceptance
  documents may predate newer live evidence.
- Ordering inside a section is the intended order. Sections run from most to least
  imminent. Nothing here implies a date.
- **Trust model applies to everything below.** Data is OBSERVED, UNKNOWN, DERIVED, or
  LAST_SEEN. UNKNOWN is never turned into zero/empty, and LAST_SEEN is never shown as
  current. See [ARCHITECTURE.md](ARCHITECTURE.md) ("Known vs. unknown", "Freshness convention").

Where a link points at another repository, the path is given relative to that repository:

- **GearExport** = the addon repo (`D:\dev\wow-addons\GearExport`). This repository never
  modifies it; work items on the addon side are tracked here but done there.
- **Product review** = [DASHBOARD_PRODUCT_REVIEW.md](DASHBOARD_PRODUCT_REVIEW.md).
- **Architecture** = [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Active

Work happening now.

- [x] **Forever completion pass (GearExport): complete.** GearExport branch
  `feature/retail-bank-support-implementation`, commit
  `791cb9d33d9b979441550858a6708c61a4d4dcdd` (`feat: complete live-validated Forever support`).
  - Live validation passed for **Character Bank**, **Trainers** and **Professions**.
  - Professions trust fix: values now come from `GetProfessions()` / `GetProfessionInfo()`
    instead of unhydrated `C_TradeSkillUI` skill values. After a fresh `/reload`, before
    opening any trade-skill window, Cooking 5/75, Engineering 20/75 and Mining 23/75 are
    reported correctly.
  - Bounded limitations, intentionally kept: the build guard is limited to Forever 1.60.1
    build 69913; only live-proven effective-stat keys are normalized; trainer rank and spell
    ID are unavailable from the validated tuple; Character Bank only (no Forever Warband or
    Guild Bank; none is planned); defensive UNKNOWN/LAST_SEEN handling remains for
    malformed or unavailable profession tuples.
  - What remains is release acceptance: see [Validation & Release Gates](#validation--release-gates) (item 14).
  - Detail: GearExport `FOREVER_PHASE1.md`, `FOREVER_PHASE2.md`, `FOREVER_BAGS.md`,
    `FOREVER_PROFESSIONS.md`, `FOREVER_REMAINING.md`, `FOREVER_SPELLS.md`,
    `FOREVER_STATS_DIAGNOSTIC.md`. Dashboard side: [ARCHITECTURE.md](ARCHITECTURE.md) ("Forever").

- [x] **Developer bridge: import a saved export from SavedVariables (done; separate from the Desktop companion).**
  `npm run import:saved -- --character <name>` reads GearExport's persisted `latestExport.text` from the WoW SavedVariables
  file as data (never executing it, never writing to WoW) and sends the exact text through the existing `POST /api/import`;
  `--list` and `--dry-run` contact nothing. It replaced the scratch extraction used to validate item metadata. It is a
  command run by hand: it does **not** watch files, react to `/wowsync`, force a `/reload`, run in the background or start the
  server, so it is **not** the Desktop companion (item 8 below; its Slice 1, `npm run watch:saved`, is the same bridge run by a
  foreground watch loop and is awaiting review). Detail: [README.md](../README.md) ("Developer
  bridge"), [ARCHITECTURE.md](ARCHITECTURE.md) ("SavedVariables developer bridge").

- [x] **Richer item metadata / expansion awareness: producer and Dashboard consumer done and validated
  against a real export.** The addon (GearExport `a94288e`, `feat: add additive item metadata
  export`) exports `[ITEM METADATA]`; the Dashboard parses it, keeps it in its own game-version-scoped
  store, serves it over `GET /api/versions/:version/item-metadata`, and shows expansion and crafting-reagent
  info on inventory lists and the Shared Storage table. Design: [ARCHITECTURE.md](ARCHITECTURE.md) ("Item metadata").
  - **Design decision (investigation, 2026-09-21):** the Blizzard Game Data API item document has no
    expansion field (per typed clients; the official reference could not be read), and the in-game
    `GetItemInfo` has one but was reported unreliable for some items - so the client's raw value is exported
    as evidence and the Dashboard, not the addon, derives labels. This replaced the earlier assumption
    "prefer Blizzard API metadata over a hand-maintained item database" for expansion.
  - Verified in the live Retail client: Mote of Harmony 4, Progenitor Essentia 8, Elemental Mote 9, Bismuth 10,
    Mote of Light 11. Only these values are mapped (Retail only); every other number, including 0 and 254,
    renders as "Expansion unknown (client value N)".
  - Regression pinned: *Mote of Light* (base id 236949) is a known crafting reagent from the Midnight expansion
    wherever it appears (character bags, Warband, Guild Bank), from the client's own data, never from its name
    or id.
  - **Real-export validation (2026-09-21):** a fresh Virek export from the installed `a94288e` addon
    (build 69875, 200 metadata rows: 109 with every facet known, 91 with every facet `?`) was read from
    SavedVariables `latestExport.text` and imported into the real database through `POST /api/import`. Every
    row reached the API intact (545 known facets, 0 mismatches); Mote of Light's row `7 11 0 11 yes` resolves to
    Midnight · Reagent; the Warband observation (hash, time, 98 items, 98/98 slots) was unchanged and gained one
    carrying export; no excluded consumer changed.
  - **What that export taught us:** the client's expansion number is its own tag, not an introduction date
    (the 2004 items Snowball and Winter Veil Cookie report 11, Midnight; several old food and drink items report
    0). The UI says so, and any future obsolescence logic must not read the tag as an item's age. Items the
    client had not cached (91 rows, including Warband items replayed as last seen) stay `?`.
  - Still open (see [Needs Decision](#needs-decision) and [Later](#later)): the remaining expansion numbers
    (that export also reported 3, 6 and 7, which are not yet verified against a known item); a resolution policy
    for conflicting client values; Blizzard-API enrichment; and every consumer that is deliberately excluded
    (totals, global item search, recent-change diffs, AccountContext, the LLM context).
  - Goal, unchanged: make *"What should I keep, vendor, mail to my banker, or move to shared storage?"*
    answerable. No recommendation policy exists yet; do not claim inventory intelligence from item data alone.

---

## Next

Work intended next, in this order.

- [ ] **GearExport: keep `latestExport` fresh in memory while playing (remove manual `/wowsync`).**
  **Repo:** GearExport only (this Dashboard repo must not modify the addon). Pairs with Slice 1
  `watch:saved` so the player's biggest friction — remembering to run a report — goes away.
  - On relevant OBSERVED changes (bags/bank/money/equipment/zone/level, or a quiet throttle), rebuild
    `WoWSyncDB.characters[guid].latestExport` in memory the same way `/wowsync` does today.
  - Disk flush stays **WoW-owned**: `/reload`, logout, or exit. No forced reload, no off-box network
    from the addon, no writing outside SavedVariables.
  - Player loop becomes: play normally → natural `/reload` or end-of-session logout → watcher imports.
  - Keep an explicit `/wowsync` (or equivalent) for "force refresh now" and for clients where auto-refresh
    is off or still landing.
  - Do-not-do: mid-session Dashboard push, process memory, input simulation, clipboard as primary path.
  - Acceptance: after bag/bank changes without typing `/wowsync`, a `/reload` (or logout) with
    `watch:saved` running produces a new Dashboard snapshot whose `generatedAt` matches the post-change export.

- [ ] **Account / multi-character context.**
  Existing addon schema direction (GearExport `WOWSYNC_SCHEMA.md`, account/alt export
  section):
  - Normal `/wowsync`: full current-character snapshot **plus a compact known-alt/account
    summary with freshness**.
  - Later, explicit full-account export: complete cross-character bags/banks/economy.
  - Keep account-level and character-level state separate. The normal public LLM workflow
    must not require an enormous full-account export.
  - Shared storage is already owner-level state (never per character); keep it that way here.
  - Whether/when the explicit full-account export ships is undecided (see
    [Needs Decision](#needs-decision)).

---

## Dashboard Product

Continue the product review. Source of detail:
[DASHBOARD_PRODUCT_REVIEW.md](DASHBOARD_PRODUCT_REVIEW.md) (see "High-Value Improvements",
"Information Architecture Recommendation", "Implementation Roadmap"). Do not duplicate it here.
Re-verify each item against the current branch before starting: the review's "current"
statements describe `797fc3d`, and the first trust wave has since landed.

### 6. Continue the product review

- [ ] URL routing, deep links, and browser Back behavior (gates most of the rest)
- [ ] Roster table with sort / filter / search
- [ ] Global item search
- [ ] Deterministic **Needs Attention** digest
- [ ] Freshness cleanup / age bands
- [x] Character-page old-snapshot banner (2026-09-23)
- [x] Per-section observed/freshness display (2026-09-23)
- [ ] Display equipment item level
- [ ] Version-tab information and default behavior
- [ ] Fix the recent-changes cap after realm scoping
- [ ] Remove the stale LLM placeholder
- [ ] De-duplicate the Professions presentation

### 7. Ask My Account / deterministic context

Current LLM context is intentionally compact but omits useful information: inventory,
equipment, location, trainers, spells, profession coverage, playtime totals,
`lastObservedAt`, section freshness, Warband data, Guild data.

- [ ] Continue **deterministic** fact/context construction. Do not dump the full export into
  the model.
- [ ] Suggested-question chips, and data-age / scope communication.
- [ ] Keep Ask **stateless** for now.
- [ ] Coordinate shared storage and item metadata *before* claiming inventory intelligence.
- Detail: [ARCHITECTURE.md](ARCHITECTURE.md) ("LLM boundary — Ask My Account"); product
  review "Ask My Account Product Design". Provider choice is separate (see
  [Needs Decision](#needs-decision)).

---

## Soon

- [ ] **8. Desktop companion / automatic ingestion.** (The manual [developer bridge](#active) exists; this item is the automatic,
  user-facing product and is not started.) A real product need: the user
  sometimes forgets to paste `/wowsync` output into the Dashboard. Goal: reduce or
  eliminate that manual handoff.
  - **Status: Slice 1 shipped** (`ad5fc79` on `feature/dashboard-integration`; live-validated: `/wowsync` → `/reload` → auto-import).
    `npm run watch:saved -- --wow-dir <one product folder>` (`--once` for a single catch-up import) polls one GearExport SavedVariables
    file and POSTs the newest `latestExport.text` through existing `POST /api/import` (loopback only; read-only; no second parser/DB).
    Delivery is still at the next WoW save (`/reload`, logout, exit). **Next dependency for "no manual report":** GearExport in-memory
    auto-refresh (see [Next](#next)). Still open on the companion itself: tray/installer/autostart, multi-file/multi-account watching,
    deleted-character tombstone. See [DESKTOP_COMPANION_FEASIBILITY.md](DESKTOP_COMPANION_FEASIBILITY.md).
  - **Began with a design/feasibility checkpoint (approved); Slice 1 was built from it. Packaging (tray, installer, autostart) needs its own review first.**
  - Reuse, do not duplicate: `POST /api/import`, idempotent imports, observation-time
    ordering, transactional persistence, `parseWowSyncExport`,
    `SnapshotStore.importSnapshot`, `ImportResult` semantics. The companion must not
    contain a second parser or database.
  - Addon-side schema already anticipates a read-only SavedVariables companion with a
    deterministic trigger engine, optional LLM layer, and notifications (GearExport
    `WOWSYNC_SCHEMA.md`, "Read-only external companion").
  - Open feasibility questions to answer first:
    - `WoWSyncDB.characters[guid].latestExport` exists after `/wowsync`, but SavedVariables
      normally reach disk only on logout/reload. A plain file watcher may **not** deliver
      the immediate post-`/wowsync` handoff while the user stays logged in. Find the best
      WoW-compliant handoff.
    - SavedVariables must be parsed as restricted data, never executed as Lua; incomplete
      writes must be rejected; the companion must never trigger a reload.
    - File modification time is **not** observation time.
    - The Dashboard API has no auth/token and relies on loopback binding plus a
      Host/Origin guard.
    - SavedVariables keys characters by GUID; the text export carries none.
    - Activity History is expected to use a separate transport artifact/channel.
  - Existing note: [README.md](../README.md) → "Future automatic snapshot ingestion".

---

## Later

### 9. Dashboard / UX follow-ups

- [ ] Retail profession tier
- [ ] Full bag/bank table
- [ ] Multi-export import
- [ ] Raw snapshot/export backup and download
- [ ] Accessibility
- [ ] Responsive/mobile improvements
- [ ] Facts cache, when scale justifies it
- [ ] Per-question LLM routing, when scale/context size justifies it
- [ ] **Item-metadata follow-ups (deferred on purpose):**
  - use metadata in AccountFacts totals, global item search, recent-change diffs, AccountContext and the LLM
    context (each is its own milestone; nothing consumes it today, and tests pin that)
  - map further expansion numbers (0-3, 5-7, 12+) only as each is verified from a real client value
  - Blizzard Game Data API enrichment (names, icons, class/subclass names): a separate, asynchronous, opt-in
    source that would be recorded as its own `source` and never mixed into the game-client evidence; needs
    Blizzard API credentials, which the repository must never contain
  - a policy for a conflicting client value across builds (today it is shown as unknown, never resolved)
- [ ] **Shared-storage follow-ups (deferred on purpose after the reconciliation milestone):**
  - shared-storage consumers: account totals, global item search, recent-change diffs, AccountContext and
    the LLM context (each must count an owner once, however many characters carried it, and label shared
    totals as asynchronous observations; depends on richer item metadata for useful item questions)
  - surface `ImportResult.sharedStorage` in the import dialog
  - a guild with only informationless observations keeps a display name but exposes no tab detail; richer
    detail could be added to the API/UI if it proves useful
  - a "delete all Dashboard data" operation does not exist; if added it must clear the shared journal and the
    per-owner cutoff state (`shared_owner_clears`) together

Triggers for the scale-dependent items are in the product review, "Later — with explicit
triggers".

### 10. Addon / data follow-ups

Repository-backed deferred ideas (GearExport `README.md`, "deferred"). Keep later unless
dependencies change.

- [ ] TSM price enrichment
- [ ] Mailbox / Auction House capture
- [ ] Recipe catalogues
- [ ] Pet spellbook capture
- [ ] Per-tab Guild Bank item rows (addon): current item rows are aggregated and carry no tab attribution, so
  there is no safe per-tab item reconciliation or merge until the export preserves it
- [ ] Optional currency / account-balance views where appropriate

---

## Post-release / Major subsystems

- [ ] **11. Activity History.** Architecture is designed; **Dashboard implementation is
  zero.** Not a blocker for the core product.
  - Principle: snapshots answer *what is true*; activity answers *what happened*.
    Normalized append-only OBSERVED event journal → explicit session records →
    deterministic DERIVED projections.
  - Do not infer gameplay causes from snapshot changes. Snapshot diffs remain DERIVED
    state transitions, never evidence of activity.
  - Expected work: addon activity transport; SavedVariables activity queue/artifact;
    Dashboard migration runner; activity tables; idempotent importer; range queries;
    sessions; projections; UI; deletion semantics; runtime/live experiments.
  - Design: GearExport branch `feature/activity-history-architecture`,
    `docs/ACTIVITY_HISTORY_ARCHITECTURE.md` (commit `056b4ca`). Dashboard-side
    integration notes: product review, "Activity History Integration".

---

## Validation & Release Gates

These are gates, not product features. Reconcile stale wording instead of blindly
repeating old unchecked boxes.

- [ ] **12. Classic Era live regression.** Outstanding per the addon's acceptance doc:
  in-game smoke test (login, bags, bank, equipment, trainer, professions, multiple
  characters, SYNC, deterministic output) and the final live-build/package regression.
  Detail: GearExport `WOWSYNC_ACCEPTANCE.md`.
- [ ] **13. Retail acceptance.** Character/Warband/Guild Bank now have substantially newer
  live evidence than some old documents reflect. Remaining broader matrix: equipment,
  delayed data, bags, trainers, professions, spells, character separation, UI/error
  checks. Reconcile the stale wording in `WOWSYNC_ACCEPTANCE.md` and `RETAIL_TEST_PLAN.md`
  (including the icon item, which is now integrated) rather than repeating it.
- [ ] **14. Forever acceptance.** The live Character Bank / Trainers / Professions validation
  has passed (GearExport `791cb9d`). Remaining: confirm the Forever documents are
  reconciled, full package validation, release acceptance.
- [ ] **15. Public release acceptance.** Explicitly deferred until sufficient live evidence
  and final fixes.
---

## Needs Decision

Architectural questions. This document does not decide them: record a decision here (and
where it is written up) when it is made; open parts stay listed.

| Question | Blocks | Notes |
| --- | --- | --- |
| Stable Warband account discriminator | Multi-account Warband | The shared-storage model is decided and implemented (journal + read-time projection, installation-local account scope; [ARCHITECTURE.md](ARCHITECTURE.md)). **Open (needs the addon):** a stable account identifier; until then two Battle.net accounts imported into one Dashboard are reconciled as one Warband |
| Guild uniqueness: region / discriminator, and real `GuildClubID` form | Multi-region guilds | Guilds are keyed by the opaque `GuildClubID` text (implemented; never parsed). **Open (addon):** whether the id alone is unique across regions. The addon and Dashboard both treat it as opaque text; one live value has been seen in GearExport validation (Ciao, 84606081) and no broader guarantee is inferred from it |
| Deletion semantics for shared observations | — (decided) | **Decided and implemented:** deleting a character or snapshot never deletes shared observations; an explicit per-owner clear removes that owner's observations and provenance, is not a tombstone (a new export may recreate the owner) and cannot be undone by backfill from already-stored snapshots; typed confirmation plus "Clears stored shared-storage history. A later WoWSync export may add it again." |
| Character identity / GUID strategy, especially rename/transfer | Identity, companion, Activity History | Identity is `version::realm::name`; the text export carries no GUID while SavedVariables is GUID-keyed |
| Desktop companion transport / handoff | Desktop companion | **Decided for Slice 1:** poll the SavedVariables file and POST the newest `latestExport.text`; delivery is at the next WoW save (`/reload`, logout, exit), not at `/wowsync`. The flush timing is an accepted assumption, still **UNVERIFIED** (optional experiment in the feasibility checklist). Open: a dedicated handoff artifact (addon side) |
| Local companion API authentication | Desktop companion | **Decided for Slice 1: no token; loopback-only client** (the watcher refuses a non-loopback `--url`). Revisit if the server binds beyond loopback, other local users matter, or the companion becomes a background service or accepts inbound connections ([feasibility doc](DESKTOP_COMPANION_FEASIBILITY.md), section 5) |
| Deleted-in-Dashboard character vs the companion | Desktop companion | **Accepted for Slice 1:** the newest export can reappear after a Dashboard delete (delete is not a tombstone; the watcher sends only the single newest export, and only after a change seen since it started, or with `--once`). Needs a persisted watermark or a server-side tombstone (its own milestone) before the companion runs unattended |
| Activity History transport path | Activity History | Expected to be separate from the snapshot export |
| When/if the explicit full-account export ships | Account context | Normal `/wowsync` stays current-character plus compact summary |
| LLM provider | Ask My Account | Project is paused at this decision (provider-agnostic work continues) |

Related detail: [ARCHITECTURE.md](ARCHITECTURE.md) ("Shared storage", "Deleting a character");
product review "Activity History Integration" item 6 (identity).

---

## Recently Completed

Guard against re-adding. This is not a changelog.

**Addon (GearExport)**
- Retail Character Bank support
- Retail Warband Bank capture
- Trusted Retail Guild Bank capture
- Activity History architecture/design (design only; see [Post-release](#post-release--major-subsystems))
- README suggested LLM/ChatGPT prompt set
- WoWSync icon integration (TOC `IconTexture` on all builds)
- Forever completion pass: live-validated Character Bank, Trainers, Professions, equipment,
  bags, playtime, known spells and effective-stat work (GearExport
  `feature/retail-bank-support-implementation` @ `791cb9d`); only release acceptance remains
  (item 14)

**Dashboard**
- Trust hardening: unknown is not zero, freshness-aware totals, observation-time ordering
  and latest-snapshot semantics, idempotent re-import, per-realm LLM gold, classified API
  errors, localhost binding by default with Host/Origin guard
- Warband parsing; Guild Bank parser compatibility (later superseded by the Shared Storage view below). Current
  Retail exports, which always contain `[GUILD BANK]`, import successfully
- Product review document
- **Shared-storage reconciliation: milestone closed.** Warband and Guild Bank state is owned by the Warband /
  the guild (never by the carrying character), reconciled from an immutable observation journal with
  provenance, projected on read, persisted transactionally with an idempotent backfill, explicitly clearable per
  owner, exposed over HTTP, and shown in an account-level Shared Storage view. Design:
  [ARCHITECTURE.md](ARCHITECTURE.md) ("Shared storage").
  - Chain: **C1** `90ff3c1` pure domain module; **C2** `3f13975` persisted journal, import integration and
    backfill; **C3** `fa06d4d` explicit owner deletion with a backfill cutoff; **C4** `b658e17` HTTP read/delete
    API; **C5** `ca1baa2` owner-level UI; **C6** closeout (`docs: close shared-storage reconciliation milestone`):
    final trust-model audit, cross-layer end-to-end tests, documentation reconciled.
  - **Real-data validation** (the real Dashboard database; 40 snapshots and 15 characters preserved): one Warband
    observation (complete, observed 1789965174, `LAST_SEEN`) carried by two Virek/Cairne exports, 98 item rows,
    98 of 98 slots occupied; no Guild owner; nothing leaked into AccountFacts, AccountContext, the LLM context or
    character pages; the real Warband was never deleted.
  - **Guild Bank evidence is separate:** GearExport's Guild Bank capture was live-validated earlier (Ciao), but the
    Dashboard's real database holds **no** real Guild shared observation. Guild behavior is covered by rendered
    fixtures and tests (restricted, partial, conflicting and locked guilds; opaque ids above 2^53).
  - Still open, recorded above: stable Warband account discriminator and guild region question ([Needs
    Decision](#needs-decision)); per-tab Guild item rows (addon); shared-storage consumers, import-dialog
    surfacing, informationless-guild detail and delete-all-data ([Later](#later)).
- Integration branch `feature/dashboard-integration` (`0f525a7`): main + trust hardening +
  Warband + Guild Bank + product review. Not yet merged to `main`.

