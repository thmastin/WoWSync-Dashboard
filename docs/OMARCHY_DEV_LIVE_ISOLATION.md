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
- DEV's authenticated capture receiver keeps its journal and receipts under a
  private directory in `/var/lib/wowsync-dev`; the durable sender spool remains
  on Windows. The receiver starts only with its DEV token, directory, and target
  configured together.
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
`WOWSYNC_DATA_DIR` and `WOWSYNC_DB_PATH`, and `127.0.0.1:4174`. With the DEV
capture environment configured, that same process starts the separate
authenticated, loopback-only receiver on `127.0.0.1:4175`, which exposes only
`POST /api/captures`.
`tools/omarchy/install-wowsync-dev.sh` installs `wowsync-dev.target` and the
`wowsync-dev` operator. The target starts the Dashboard/receiver together at
boot and groups start/stop/restart/status. A `PartOf=` drop-in makes stopping
the target stop the DEV Dashboard too. The Windows supervisor privately
forwards `4175` for captures and `4174` for the Dashboard browser on Windows
loopback. Neither listener is opened on the LAN; the capture listener is not a
proxy to general Dashboard routes.
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
`packages/mcp/src/index.ts`. Root-managed
`wowsync-dev-mcp-tunnel.service` runs the official tunnel-client v0.0.15 as
`wowsync-dev`, loads its restricted DEV tunnel key as a systemd credential,
and launches the local stdio MCP child with explicit DEV DB and research paths.
It is attached to `wowsync-dev.target`; there is no separate MCP daemon or HTTP
MCP endpoint. ChatGPT accepted the DEV tunnel on 2026-09-30; the tunnel ID
itself is not written here (see
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md#do-not-hard-code-the-live-tunnel-id)
for how to check the live value). Windows remains the
authoritative database host and capture source; its old MCP tunnel was retired
after acceptance while capture watching, transfer, SSH forwarding, and
scheduled startup remain. DEV import/watch commands and the Vite proxy also
need an explicit DEV URL/port; their defaults target 4173.

## Network boundary

UFW is the host firewall. Both `/etc/ufw/before.rules` and `before6.rules`
place `wowsync-dev` UID rules **before** UFW's loopback and established-connection
accepts. A narrow `ESTABLISHED` TCP reply exception lets DEV complete connections
to its own Dashboard; new connection rules remain in force. DEV may reach its
Dashboard on local TCP 4174 and local DNS on TCP/UDP 53; other host-local TCP/UDP
and UDP multicast (plus IPv4 broadcast) are denied.
An explicit TCP 4173 denial also covers any destination address, including a
future LAN-bound listener. Before activating any new LIVE API port, extend and
retest this UID policy. Never expose the unauthenticated Dashboard API to LAN.

The host-local deny also blocks the random loopback ports used by server tests.
Run networkless tests from a DEV Herdr pane in a private user/network namespace:
`unshare --user --map-root-user --net -- /usr/bin/bash -c 'ip link set lo up; npm test'`.
This gives the tests their own loopback without exposing host-local personal or
LIVE listeners. The mapped root is root only inside the new user namespace;
host files remain subject to `wowsync-dev` permissions. Do not open an ephemeral
host port range for tests. The full suite passed under this workflow on
2026-09-29; direct host-network execution failed on loopback-dependent cases.

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
"never"`, `sandbox_mode = "workspace-write"`, network enabled, and the DEV Herdr
configuration directory as an additional writable root. This was validated in a
fresh DEV Codex session: Herdr and the DEV Dashboard were reachable; LIVE IPv4/
IPv6, personal Herdr/control listeners, and Docker remained denied. The tested
filesystem boundary also denies DEV access to LIVE data/config/secrets. The
`wowsync-dev` user config trusts only that checkout. Neither config is copied to
the personal `thmastin` checkout; `.gitignore` excludes the DEV-local project
config. Each new DEV worktree must receive the same local config before Codex
starts. DEV Codex authentication is provisioned separately, not copied from the
personal account. See repository `AGENTS.md` for the single-primary-agent
operating model and human gates.
The DEV CLI uses a complete packaged 0.157.1 installation at
`/opt/wowsync/dev-tools/codex-npm-0.157.1`; the existing
`/usr/local/bin/wowsync-codex` launcher resolves it and enters the DEV checkout.
This was validated from a fresh launched session on 2026-09-30. See
[DEV_CODEX_PACKAGE_REPAIR.md](DEV_CODEX_PACKAGE_REPAIR.md) for package history
and remaining host-only daemon checks.
