# Omarchy DEV/LIVE isolation

This host layout separates WoWSync development from a future authoritative
Omarchy LIVE deployment. The authoritative Windows database remains on Windows
until a separate, human-approved migration and cutover. A directory or release
artifact on Omarchy is not evidence that LIVE is active.

## Trust boundary

| Role | Identity | Writable areas | Deliberately inaccessible |
| --- | --- | --- | --- |
| DEV checkout, Dashboard, agents, Herdr | `wowsync-dev` | `/home/wowsync-dev`, `/var/lib/wowsync-dev` | LIVE DB, config, secrets, backups, release writes, personal Herdr socket |
| Future LIVE Dashboard and importer | `wowsync-live` | `/var/lib/wowsync-live` | DEV checkout/worktrees |
| Release promotion and backups | administrator | `/opt/wowsync/releases`, `/var/backups/wowsync-live`, `/etc/wowsync`, system units and firewall | None by Unix permissions |

Neither service identity belongs to `wheel` or `docker`. The current personal
`thmastin` login does have administrator and Docker access, so it is **not** the
future autonomous DEV principal. A worktree prevents concurrent edits; Unix
ownership and the DEV-only Herdr socket enforce the host boundary.
An existing host-wide passwordless `asdcontrol` sudo rule was disabled by moving
`/etc/sudoers.d/asdcontrol` to
`/etc/sudoers.d/asdcontrol.pre-wowsync`. The separate `%wheel` rule in
`/etc/sudoers.d/omarchy-asdcontrol` preserves personal display control. Neither
WoWSync identity may have any sudo command privilege.

## Files and processes

- DEV Git checkout: `/home/wowsync-dev/src/WoWSync-Dashboard`; isolated task
  worktrees: `/home/wowsync-dev/worktrees/<task>`.
- Pinned, administrator-owned LIVE source release:
  `/opt/wowsync/releases/<commit>`. This is not a DEV Git checkout. The initial
  source archive is non-authoritative and needs a separately validated runtime
  dependency/web build promotion before any LIVE start.
- DEV and future LIVE SQLite: `/var/lib/wowsync-{dev,live}/db/wowsync.sqlite`.
  Each database's `-wal` and `-shm` files stay beside it on the local filesystem.
  LIVE SQLite does not exist until the later migration.
- Per-role `inbox/{staging,accepted,quarantine}`, `receipts`, and `state` live
  under `/var/lib/wowsync-{dev,live}`. Windows capture/transfer and importer
  services are later milestones; these directories are not active receivers.
- Per-role non-secret config directories: `/etc/wowsync/{dev,live}`. They are
  root-owned, group-readable only by the matching role. No production
  credentials are installed in this milestone.
- Root-private future LIVE backup target: `/var/backups/wowsync-live`.
  Neither account should rely on a network filesystem for SQLite/WAL.
- DEV research comes from the DEV checkout's `docs` tree; LIVE research comes
  from the pinned release's root-owned `docs` tree. Set
  `WOWSYNC_MCP_RESEARCH_ROOT` explicitly to that tree when launching MCP.
- Logs use the system journal. Runtime directories under `/run` can be added
  with `RuntimeDirectory=` when a service actually needs one.

Root-managed `wowsync-dev-dashboard.service` uses `User=wowsync-dev`, explicit
`WOWSYNC_DATA_DIR` and `WOWSYNC_DB_PATH`, and `127.0.0.1:4174`.
`wowsync-live-dashboard.service` uses `User=wowsync-live`, explicit LIVE paths,
and `127.0.0.1:4173`; it remains disabled and has an existing-DB condition.
`wowsync-dev-herdr.service` runs the DEV control plane as `wowsync-dev` with a
socket in that account's private Herdr configuration. LIVE has no Herdr unit.
The existing personal Herdr server is separate and remains under `thmastin`.
These are system units with explicit `User=` settings; they do not depend on
`thmastin`'s enabled systemd user linger.

The server path/port selectors are implemented in
`packages/server/src/index.ts` and `packages/server/src/net.ts`. The MCP uses
`WOWSYNC_MCP_DB_PATH` and `WOWSYNC_MCP_RESEARCH_ROOT` in
`packages/mcp/src/index.ts`. No MCP/tunnel unit is activated yet. Future MCP
launches must set those values explicitly and use the matching role's data and
research tree. DEV import/watch commands and the Vite proxy also need an
explicit DEV URL/port; their defaults target 4173.

## Network boundary

UFW is the host firewall. Both `/etc/ufw/before.rules` and `before6.rules`
place a `wowsync-dev` owner-match TCP rejection for destination port 4173
**before** UFW's loopback and established-connection accepts. The rule has no
destination-address restriction, so it covers IPv4, IPv6, loopback, and a
future LAN-bound listener on that port. Ports alone do not provide isolation;
private storage and credentials remain necessary. Before activating any new
LIVE HTTP/API port, extend and retest this UID policy. Do not bind the current
unauthenticated Dashboard API to the LAN.
The OUTPUT rule does not prevent DEV from binding port 4173 while LIVE is
absent, and the planned LIVE unit binds IPv4 only. Before any authoritative
LIVE HTTP service starts, verify listener ownership, reserve its port against
DEV impersonation, test both address families and aliases, and ensure clients
cannot reach a DEV listener through another local proxy. The current local
OpenClaw and Docker-related endpoints are not part of the validated boundary;
review them before granting unattended agent control.

## Validation and rollback

Acceptance requires testing from the actual `wowsync-dev` identity: denied
LIVE DB/config/backup/release access; denied personal Herdr socket and
privilege escalation; blocked read, import, delete, and Ask HTTP requests to
a reachable disposable LIVE fixture over IPv4 and IPv6; and successful DEV
dependency installation, TypeScript checks, full tests, web build, MCP
protocol tests, DEV SQLite, Dashboard, and Herdr startup. Fixtures must be
removed, LIVE DB absent, and the repository checkout clean afterward.

If rollback is needed before authoritative data exists: stop and disable only
the new WoWSync DEV units; restore the saved pre-WoWSync UFW files and reload
UFW; remove only the new WoWSync units and reload systemd; remove the new
DEV/LIVE directories and pinned release **only after confirming they contain
no authoritative data**; then remove the two service identities. Keep the
personal Herdr server and `thmastin` checkout untouched. After any LIVE
cutover, rollback requires a separate human-approved data recovery plan.
Restoring the host-wide `asdcontrol` rule is a separate administrator decision:
the saved file can be moved back to `/etc/sudoers.d/asdcontrol` after confirming
the target is absent, followed by `visudo -cf /etc/sudoers`. It must stay
disabled while the WoWSync DEV identity is an autonomous agent principal.

Before a LIVE start, promote and validate a complete pinned runtime release
(including dependencies and web build). The current `ConditionPathExists=`
checks only that a DB path exists; a zero-byte file could satisfy it, so it is
not a migration or health gate. Explicit role-specific MCP DB/research and
import/watch destination settings must be part of that later deployment.

The later autonomy bootstrap must move lead/worker execution into the
`wowsync-dev` identity and its Herdr control plane before enabling
`approval_policy = "never"`. It must not grant the DEV agent access to the
personal Herdr socket, `wheel`, Docker, or LIVE credentials.
