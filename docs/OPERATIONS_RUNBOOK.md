# Operations Runbook

This is the operating/deploying reference for the Omarchy DEV runtime. It documents what is now
tracked in this repository (`ops/systemd/`, `tools/omarchy/`) and what remains host-only and
outside the repository's control. For the Unix-identity trust boundary and firewall rules this
runbook assumes, see [`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md). For the MCP
protocol/tool details, see [`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) and
[`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md).

## Do not hard-code the live tunnel ID

**This runbook deliberately does not state the current tunnel ID, and no other document in this
repository should either.** A tunnel ID is a volatile operational fact, not architecture — writing
it into documentation guarantees it goes stale the next time the tunnel is reissued. To find the
live value:

```bash
# On the DEV host, as a user who can read the systemd unit (does not require starting/stopping anything):
systemctl cat wowsync-dev-mcp-tunnel.service
# Then inspect the EnvironmentFile it references (root-only; requires sudo to read):
sudo cat /etc/wowsync/dev/mcp-tunnel.env
```

or check the live `tunnel-client` control-plane state directly (Platform → Organization → Tunnels
in the OpenAI dashboard). Do not rely on a tunnel ID written in any Markdown file in this
repository — if you find one, it is stale by construction and should be replaced with this
pointer (see "Tunnel-ID cleanup performed in this milestone" below).

## DEV systemd topology

Four tracked units/target under `ops/systemd/`, reconstructed from the live host's `systemctl cat`
output so the topology is reviewable and reproducible from the repository, not only discoverable
by inspecting the live host:

| Unit | Role | Tracked? |
|---|---|---|
| `wowsync-dev.target` | Umbrella target. On **start**, `Requires=`/`After=` only pull in `wowsync-dev-dashboard.service` — intentionally **not** `mcp-tunnel` or `herdr`; starting the target does not by itself start either of those two. | Yes (`ops/systemd/wowsync-dev.target`) |
| `wowsync-dev-dashboard.service` | DEV dashboard web server, loopback port 4174, plus the authenticated capture receiver on loopback port 4175. | Yes (`ops/systemd/wowsync-dev-dashboard.service`) |
| `wowsync-dev-dashboard.service.d/90-wowsync-dev-target.conf` | Drop-in supplying `PartOf=wowsync-dev.target`, so stopping the target stops the DEV dashboard too. | Yes |
| `wowsync-dev-mcp-tunnel.service` | Runs `tunnel-client` (MCP control-plane tunnel), which spawns the MCP server as its stdio child. Declares `PartOf=wowsync-dev.target` **on itself** — see "Stop/restart lifecycle" below. | Yes (`ops/systemd/wowsync-dev-mcp-tunnel.service`) |
| `wowsync-dev-herdr.service` | Runs `herdr server` (DEV agent control plane). No `PartOf=`/target relationship in either direction, matching live. | Yes (`ops/systemd/wowsync-dev-herdr.service`) |

A separate, **untracked** `capture.conf` drop-in exists live on the dashboard service
(`EnvironmentFile=/etc/wowsync/dev/capture.env`) and is intentionally out of scope for this
repository — it is host-provisioned, like the other host-only prerequisites below.

### Stop/restart lifecycle: start-dependency vs. `PartOf=` are not the same relationship

These are two different systemd mechanisms and the target's unit file only tells you about one of
them. `wowsync-dev.target`'s own `Requires=`/`After=` (above) governs what starting the target
pulls in — dashboard only. But `wowsync-dev-mcp-tunnel.service` separately declares
`PartOf=wowsync-dev.target` **in its own unit file**
(`ops/systemd/wowsync-dev-mcp-tunnel.service`), which governs the *stop/restart* direction
independently of the start direction: **`systemctl stop`/`restart wowsync-dev.target` also
stops/restarts `wowsync-dev-mcp-tunnel.service`**, exactly like the dashboard drop-in's `PartOf=`
does for the dashboard. `wowsync-dev-herdr.service` has no `PartOf=` declaration anywhere, so it is
unaffected by the target's stop/restart in either direction — stopping the target does **not**
stop herdr. Verify this yourself with `systemctl cat wowsync-dev-mcp-tunnel.service` (read-only;
does not start/stop anything) rather than trusting this paragraph if it matters for an operation
you're about to perform.

## Tracked vs. host-only-provisioned

Tracked by this repository (the **service definitions** are reconstructable by running the
install script against a fresh host that already has the host-only prerequisites below — see
"Install / reconstruction process" for exactly what the script does and does not start/enable):

- All four unit/target files and the dashboard drop-in, under `ops/systemd/`.
- `ops/systemd/wowsync-dev-mcp-tunnel.env.example` — a placeholder `EnvironmentFile` shape, never
  a real value.
- `ops/systemd/README.md` — the short topology summary this runbook expands on.
- `tools/omarchy/install-wowsync-dev.sh` — installs all unit files and the `wowsync-dev` status
  CLI.
- `tools/omarchy/wowsync-dev` — the `start|stop|restart|status` operator CLI.

**Not** tracked — host-only prerequisites that must already exist before the tracked units can
actually run:

- The `wowsync-dev` system user/group and `/home/wowsync-dev`.
- The `tunnel-client` binary itself
  (`/opt/wowsync/dev-tools/tunnel-client/v0.0.15/tunnel-client`).
- The `herdr` binary itself (`/usr/bin/herdr`).
- `/etc/wowsync/dev/tunnel-api-key` — the real tunnel-client control-plane API key, loaded via
  systemd `LoadCredential=`.
- `/etc/wowsync/dev/mcp-tunnel.env` — the real `CONTROL_PLANE_TUNNEL_ID` value. Provisioned
  manually from `wowsync-dev-mcp-tunnel.env.example`; the install script deliberately does not
  create or populate it.
- `/etc/wowsync/dev/capture.env` — consumed by the dashboard's untracked `capture.conf` drop-in.

Credential and tunnel-ID *values* are never committed anywhere in this repository — only path
references and the one placeholder `.example` file.

## `tunnel-client`'s native tunnel-ID handling

`tunnel-client` natively reads the tunnel ID from the `CONTROL_PLANE_TUNNEL_ID` environment
variable (equivalent to its `--control-plane.tunnel-id` flag). The committed
`wowsync-dev-mcp-tunnel.service` sources this via an optional
`EnvironmentFile=-/etc/wowsync/dev/mcp-tunnel.env` (the leading `-` means the unit still starts
without the file present, though `tunnel-client` will then fail its own startup validation until
it's provisioned). This is deliberate: the real tunnel ID is never inlined on a command line or
committed with the unit.

## Windows-capture -> Omarchy-receiver relationship

The Windows side continues to own SavedVariables watching, DEV capture transfer, and scheduled
startup (see [`WINDOWS_CAPTURE_SETUP.md`](WINDOWS_CAPTURE_SETUP.md)); its own former MCP tunnel
ownership was retired once the Omarchy tunnel was accepted (see "DEV vs. LIVE separation" below —
this is the one place Windows previously ran an MCP component, and it no longer does). The Windows
supervisor privately forwards capture traffic to the Omarchy DEV dashboard's authenticated
receiver on loopback port 4175 (`POST /api/captures` only — not a proxy to general Dashboard
routes) and the Dashboard browser view to loopback port 4174. Neither listener is exposed on the
LAN.

## Secure MCP Tunnel model: outbound-only, no inbound listener

**No inbound public MCP listener exists anywhere in this architecture.** The dedicated MCP process
communicates with `tunnel-client` over local stdio only; `tunnel-client` itself initiates outbound
HTTPS to OpenAI's control plane. There is no TCP/HTTP port the MCP process itself listens on, and
no public Dashboard/MCP endpoint. See `ARCHITECTURE_INVARIANTS.md` (MUTATION/SECURITY) for the
read-only guarantees layered on top of this transport.

## Install / reconstruction process

Once the host-only prerequisites above exist:

```bash
./tools/omarchy/install-wowsync-dev.sh
```

**What this script actually does, precisely** (verified against `tools/omarchy/install-wowsync-dev.sh`
itself — re-check it yourself if this ever needs to be authoritative for an operation):

- **Installs** (copies to `/etc/systemd/system/`, root-owned, mode 0644) all four unit files and
  the dashboard drop-in, and installs the `wowsync-dev` CLI (mode 0755) to
  `/usr/local/bin/wowsync-dev`.
- Runs `systemctl daemon-reload`.
- **Enables and starts** `wowsync-dev.target` only. Because the target's `Requires=` pulls in
  `wowsync-dev-dashboard.service` (see "DEV systemd topology" above), this transitively starts the
  dashboard too, and the script additionally runs `systemctl disable wowsync-dev-dashboard.service`
  directly (it's meant to be started only via the target, not independently enabled).
- **Does NOT enable or start `wowsync-dev-mcp-tunnel.service` or `wowsync-dev-herdr.service`.**
  Running this script on a fresh host reproduces the *service definitions* for all four
  units/target, but produces a *running* topology that covers the dashboard only — the MCP tunnel
  and herdr remain stopped (and not enabled for boot) until an operator explicitly runs, for
  example, `sudo systemctl enable --now wowsync-dev-mcp-tunnel.service wowsync-dev-herdr.service`
  as a separate, deliberate step.
- Does **not** create or populate `/etc/wowsync/dev/mcp-tunnel.env` — that must be provisioned
  manually with the real tunnel ID before `wowsync-dev-mcp-tunnel.service` can actually connect,
  even once it's enabled/started.

In short: this script reconstructs the **tracked service definitions** reliably from a clean
checkout. It does **not**, by itself, reconstruct a running ChatGPT-facing DEV MCP runtime — that
requires the host-only prerequisites (binaries, credential files) to already exist *and* the
explicit enable/start step above for the two services it deliberately leaves untouched. Whether
mcp-tunnel/herdr should auto-start alongside the target is a separate decision this runbook does
not make.

## Safe, read-only validation commands

Use these to inspect the DEV runtime without mutating anything:

```bash
# Confirm unit file syntax without installing/starting anything:
systemd-analyze verify ops/systemd/wowsync-dev.target
systemd-analyze verify ops/systemd/wowsync-dev-dashboard.service
systemd-analyze verify ops/systemd/wowsync-dev-mcp-tunnel.service
systemd-analyze verify ops/systemd/wowsync-dev-herdr.service

# Inspect the live installed unit (read-only):
systemctl cat wowsync-dev-mcp-tunnel.service
systemctl status --no-pager --full wowsync-dev.target wowsync-dev-dashboard.service \
  wowsync-dev-mcp-tunnel.service wowsync-dev-herdr.service

# The repo's own read-only status helper (runs `systemctl status` plus a couple of
# unauthenticated-expected probe requests; does not start/stop/restart anything):
wowsync-dev status
```

Never run a mutating command (`systemctl start/stop/restart`, `install-wowsync-dev.sh` against a
live host you don't intend to change) as part of a documentation/validation pass. `wowsync-dev
start|stop|restart` exist for normal operation, not for doc validation.

## DEV vs. LIVE separation

DEV (`wowsync-dev` identity) and the future LIVE deployment (`wowsync-live` identity) are
separated by Unix ownership, firewall rules, and distinct service units — never by convention
alone. LIVE has no Herdr unit, no MCP tunnel, and (as of this baseline) no authoritative database;
Omarchy LIVE has not been cut over. See
[`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md) for the full trust-boundary table
and network rules this runbook assumes but does not repeat.

## Tunnel-ID cleanup performed in this milestone

As part of this documentation pass, hard-coded tunnel ID values were removed from
[`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md) and
[`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) (both the current DEV tunnel ID and the retired old
Windows tunnel ID previously kept as rollback-reference text). Both now point here instead. This
was motivated by two findings: `OMARCHY_DEV_LIVE_ISOLATION.md`'s previously-written value did not
match the live service (most likely a copy-paste slip from the old retired Windows tunnel ID);
`MCP_DEVELOPMENT.md`'s value was separately found to match live correctly at the time it was
checked. Rather than fix one and leave a volatile fact duplicated in two places (where it will go
stale again), both were replaced with the live-inspection pointer above.
