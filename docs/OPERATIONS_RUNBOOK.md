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

`/home/wowsync-dev/releases/current/release.json` must also identify a completed SHA release before
this installer is run. The installer checks that precondition before touching units; it will not
start a Dashboard whose release path is missing. For the existing host, use the one-time topology
migration below rather than this installer.

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

## Exact-SHA DEV application releases

**Operational status on this infrastructure feature branch:** deployment infrastructure is
implemented for review only. Privileged bootstrap has **not** occurred and topology migration has
**not** occurred. Active DEV still runs Dashboard and MCP from
`/home/wowsync-dev/src/WoWSync-Dashboard`; Herdr also runs from that developer/source checkout.
`/home/wowsync-dev/releases/current` is the intended post-migration runtime path. Checked-in unit
paths do not describe the currently installed units until migration is separately approved and
completed. The live inline tunnel-ID configuration remains untouched.

The DEV source checkout and running application are separate:

- Agent/developer workspace: `/home/wowsync-dev/src/WoWSync-Dashboard`.
- Deployment Git cache and build staging: `/home/wowsync-dev/deploy/`.
- Completed, read-only-by-mode release: `/home/wowsync-dev/releases/<full-40-character-sha>`.
- Active runtime pointer: `/home/wowsync-dev/releases/current`, an atomically replaced symlink
  directly to one SHA-named release.
- Persistent mutable data remains under `/var/lib/wowsync-dev/`, including SQLite and its WAL,
  captures, receipts, inbox, and deployment audit/backup data. Promotion never relocates or
  recreates it.

The release tree's removed write bits are an accidental-change guard, not a security boundary:
`wowsync-dev` owns both releases and its developer checkout and can restore those bits. The useful
isolation is that ordinary source-checkout edits do not alter a separate release path, while the
systemd service sandbox mounts application source read-only and mutable state under `/var/lib`.

After topology migration, Dashboard and MCP use `releases/current`. Herdr continues to use the source checkout and is not
part of application promotion. The app units are restarted by name; never restart
`wowsync-dev.target` for an application release because that also affects the tunnel through
`PartOf=` and makes the lifecycle less explicit.

### One-time privilege bootstrap (administrator-controlled trusted export)

Root must never execute privileged content directly from the wowsync-dev-writable checkout. Tate
reviews the exact full infrastructure commit SHA and every hash in its artifact manifest before
authorizing the bootstrap. The administrator fetches that reviewed branch into a root-owned bare
mirror, verifies the resulting full SHA, exports the commit to a root-owned directory, and marks
the export read-only:

```bash
REVIEWED_SHA=FULL_REVIEWED_SHA
sudo install -d -o root -g root -m 0700 /root/wowsync-deploy-review.git /root/wowsync-deploy-export
sudo git -C /root/wowsync-deploy-review.git init --bare
sudo git -C /root/wowsync-deploy-review.git remote add origin REVIEWED_REPOSITORY_URL
sudo git -C /root/wowsync-deploy-review.git fetch origin refs/heads/feature/dev-exact-sha-deploy
test "$(sudo git -C /root/wowsync-deploy-review.git rev-parse FETCH_HEAD^{commit})" = "$REVIEWED_SHA"
sudo git -C /root/wowsync-deploy-review.git archive "$REVIEWED_SHA" | sudo tar -x -C /root/wowsync-deploy-export --no-same-owner
printf '%s\n' "$REVIEWED_SHA" | sudo tee /root/wowsync-deploy-export/.reviewed-source-sha >/dev/null
sudo chown root:root /root/wowsync-deploy-export/.reviewed-source-sha
sudo chmod 0444 /root/wowsync-deploy-export/.reviewed-source-sha
sudo chmod -R a-w /root/wowsync-deploy-export
sudo sha256sum --check --strict /root/wowsync-deploy-export/ops/privileged-artifact-sha256.txt
sudo /root/wowsync-deploy-export/tools/omarchy/bootstrap-wowsync-dev-deploy.sh "$REVIEWED_SHA"
```

Replace both uppercase placeholders only with values Tate has checked from the reviewed commit.
Tate independently verifies the four pinned values in `ops/privileged-artifact-sha256.txt` against
the same SHA before authorizing the command. The bootstrap rechecks the marker, root ownership/no
group-world write bits, and hashes before installing anything. It stages helpers as root-owned
files and restores the previous sudoers file if full configuration validation fails.

The installed helper accepts only `stop`, `start`, `restart`, or a bounded `warnings UTC_TIMESTAMP`
query. Its service operations name only `wowsync-dev-dashboard.service` and
`wowsync-dev-mcp-tunnel.service`; its journal query reads warnings for only those units. It rejects
extra arguments and arbitrary unit names. `wowsync-dev` receives no general `systemctl` access or
arbitrary root shell. The helper uses systemd's `ignore-dependencies` job mode on its fixed app-unit list
so stopping Dashboard does not deactivate `wowsync-dev.target` through `Requires=`. The sudoers
rule grants no `SETENV`; during bootstrap Tate confirms the host's effective `env_reset` default
and checks `sudo -l`/the sudoers configuration for any matching `SETENV` grant. Journal access is limited to warnings
for the two fixed units. Bootstrap validates the exact temporary sudoers content before atomic
rename. Root never runs Git build hooks, `npm ci`, tests, or application build scripts.
Until an administrator performs the bootstrap, DEV retains its current no-sudo state. This
bootstrap is the documented narrow exception to the prior no-sudo rule.

The normal deployment command itself runs as `wowsync-dev`. It fetches the requested full remote
ref into a separate bare cache, requires that fetched ref to resolve to the exact supplied SHA,
exports that SHA (not a branch checkout), then runs `npm ci`, `tsc --noEmit` for core/server/MCP/web,
the full `npm test` suite in the documented private network namespace, and `npm run build:web` in fresh staging.
Every release gets its own dependencies and build. It rejects modified/missing tracked files,
unexpected source files, dependency symlinks escaping the release, and any collision with an
existing SHA release. It does not use the source checkout's `node_modules` and does not overwrite
an existing release.

For the correction pass, the reviewed version-2 deploy-tool implementation is commit
`12c5d352a383075e4bdea59d1a3cbe8aa29c5a54`; use that reviewed code for topology migration. The wrapper and
Node entry point still run from the mutable developer checkout; every record captures that checkout
Git SHA, dirty flag, Node entry SHA-256 and wrapper SHA-256. Before promotion, verify the recorded
tool identity corresponds to the independently reviewed infrastructure commit. The SHA identifies
the checkout revision; file hashes and dirty state expose local edits but do not make the checkout
immutable.

Prepare/build without changing the live runtime:

```bash
/home/wowsync-dev/src/WoWSync-Dashboard/tools/omarchy/wowsync-dev-deploy prepare \
  FULL_40_CHARACTER_SHA refs/heads/feature/your-branch
```

Promote the exact prepared SHA. Supply optional feature-route expectations as `--route
PATH=STATUS`; the defaults check `/` and `/api/versions` for HTTP 200. Promotion verifies the ref
again, validates the release, records an intent before mutation, stops only Dashboard and MCP,
records pre-change schema/data evidence, creates a SQLite online backup, atomically switches
`current`, starts only those two units, polls Dashboard readiness to a bounded timeout, holds a
short settle window, then checks service state, HTTP, schema compatibility, Herdr PID, target
state, and restart counters at zero/stable for this invocation. Counts and demand observations are
audit evidence; capture writes during validation are allowed and do not trigger false data rollback.
A schema change prevents automatic restart of old code. `node:sqlite` online backup includes committed WAL contents;
backup integrity is checked and its SHA-256 and path are recorded. Audit JSONL is at
`/var/lib/wowsync-dev/deployments.jsonl`.

```bash
/home/wowsync-dev/src/WoWSync-Dashboard/tools/omarchy/wowsync-dev-deploy promote \
  FULL_40_CHARACTER_SHA refs/heads/feature/your-branch \
  --route /api/versions/retail/allocation-review=200
```

If validation fails with unchanged schema, the tool switches back to the prior release, restarts
only Dashboard/MCP, and validates that recovery before claiming success. During initial same-SHA
topology migration, failure stops the application units and requires reverse-topology recovery;
resetting the pointer is not reported as restoring the source-checkout topology. If schema changed,
services remain stopped for operator review and old code is not started. Code rollback is not
database rollback. Forward-only schema changes may prevent safe automatic code rollback. Database
restoration is a separate explicit decision and may discard post-backup observations.

Rollback to a retained SHA is:

```bash
/home/wowsync-dev/src/WoWSync-Dashboard/tools/omarchy/wowsync-dev-deploy rollback \
  PREVIOUS_FULL_40_CHARACTER_SHA
```

Rollback takes another consistent backup, changes only the code pointer, restarts only Dashboard
and MCP, and runs the same HTTP/database/service/journal checks.

### One-time topology migration, without application-code change

Do not run this migration as part of building or installing the tooling. After independent review,
the first release must be the currently running application SHA
`81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`. The expected branch must still resolve to that exact
SHA; if it has moved, stop and identify a remote ref that resolves to the same commit.

1. Capture current unit/data/HTTP state, prepare and build the exact release, and take a consistent
   online backup before changing units:

   ```bash
   tools/omarchy/wowsync-dev-deploy prepare \
     81f66eeb8a035acf3c633f6fa9d8693cc4f9a009 \
     refs/heads/feature/erp-slice3-held-item-identity
   tools/omarchy/wowsync-dev-deploy backup topology-migration \
     --route /api/versions/retail/allocation-review=404
   ```

2. Complete the one-time helper bootstrap above. Then seed `current` to the same SHA without
   restarting services. This verifies both old application processes still use the source checkout
   and the explicitly supplied running SHA:

   ```bash
   tools/omarchy/wowsync-dev-deploy seed-initial \
     81f66eeb8a035acf3c633f6fa9d8693cc4f9a009 \
     refs/heads/feature/erp-slice3-held-item-identity \
     --previous-runtime-sha 81f66eeb8a035acf3c633f6fa9d8693cc4f9a009
   ```

3. As administrator, run the installed migration helper. It validates both proposed unit files and
   the exact same-SHA release/current pointer before touching either unit, makes root-owned
   timestamped backups, then replaces both files transactionally and daemon-reloads without
   restarting services. It preserves the live MCP tunnel-ID command exactly:

   ```bash
   sudo /usr/local/libexec/wowsync-dev/migrate-runtime-paths apply
   ```

   Do not run the broad unit installer here: the live MCP unit has an unrelated inline tunnel-ID
   deviation, and the tracked env-file form is not being migrated in this milestone. Migration
   preserves every other installed unit line.
4. Promote the same SHA through the new path. The explicit previous-runtime SHA identifies initial
   topology migration; the tool verifies both Dashboard and MCP still run from the source
   checkout and compares application source against the explicitly supplied old runtime SHA. It
   records its own Git SHA and identifies the tool workspace as mutable; it does not assume the
   developer checkout HEAD identifies the running application.

   ```bash
   tools/omarchy/wowsync-dev-deploy promote \
     81f66eeb8a035acf3c633f6fa9d8693cc4f9a009 \
     refs/heads/feature/erp-slice3-held-item-identity \
     --previous-runtime-sha 81f66eeb8a035acf3c633f6fa9d8693cc4f9a009 \
     --route /api/versions/retail/allocation-review=404
   ```

   Promotion creates a second just-in-time backup after stopping the app units, then switches the
   pointer and starts Dashboard/MCP. Herdr remains running from the developer checkout. Verify
   resolved process working directories, exact release SHA, service `Result`/`NRestarts`, route
   results, database checks, Herdr PID, and journal warnings before accepting the topology.

If same-SHA promotion fails after units were migrated, it leaves the application services stopped
and reports that no old runtime was restored. The exact reverse-topology action is:

```bash
sudo /usr/local/libexec/wowsync-dev/migrate-runtime-paths restore CURRENT
```

That command restores the timestamped original Dashboard/MCP unit files, daemon-reloads, starts
only Dashboard and MCP, and verifies both processes returned to the source-checkout path plus
Dashboard HTTP/API health. It leaves Herdr alone and does not restore SQLite. Review the promotion
audit and database backup separately before deciding any database recovery.

After that topology is independently accepted, the first feature promotion is the ERP Allocation
Tab SHA below. This is the future command; it is not part of the infrastructure migration:

```bash
tools/omarchy/wowsync-dev-deploy promote \
  51628e4514448bb9cfdb56c1214d27ee38fa92e3 \
  refs/heads/feature/erp-allocation-tab \
  --route /api/versions/retail/allocation-review=200
```

The tool will refuse if the remote ref no longer resolves to that exact SHA.

### Audit and retention

Each successful prepare writes a `release.json` with full SHA, verified remote ref/origin, prepare
time, and the Git source manifest. `deployments.jsonl` is an operational audit log, not tamper-proof
history: `wowsync-dev` owns it. Each record has a schema version and the deployment tool version,
Git SHA, and entry-file hash (the tool is run from a mutable developer checkout). Intent and
success/failure records identify requested SHA/ref, prior/candidate SHA, backup result, schema
change, service and HTTP validation, and recovery attempt/result. Journal collection is diagnostic;
its failure is recorded and cannot trigger rollback. Audit-write failure before mutation prevents
the action; after successful validation it is reported without turning the healthy candidate into
an automatic rollback. The log and backups are outside releases and SQLite.

Do not automatically prune releases or backups. Retain the active release and at least the two
previously validated releases; retain all SQLite deployment backups for at least 90 days and the
10 most recent. Manual pruning must confirm a release is not `current`, no process working
directory resolves into it, and no open validation/rollback record relies on its backup.

Follow-up hardening intentionally deferred: release metadata hashes tracked source but not generated
`node_modules`/`dist`; workspace symlink checks do not cover all Node parent-directory lookups;
failed prepare and pointer-temp cleanup can leave artifacts for inspection; and same-identity
ownership/mode is not a security boundary. Schema-only validation removes full-row hashing from the
promotion path and avoids blocking on ordinary capture writes.

### Tool acceptance checks

Run the isolated tooling tests with:

```bash
npm run test:deploy-tool
```

They use temporary Git remotes, release directories, symlinks, and fixture SQLite databases to
exercise malformed SHA/ref handling, remote mismatch, build failure, dirty source, collision,
self-contained workspace links, atomic pointer/rollback behavior, WAL-aware backup integrity, and
helper argument rejection. Before first use, also prepare the current SHA and run it as a canary
from a disposable fixture database/private network namespace; do not point `current` at it or
restart the live services during acceptance.

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
