# WoWSync Dashboard — Product & UX Review

Status: research / design. Nothing in this document is implemented.
Date: 2026-09-19. Basis: `main` at `797fc3d` (Forever support + character deletion).

> **Point-in-time review.** This document records the findings as of the date and
> basis above and has deliberately not been edited since. Some of them have since
> been implemented (for example the trust-hardening wave: unknown-is-not-zero,
> freshness-aware totals, observation-time ordering, idempotent imports, per-realm
> LLM gold, classified API errors, localhost binding) and Warband/Guild Bank
> parsing has been added. Read its "current" statements as describing the
> repository at that basis, not today's. In particular the review's remarks that the Warband bank is not shown or is
> excluded describe that basis: shared storage (Warband and Guild Banks) now has its own account-level Shared Storage
> view (see docs/ROADMAP.md, shared-storage checkpoint C5); it is still not part of any total, search or AI context.

**Evidence legend.** `[REPO]` = read in the source or the local API by the review team
and, for the items in "Verified by the lead" below, re-checked by the lead.
`[EXTERNAL]` = outside research. `[AGENT]` = a claim by a review agent that the lead
did not independently re-check (measurements, estimates, computed contrast).
`[SPECULATIVE]` = a judgment call. Where a claim is tagged only `[REPO]` it is a
description of code or data shape, not of how the UI renders.

**Limitations, stated up front.**
1. **No browser inspection.** The browser extension could not load the local server,
   so no screen was ever looked at. Every statement about how the UI "looks" or
   "behaves" is inferred from React/CSS source and API payloads.
2. **External research was thin.** Two sources were actually consulted: the public
   feature description of the Altoholic alt-tracking addon (CurseForge) and WCAG 2.2.
   No systematic comparison of other tools was done, so this document makes no claims
   about competitor feature sets beyond those two.
3. **Activity History is not in this repository.** Its architecture is being designed
   separately; this document only records where the dashboard should leave room.
4. Live-data observations are counts and shapes from the author's own local database
   (14 characters at review time). No character names, realms or amounts are recorded
   here.

---

## Executive Summary

WoWSync's data layer is ahead of its dashboard. The snapshot model, the
OBSERVED / UNKNOWN / DERIVED discipline, version isolation and the deterministic
AccountFacts layer are strong. The dashboard on top of it was built feature-by-feature
to expose that data and now has three kinds of problems:

1. **Trust gaps — places where the UI or the LLM payload quietly break the
   project's own rules.** These are small and should be fixed first:
   - The Economy tab can print `0c` / `0m` where the Overview correctly prints `?`.
   - Totals include characters last synced weeks ago with no statement of that.
   - "Latest snapshot" is chosen by *import* time, not export time, and re-importing an
     identical export inserts a duplicate that becomes the "previous" snapshot and
     erases the real diff.
   - The LLM payload hands the model a cross-realm gold total for realm-partitioned
     versions, labelled authoritative, while the system prompt tells it never to combine
     realms.
   - Every fetch lacks an error path: a stopped server is an endless "Loading…".
   - The server listens on all network interfaces with no authentication, including the
     new `DELETE` route and `/api/ask`.
2. **Triage gaps — the dashboard answers "what is this character" but not "what do I
   need to do".** The Characters view is an unsorted, unsearchable card grid; item
   search (the single strongest cross-character feature) is at the bottom of the
   Economy tab; freshness is a binary badge shown four different ways; nothing is
   deep-linkable; Back always lands on Characters.
3. **Missing product surface around Ask My Account** — a blank textarea in a modal, no
   suggested questions, no indication of scope or data age, although the server already
   returns the data age.

**Recommended direction:** keep the version-first structure (it is correct and it
protects isolation); make WoWSync a **triage ledger** — "what do I have, where, how
current is it, and what needs my attention" — by (1) making every number state its
basis, (2) adding one deterministic "needs attention" surface, (3) turning the
Characters view into a sortable, searchable roster, (4) promoting item search, and
(5) giving every screen a URL. Keep Ask My Account as a modal with scope, data-age and
low-risk suggested questions; do not chat-ify it.

**Ranked, in one line each** (details in *High-Value Improvements*):
**Wave 1 (trust and survivability, all small):** honest totals · import ordering/dedupe
· error states · one age-based freshness surface · realm beside every name · character-page
staleness/age/ilvl · informative version tabs · Ask context banner + chips · LLM context
fixes · bind server to localhost.
**Wave 2 (the roster spine):** URL routing · roster table · promoted item search ·
"needs attention" digest · Retail profession tier.
**Wave 3:** multi-export import · full bag/bank table · accessibility pass · raw-export
download · Ask version scope.
**Rejected outright:** empty Activity placeholders, cross-version totals, configurable
freshness thresholds, a "retire/hide" flag (for now), multi-turn Ask, armory-style
features, price/AH data, charts library.

---

## Current Product Assessment

What is good [REPO]:
- **Honest section states.** The character page renders an OBSERVED/LAST_SEEN/UNKNOWN
  badge per section with "Never observed." copy; Overview tiles show `?` plus "N
  unobserved" hints; item search caveats unknown storage. This is unusually disciplined.
- **Version isolation is real** — four tabs, per-version accents, realm pills where
  realm-partitioned, an "Account-wide" badge for Retail.
- **Deterministic core** — AccountFacts/AccountContext/LlmContext are pure, tested, and
  hold the hard-won LLM-grounding fixes (comparison status, latest-transition index,
  copper conventions).
- **Real drill-down** — Overview rows and cards open the character page; the character
  page has a snapshot picker/history and (new) a guarded delete.

What is weak:
- It is a **status wall, not a triage tool** (details in *Current Gaps*).
- Data the pipeline already carries is **collected but not shown**: equipment item
  level, required level and stats; bag item vendor value and bound state; per-section
  `observedAt`/`coverageNote`/`refreshIssue`; profession tier/category; the bank status
  on roster rows; the data age that `/api/ask` already returns. [REPO]
- Some UI is **stale**: the Overview "Account summary (LLM)" panel says the feature "isn't
  wired up yet" while an Ask button sits in the header. [REPO]

---

## Current Architecture Relevant to UX

[REPO] unless noted.

- **Navigation is three pieces of React state, no router.** `activeVersion` (one of four
  tabs; the only piece persisted, in `localStorage`, defaulting to TBC Anniversary when
  empty), `view` (`overview | characters | economy | detail{identityKey}`), and
  `selectedRealm`. There are no URLs, no `history` use, no deep links; the browser Back
  button leaves the app; refresh keeps only the version.
- **Realm state is reset on every refresh.** The facts-loading effect sets
  `selectedRealm = null` and `facts = null` on every version change *and* every
  import/delete refresh, so after any import the realm snaps to the first alphabetical
  realm and the page flashes "Loading…".
- **Character page Back always goes to Characters**, regardless of where the user came
  from (Overview, Economy, an item-search hit).
- **Nothing has an error path.** No `.catch` on any fetch; a failed request is an
  infinite "Loading…"; a 404 on the character page (deleted elsewhere) likewise.
  Switching tabs does not cancel an in-flight request.
- **`/api/versions` exists and is unused by the web app** (character count, total gold,
  `lastUpdatedAt` per version). Its `lastUpdatedAt` is the latest *import* time; it has
  no freshness counts.
- **Two "last seen" clocks.** Freshness badges and lists use `lastObservedAt`
  (= the export's `generatedAt`, falling back to import time); the card timestamps,
  "Recently updated" and the character page "Last seen" use `lastImportedAt`. Neither is
  labelled. They diverge whenever an older export is imported after a newer one.
- **Snapshot ordering.** The store selects the "latest" and "previous" snapshot with
  `ORDER BY imported_at DESC, id DESC`. AccountContext orders chronologically by
  `generatedAt` (with an `id` tie-break). The two can disagree, and the UI and the LLM's
  `latestTransition` can then describe different pairs. `importSnapshot` has no dedupe
  and no unique constraint on `(character, generated_at)`, and inserts the character row
  and the snapshot row without a transaction (deletion, by contrast, is transactional).
- **Recent changes are capped before realm scoping.** `recentChanges` defaults to 20 for
  the whole version; the realm filter is applied afterwards in the browser, so a realm
  can show "no changes" while it has some.
- **Freshness is one constant** (3 days) in `core/freshness.ts`, exposed as a three-way
  label (`recent | stale | unknown`); with the live data, roughly half to two-thirds of
  characters read "stale" depending on when it is queried. [AGENT: reviewers queried at
  different times and counted 7–9 of 14.]
- **Item search** lives at the bottom of the Economy tab, name-substring only, scoped to
  the current version and realm, uncapped, with a "known total" caveat but no per-location
  data age and no LAST_SEEN caveat.
- **Ask My Account** is a modal: one textarea, one placeholder example, answer rendered
  through the safe Markdown renderer, footer "model · tokens". It is stateless by design.
  `/api/ask` already returns `contextGeneratedAt` and `contextSummary`; the modal
  ignores both, and it downloads the full ~400 KB `/api/account-context` just to count
  characters. The payload sent to the model covers **all four versions** regardless of
  the tab on screen.
- **LLM payload sizes.** [AGENT, measured by two reviewers] Canonical AccountContext ≈
  400 KB for 14 characters; the LlmContext projection sent to the model ≈ 30 KB
  (≈ 8.5K tokens), roughly 2 KB per character. Extrapolations to 30/100 characters
  (~17K / ~55–60K tokens) are estimates.
- **Styling.** One 800-line CSS file, dark theme, per-version accent variable, exactly two
  `@media` rules (both at 900 px, no phone breakpoint), Google Fonts loaded by CSS
  `@import`. Clickable cards/rows are `div`/`li`/`tr` with `onClick` (no keyboard access),
  only the delete dialog has `role="dialog"`.
- **Server exposure.** `app.listen(port)` passes no host, so it binds every interface;
  there is no auth or Origin check. Reachable from the LAN: import, the destructive
  `DELETE /api/characters/:identityKey`, and `/api/ask` (which spends the configured
  provider key). The delete's `confirmIdentityKey` guard prevents accidents, not a
  deliberate caller (keys are readable via `GET`).

**Verified by the lead** (re-read in source before inclusion): unguarded Economy totals;
stale LLM placeholder; absence of any `.catch`; two `@media` rules at 900 px; clickable
`div`/`li`; no import dedupe or transaction; `imported_at` ordering; `recentChanges`
cap-before-scope; server binds all interfaces; default tab is TBC; `itemLevel` absent
from the web `ParsedSnapshot` type although the parser and stored JSON carry it; the
`goldSummary` cross-realm sum vs the system prompt (see *Current Gaps*, item 4).

---

## What WoWSync Should Be

**A personal account ledger with a triage mindset.** Its job:

> *What do I have, where is it, how current is that answer, and which characters need
> my attention?*

It is **not** an armory (no gear scoring, BiS, tooltips, rendering), not a market tool
(no prices/AH — the export has none), not a combat or activity analyzer, and not a
generic gaming dashboard. It is the place where a player with many characters across
several client versions sees the state of their stable and asks questions the tables
cannot answer.

Design principles that follow from that (and from what the codebase already believes):
1. **Every number states its basis.** A total says how many characters contributed, how
   many were excluded as unobserved, and how old the oldest contribution is.
2. **UNKNOWN is a first-class visible state**, never a blank, `0`, or empty list, and
   never styled as an error.
3. **Version is the hard boundary.** Nothing sums, merges or ranks across versions.
   Inside a version, realm is a filter/column — but realm-partitioned versions never
   sum across realms without labelled per-realm parts.
4. **Deterministic first, LLM second.** If a table or a computed list can answer a
   question, it should; the LLM handles fuzzy and cross-cutting questions.
5. **Small surfaces.** Prefer improving the existing five views over adding new ones.

---

## Primary User Jobs

Ranked by how often a multi-character player does them (`[SPECULATIVE]` frequency,
`[REPO]` for whether the UI supports them today):

| # | Job | Supported today? |
|---|---|---|
| 1 | "Which characters need a fresh sync / a login?" | Partly: a binary badge + unsorted list |
| 2 | "Who has item X, and how old is that answer?" | Yes, but buried, one realm at a time, no age |
| 3 | "Find character Y" / "compare my alts" | No sort/search/filter; cards only |
| 4 | "How much gold do I have (here)?" | Yes, but the total hides staleness/exclusions |
| 5 | "What changed since I last looked?" | Partly: latest snapshot pair only, capped before realm scope |
| 6 | "Who covers profession P?" | Yes (coverage); tier dropped for Retail |
| 7 | "What is this character's state?" | Yes (character page), with gaps (age, ilvl, banner) |
| 8 | "Get my data in" (import 1…40 exports) | One paste at a time, no dedupe |
| 9 | "Ask something the UI can't answer" | Yes, with no scope/age/suggestions |
| 10 | "Clean up test/mistaken data" | Yes (new delete); no raw-export backup first |

---

## Current Gaps

Ordered by severity — integrity/misleading first, then triage, then polish.

**Trust / integrity (misleading or data-corrupting)**
1. **Economy totals can show `0c`/`0m` for "nothing known"** while Overview shows `?`.
   Violates UNKNOWN ≠ zero. [REPO, verified]
2. **Totals ignore staleness.** Gold and playtime sum every character's latest value; only
   *unobserved* characters are caveated, not *old* ones. On the live Retail data most of
   the total comes from characters that read "stale". The same total feeds the LLM as
   `goldSummary` with no caveat. [REPO; share of total is an [AGENT] measurement]
3. **Import ordering and duplicates.** "Latest" is by import time; an old export imported
   late becomes current; an identical re-import becomes the "previous" snapshot and the
   real diff is lost; no transaction between the character and snapshot inserts. The
   character page's "Last seen just now" can sit beside a "Stale" badge. [REPO, verified]
4. **LLM `goldSummary` sums across realms for realm-partitioned versions** (documented in
   `llmContext.ts` as intentional carry-over of `facts.gold.totalKnownCopper`), is marked
   "authoritative — copy it directly" in the system prompt, and the same prompt says never
   to combine totals across realms. The instruction and the data contradict each other.
   [REPO, verified] (Retail is genuinely account-wide, so it is not affected there.)
5. **Section age is dropped.** Parsed sections carry `observedAt` (and LAST_SEEN
   `lastVisit`), but facts, UI and LLM context never use it. A bank last seen weeks ago is
   searchable with no age, while its owner reads "recent". [REPO]
6. **Retail profession skill shown without its tier.** `CharacterProfessionEntry` carries
   only name/skill/max; the export's tier is dropped, so "Mining 25/100" and "Mining 1/300"
   on the same account are not comparable but look it. [REPO]
7. **The system prompt and LLM payload disagree** about profession coverage: the prompt
   explains coverage status, the projection carries none, so the model must derive
   "nobody has X" itself — the DERIVED-vs-OBSERVED blur the project forbids. [REPO]
8. **Server exposure** (all interfaces, no auth) covers the destructive delete and the paid
   Ask route. [REPO, verified]
9. **Ghosts.** Identity is `version::realm::name` (no GUID in the export). A rename or
   realm transfer creates a new character and orphans the old one; in Retail (account-wide)
   both count toward gold. Today's only remedy is Delete, which also destroys history.
   [REPO — the mechanism is in the identity code; how often it happens is `[SPECULATIVE]`.]

**Triage**
10. Characters view: no sort/filter/search/grouping; realm is small grey text; two Retail
    characters share a name on different realms and are indistinguishable in Economy,
    Overview and item-search rows. [REPO]
11. Item search: buried, per-version-per-realm, uncapped, no data age, no bound/storage
    filter. [REPO]
12. Freshness is presented four times (tile, panel, per-card badge, "Recently updated")
    with the same information; a permanently amber roster stops carrying signal. [REPO]
13. Version tabs are bare labels; the default tab is a hard-coded TBC rather than the
    version with the most recent activity. [REPO]
14. No deep links; Back goes to the wrong place; realm resets on every import. [REPO]
15. Import is one export per paste; after "Done" the modal closes and state is lost.
    [REPO]

**Polish / accessibility**
16. No error, retry or empty-fetch states. [REPO]
17. Character page: a chosen historical snapshot changes every card while the header still
    says "Level {latest}" — no "you are viewing an old snapshot" banner. [REPO]
18. UNKNOWN and "freshness unknown" share the error red; small badge text on tinted red
    computes below AA contrast (4.03:1 at ~10 px) [AGENT]; input borders are below the 3:1
    non-text contrast target [AGENT]; no phone breakpoint; header/tabs likely overflow at
    375 px [AGENT, inferred from CSS]; clickable rows are not keyboard-operable; modals
    (other than delete) lack dialog roles and Escape handling. [REPO]
19. Equipment shows names only though ilvl/required level/stats are stored; bags/bank show
    12 unsorted rows then a dead-end "+N more…". [REPO]

---

## Competing Research Findings

Eight agents with deliberately different mandates inspected the source and the running
API (GET only; no writes; no browser). A second round had every agent attack a merged
list of 24 candidates and 10 explicit disagreements from its own lens.

| Agent | Lens | Headline contribution |
|---|---|---|
| 1 | WoW player | "Who to log in next" is the daily job; equipment ilvl is collected but unshown |
| 2 | Information architecture | Version-first is right; no URLs/deep links; version tabs carry no information; realm reset |
| 3 | LLM product | Deterministic answers first; chips + data-age banner; prompt/context mismatch; keep it stateless |
| 4 | WoW data/economy | What the export can and cannot answer; bank age invisible; Retail tier dropped; no recipes exist |
| 5 | UX / visual critic | Absent-value inventory; Economy `0c` bug; old-snapshot banner; a11y/contrast/phone |
| 6 | Adversarial | Stale-in-totals; import ordering/dedupe; ghosts; error recovery; LAN exposure; goldSummary |
| 7 | 30–50 character power user | Roster table; multi-export import; realm reset per import; only external sourcing (Altoholic, WCAG) |
| 8 | Minimalist PM | What already exists; nearly-free wins; strict reject list |

### Where the agents converged (used as decisions)

- **Version-first navigation stays.** No cross-version roster, no summed totals (8/8).
- **No empty Activity placeholders.** Proposed by two agents in round one; after critique
  all eight agreed against (an empty tab promises data that does not exist and blurs
  "nothing yet" with "no data"). Leave room *structurally* instead (see *Activity History
  Integration*).
- **Fixed age bands, not a configurable freshness threshold** (8/8): a user setting makes
  "stale" mean different things on different screens and to the model.
- **Ask stays a modal for now** (polish it; a docked panel only after evidence of use) and
  **stateless, no multi-turn** — all eight agents after critique; three had proposed a
  docked panel in round one.
- **Import ordering/dedupe and the Economy `0c` bug are correctness fixes, not features**
  (the minimalist PM explicitly revised its own round-one view on this).
- **Server bind** is one line and should be done, but is hygiene, not product.

### Where they disagreed, and how it was resolved

| # | Question | Positions | Decision | Reason |
|---|---|---|---|---|
| D1 | Reserve Activity slots now | 2 for, 6 against → 8 against | **Reject** | Empty UI is debt; room is left by URL grammar, section pattern and the ordering fix |
| D2 | Ask evidence/citations | Round one: LLM lens for, minimalist against. Round two: IA "yes, resolvable-only"; all others defer/reject | **Later** | Model-returned keys can carry wrong values; UI can only verify against facts. A cheaper number check (below) gets most of the benefit |
| D3 | "Retire/hide" flag vs delete | Adversarial for; 7 against | **Reject now; ghost *hint* Later** | A hidden character silently makes totals lie; speculative at 14 characters. Revisit if ghosts are observed |
| D4 | Sparklines | Round one: adversarial "cheap win", minimalist/UX against. Round two: all Later or Reject | **Later** | 1–7 snapshots per character; a line between sparse, asynchronous points reads as interpolated gold, which is not OBSERVED |
| D5 | Ask panel vs modal | 3 panel → all modal | **Modal + scope** | No conversation state to dock; promoting it before provenance exists amplifies its weakest part |
| D6 | Configurable freshness | 1 for → all fixed bands | **Fixed bands** | See above |
| D7 | Cross-version "roster strip" | all: no sums | **Only the informative tabs** | Anything more invites summation |
| D8 | Per-question context routing | mixed | **Defer routing; do the small context fixes now** | Projection is ~8.5K tokens today; routing matters only once inventory/activity sections arrive |
| D9 | Server hardening in a product review | all: one line | **Include, flagged as hygiene** | Existing exposure of destructive + paid routes |
| D10 | Priority of multi-export import | Power-user: top; most others: below integrity | **Ordering/dedupe Now; multi-paste Wave 3** | A wrong "latest" corrupts every fact; typing effort does not |
| D11 | Roster: table vs cards+sort | UX critic: cards + controls suffice; others: table | **Table (Wave 2)** | Rows can be real links (fixes keyboard access), carry a realm column (fixes ambiguity) and fit 8+ attributes; sequenced *after* trust fixes |
| D12 | Bag/bank vendor value | data lens: high value | **Wave 3, labelled DERIVED** | A floor (unsellable items report 0), excludes unobserved storage |
| D13 | Retail profession tier now | Data lens: Now; **seven of eight lenses: Later** | **Next (Wave 2), small — a deliberate override of the majority** | The others rated it a nicety; the lead judges it an integrity issue: the UI currently presents skill values from different tiers as comparable. It is an additive field, not a feature. If it proves larger than it looks, demote it |

### Feasibility limits the data lens established (do not build past these)

[REPO — from the addon schema and real payloads]
- Items carry only `itemRef`, name, quantity, bound flag and `vendorEachCopper`. **No
  quality, item class or equippability.** Rarity colours, "usable by", upgrade advice: not
  possible. [REPO, verified in `core/src/types.ts`]
- Professions carry name/skill/max (Retail also tier/category). **No recipes.** "Who can
  craft X?" cannot be answered; trainer data is "available/unavailable", not "known". [REPO,
  verified in types; the trainer semantics are from the data lens, [AGENT]]
- Equipment stats are an unparsed string; only ilvl/required level are structured. [REPO,
  verified in types]
- Retail bank coverage is purchased character tabs only; Warband bank, mail, AH, currencies:
  not exported. **Any "total wealth" headline would be misleading.** [AGENT, from the addon
  schema; not re-checked by the lead]
- Bank status live: most Retail banks UNKNOWN, none currently OBSERVED, some LAST_SEEN.
  [AGENT, point-in-time]

---

## Information Architecture Recommendation

**Keep version-first; make it addressable and informative.** Alternatives considered:

| Model | Verdict |
|---|---|
| Character-first global roster | **Rejected** — same name exists across versions/realms; blurs identity and the isolation boundary |
| Task-first (global "Gold", "Search") | **Rejected** — would blend versions |
| **Version-first, task views inside** | **Chosen** — matches the user's "what am I playing" axis and the data model |

Structure:
- **Level 1 — Version tabs** with count and a freshness dot (count from `/api/versions`;
  dot from sync age, see *Freshness*). Default to the version with the most recent sync,
  not a hard-coded one. Hide nothing; an empty version says "no exports yet — import one".
- **Level 2 — Views inside a version:** Overview · Characters · Gold & Items (today's
  "Economy", renamed for what it holds; Professions coverage appears once, not twice).
- **Scope control — Realm.** For realm-partitioned versions (Classic Era, TBC, Forever)
  default to **All realms** with a realm column and per-realm *labelled* subtotals; a
  realm filter narrows. Hide the pill row when a version has one realm. Retail is
  account-wide: no realm control, realm is a column/filter on the roster. Never sum gold
  across realms without showing the realm parts.
- **Faction** is a column, not navigation (real data is one faction per realm).
- **Level 3 — Character page** (drill-down, addressable).
- **Global chrome:** item search box, Import, Ask, Developer.

**Proposed URL grammar** (hash routing; localStorage keeps only the last version, used
only when the URL is empty):
```
#/<version>/overview
#/<version>/characters?q=&realm=&class=&age=&sort=
#/<version>/items?q=&storage=&bound=
#/<version>/c/<identityKey>[/snapshot/<id>]
```
Every state is bookmarkable; Back and refresh work; "Back to characters" returns to the
originating view. The grammar deliberately has no reserved future segments.

---

## Account Home Recommendation

The Overview today is four tiles plus six equal-weight panels, one of them a stale
placeholder, three of them overlapping freshness lists. Replace with a **short, prioritised
page for the active version (and realm scope if any):**

1. **Tiles (4)** — characters · known gold · known /played · last synced. Each with its
   basis line: *"from 6 of 8 characters · 2 unobserved · oldest sync 12 d"*. Unknown = `?`,
   never `0`.
2. **Needs attention** — one deterministic list, oldest sync first. Each row is a
   character with **reasons stated as observed facts, each citing its field**:
   *"synced 12 d ago"*, *"bank never observed"* / *"bank last seen 9 d ago"*,
   *"professions never observed"*, *"free bag slots: 2 of 38"*. No advice text, no
   inference ("should log in" is the *user's* conclusion). Replaces the Data freshness
   panel and "Recently updated".
3. **Recent changes** — kept, un-capped before realm scoping, one row per character's latest
   pair with the interval shown ("since previous sync, 3 d").
4. **Progression** and **Professions coverage** — kept; coverage shows "+N more" instead of
   silently truncating at 8.
5. The "Account summary (LLM)" placeholder is **deleted**.

---

## Character Page Recommendation

Same page, re-ordered and with the missing safety/age information — not a redesign:

1. **Header:** name, class/level/realm/faction, **sync age badge** ("synced 4 d ago"),
   snapshot count. If a non-latest snapshot is selected: a banner **"Viewing snapshot from
   {date} — not the latest. [Jump to latest]"**, and the header reflects the *selected*
   snapshot.
2. **Progress and Location** (as today).
3. **Equipment:** slot + name + **ilvl** (already stored), an average ilvl, empty slots
   flagged. No stats parsing, no paper-doll.
4. **Bags / Bank:** each card shows its **section age** ("bank last seen 9 d ago" using
   `observedAt`/`lastVisit`, plus `coverageNote`/`refreshIssue` when present) and, in Wave 3,
   opens a full filterable table (bound state, vendor value each/total, labelled DERIVED).
5. **Professions:** skill/max **with tier for Retail**; Forever 0/0 rows keep their
   existing "not confirmed learned" label.
6. **Spells / Trainers:** as today.
7. **Snapshot history:** as today, moved nearer the picker.
8. **Details:** client build/interface (developer trivia) collapsed under "Details";
   **Delete** stays here with a "Download raw exports first" affordance (Wave 3).

Global vs character-specific: totals, coverage, item search, freshness, recent changes are
*version/realm scope*; equipment, bag/bank contents, spells, trainers, snapshots are
*character*.

---

## Cross-Character Workflows

| Workflow | Where it lives | Status |
|---|---|---|
| Who needs attention | Overview "Needs attention" | Wave 1–2 |
| Find/compare alts | Characters roster (sort/filter/search) | Wave 2 |
| Who has item X (+ age) | Global item search (`#/<v>/items`) | Wave 2 |
| Who covers profession P (+ tier) | Professions coverage, tier shown | Wave 2 |
| Where is my gold (+ basis) | Gold & Items, per-realm labelled | Wave 1 |
| Bag space / overflow | Roster column "free slots" (from stored slot counts) | Wave 3 |
| What changed since last sync | Recent changes (fixed) + Ask chip | Wave 1 |

**Not supported and not to be faked:** who can *craft* X (no recipes), what to *send* to
alt Y (no need/recipe data — any answer would be a heuristic presented as fact),
gear-upgrade advice (no equippability), prices.

---

## Search and Filtering

Highest-value first:
1. **Item search** (name substring across bags + bank + equipped, per version; Retail
   account-wide): result rows show **character, realm, storage, quantity and data age**
   ("bank, seen 9 d ago"), a LAST_SEEN/UNKNOWN storage caveat *per row*, capped at 50 with
   "+N more". A header search box focuses the items view. Versions never mix in results.
2. **Roster search** by name/realm/class (client-side).
3. **Roster filters:** sync-age band, class, realm, level range, "bank not observed".
   Faction filter omitted for now.
Bound/storage filters on item search are Wave 3.

---

## Inventory / Equipment / Profession UX

- **Inventory:** the aggregate already exists; the work is presentation — per-location age,
  a per-row unobserved-storage flag, expandable lists instead of "+N more…", and (Wave 3)
  a full table with vendor value **labelled DERIVED, a floor, excluding unsellable items,
  never summed with unobserved storage**. No categories or rarity (the export has no
  quality/class).
- **Equipment:** ilvl + average + empty-slot marks. Not an armory.
- **Professions:** show tier for Retail; one coverage view (not two); a
  character × profession matrix is a Later idea — it must never compare skill across
  tiers. Forever remains "unknown" for 0/0 rows.

---

## Economy UX

- Rename the tab for what it contains; move Playtime next to Gold (it is not economy).
- **Gold table:** sortable by gold, realm column, thousands separators, an inline share-of-scope
  bar. Total states its basis (see below). Per-character delta since previous sync (exists).
- **Basis line on every total:** *"X g from N characters · M unobserved (not counted) ·
  K last synced > 14 d ago · oldest 31 d"*. "Stale" here is an **observed age**, not a
  judgment.
- **Standing caveat, stated once:** the sum excludes mail, AH, Warband bank, and any
  unobserved storage. No "net worth" headline anywhere.
- **Fix:** guard Economy totals (`?` when no character has a known value).
- **LLM `goldSummary`:** for realm-partitioned versions, replace the single cross-realm
  figure with **per-realm** figures (Retail stays one account-wide figure), each with the
  same basis fields, and align the prompt wording.

---

## History and Timeline UX

- Keep the per-character snapshot table and the "Recent changes" panel as **the** history
  surface until Activity History exists.
- Fix what makes them misleading: order by export time, show the **interval** each delta
  covers, banner when viewing an old snapshot.
- **No cross-character timeline, no charts, no sparklines yet.** Trigger to revisit: most
  characters have ≥ 5 snapshots *and* an Activity History design defines gap/interpolation
  rules (draw points, never implied lines).

---

## Ask My Account Product Design

**Position:** a scoped, honest *assistant for questions the UI cannot answer* — not the
front door, not a chatbot.

1. **Keep the modal, keep it stateless.** No multi-turn, no stored answers (a prior answer
   treated as fact re-introduces the cross-character contamination the LlmContext
   projection was built to prevent).
2. **Show what it was given** — from `/api/versions` + the response, not the 400 KB fetch:
   *"Data as of {contextGeneratedAt} · {N} characters · {S} last synced > 3 d ago ·
   {U} with a single snapshot (comparison unavailable)"*.
3. **Scope selector (Wave 3):** "This version" (default = active tab) or "All versions".
   Filtering is a deterministic subset of `versions` in the payload — never merged.
4. **Suggested-question chips** — only questions the *current* payload answers with low
   hallucination risk, version-scoped, e.g.:
   - "What changed on {character} between its last two snapshots?"
   - "Which characters gained or lost gold since their previous snapshot?"
   - "Who is closest to leveling?" (within-level progress — the answer must say so)
   - "Which professions does nobody on this realm have?" (after the coverage fix)
   - "Which characters have fewer than two snapshots?"
   - "What should I level next?" (must be answered as a labelled *suggestion*)
   Questions a deterministic view already answers (stale list, unknown banks) are **not**
   chips — they live in Needs attention. Trap questions ("what's in X's bank?", "did that
   gold come from an auction?") belong in a developer evaluation set, not the UI.
5. **Answer footer:** data-as-of and scope beside model/tokens. Optionally a cheap **number
   check**: every gold string/number in the answer must appear in the payload, else show a
   "contains figures not in the supplied data" warning — most of citations' benefit at a
   fraction of the cost.
6. **Payload fixes (deterministic, small):** add `lastObservedAt` (and section age where
   relevant), formatted playtime totals, and a per-scope profession-coverage summary
   (covered / none / unknown lists) so the model stops deriving "nobody has X"; per-realm
   gold as above; keep the comparison-status pattern as the template for any future
   history section.
7. **Not now:** per-question context routing (revisit when the payload nears ~30K tokens,
   e.g. when inventory/activity sections are added), citations, provider work.

---

## Provenance / UNKNOWN / DERIVED UX

Today: OBSERVED/LAST_SEEN/UNKNOWN exist as per-section badges on the character page;
`?`/"Never observed." elsewhere; **DERIVED appears nowhere in the UI**; absent values are
rendered five different ways (`?`, `—`, `never`, `unknown`, blank) and UNKNOWN shares the
error red. One shared vocabulary, implemented once as a small presentational component:

| State | Meaning | Rendering |
|---|---|---|
| OBSERVED | Directly seen in the export | Plain value; **no badge** (badge only the exceptions) |
| LAST_SEEN | Seen once earlier | Value + "as of 9 d ago" (uses `observedAt`/`lastVisit`) |
| UNKNOWN | Never observed | Neutral grey "?" / "Not observed" — **never red, never 0, never blank** |
| DERIVED | Computed from observed values | Small "derived" tag with a tooltip stating the basis ("sum of 6 characters"; "vendor value floor"); never merged into an OBSERVED number |

Terminology, fixed: **"Synced"** = the export's own timestamp (what the freshness clock
measures); **"Imported"** = when it was pasted (import summaries only). "Last seen" is
retired — it asserts a login the data does not establish.

Partial exports: the import result gains one line, *"sections observed 6/8 — bank,
trainers not observed"*, and the roster shows a "bank ?" chip from `bankStatus`.

---

## Activity History Integration

The dashboard must **not** be designed around events that do not exist. What to do now so
Activity History lands cleanly:

1. **Fix snapshot ordering and dedupe first** (Wave 1). Any activity layer that attaches
   to "between snapshot A and B" inherits a wrong A/B today.
2. **Stable, addressable routes** (Wave 2) — an activity view is a new segment, not a new
   navigation model.
3. **The provenance component above** — activity events will need OBSERVED/DERIVED tags on
   day one; build the vocabulary once.
4. **Keep the deterministic-index pattern** from LlmContext (an availability field plus a
   positive-only index) as the template for how activity will reach the model.
5. **Keep Recent changes as the seed** — its per-character "latest pair" becomes one
   consumer of a richer history later.
6. **Identity (cross-repo, for the addon owner, not this repository):** the addon's own
   docs treat GUID as authoritative but the export does not emit it, so rename/transfer
   ghosts are structurally possible; an emitted GUID would let history follow a character.
   Recorded as an open question, not a task here.

**Explicitly not now:** empty Activity tabs/bands, a timeline, sparklines, event feeds.

---

## Scalability

### 10 Characters
Current UI is adequate; the four trust fixes and the attention list already pay off
(the live account is 14 characters and already shows the ghost/name-collision and
staleness problems). Cards are still readable.

### 30 Characters
`[SPECULATIVE]` The unsorted card grid, per-realm pill navigation, the unbounded stale list
and the uncapped item search all fail here. Essential: roster table with sort/filter/search,
age bands, global item search, realm persistence across imports (no snapshot back to realm
one after each paste), multi-export import (≈ 4 actions per character today), raw-export
backup. The LLM payload is ~17K tokens `[AGENT estimate]`; still workable.

### 100 Characters
`[SPECULATIVE]` Requires: virtualised/paginated roster and history, saved filters or
grouping by realm/class, a facts cache (every call currently re-reads and re-parses every
full snapshot row, twice for diffs; measured 36 ms for 37 snapshots — the ~1–2 s figure at
100 characters is an `[AGENT]` extrapolation), a scoped/routed LLM context (~55–60K tokens
estimated), automatic ingestion (manual paste does not scale), and storage retention
(raw text + parsed JSON are both stored per snapshot with no dedupe). **Do not build any of
this now.** Triggers: > 50 characters or a facts call > 200 ms.

---

## Visual / Responsive Design Recommendations

Utility over aesthetics; the dark theme, gold accent and per-version accents stay.

- **Neutral UNKNOWN**, red reserved for errors and destructive actions; badge only
  non-OBSERVED states; raise small-badge contrast and size (agent-computed 4.03:1 at
  ~10 px for the red-on-tint badge; verify when fixing).
- **One phone breakpoint (~600 px):** wrap the header and tabs (or make tabs scroll),
  single-column tiles, smaller stat value text; keep tables in their horizontal scroll
  containers. Whether phone use matters is `[SPECULATIVE]`; the fix is small either way.
  Self-host fonts (the app is local-first; a CSS `@import` to a font CDN is an outbound
  call and an offline failure point).
- **Rows and cards as real `<a>`/`<button>`** with `:focus-visible` styles; version/view tabs
  get `role="tablist"`/`aria-selected`; modals get `role="dialog"`, Escape, focus restore.
  These come for free with the roster rebuild and routing.
- **Charts:** at most a CSS bar for gold share and level/XP progress; **no chart library**.
  Tables for items, professions, gold.
- **Thousands separators** in gold; copper precision only below ~1,000 g.

---

## High-Value Improvements

Each item: value / cost (S = under a day, M = a few days) / backend change? / depends on
Activity History? / bloat risk. Numbers in brackets refer to *Current Gaps*.

### Now — Wave 1: trust and survivability (all small; order is a suggestion)

| # | Item | Value | Cost | Backend | AH | Bloat |
|---|---|---|---|---|---|---|
| N1 | **Totals state their basis**; guard Economy `?`; LLM `goldSummary` per realm + prompt alignment [1,2,4] | H | S | small (llmContext, prompt) | no | L |
| N2 | **Import integrity**: latest/previous by export time (`generated_at`, then `imported_at`, then `id`), dedupe identical exports ("already imported"), single transaction for character+snapshot, one "synced" clock [3] | H | M | yes | enables it | L |
| N3 | **Error/loading states**: `.catch` + Retry, cancel stale responses, refetch character page after import, keep realm across refresh, 404 page with Back [14,16] | H | S | no | no | L |
| N4 | **One age-based freshness surface**: age in days everywhere, fixed bands (≤ 3 d / 3–14 d / > 14 d / never), "Needs attention" replaces three overlapping panels [12] | H | S–M | small (add age field) | no | L |
| N5 | **Names with realm everywhere**; recent changes un-capped before realm scoping; "+N more" on profession list; delete the stale LLM placeholder; one Professions view [10] | M | S | no | no | L |
| N6 | **Character page:** sync-age badge, old-snapshot banner (header follows the selected snapshot), per-section `observedAt`/LAST_SEEN date, ilvl + average ilvl [5,17,19] | H | S | small (expose fields; web type) | no | L |
| N7 | **Informative version tabs** (count + freshness dot) and default to the most recently synced version [13] | M | S | small (`lastSyncedAt` + stale count on `/api/versions`) | no | L |
| N8 | **Ask banner + chips**: data-as-of, scope, stale/single-snapshot counts from `/api/versions`; low-risk chips | H | S | no | no | L |
| N9 | **LlmContext fixes:** `lastObservedAt`, playtime totals, per-scope profession-coverage summary (resolves prompt/payload mismatch) [7] | H | S–M | yes (core) | no | L |
| N10 | **Bind to localhost by default** (`WOWSYNC_HOST` to opt into LAN/phone use, with a documented warning); Origin check on mutating routes is Later [8] | M | S | yes (server) | no | L |

### Next — Wave 2: the roster spine

| # | Item | Value | Cost | Backend | AH | Bloat |
|---|---|---|---|---|---|---|
| X1 | **Hash routing** + Back returns to origin + realm/filter state in the URL (gates X2–X4) | H | S–M | no | no | L |
| X2 | **Roster table** replacing the card grid: sortable, searchable, filterable (age band, class, realm, level, bank-not-observed); rows are real links; realm column; "bank ?" chip | H | M | no | no | L |
| X3 | **Global item search** (`#/<v>/items` + header box): per-location age, per-row caveat, capped results | H | S–M | no | no | L |
| X4 | **"Needs attention" digest** (deterministic, fact-only, each reason cites its field) — one implementation shared with the Ask chips' context | H | M | maybe (core helper) | no | M |
| X5 | **Retail profession tier** carried through AccountFacts (additive field) and displayed; matrix only after | M | S | small (core) | no | L |

### Later — with explicit triggers

| Item | Trigger to revisit |
|---|---|
| Multi-export paste / multi-file drop + per-character import summary + "sections observed n/N" (Wave 3, but ahead of everything below) | > ~15 manual imports per session, or automatic ingestion design |
| Full bag/bank table (bound, vendor value — DERIVED), free-slot column | after X3 lands |
| Accessibility pass beyond what X1/X2 give (tablist roles, modal Escape/focus, contrast, phone breakpoint, self-hosted fonts) | with the visual-polish wave |
| Raw-export download per snapshot (and before delete); whole-DB backup only if trivial | before automatic ingestion |
| Ask version scope selector | after N8 shows real use |
| Ghost-candidate **hint** (DERIVED; same class in a version, different realm/name, one old) | first observed ghost / rename |
| Citations for Ask | number check proves insufficient |
| Facts cache / performance pass | > 50 characters or a facts call > 200 ms |
| Per-question LLM context routing | payload nears ~30K tokens (e.g. inventory or activity sections added) |
| Sparklines / timeline | ≥ 5 snapshots typical **and** Activity History gap rules exist |

---

## Explicitly Rejected / Deferred Ideas

**Rejected**
- **Cross-version totals or a cross-version roster** — violates isolation; the currencies and
  economies are not comparable.
- **Empty Activity tabs/bands/feeds** — no data behind them; blurs "nothing yet" with "no data".
- **Configurable freshness threshold / per-character thresholds** — changes the meaning of
  "stale" between screens and for the model.
- **"Retire/hide from totals" flag (now)** — silently makes totals lie; delete exists. Revisit
  only with observed ghosts.
- **Undo/tombstones for deletion** — a new store for a rare event; the confirmation is enough.
- **Multi-turn Ask, stored answers, docked chat panel** — re-introduces cross-contamination;
  contradicts the stateless/privacy stance.
- **Armory features** (paper-doll, tooltips, gear score, BiS/upgrade advice) — not the product;
  the data (no quality/equippability) cannot support them honestly.
- **Price/AH/net-worth/profit views** — the export has no prices; a net-worth headline would
  be false.
- **"Who can craft X" / "what to send to alt Y" recommender** — the addon exports no recipes.
- **Chart library, gold-per-hour analytics, leaderboards, radar/donut charts.**
- **Auto-refresh/polling, notifications/reminders** — the data is a point-in-time export.
- **Faction filters/nav trees, saved views, tags, command palette** — over-engineering at this scale.
- **A user account/auth system** — a host bind (and later an Origin check) is enough.
- **LLM-written digests or scheduled LLM jobs** — costs money unprompted, breaks "opt-in per question".
- **Re-theme / light theme / drag-and-drop layouts.**

**Deferred:** see the *Later* table for each item's trigger.

---

## Recommended Dashboard Direction

> **WoWSync is a triage ledger for a multi-version WoW account.** Version is the hard
> boundary; inside it, a roster, an attention list and a global item search answer the
> daily questions deterministically; every number says what it is made of and how old it
> is; UNKNOWN is visible and neutral; the LLM is an opt-in assistant for what the tables
> cannot answer, scoped and honest about its data's age.

Sequencing rule: **trust before features, spine before polish, structure before
speculation.** Do not start Wave 2 until N1–N3 are done; do not start any history
visualisation until Activity History exists.

---

## Proposed Future Navigation

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⚔ WoWSync   [ Search items… ]            [Import] [Ask] [Developer]           │
├──────────────────────────────────────────────────────────────────────────────┤
│ Retail 8 ●   Classic Era 2 ●   TBC Anniversary 3 ●   Forever 1 ●             │  ← version tabs
├──────────────────────────────────────────────────────────────────────────────┤
│ Overview   Characters   Gold & Items      Realm: All ▾ (realm-partitioned)    │  ← views + scope
├──────────────────────────────────────────────────────────────────────────────┤
│ (view content)                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
 ● = sync-age colour (neutral for "never"); counts from /api/versions.
 Character page: #/<version>/c/<identityKey> — header carries sync age + snapshot banner.
```

---

## Proposed Future User Flows

1. **Open the app** → lands on the most recently synced version's Overview → tiles with
   bases → "Needs attention" lists the characters worth a login and *why*, oldest first.
2. **"Where is my Strange Dust?"** → header search → item results for this version → rows
   show character, realm, storage, quantity and *"bank, seen 9 d ago"*; unobserved banks
   flagged per row → click a row → character page (Back returns to the results).
3. **"Which alt should I play?"** → Characters → filter age = "> 3 d", sort by level → open one
   → header shows sync age; equipment ilvl and bank age visible.
4. **Import a play session** → paste several exports → one summary line per character
   ("already imported" / "new snapshot · level +2 · sections observed 6/8") → attention list
   updates in place, realm selection preserved.
5. **Ask** → opens scoped to the active version showing *data as of…* → tap a chip or type →
   answer footer repeats scope and data age; figures not in the payload are flagged.
6. **Clean up a test character** → character page → Details → Delete → typed-name dialog
   (existing) → optional raw-export download first → back to the roster.

---

## Implementation Roadmap

Product-level only; no implementation is implied by this document. Each numbered item is
sized to be handed to one implementation task with its own tests.

**Wave 1 — trust and survivability** (N1–N10 above). Suggested task grouping so each is
one reviewable change:
- *W1-A Data-integrity:* N2 (ordering, dedupe, transaction, single clock) + tests for
  identical re-import and out-of-order import (none exist today).
- *W1-B Honest numbers:* N1 + N9 + prompt alignment (core/server; deterministic; tests
  against the real fixtures; LLM payload sizes recorded before/after).
- *W1-C Survivability:* N3 + N10.
- *W1-D Freshness + character page + tabs:* N4, N5, N6, N7 (web + small API/core additions).
- *W1-E Ask context banner + chips:* N8.

**Wave 2 — the roster spine:** X1 → X2 → X3 → X4 → X5. X1 first (routing gates the rest).
Acceptance for the wave: a 30-character synthetic account (built from fixtures) can
locate a character, an item and every stale character in ≤ 2 interactions each.

**Wave 3 — depth and hardening:** multi-export import; bag/bank table; accessibility pass;
raw-export download; Ask version scope.

**Revisit points:** after Wave 1 (do the trust fixes change how the account *reads*? — re-run
this review's absent-value inventory); when Activity History ships (slot it into the
character page and attention list using the provenance vocabulary); if the LLM provider
decision moves (payload/prompt work in this document is provider-agnostic).

**Cross-repo note:** any change that needs new addon output (GUID, quality, recipes, Warband
data) is out of scope here and would be a request to the addon owner; this repository's
work above needs none.

---

## Appendix — Round-2 bucket votes (for traceability)

Buckets given by each lens to the merged candidates (N = Now, X = Next, L = Later, R =
Reject). The decisions above follow the reasoning in the tables, not the tally.

| Candidate | Player | IA | LLM | Data | UX | Adversarial | Power | Minimalist |
|---|---|---|---|---|---|---|---|---|
| Roster table | N | N | N | X | X | X | N | N (sort+filter; table X) |
| Item search promoted | N | N | X | N | N | X | N | N |
| Freshness redesign | N | N | N | N | N | N | N | N |
| Totals state basis | N | N | N | N | N | N | N | N |
| URL routing | X | N | X | X | X | X | N | X |
| Informative tabs | N | N | N | X | X | N | X | N |
| Error states | X | N | N | X | N | N | X | N |
| Import integrity | X | X | X | N | L | N | N | X |
| Character page | N | N | X | N | N | X | X | X |
| Ask chips + banner | N | N | N | X | N | N | N | N |
| Ask citations | L | X | L | L | L | L | L | R |
| Deterministic digest | X | X | N | X | X | X | X | L |
| LlmContext fixes | X | X | N | N | X | X | X | X |
| Ghost handling | L | L | L | R | L | X | L | L |
| Accessibility | X | X | X | X | N | X | X | X |
| Cleanup / realm names | N | N | N | N | N | N | N | X |
| Profession tier | L | L | L | N | L | L | L | L |
| Server bind | X | N | X | N | X | N | X | N |
| Performance | L | L | L | L | L | X | L | L |
| Raw-export download | X | X | X | L | X | X | X | X |
| Activity placeholders | R | R | R | R | R | R | R | R |
| Sparklines | L | L | L | R | L | L | R | R |
| Per-alt outstanding line | X | X | X | L | X | L | X | L |
| Docked Ask panel | L | L | R | R | R | R | R | R |
