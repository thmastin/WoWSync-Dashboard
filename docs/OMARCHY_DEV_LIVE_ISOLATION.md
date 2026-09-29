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
`wowsync-live-dashboard.service` remains disabled and has an existing-DB
condition. Its pinned release and TCP bind are **not cutover-ready**: before any
LIVE start, promote a release containing `WOWSYNC_LISTEN_SOCKET` support and
configure it to listen on `/run/wowsync-live/dashboard.sock` under a private
`RuntimeDirectory=wowsync-live` with mode `0700`.
Root-managed `wowsync-live-proxy.socket` reserves both `127.0.0.1:4173` and
`[::1]:4173` even while LIVE is offline. Its socket-activated proxy forwards
to that private LIVE Unix socket; without a LIVE backend, it serves no account
data. Neither LIVE Dashboard nor importer is running.
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
place `wowsync-dev` UID rules **before** UFW's loopback and established-connection
accepts. DEV may reach its Dashboard on local TCP 4174 and local DNS on TCP/UDP
53; other host-local TCP/UDP and UDP multicast (plus IPv4 broadcast) are denied.
An explicit TCP 4173 denial also covers any destination address, including a
future LAN-bound listener. Before activating any new LIVE API port, extend and
retest this UID policy. Never expose the unauthenticated Dashboard API to LAN.

The root-owned proxy socket, not `SocketBindDeny=` alone, prevents DEV from
impersonating the expected LIVE loopback endpoint. `SocketBindDeny=4173` on
the DEV Herdr and Dashboard units adds defense within those service cgroups.
SSH denies logins by both WoWSync service identities, including the host's
world-connectable local SSH socket; DEV service namespaces also hide that
socket, personal home/user bus, LIVE trees, and system D-Bus/CUPS sockets.
DEV has no personal Herdr, Docker, sudo, LIVE credential, or LIVE file access.
Ports and worktrees are not substitutes for the Unix identity boundary.

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

For the autonomy bootstrap specifically, the administrator backup directory
reported by the host apply script contains the previous UFW and DEV unit files.
Rollback must also disable `wowsync-live-proxy.socket`, remove its two unit
files and the WoWSync SSH deny drop-in, reload UFW/systemd, and remove the
root-owned DEV Codex binary/templates under `/opt/wowsync/dev-tools` if the
DEV control plane is being retired. DEV-home Codex configuration and skill
files are removed only as `wowsync-dev`, after stopping DEV agents. Never remove
the personal Herdr server or the LIVE data tree as part of this rollback.

Before a LIVE start, promote and validate a complete pinned runtime release
(including dependencies and web build). The current `ConditionPathExists=`
checks only that a DB path exists; a zero-byte file could satisfy it, so it is
not a migration or health gate. Explicit role-specific MCP DB/research and
import/watch destination settings must be part of that later deployment.

The DEV-only checkout has a local `.codex/config.toml` with `approval_policy =
"never"`, `sandbox_mode = "workspace-write"`, network disabled, and only the
DEV Herdr configuration directory as an additional writable root. The
`wowsync-dev` user config only trusts that checkout. Neither config is copied
to the personal `thmastin` checkout; `.gitignore` excludes the DEV-local
project config. Each new DEV worktree must receive the same local config
before a Codex worker starts. These settings are not considered accepted until
a fresh DEV lead proves effective sandbox behavior, DEV-only orchestration,
and inability to access personal or LIVE controls. DEV Codex authentication
must be provisioned separately without copying personal credentials.
