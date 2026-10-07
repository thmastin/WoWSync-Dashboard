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
- `tools/omarchy/wowsync-dev-deploy` (launcher), `tools/omarchy/wowsync-dev-deploy.mjs` (deploy
  tool), `tools/omarchy/wowsync-dev-app-services` (service helper), `ops/sudoers/wowsync-dev-deploy`,
  and `tools/omarchy/install-wowsync-dev-deploy.sh` — see "Deploying to DEV" below.

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
start a Dashboard whose release path is missing. The existing host is already installed; application
changes are deployed with `wowsync-dev-deploy deploy` (see "Deploying to DEV"), never by re-running
this installer. On a rebuilt host, create the first release with `wowsync-dev-deploy prepare BRANCH
FULL_SHA` (run as `wowsync-dev` from an export of the reviewed commit, as in "First deployment with
this tool"), then point `current` at it once:
`ln -sfn /home/wowsync-dev/releases/FULL_SHA /home/wowsync-dev/releases/current`.

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

## Deploying to DEV

The persistent DEV Dashboard and MCP run from an immutable release of one exact Git SHA, never from
a workspace. People and agents work freely in their own checkouts and worktrees; nothing done there
reaches the running DEV runtime until someone deliberately deploys a pushed SHA.

### Routine deployment

1. Validate the change in its workspace (tests, typecheck, build).
2. Push the exact commit.
3. Deploy that SHA:

```bash
wowsync-dev-deploy deploy feature/your-branch FULL_VALIDATED_SHA
```

The ref may be a branch name, `refs/heads/...`, or `refs/tags/...`. The SHA is the commit that was
validated (normally the full 40 characters; at least 7). Optional: `--route /path=STATUS` adds a
feature-specific check to the defaults (`/` and `/api/versions` must return 200), and `--json`
prints the full evidence record instead of the summary. A successful deployment prints:

```text
DEV DEPLOYED
SHA:                 <deployed sha>
Ref:                 refs/heads/feature/your-branch
Previous:            <previous sha>
Release:             built and tested in staging
Data backup:         OK, integrity ok (/var/lib/wowsync-dev/backups/deploy/...sqlite)
Schema:              unchanged
Dashboard:           healthy (/ 200, /api/versions 200)
MCP:                 healthy
Herdr:               untouched
Journal warnings:    none
Details:             /var/lib/wowsync-dev/deployments.jsonl (or --json)
```

Deploying the SHA that is already running prints `DEV ALREADY AT <sha>` and changes nothing. To see
what is deployed and whether it is healthy at any time (read-only):

```bash
wowsync-dev-deploy status
```

Agents deploy to DEV only when explicitly asked, with exactly this command and the SHA they
validated (see `AGENTS.md`).

### What `deploy` does

1. Fetches the ref from origin into a private bare cache and requires it to point at the validated
   SHA. A moved or unpushed ref stops here.
2. Confirms DEV has a deployed release and that Dashboard/MCP are configured to run from
   `releases/current`.
3. If `releases/<sha>` does not exist yet, builds it: exports exactly that commit into fresh
   staging, runs `npm ci`, `tsc --noEmit` for core/server/MCP/web, the full `npm test` suite in a
   private network namespace, and `npm run build:web`; checks that the source still matches Git and
   that no dependency link escapes the release; then makes the release read-only. A failure
   discards the staging tree. An existing release is re-verified against Git and reused.
4. If that SHA is already deployed, checks health and reports `DEV ALREADY AT` (no restart, no
   backup) — unless the audit log's last release switch is an intent with no recorded result (or
   its last line is unreadable), which reports `DEV DEPLOY INTERRUPTED — REVIEW REQUIRED` instead
   (see below).
5. Otherwise predicts the candidate's schema change (the **schema plan**): the running release's and
   the candidate's own `SqliteSnapshotStore` each initialize a fresh disposable database under
   `/home/wowsync-dev/deploy/staging/schema-plan-*`, which is removed afterwards; the real database is
   never opened. A predicted change that is not exactly declared (see "Deploying an expected
   additive schema change") stops the deployment here, before anything is stopped.
6. Otherwise records its intent, stops only Dashboard and MCP, takes an integrity-checked SQLite
   online backup (which includes committed WAL data), atomically switches `releases/current`, starts
   Dashboard and MCP, waits for readiness plus a settle window, and verifies: both units are fresh
   invocations started from `releases/current` resolving to the new SHA, restart counters are zero,
   the HTTP routes answer as expected, the database schema is unchanged (or changed by exactly the
   declared additions), Herdr's process is unchanged, and `wowsync-dev.target` is still active. This
   check of the real database is authoritative; the plan in step 5 can only refuse a deployment.
7. Appends the full evidence to `/var/lib/wowsync-dev/deployments.jsonl` and prints the summary.

Steps 1–5 never touch the running services. Mutating commands hold
`/home/wowsync-dev/deploy/deploy.lock`; a second concurrent deployment reports
`DEV DEPLOY NOT STARTED — another deployment is running` and exits.

### When a deployment fails

| First line | What happened | Running afterwards | Manual intervention |
| --- | --- | --- | --- |
| `DEV DEPLOY FAILED — DEV UNCHANGED` | Failed before any service was stopped (ref/SHA mismatch, build or test failure, DEV already unhealthy, a schema plan that is not exactly declared, or a schema plan that could not be computed). | Previous release, untouched. | No — fix the cause and deploy again. |
| `DEV DEPLOY FAILED — RECOVERED` | The new release failed validation with an unchanged schema — or with exactly the declared additions and `--previous-code-compatible` (`Schema: additions retained: ...`); the previous release was restarted and validated. | Previous release. | No. The database is not restored: writes made while the new release ran remain, declared additions stay, and the pre-deploy backup is kept. |
| `DEV DEPLOY FAILED — DASHBOARD/MCP STOPPED` | The schema changed in a way that was not declared, changed by declared additions without `--previous-code-compatible`, or could not be verified, so old code was not started against it. | Nothing (Dashboard/MCP stopped). | **Yes** — decide schema compatibility (see below). |
| `DEV DEPLOY INTERRUPTED — REVIEW REQUIRED` | The requested SHA is already `current`, but the last release switch in the audit log never recorded a result (the tool or host stopped mid-switch). The tool will not call that a no-op. | Whatever is running; nothing was changed by this command. | **Yes** — check `status`, the audit log, and the named backup; then `rollback` to the previous release (which records a completed switch) or re-validate. |
| `DEV RECOVERY FAILED` | Restoring the previous release also failed. | Unknown; the output names the last known release. | **Yes** — `wowsync-dev-deploy status`, the audit record, and the unit journals. |

Exit status: `0` deployed or already deployed, `1` failed but DEV is untouched or recovered, `2`
manual intervention required, `64` usage error, `75` another deployment is running, `77` cannot
switch to the `wowsync-dev` identity.

Database restoration is never automatic. Code rollback is not database rollback: forward-only
schema changes may make old code unsafe, and restoring a backup may discard observations captured
after it. Both are explicit operator decisions.

### Deploying an expected additive schema change

A release that adds a table or index (the repository's additive `CREATE ... IF NOT EXISTS` schema
evolution) cannot be deployed with the plain command: its schema plan shows the addition and
`deploy` stops before touching DEV. Authorize it explicitly, for that one deployment only:

1. Build the release and read its schema plan (DEV untouched):

   ```bash
   wowsync-dev-deploy prepare feature/your-branch FULL_VALIDATED_SHA
   ```

   ```text
   Schema plan: additive (requires explicit approval)
     table snapshot_equipment_observations  sql sha256 <64 hex>
       --expect-schema-add table:snapshot_equipment_observations@<64 hex>
   ```

   `Schema plan: none` means no declaration is needed. `Schema plan: NON-ADDITIVE` (a removed or
   changed object, a trigger or view, or a `user_version` change) cannot be declared; such a release
   is refused.
2. Review the printed SQL (`--json` shows it in full) against the reviewed code. Approval of the
   exact plan or declaration is a Tate decision.
3. Deploy with the exact declaration(s), copied from the plan:

   ```bash
   wowsync-dev-deploy deploy feature/your-branch FULL_VALIDATED_SHA \
     --expect-schema-add table:snapshot_equipment_observations@<64 hex> \
     [--previous-code-compatible]
   ```

Declaration syntax is exactly `table:<name>@<sha256>` or `index:<name>@<sha256>`: lowercase name
`[a-z][a-z0-9_]{0,62}` not beginning with `sqlite`, and the SHA-256 of the object's normalized SQL
(whitespace runs collapsed, as stored in `sqlite_master`). `--expect-schema-add` repeats for several
objects; duplicates, wildcards, and any other form are usage errors (exit 64). Both options are
accepted only by `deploy` and apply only to that invocation; nothing is stored except the audit
record. A new index must belong to an existing table or to a table declared in the same command.
SQLite's implied objects (`sqlite_autoindex_*` from a `UNIQUE`/`PRIMARY KEY` constraint,
`sqlite_sequence`) are never declared: the table's SQL hash already binds them.

What is compared:

- **Before stopping anything:** the schema plan must add exactly the declared objects with the
  declared hashes, and nothing else may differ. Otherwise `DEV DEPLOY FAILED — DEV UNCHANGED`.
- **After the candidate starts (authoritative):** the real database's schema before and after must
  differ only by exactly the declared objects with the declared hashes, with `user_version`
  unchanged. Anything else is treated as an undeclared change: Dashboard/MCP are stopped for review.
- A success prints `Schema: ADDED (declared) <names>`; the audit record keeps the declarations, the
  observed additions with their SQL and hashes, and the post-start schema.

`--previous-code-compatible` is an explicit operator/Tate statement that the previous release runs
correctly against the database with the declared additions. It is valid only with at least one
declaration. If the candidate then fails validation and the real database changed by exactly the
declared additions, the previous release is restarted and validated while the additions stay in the
database (`DEV DEPLOY FAILED — RECOVERED`, `Schema: additions retained: ...`); the database is not
restored. It never authorizes an undeclared, changed, or unreadable schema; those still stop
Dashboard/MCP for review. Without it, a failure after a declared addition also stops for review.

Rollback takes no declarations. Rolling back from a release with a declared addition to an older
release normally works unchanged: older code does not alter the added table, so the schema before
and after the rollback is identical. Use `rollback`, not `deploy`, to go back: `deploy` of an older
release plans the newer table as removed and refuses it.

The deploy tool that runs is the one in the *currently deployed* release. A tool change therefore
takes effect only after it has itself been deployed; until a release containing it is current, the
older tool's rules apply.

Recorded example (Slice A, `1832aba`): the plan adds exactly `table:snapshot_equipment_observations`.
A disposable compatibility proof showed that `be0c370` reads, imports, and serves recipient screens
against that database unchanged, with one caveat: `node:sqlite` enforces foreign keys, so `be0c370`'s
character deletion fails (atomically, without corruption) for a character that already has
equipment observation rows. With that caveat, `--previous-code-compatible` is approved for Slice A.

### Troubleshooting operations (only when explicitly asked)

```bash
wowsync-dev-deploy rollback PREVIOUS_FULL_SHA     # switch back to a retained release
wowsync-dev-deploy backup some-label              # take a consistent SQLite backup now
wowsync-dev-deploy prepare BRANCH FULL_SHA        # build/verify a release and print its schema plan; DEV untouched
```

`rollback` uses the same backup, validation, and automatic-recovery path as `deploy`. If a deployed
release ever contains a broken deploy tool, run a retained release's own copy as `wowsync-dev`, for
example `/home/wowsync-dev/releases/PREVIOUS_FULL_SHA/tools/omarchy/wowsync-dev-deploy rollback
PREVIOUS_FULL_SHA`.

### How it is put together

- **Launcher** — `/usr/local/bin/wowsync-dev-deploy`, root-owned, installed from
  `tools/omarchy/wowsync-dev-deploy`. From any login it switches to `wowsync-dev` with
  `sudo -n` (or asks for a password when run in an interactive terminal without the passwordless
  rule), resets the environment, and runs the tool from the currently deployed release, so
  deployment code always comes from a validated immutable SHA rather than from a workspace.
  Arguments are passed through unchanged and never evaluated. Run as `wowsync-dev` from a checkout
  or release tree, a copy runs the tool next to it.
- **Tool** — `tools/omarchy/wowsync-dev-deploy.mjs`; Node built-ins only, so nothing resolves
  through another checkout's `node_modules`.
- **Service helper** — `/usr/local/sbin/wowsync-dev-app-services`, root-owned. Accepts only `stop`,
  `start`, `restart`, or a bounded `warnings UTC_TIMESTAMP` journal query, always for exactly
  `wowsync-dev-dashboard.service` and `wowsync-dev-mcp-tunnel.service`, using systemd's
  `ignore-dependencies` job mode so `wowsync-dev.target` stays active. Herdr is never part of a
  deployment; never restart `wowsync-dev.target` for an application release (that also cycles the
  tunnel through `PartOf=`).
- **sudoers** — `ops/sudoers/wowsync-dev-deploy`: `wowsync-dev` may run the helper as root, and
  `thmastin` may run the launcher as `wowsync-dev`. No other identity change is granted.
- **Paths** — deployment Git cache and staging under `/home/wowsync-dev/deploy/`; releases at
  `/home/wowsync-dev/releases/<full-sha>`; the active pointer `/home/wowsync-dev/releases/current`
  is an atomically replaced symlink to one release. SQLite and its WAL, captures, receipts, inbox,
  backups (`/var/lib/wowsync-dev/backups/deploy/`), and the audit log stay under
  `/var/lib/wowsync-dev/` and are never relocated by a deployment.

Release write bits are removed after build. That is an accident guard, not a security boundary: it
keeps workspace edits and stray commands from altering the running code, while the systemd sandbox
mounts application source read-only and only the `/var/lib/wowsync-dev` state paths writable.

### Installing or updating the entry points (administrator)

From a checkout of the reviewed commit:

```bash
sudo tools/omarchy/install-wowsync-dev-deploy.sh
```

It installs the helper, the launcher, and the sudoers fragment (validated with `visudo` first,
activated atomically, and the previous fragment restored if the full configuration fails to
validate). It does not start, stop, or deploy anything. Re-run it only when one of those three
files changes; ordinary deploy-tool changes ship with the next deployment.

### First deployment with this tool (completed on this host)

This one-time bootstrap was completed on 2026-10-05 (see "History"); it is not part of routine
deployment. It is kept only for a rebuilt host. The launcher runs the tool from the deployed
release, so the release that is running when the launcher is first installed must already contain
`tools/omarchy/wowsync-dev-deploy.mjs`. If it does not (the launcher says the release "predates this
deploy tool"), run the tool once from an export of the reviewed commit as `wowsync-dev`:

```bash
# as wowsync-dev, e.g. `sudo -u wowsync-dev -i`
git -C ~/src/WoWSync-Dashboard fetch origin
mkdir -p ~/deploy/tool-bootstrap
git -C ~/src/WoWSync-Dashboard archive FULL_SHA tools/omarchy | tar -x -C ~/deploy/tool-bootstrap
~/deploy/tool-bootstrap/tools/omarchy/wowsync-dev-deploy deploy BRANCH FULL_SHA
```

After that, every deployment uses `wowsync-dev-deploy`.

### Audit and retention

Each successful build writes a `release.json` with the full SHA, verified remote ref and origin,
build time, and the Git source manifest. `deployments.jsonl` is an operational audit log, not
tamper-proof history: `wowsync-dev` owns it. Each record has a schema version and the deploy tool's
identity (entry path, its SHA-256, and the release SHA it ran from). Intent and success/failure
records identify the requested SHA/ref, previous SHA, backup, schema change, service and HTTP
validation, and the recovery attempt/result. Journal collection is diagnostic; its failure is
recorded and cannot trigger rollback. Audit-write failure before any service stops prevents the
deployment; after successful validation it is reported without turning the healthy release into an
automatic rollback. The log and backups are outside releases and SQLite.

Do not automatically prune releases or backups. Retain the active release and at least the two
previously validated releases; retain all SQLite deployment backups for at least 90 days and the
10 most recent. Manual pruning must confirm a release is not `current`, no process working
directory resolves into it, and no open validation/rollback record relies on its backup.

Follow-up hardening intentionally deferred: release metadata hashes tracked source but not generated
`node_modules`/`dist`; workspace symlink checks do not cover all Node parent-directory lookups;
failed build and pointer-temp cleanup can leave artifacts for inspection. Schema-only validation
removes full-row hashing from the deployment path and avoids blocking on ordinary capture writes.

### Tool tests

```bash
npm run test:deploy-tool
```

They use temporary Git remotes, release directories, and SQLite databases with systemd, sudo, and
HTTP replaced by a simulated DEV host. They cover the routine deploy path end to end (build,
reuse, no-op, SHA mismatch, build failure, automatic recovery, failed recovery, schema-change
stop, Herdr isolation, lock contention, concise and JSON output, status) plus the underlying
backup, schema, pointer, readiness, fresh-invocation, helper, sudoers, launcher, and installer
checks. The expected-additive-schema cases (D01–D35) cover the declaration parser, the schema
classifier, the pre-stop plan (including a real `/usr/bin/node` run of a small release's
`sqliteStore.ts` against disposable databases), declared deployments and their recovery, rollback
after an addition, and the interrupted-deployment guard; the workflow tests simulate the
application's schema initialization so they never depend on application code.

Run them with plain `node --test` (as above). Under `unshare --map-root-user` the installer test
"refuses unprivileged execution" fails as an environment artifact: mapped root defeats its premise.

### History

The one-time topology migration that moved Dashboard/MCP from the developer checkout to
`releases/current` is complete (it preceded the 2026-10-04 Allocation deployment). Its scripts,
the trusted-export bootstrap, and the `seed-initial`/`--previous-runtime-sha` path were removed
afterward and remain in Git history.

First real-host validation of the simplified tool (2026-10-05): after independent review, the entry
points were installed from a clean archive of `7da561362ef740a014fe65276ecccb60536c3af6`; the
installed `wowsync-dev-deploy status` crossed to `wowsync-dev` non-interactively and reported that
release `51628e4514448bb9cfdb56c1214d27ee38fa92e3` predated the tool, as expected. The one-time
bootstrap then ran `deploy feature/dev-exact-sha-deploy 7da561362ef740a014fe65276ecccb60536c3af6`:
`DEV DEPLOYED` from previous `51628e4…`, release built and tested in staging, SQLite backup OK with
integrity ok (`/var/lib/wowsync-dev/backups/deploy/20261005T043838.915Z-bbe728c1-51628e4514448bb9cfdb56c1214d27ee38fa92e3-to-7da561362ef740a014fe65276ecccb60536c3af6.sqlite`),
schema unchanged, Dashboard healthy (`/` 200, `/api/versions` 200), MCP healthy, Herdr untouched,
no journal warnings. Afterwards the installed `wowsync-dev-deploy status` from the personal login
reported `DEV STATUS: HEALTHY` at `7da5613…` (last action `PROMOTE_SUCCESS`). The bootstrap is
complete; every deployment is now `wowsync-dev-deploy deploy <ref> <validated-sha>`.

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

# Deployed SHA plus Dashboard/MCP health (read-only):
wowsync-dev-deploy status
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
