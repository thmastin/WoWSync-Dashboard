# Start Here

This is the fixed onboarding entry point for WoWSync Dashboard and Azeroth ERP. Read this first;
it routes you to the right document for whatever you're trying to do.

For the Retail gear-allocation capability, start with [`RETAIL_GEAR_ALLOCATION.md`](RETAIL_GEAR_ALLOCATION.md).

## What WoWSync is, in plain language

WoWSync Dashboard is a local-first tool that turns a World of Warcraft addon's text export into
durable, queryable account history. A companion addon (GearExport, a separate repository) exports
a character's current state as text; you paste or pipe that text in; WoWSync remembers it forever,
alongside every earlier export, and lets you ask questions about it — through a web UI, or through
ChatGPT via a read-only MCP connection.

Azeroth ERP is a small, deliberately narrow reasoning layer built on top of that durable history:
given what the account actually holds and what you've explicitly said you want ("I want 450 of
this material"), it tells you what's satisfied, what's short, what's uncertain, and what
(non-executing) action follows. It does not act for you.

## The flow, end to end

```
GearExport addon (external repo)
        | WoWSync v1 text export
        v
capture: manual paste / import:saved CLI / watch:saved + receiver   (three transports, one write call)
        v
durable evidence: SQLite, additive-only schema, nothing overwritten
        v
read models:
  Pipeline A -> AccountFacts -> AccountContext -> LlmContext -> Dashboard UI + Ask My Account
  Pipeline B -> DashboardReadModel -> MCP tools -> ChatGPT
        v
reasoning: Azeroth ERP allocation (demand vs. observed evidence -> surplus/deficit/disposition)
```

The single most important thing to internalize about this flow: **there are two separate read
pipelines, and `DashboardReadModel` only feeds the MCP/ChatGPT one — not the Dashboard UI.** See
[`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md) for the full explanation.

## Where to go next

| I'm trying to... | Go to |
|---|---|
| Make or understand a **design decision** / durable invariant | [`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md) |
| **Implement or change current code** | [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md) |
| Work on **Azeroth ERP** specifically | [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) |
| **Operate or deploy** the DEV runtime | [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) |
| **Test or live-validate** a change | [`TESTING_AND_VALIDATION.md`](TESTING_AND_VALIDATION.md) |
| See **what's actually shipped** right now | [`CURRENT_STATE.md`](CURRENT_STATE.md) |
| See **what's planned** next | [`ROADMAP.md`](ROADMAP.md) |
| Understand **why something isn't built** | [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) |
| Read a **historical** document (point-in-time, not current) | see "History" below |

## Which documents are authoritative vs. reference/historical

**Authoritative (durable, kept current):**

- [`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md) — the highest-authority rules doc.
- [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md) — current implementation reference.
- [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) — ERP semantics contract.
- [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) — current DEV ops topology.
- [`TESTING_AND_VALIDATION.md`](TESTING_AND_VALIDATION.md) — how to validate changes.
- [`CURRENT_STATE.md`](CURRENT_STATE.md) — what's shipped, stamped with a commit SHA.
- [`ROADMAP.md`](ROADMAP.md) — what's planned, kept current as a TODO index.
- [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) — boundaries and
  future ideas, explicitly not current behavior.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the long-form historical/narrative architecture doc.
  Still broadly accurate and useful for "how did we get here," but `SYSTEM_REFERENCE.md` and
  `ARCHITECTURE_INVARIANTS.md` are the faster current-state references; when the two disagree,
  trust the newer documents and treat `ARCHITECTURE.md` as needing a reconciliation pass.
- [`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) and
  [`READ_RETRIEVAL_ARCHITECTURE.md`](READ_RETRIEVAL_ARCHITECTURE.md) — MCP operations/protocol
  detail and provider-neutral read-model design, respectively. Reference material, kept accurate,
  but not the first place to look — start from `SYSTEM_REFERENCE.md` or `OPERATIONS_RUNBOOK.md`.
- [`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md) and
  [`WINDOWS_CAPTURE_SETUP.md`](WINDOWS_CAPTURE_SETUP.md) — host trust-boundary and Windows-capture
  detail `OPERATIONS_RUNBOOK.md` summarizes but does not replace.
- The Midnight research documents (`MIDNIGHT_12_1_ENDGAME_RESEARCH.md`,
  `MIDNIGHT_12_1_RENOWN_REPUTATION_RESEARCH.md`, `MIDNIGHT_CRAFTERS_GUIDE.md`,
  `MIDNIGHT_LEVEL_90_ENDGAME_GUIDE.md`) — versioned game-mechanics research, registered with
  `ResearchRegistry` and served to MCP/ChatGPT. Dated research snapshots, not architecture.

## History

These documents are point-in-time records. They describe the repository as it was on a specific
date/commit and have deliberately not been updated since — read their "current" statements as
historical, and check `CURRENT_STATE.md`/`ROADMAP.md` for what's true today:

- [`DASHBOARD_PRODUCT_REVIEW.md`](DASHBOARD_PRODUCT_REVIEW.md) — product/UX review, basis `797fc3d`
  (2026-09-19).
- [`DESKTOP_COMPANION_FEASIBILITY.md`](DESKTOP_COMPANION_FEASIBILITY.md) — Desktop-companion
  feasibility checkpoint, 2026-09-21.
- [`DEV_CODEX_PACKAGE_REPAIR.md`](DEV_CODEX_PACKAGE_REPAIR.md) — a one-time package-repair
  installation record, 2026-09-30. Explicitly says not to repeat its procedure.
- [`CLAUDE_PROMPT_GEARING_PLANNER_FEASIBILITY.md`](CLAUDE_PROMPT_GEARING_PLANNER_FEASIBILITY.md) —
  a standalone implementation prompt for a gearing planner, with no implementing code behind it.
  Its content is folded into [`ROADMAP.md`](ROADMAP.md)'s planning sections; treat it as
  superseded context for that roadmap entry, not as a standalone authoritative spec.

## What's new since the last baseline

Azeroth ERP Vertical Slice 1 (durable `STOCK_TARGET` demands, deterministic allocation reasoning,
the `get_item_allocation` MCP tool) is implemented and live-validated. The Omarchy DEV systemd
topology (`ops/systemd/`, `tools/omarchy/`) is now tracked in this repository. See
[`CURRENT_STATE.md`](CURRENT_STATE.md) for the full current baseline.

Azeroth ERP Vertical Slice 2 (the account-wide Account Allocation Review, `get_allocation_review`) is
shipped, merged to `main`, and live-validated (2026-10-03). See
[`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) §23.

Azeroth ERP Vertical Slice 3 (held-item identity and binding gates) is shipped and blindly
live-validated at `81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`; see §24 and its live-validation record
in [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md).
