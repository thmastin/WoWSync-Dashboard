# WoWSync development rules

## Project and boundaries

This repository is the WoWSync Dashboard consumer, separate from the GearExport addon repository. Do not modify GearExport or BankCleanup unless Tate explicitly authorizes work there. Omarchy `wowsync-dev` is the development environment; Omarchy LIVE is inactive and has no authoritative database. The authoritative database remains on Windows. Do not migrate/cut over LIVE, change production credentials or destinations, or perform destructive LIVE work without Tate.

Keep Retail/Midnight, Classic BCC Anniversary, Classic Era, Forever, and Hardcore/SSF identities distinct. Quarantine ambiguous Hardcore/SSF rather than guessing. Preserve `OBSERVED`, `UNKNOWN`, `LAST_SEEN`, and `DERIVED`: UNKNOWN is never zero, inaccessible is never empty, and LAST_SEEN is never described as current. Preserve character, account/Warband, and guild ownership domains.

## Normal work

Use one primary development agent. It should inspect, implement, test, debug, and maintain project context itself. Use a Herdr worker only when an independent perspective or parallel investigation has clear value; keep its task bounded and give it an isolated worktree when editing. Never let parallel workers edit the same checkout.

For ordinary tasks, prefer the lowest-cost available model at medium reasoning effort (Luna Medium/Think-equivalent when available). Escalate to Sol Medium only when evidence shows the default is struggling or the task spans difficult interacting subsystems; reserve Sol High for consequential security, architecture, or database-migration decisions. Do not spawn a worker or escalate just because a task is large.

Investigate before consequential changes. Run relevant tests and builds; for the full suite on the host use the established private network-namespace workflow in `docs/OMARCHY_DEV_LIVE_ISOLATION.md`. Keep routine work on `feature/dashboard-integration`, review the diff, and commit/push validated work there. Never merge to `main` without Tate.

DEV Codex uses the repository-local `.codex/config.toml` with `approval_policy = "never"`, `sandbox_mode = "workspace-write"`, and network access enabled. This is for the isolated DEV identity only. Do not broaden it to danger-full-access or copy it into the personal checkout. The host firewall and Unix ownership provide the DEV/LIVE boundary; do not weaken them. DEV agents must not gain sudo, wheel, Docker, LIVE paths/secrets, or personal control sockets.

Tate approval is required for authoritative database migration, production credentials, Windows LIVE destination changes, destructive LIVE operations, merge to `main`, and addon deployment or live-game validation requiring `/reload`. Ordinary DEV edits, commands, tests, builds, and feature-branch Git work are autonomous.

## Current state and next milestone

Read [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) for the concise accepted state and next product milestone. Do not begin that milestone until requested; it is Windows capture/receiver routing and migration preparation, not part of autonomy setup.
