# WoWSync Roadmap

Last updated: 2026-10-03 (Azeroth ERP Vertical Slice 2 shipped, merged and live-validated; Slice 1
shipped 2026-10-02; Omarchy DEV systemd topology tracked; see [`CURRENT_STATE.md`](CURRENT_STATE.md) for the full
current baseline and [`START_HERE.md`](START_HERE.md) for document routing).
Historical product baseline (2026-09-23; not a description of today's full branch state):
`feature/dashboard-integration` had not yet merged to `main` (then at `797fc3d`)
and included the closed shared-storage reconciliation milestone (C1-C6), item-metadata
consumer, and SavedVariables developer bridge. Validation at that baseline was core
471, server 161, web 150; typechecks clean and production build successful.

This roadmap predates Azeroth ERP Slice 1 in most of its sections below; reconciled entries are
marked as such. For ERP-specific forward-looking material, this roadmap defers to
[`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) rather than
duplicating it — this file lists ERP-adjacent deferred items by name only, with a link.

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
  current. See [ARCHITECTURE_INVARIANTS.md](ARCHITECTURE_INVARIANTS.md) (the durable rules,
  current authority) and [ARCHITECTURE.md](ARCHITECTURE.md) ("Known vs. unknown", "Freshness
  convention") for the narrative version.

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
  foreground watch loop; Slice 1 is implemented and packaging remains deferred). Detail: [README.md](../README.md) ("Developer
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

- [ ] **Azeroth ERP Slice 3+ (not scoped here; do not design in detail in this document).**
  Slices 1 (durable `STOCK_TARGET` demands, deterministic allocation, `get_item_allocation`) and 2
  (account-wide review, `get_allocation_review`) exist — see
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) and
  [`CURRENT_STATE.md`](CURRENT_STATE.md). Demand management is still a direct HTTP call: a
  demand-management UI or an MCP mutation tool for demand CRUD are both absent (see
  `CURRENT_STATE.md`, "Current limitations"; MCP mutation would overturn an enforced invariant), and
  a special Hellomags sale-inventory designation is undesigned. The fuller set of future ERP directions (player-intent/strategy modeling,
  BoE utility, richer reserve policy, exact-item identity, TSM/CraftSim/Journalator integration)
  is deliberately left exploratory — see
  [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) rather than
  committing to any of it here.

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
- [x] Display equipment item level (2026-09-23)
- [x] Version-tab information and default behavior
- [x] Fix the recent-changes cap after realm scoping (2026-09-23)
- [x] Remove the stale LLM placeholder (2026-09-23; Overview has no Account summary / LLM panel)
- [x] De-duplicate the Professions presentation (2026-09-23; coverage on Overview only; Economy is gold + playtime ledger)
- [x] Economy gold-focus + sync strip + character TOC + roster bag slots + freshness glossary (2026-09-23 polish)
- [x] Top-level Professions tab + Overview one-line summary (2026-09-23; coverage-first; Economy stays gold+/played)
- [x] Roster all-column sort (Bank/Bags included) + gold thousands commas in formatCopper (2026-09-23)

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

- [ ] **Reconcile the DEV MCP tunnel unit with its documentation (operational drift, found
  2026-10-03).** The live `wowsync-dev-mcp-tunnel.service` passes the tunnel ID directly on its
  `ExecStart` command line, while the tracked unit and
  [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) describe it as sourced from
  `/etc/wowsync/dev/mcp-tunnel.env`. Undecided: change the live unit or the documentation. Do not
  record the tunnel ID value anywhere in this repository while resolving it.

- [ ] **Classic Beta capture identity routing: `Unknown` / Fizzwick.** The
  SavedVariables record is named `Unknown`, while its embedded export identifies
  Fizzwick. It was intentionally not sent because identity/version routing was
  ambiguous. Define and validate a safe routing rule before retrying; quarantine
  remains correct until then.

---

## Later

- [ ] **WoWSync Windows System-Tray / Taskbar control surface.** Show runtime
  health, queue/recovery and error state; eventually provide an explicit DEV/LIVE
  target switch. Keep DEV and LIVE credentials separate, pin each queued capture
  to the target selected when it was created, and ensure changing capture target
  never silently repoints normal ChatGPT MCP.

- [ ] **Cloud LIVE deployment.** Later deployment milestone for the authoritative
  runtime. Do not stand up Omarchy LIVE merely because the existing isolation and
  runtime infrastructure supports it. Preserve separate approval gates for
  production credentials, authoritative database migration and destination
  changes.

### 9. Dashboard / UX follow-ups

- [x] Retail profession expansion/Midnight planning (2026-09-23; primary by expansion then skill; Missing Midnight gaps)
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

---

## Deferred / Future

Design intent, not implemented. Do not treat anything in this section as current behavior.

- [ ] **Hardcore/SSF version quarantine.** Keep Retail/Midnight, Classic BCC Anniversary, Classic
  Era, Forever, and a future Hardcore/SSF identity distinct; quarantine ambiguous Hardcore/SSF
  version input rather than guessing, the same way `UNKNOWN_VERSION` is quarantined today. This
  was previously (incorrectly) stated in `CURRENT_STATE.md` as current behavior; it is not — no
  commit anywhere in `packages/*/src` has ever added Hardcore/SSF-aware code. This entry records
  the design constraint to apply **whenever** a Hardcore/SSF version is eventually modeled, not a
  statement that modeling it is scheduled. See
  [`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md) (VERSION section) for the invariant
  framing.
- [ ] **Azeroth ERP future concepts** (player-intent/strategy modeling, BoE/gear utility,
  independently-testable reserve policy, exact-item identity, TSM/CraftSim/Journalator
  integration boundaries). All exploratory, none committed. See
  [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) for the full
  reasoning rather than duplicating it here.
- [ ] **Retail Midnight gearing planner.** Folded in from the standalone
  [`CLAUDE_PROMPT_GEARING_PLANNER_FEASIBILITY.md`](CLAUDE_PROMPT_GEARING_PLANNER_FEASIBILITY.md)
  prompt, which had no implementing code behind it: a snapshot-based (not live-remote) planner
  view showing equipped ilvl/slots, item track/rank where directly observable, Mistcrest/currency
  weekly progress, Great Vault progress, campaign/Renown milestones from an explicit maintained
  catalogue, and profession snapshot data, with a rule-based "readiness" explanation (evidence +
  confidence, never a claimed server fact). Explicitly not a generic "what should I do next"
  coach; no execution of any kind. Treat the original document as superseded context for this
  entry, not as a standalone spec — verify its API surface against current Retail client
  signatures before any implementation work begins.

---

### 10. Addon / data follow-ups

Repository-backed deferred ideas (GearExport `README.md`, "deferred"). Keep later unless
dependencies change.

- [ ] **WoW addon performance audit and optimization.** Future measurement-first
  maintenance work for GearExport/WoWSync and, where relevant, BankCleanup. This
  entry does not authorize edits to either separate repository; get Tate's
  explicit authorization before implementation begins. Establish per-client
  baselines (Retail/Midnight, Classic BCC Anniversary, Classic Era, Forever,
  Hardcore/SSF) for normal/combat CPU, memory and allocation pressure, event
  registrations and handler cost, OnUpdate/timers, SavedVariables size and
  serialization, login/reload/logout, export generation, inventory/bank/guild
  scans, item metadata calls/caching, and idle work. Rank measured hotspots by
  gameplay impact; optimize only where evidence shows a meaningful gain, then
  re-measure while preserving correctness and export semantics. Pay particular
  attention to high-frequency events and defer, cache, or coalesce work when
  appropriate. If measured overhead is already negligible, document the result
  and stop without speculative rewrites. Keep this deferred future maintenance;
  the infrastructure closeout does not start it.

- [ ] **Omarchy → Windows addon deployment workflow.** Package and stage explicit
  addon revisions from Omarchy, deploy each revision to the correct WoW product,
  and report the deployed revision. Tate retains control of `/reload` and all
  live-game validation. GearExport and BankCleanup are separate repositories;
  this roadmap item does not authorize modifying either repository.

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
| Local companion API authentication | Desktop companion | **Decided for local Slice 1: no token; loopback-only client.** Authenticated transport mode uses a separate capture-only listener and target token; it does not enable access to other API routes. Widening the general Dashboard API remains a separate security decision ([feasibility doc](DESKTOP_COMPANION_FEASIBILITY.md), section 5) |
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
- **Azeroth ERP Vertical Slice 2 — Account Allocation Review: shipped, merged to `main`
  (`77f9c95`), and live-validated (2026-10-03).** `DashboardReadModel.getAllocationReview` and the
  read-only `get_allocation_review` MCP tool: every active demand's allocation result (identical to
  `get_item_allocation`) plus account-owned `unallocated` holdings, which are never surplus and carry no
  disposition. One shared evidence projection for both slices; unreported item quantities are no
  longer summed as 0 (unresolved item-quantity evidence in observed storage; a counted floor marker in
  LAST_SEEN storage). No new durable state. Live-proven through real WoW evidence -> DEV SQLite ->
  explicit demand -> `DashboardReadModel` -> read-only MCP -> Secure MCP Tunnel -> ChatGPT; the
  temporary validation demand was deactivated afterward. See
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) §23 and its Slice 2 live-validation
  record.
- **Azeroth ERP Vertical Slice 1: shipped and live-validated (2026-10-02).** Durable
  `STOCK_TARGET` demands, deterministic allocation reasoning (capability != demand, missing
  demand != demand zero, confirmed/potential/unresolved evidence tiers, guild isolation, the
  conservative UNKNOWN disposition gate), and the `get_item_allocation` MCP tool (the newest
  registered tool as of this entry; see [`CURRENT_STATE.md`](CURRENT_STATE.md) for the current
  total). All six required acceptance scenarios proven twice each (unit +
  read-model/end-to-end). Real-data live validation through the full chain — WoW evidence ->
  SQLite -> explicit demand -> ERP allocation -> `DashboardReadModel` -> read-only MCP -> Secure
  MCP Tunnel -> ChatGPT — succeeded; the temporary validation demand was deactivated afterward.
  See [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) for the full semantics and the
  live-validation record. Also shipped: the Omarchy DEV systemd topology
  (`wowsync-dev.target`, `wowsync-dev-dashboard.service`, `wowsync-dev-mcp-tunnel.service`,
  `wowsync-dev-herdr.service`) is now tracked in the repository under `ops/systemd/`, with
  `tools/omarchy/install-wowsync-dev.sh` able to reconstruct those definitions and the dashboard's
  running path on a fresh host (given the documented host-only prerequisites); enabling/starting
  the mcp-tunnel and herdr services remains a separate manual operator step the script
  deliberately does not perform. See
  [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md). Not yet built: a demand-management UI and any
  MCP mutation tool — `demandRoutes.ts` has no caller today.
- **Windows/Omarchy DEV runtime infrastructure accepted and closed (2026-09-30).**
  Hidden Windows sign-in startup, DEV capture and Dashboard access, durable queue
  acknowledgement, credential-free status, and external ChatGPT access through
  the existing 11-tool read-only MCP contract passed. No infrastructure blocker
  remains. The setup/acceptance record is [WINDOWS_CAPTURE_SETUP.md](WINDOWS_CAPTURE_SETUP.md).
- **Phase 6 external read integration: complete and live-validated (2026-09-28).** The provider-neutral read model, strict SQLite read-only store, registered research retrieval, and dedicated MCP server are implemented. The personal ChatGPT MCP App was connected through Secure MCP Tunnel and invoked successfully. See [MCP development, operations, and acceptance](MCP_DEVELOPMENT.md), [read/research retrieval architecture](READ_RETRIEVAL_ARCHITECTURE.md), and [architecture](ARCHITECTURE.md). This does not implement Renown capture, arbitrary account queries, MCP mutation, or public Dashboard access. No Phase 7 work is started or implied.
- Retail Midnight profession planning: plumb `expansion`, rank expansions, Covered = Midnight holders only, Gaps add Missing Midnight (olderOnly); primary by expansion then skill; Overview Midnight gap counts; 2026-09-23 on `feature/dashboard-integration`
- Top-level Professions tab (coverage table + gaps; Overview one-line summary navigates there); roster all-column sort; gold thousands commas via formatCopper; 2026-09-23 on `feature/dashboard-integration`
- Professions tab UX rebuild: gaps-first (none then unknown), Crafting vs Gathering split, covered rows show one derived primary (+N more expand); `professionPlanningKind` + `selectPrimaryProfessionCharacter` in core; 2026-09-23 on `feature/dashboard-integration`
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
- Integration branch `feature/dashboard-integration` includes the Dashboard
  trust hardening, shared storage, item metadata, provider-neutral read model,
  strict read-only MCP, and Phase 6 live ChatGPT/Tunnel validation. It remains
  a feature branch and has not been merged to `main`.
