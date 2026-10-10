# WoWSync ERP capability inventory

Updated: 2026-10-10, Phase 55. This is a cumulative status view, not a claim that every domain is live-validated. See the linked phase reports and `ERP_PLANNING.md` for contracts and limits.

| Capability | Status | What a player can do / evidence status |
|---|---|---|
| Version-scoped character and resource observations | Implemented and usable | Import supported client exports, inspect identity, item/resource location, quantity, completeness, and provenance. Four supported version buckets remain isolated. |
| Equipment allocation screening | Implemented; partly live-validated | Review evidence-qualified Forever equipment candidates and recipient screens. Hallo/Fizzwick mail behavior validates one specific Forever transfer event; it does not establish general eligibility, ownership, or routes. |
| Project requirements and evidence assessment | Implemented and usable | Record item, currency, profession, and recipe-knowledge needs; compare them with version-scoped observations while preserving UNKNOWN, LAST_SEEN, and freshness. |
| Resource commitments and reservations | Implemented and usable | Record project reservations, inspect overlaps, and limit increases to current unreserved observed lower bounds where available. A reservation is planning intent, not possession. |
| Manual work orders | Implemented and usable | Create, assign, edit, link dependencies and needs, and record player instructions for gather, purchase, craft, provision, retrieve, investigate, and other supported manual steps. No game action is issued. |
| Work-order readiness and project fulfillment | Implemented; synthetic-tested | Shared core combines needs, evidence, commitments, dependencies, progress observations, and project intent. REST, AccountContext, MCP, and Dashboard expose shared projections. It does not infer action causation or complete projects from resource changes. |
| Multi-need fulfillment review (Phase 49) | Implemented; synthetic-tested only | In an active project, group 2–4 uncovered/unworked needs into one linked INVESTIGATE work order. The saved task snapshots evidence and plan time, supports an optional same-version reviewer and open dependencies, and explicitly asks for a fresh review. It does not choose a fulfillment action or reserve/move resources. |
| Cross-project fulfillment triage (Phase 55) | Implemented; synthetic-tested only | One version-scoped core projection groups changed observations, uncovered requirements, reservation reviews, and open manual work. REST, MCP, AccountContext schema 26, and the Project Workbench use the same projection; UI links return to exact need/order details. Signals are review prompts, not causal conclusions or execution routes. |
| Craft planning | Partial; recipe inputs require player declaration | Exact supported recipe-knowledge evidence can be reviewed. Players can declare material needs, link them to manual craft work, and plan around observed supply. The system does not infer recipes/reagents, skill sufficiency, unlocks, output, or craftability. |
| Procurement planning | Partial; synthetic-tested | Supports explicit item need, buyer, player-entered ceiling/quote, dated gold and reservations, and manual purchase review. Market stock, price, seller, route, and affordability are not established. |
| Storage retrieval and provisioning | Partial; evidence-gated | Recent section observations can support manual retrieval/provision review. Storage ownership, character access, transfer route, and causation remain separate/unknown unless directly evidenced. |
| Observation-backed reconciliation | Partial; synthetic-tested | Shows comparable resource deltas, staleness, and contradictions with cause UNKNOWN. It cannot attribute disappearance/increase to a particular action or infer completion. |
| REST, AccountContext, MCP consistency | Implemented; automated-tested | Existing project/read-model projections are shared. MCP is read-only; project mutations remain player-authored through Dashboard/REST. |
| Browser workflow | Implemented; synthetic browser-tested | Temporary SQLite and headless-browser scenarios exercise project needs, planning, reservations, manual orders, evidence, and parity. These fixtures are not real-account or game validation. |
| Automatic cross-project optimizer / dependency scheduler | Missing | No global solver chooses craft/gather/buy/retrieve combinations, optimizes competing resources, or automatically schedules dependency graphs. |
| Verified general craft execution, market prices, and causal action attribution | Missing or unsupported | Must remain unknown until version-specific evidence and safe contracts exist. |
| Broader multi-character allocation and version-specific live acceptance | Requires live validation | Automated fixtures test logic. Current real observations validate only their documented characters/events and cannot establish account membership or general transfer rules. |

## Phase 49 player workflow

Open **Projects & Work Orders** for an active version, choose **Build grouped review** when at least two requirements have no current linked task, select up to four, optionally assign a same-version reviewer and open prerequisites, then create the review. The task retains each linked need and its evidence snapshot. The player must reopen linked needs after new imports before deciding whether to reserve, retrieve, craft, gather, procure, or leave them unresolved.

This workflow was exercised with synthetic data in a disposable SQLite database and a headless browser. It has not been live-game or production-validated.

## Next substantial milestone

Move from triage into a bounded multi-project fulfillment session: let the player select several explicitly scoped need rows from active projects, inspect combined reservations and current-source evidence, and create a revision-guarded grouped manual planning update without solving routes or claiming execution. Prove consistency in REST, AccountContext, MCP, and browser acceptance, including evidence changing between review and save.
