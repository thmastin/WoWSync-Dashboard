# Phase 109 — opt-in local MCP planning writes

Date: 2026-10-10

## Outcome

Added an optional planning-write mode to the local STDIO MCP adapter. Default MCP behavior remains read-only. When the process explicitly receives `WOWSYNC_MCP_PLANNING_API_URL` with a plain HTTP origin on numeric loopback (`127.0.0.1` or `::1`), four fixed tools record player planning intent through existing REST routes:

- `create_erp_project`
- `plan_erp_work_order_batch`
- `update_erp_project_plan`
- `replan_erp_reservations`

The adapter keeps SQLite retrieval read-only and has no generic HTTP proxy. REST retains project/version/character validation, review evidence and revision checks, atomic batch persistence, and decrease/release-only reservation semantics. Whole-plan replacement and reservation changes are marked destructive for MCP host confirmation. The work cannot trigger gameplay or resource movement.

## Safety and limits

The loopback origin rejects hostnames, remote IPs, HTTPS, credentials, paths, queries, and fragments. Requests are limited to 64 KB, responses to 2 MB, redirects are rejected, and calls time out after eight seconds. A configured Dashboard REST process remains a trusted local boundary; other local processes able to call it are outside this MCP adapter's identity model. The active Secure MCP Tunnel configuration is not enabled for planning writes, and no production profile was changed.

## Validation

A new synthetic stdio integration test runs MCP against an isolated Dashboard REST server and temporary SQLite database. It checks create, reviewed work-batch persistence, player-declared status, reservation reduction, rejected increase, stale revision rejection, version isolation, and parity among REST, AccountContext, and MCP readback. URL tests reject remote, hostname, HTTPS, path-bearing, and credentialed origins. No actual player data is used.

`npm.cmd run validate:erp` passed: Core 856; MCP 5; Server 269 passed plus 2 Windows-only skips; Web 315; TypeScript passed; Vite production build passed with the existing >500 kB chunk advisory; synthetic browser acceptance 22/22 passed. Independent review identified annotation and network-boundary improvements; these were implemented, then reviewer confirmed no remaining blockers. No browser test specifically exercised MCP host confirmation, and no live game, production Dashboard, or Secure Tunnel host-confirmation validation was performed.

## Repository state

Dashboard branch: `feature/forever-gear-observation`

Baseline before this change: `c926a86b52305dd67d7569fb535bfbf8d7cb56fd`

Final commit: pending commit and push.

## Next milestone

Run browser acceptance with the actual supported MCP host client and local Dashboard session, proving user confirmation for destructive annotations and consistent UI/REST/AccountContext/MCP state. Do not enable the Secure MCP Tunnel profile until that host behavior is deliberately validated. Then resume currency and shared-storage observation-interval reconciliation.
