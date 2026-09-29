# Persistent WoWSync DEV on Windows and Omarchy

The one-file Windows → Omarchy DEV capture path was manually proven on
2026-09-29. This runbook replaces its routine terminal steps with a hidden
Windows logon task and systemd-managed Omarchy DEV startup. It does not change
the Windows Dashboard/database destination or configure LIVE. The watcher is
read-only with respect to WoW files.

## Omarchy DEV setup and operation

The DEV Dashboard process hosts both the browser UI on loopback `4174` and the
separate authenticated capture-only receiver on loopback `4175`. Provision its
DEV-only environment once as described in the existing receiver setup steps.
Keep `/etc/wowsync/dev/capture.env` root-owned and group-readable only by
`wowsync-dev`; it must contain `WOWSYNC_CAPTURE_TARGET=DEV`, the receiver
directory, port `4175`, and the dedicated DEV token. The token must never enter
the repository or logs.

From the Omarchy checkout, install the single DEV systemd operator interface:

```bash
tools/omarchy/install-wowsync-dev.sh
```

This enables `wowsync-dev.target` at boot and groups only the DEV Dashboard
service. The capture receiver is part of that same process. It leaves the LIVE
Dashboard/proxy units untouched. Use one command for normal operation:

```bash
sudo wowsync-dev start
sudo wowsync-dev stop
sudo wowsync-dev restart
wowsync-dev status
```

Status checks the DEV unit, Dashboard web response, and the receiver's expected
unauthenticated `401` response. The target uses `systemd`; no shell or terminal
needs to stay open.

## One-time Windows setup

On Windows, update the WoWSync checkout to `feature/dashboard-integration`,
install Node.js 24 or later and run `npm ci`. Confirm Windows OpenSSH can reach
Omarchy non-interactively after sign-in: its key/agent must be available and
the Omarchy host key already trusted. The SSH key should be limited to the
Windows user's existing Omarchy access; the tunnel binds only to Windows
loopback and forwards only `4174` (Dashboard browser) and `4175` (capture).
No Dashboard port is opened on the LAN.

In PowerShell at the updated repository root, install the hidden logon task:

```powershell
.\tools\windows\WoWSync-Capture.ps1 -Mode Install `
  -WowRoot "C:\Games\World of Warcraft" `
  -SshTarget "YOUR_OMARCHY_SSH_USER@YOUR_OMARCHY_HOST" `
  -RepoRoot (Get-Location).Path
```

The one-time installer obtains the DEV capture token directly over SSH from
the restricted Omarchy config file, prompts for the least-privilege Secure MCP
Tunnel runtime key (Tunnels Read + Use), and stores each credential separately
with current-user Windows DPAPI under `%LOCALAPPDATA%\WoWSync`. Neither value
is printed, passed in process arguments, or stored in the repository. The MCP
profile at `%APPDATA%\tunnel-client\wowsync.yaml` and its read-only database
path are reused unchanged. The installer registers a Task Scheduler task for
Windows user sign-in and starts it hidden.

After setup, the background supervisor maintains three processes: the private
SSH forward, the SavedVariables watcher, and the existing Secure MCP Tunnel
client. It restarts disconnected children with backoff. The capture watcher
discovers `GearExport.lua` files under the selected WoW install for Retail,
Classic BCC Anniversary, Classic Era, and other supported product folders, and
continues discovering account/product files created later. Each file retains
its own state; the export parser/server keep the version identity and unknown
or ambiguous identities are not guessed. On startup it catches up the newest
persisted export per discovered file. When Omarchy is unavailable, capture
envelopes stay in the durable Windows outbox and retry; after reconnection the
receiver's matching durable acknowledgement removes them. Re-sending an
accepted capture remains safe.

The SSH task forwards `127.0.0.1:4174` for the normal Dashboard UI and
`127.0.0.1:4175` for capture. Open the DEV Dashboard in a Windows browser at:

```text
http://127.0.0.1:4174
```

The web page uses its normal same-origin API. Both ports remain loopback-only
on Windows and Omarchy; the normal Dashboard API is not exposed to the LAN.

## Windows operator status

The installer places one operator script in the user's local WoWSync folder:

```powershell
$wowsync = Join-Path $env:LOCALAPPDATA 'WoWSync\WoWSync-Capture.ps1'
& $wowsync -Mode Start
& $wowsync -Mode Stop
& $wowsync -Mode Restart
& $wowsync -Mode Status
```

Status reports the Task Scheduler/supervisor state, SSH and MCP tunnel process
state, DEV target, browser URL, last SavedVariables observation, last
acknowledgement with character/product/version, pending outbox count, latest
receiver connectivity check, backlog-draining state, and most recent useful
error. It never displays either credential. The status JSON and logs are local
to the Windows user under `%LOCALAPPDATA%\WoWSync`; the status record contains
no token or export text.

## Outages and first validation

If Omarchy is off, the SSH child retries and captures stay in the Windows
outbox. If Windows is off, the startup catch-up reads the newest persisted
export from each discovered file after sign-in. When both machines return, the
outbox drains using the existing receiver receipts. It still requires WoW to
save SavedVariables (reload, logout, or exit); `/wowsync` alone does not write
the file.

The first real-machine acceptance should verify:

1. Windows sign-in starts the task hidden; no PowerShell window remains.
2. `Status` shows the SSH tunnel, watcher and MCP tunnel running, and the DEV
   Dashboard opens at `http://127.0.0.1:4174`.
3. A normal WoW save produces a DEV acknowledgement and clears the outbox.
4. With Omarchy stopped, a subsequent save remains queued; restart Omarchy with
   `sudo wowsync-dev start` (or reboot it), then confirm the backlog drains.
5. `sudo wowsync-dev status` reports the DEV Dashboard HTTP response and
   capture receiver HTTP 401. The Windows status shows the receiver connected.
6. In a normal ChatGPT conversation with the existing **WoWSync** app, invoke
   `list_versions`, then a version-scoped character read. Confirm the response
   still reflects the narrow read-only MCP surface. This external call is
   required; local protocol tests alone do not prove the ChatGPT tunnel.

The MCP runtime and its eleven-tool contract are unchanged. Its tunnel profile
remains outbound and private; this setup does not add a public MCP or Dashboard
listener. If the existing tunnel client/profile/runtime key is unavailable,
keep the current MCP setup intact and resolve that credential/profile issue
before claiming full infrastructure acceptance.
