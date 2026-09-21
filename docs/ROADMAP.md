# WoWSync Roadmap

Last updated: 2026-09-21. Dashboard baseline: branch `feature/dashboard-integration` (not
merged to `main`, which is at `797fc3d`), including shared-storage checkpoints C1 (`90ff3c1`),
C2 (persistence and import integration), C3 (explicit owner deletion) and C4 (HTTP API). Tests at
that baseline: core 413, server 118, web 84; typechecks clean; production build succeeds.

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

- [ ] **Shared-storage reconciliation** (in progress: C1-C4 done, C5-C6 remaining).
  Warband and Guild storage belong to an owner, not to the character whose export carried
  them. Approved design: an immutable journal of observations plus provenance, a
  deterministic read-time projection per owner (Warband = installation-local account scope;
  guild = opaque `GuildClubID` text), OBSERVED/UNKNOWN/DERIVED/LAST_SEEN preserved.
  Detail: [ARCHITECTURE.md](ARCHITECTURE.md) → "Shared storage (Warband + Guild Bank): reconciled journal".
  - [x] **C1** pure domain module and tests: `90ff3c11167707c284ee71940e9265bed139799f`
    (`feat: add pure shared-storage reconciliation domain module`).
  - [x] **C2** persisted journal, transactional import integration, idempotent backfill of
    existing databases, content-hash version persisted, store read seam
    (`loadSharedJournal` / `projectSharedStorage`), additive `ImportResult.sharedStorage`
    (`3f139751e3ef46d7e899b5be6f2942be49e2c1c2`, `feat: persist reconciled shared storage`).
    Character deletion leaves shared observations and their provenance labels intact.
  - [x] **C3** explicit owner-scoped deletion **foundation** (store/domain only at that checkpoint:
    `deleteSharedStorageOwner`): deletes one owner's whole journal
    history atomically (`feat: add explicit shared-storage deletion`). Character deletion still
    keeps shared history; a per-owner cutoff stops backfill from resurrecting deleted history
    from already-stored snapshots, while newly imported exports recreate the owner normally.
  - [x] **C4** HTTP API (`feat: expose reconciled shared storage API`): `GET /api/shared-storage` (the
    DERIVED projection: stable empty shape, bounded deterministic provenance, no database ids, a distinct
    `SHARED_STORAGE_INTEGRITY` error that names damaged owners); explicit owner-delete routes
    (`DELETE /api/shared-storage/warband`, `/guilds/:guildClubId`) with JSON confirmation, 404
    `SHARED_OWNER_NOT_FOUND`, opaque guild-id validation; typed web client seam (no UI). The existing security
    baseline is unchanged. **Controlled real-database validation passed** (2026-09-21): the first restart on this
    code backfilled the real 40-snapshot database to 1 Warband observation with 2 Virek sources (98 items,
    effective time 1789965174, LAST_SEEN preserved, no guild), through the actual API, with every AccountFacts /
    AccountContext / LLM / character-page output unchanged. Backup taken first
    (`data/wowsync.backup-20260921T133844Z.sqlite`).
  - [ ] **C5** presentation: owner-level Warband/Guild views, freshness and provenance,
    navigation; user-facing deletion controls and confirmation wording ("Clears stored shared-storage
    history. A later WoWSync export may add it again."); retitle the transitional character-page cards.
  - [ ] **C6** final documentation and roadmap update.
  - **Still deliberately excluded** from totals, item search, diffs, AccountContext and LLM
    context; each is a later consumer (see Dashboard Product / Ask My Account). Shared totals
    must count each owner once and be labelled as asynchronous observations.
  - **Deferred / open:** a "delete all Dashboard data" operation does not exist (it would have to
    purge the journal too); per-tab Guild Bank merging (needs per-tab item rows from the addon);
    a stable Warband account discriminator (addon); whether club IDs need a region to be
    unique; the textual form of a real `GuildClubID` (no live guild observation exists yet).

---

## Next

Work intended next, in this order.

- [ ] **Richer item metadata / expansion awareness (addon export → Dashboard).**
  Current inventory exports lack the information needed for reliable expansion/category
  reasoning. Real regression: the Midnight reagent *Mote of Light* was interpreted as
  legacy clutter.
  - Investigate Blizzard-provided fields: `expansionID`, `classID`, `subclassID`,
    `bindType`, `isCraftingReagent`, and any other cheap, stable metadata.
  - Prefer Blizzard APIs over a hand-maintained item database; preserve raw IDs; put
    human-readable expansion/category names in the presentation/context layer, not in
    collection.
  - Metadata that is not yet cached is UNKNOWN. Never guess or default it.
  - Weigh export size. Apply consistently to bags, reagent bags, Character Bank, Warband
    Bank, and Guild Bank where appropriate.
  - Add a regression around *Mote of Light*.
  - Goal: make this question answerable: *"What should I keep, vendor, mail to my banker,
    or move to shared storage?"*
  - Coordinate with shared-storage reconciliation and with
    [Ask My Account](#7-ask-my-account--deterministic-context): do not claim inventory
    intelligence before both exist.

- [ ] **Account / multi-character context.**
  Existing addon schema direction (GearExport `WOWSYNC_SCHEMA.md`, account/alt export
  section):
  - Normal `/wowsync`: full current-character snapshot **plus a compact known-alt/account
    summary with freshness**.
  - Later, explicit full-account export: complete cross-character bags/banks/economy.
  - Keep account-level and character-level state separate. The normal public LLM workflow
    must not require an enormous full-account export.
  - Coordinate with shared-storage reconciliation.
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
- [ ] Character-page old-snapshot banner
- [ ] Per-section observed/freshness display
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

- [ ] **8. Desktop companion / automatic ingestion.** A real product need: the user
  sometimes forgets to paste `/wowsync` output into the Dashboard. Goal: reduce or
  eliminate that manual handoff.
  - **Begins with a design/feasibility checkpoint. No implementation before it.**
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

Triggers for the scale-dependent items are in the product review, "Later — with explicit
triggers".

### 10. Addon / data follow-ups

Repository-backed deferred ideas (GearExport `README.md`, "deferred"). Keep later unless
dependencies change.

- [ ] TSM price enrichment
- [ ] Mailbox / Auction House capture
- [ ] Recipe catalogues
- [ ] Pet spellbook capture
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
| Final Warband persistence / reconciliation model | Shared-storage reconciliation | **Decided and implemented (C1-C2):** journal + read-time projection, installation-local account scope ([ARCHITECTURE.md](ARCHITECTURE.md)). **Open (needs the addon):** a stable account discriminator; until then two Battle.net accounts in one Dashboard reconcile as one |
| Final Guild persistence model keyed by `GuildClubID` | Shared-storage reconciliation | **Decided and implemented (C1-C2):** opaque text key. **Open (addon):** whether a region is needed for uniqueness; the textual form of a real club ID |
| Deletion semantics for shared observations | Shared-storage reconciliation | **Decided:** deleting a character (or a snapshot) never deletes shared observations; source labels are kept. **Also decided (C3/C4):** explicit owner deletion removes that owner's observations and provenance and never touches snapshots; it is not a tombstone (new evidence recreates the owner); the HTTP contract is settled (owner routes + JSON confirmation, 404 for a missing owner). **Open (C5):** the UI confirmation wording |
| Character identity / GUID strategy, especially rename/transfer | Identity, companion, Activity History | Identity is `version::realm::name`; the text export carries no GUID while SavedVariables is GUID-keyed |
| Desktop companion transport / handoff | Desktop companion | Depends on the feasibility checkpoint (SavedVariables flush timing) |
| Local companion API authentication | Desktop companion | Whether a token is needed beyond loopback + Host/Origin protection |
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
- Warband parsing and display
- Guild Bank parser compatibility and transitional, truthful display. Current Retail
  exports, which always contain `[GUILD BANK]`, import successfully
- Product review document
- Shared-storage reconciliation foundation: C1 pure domain module (`90ff3c1`), C2 persisted
  journal + transactional import integration + backfill, C3 explicit owner-scoped deletion, and
  C4 HTTP read/delete API (no UI; the rest of the reconciliation is under [Active](#active))
- Integration branch `feature/dashboard-integration` (`0f525a7`): main + trust hardening +
  Warband + Guild Bank + product review. Not yet merged to `main`.
