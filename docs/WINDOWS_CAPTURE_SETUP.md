# Windows → Omarchy DEV capture setup

This guide runs the WoWSync SavedVariables watcher on Windows and sends captures to the **Omarchy DEV Dashboard receiver**. It does not change
the Windows Dashboard/database destination, and it does not send to LIVE. The watcher reads `GearExport.lua`; it never writes to the WoW folder.

## Before starting

The Omarchy DEV receiver must first be provisioned and running. Get these three DEV-only values from its setup:

- SSH username and host name (or IP) that Windows can reach.
- The matching DEV capture token. Do not use a production or LIVE token.
- Confirmation that the capture-only receiver is listening on Omarchy loopback port `4175` with target `DEV`.

Until then, the tunnel and watcher cannot connect. Keep the Windows Dashboard destination and any LIVE settings unchanged.

## 1. Update the WoWSync checkout

Open PowerShell in the Windows WoWSync-Dashboard checkout. Check for local changes first; preserve them before switching branches or updating.

```powershell
git status --short --branch
git switch feature/dashboard-integration
git pull --ff-only origin feature/dashboard-integration
```

The capture transport is in commit `1d5bc08` or later. Node.js 24 or later is required:

```powershell
node --version
npm ci
```

If `node --version` is below 24, install/update Node.js on Windows, open a new PowerShell window, and check again.

## 2. Open the private SSH tunnel

In a separate PowerShell window, replace the placeholders with the SSH values from the Omarchy setup and leave this window open:

```powershell
ssh -N -L 127.0.0.1:4175:127.0.0.1:4175 <ssh-user>@<omarchy-host>
```

Accept the host key only if it matches the one you expect for this Omarchy machine. This forwards only the capture receiver. The regular
Dashboard port and its read/delete/Ask routes are not forwarded.

## 3. Configure this PowerShell session

Use the exact `GearExport.lua` path for one WoW account/product for the first run. It is usually under:

```text
<WoW install>\_retail_\WTF\Account\<account>\SavedVariables\GearExport.lua
```

For Classic clients, replace `_retail_` with the relevant product folder. Enter the values below, replacing the SavedVariables path and token.
The secure prompt avoids putting the token in PowerShell command history. The token remains available to child processes in this PowerShell
session until you remove it or close the window.

```powershell
$env:WOWSYNC_URL = "http://127.0.0.1:4175"
$env:WOWSYNC_CAPTURE_TARGET = "DEV"
$env:WOWSYNC_CAPTURE_SPOOL_DIR = Join-Path $env:LOCALAPPDATA "WoWSync\outbox"
$env:WOWSYNC_SAVED_VARIABLES = "C:\Games\World of Warcraft\_retail_\WTF\Account\YOUR_ACCOUNT\SavedVariables\GearExport.lua"

$secureToken = Read-Host "Omarchy DEV capture token" -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $env:WOWSYNC_CAPTURE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
```

Do not put these values in the repository's `.env`, commit them, or reuse the token for another target. The spool is local to this Windows user;
pending capture files stay there until Omarchy acknowledges them.

## 4. Send one saved capture to DEV

Run this from the repository root, using the same PowerShell session where you set the values:

```powershell
npm run watch:saved -- --file "$env:WOWSYNC_SAVED_VARIABLES" --once
```

This imports the newest saved export in that one file into DEV. It does not change the Windows database. Check that the output names target
`DEV`, reports a receiver acknowledgement, and the outbox is empty:

```powershell
Get-ChildItem "$env:WOWSYNC_CAPTURE_SPOOL_DIR"
```

An empty outbox means each queued capture received a matching durable acknowledgement. If the receiver is temporarily unreachable, the file
stays in the outbox and is retried; do not delete it to clear an error.

## 5. Keep capture watching

After the one-capture check succeeds, start the watcher in the same PowerShell session:

```powershell
npm run watch:saved -- --file "$env:WOWSYNC_SAVED_VARIABLES"
```

Leave both PowerShell windows open. The watcher ignores the file's current contents at startup; later it sends a new export after WoW saves
SavedVariables, such as after `/reload`, logout, or exit. It cannot see an in-memory `/wowsync` export before WoW saves it. Stop the watcher
with Ctrl+C.

To watch all products/accounts later, use `--wow-dir "<WoW install root>"` instead of `--file`; each discovered SavedVariables file has
independent watcher state. The first check intentionally uses one explicit file to limit what enters DEV.

When finished, close the watcher and tunnel windows, then clear the session token:

```powershell
Remove-Item Env:WOWSYNC_CAPTURE_TOKEN
```

## Common errors

- **SSH connection fails:** confirm Windows can reach the Omarchy SSH host and that the username/key is correct. No Dashboard port needs to be
  opened on the LAN; the SSH tunnel carries the local connection.
- **Connection refused on `127.0.0.1:4175`:** the Omarchy DEV receiver is not running/configured yet, or the tunnel window is closed.
- **HTTP 401:** token mismatch. Re-enter the DEV token provisioned on Omarchy; do not substitute a LIVE token.
- **Target mismatch:** this receiver is not configured as `DEV`; stop and check the URL and receiver target before retrying.
- **Capture remains in the outbox:** keep it. The watcher retries with backoff, and resending the same capture ID is safe.
- **No saved export:** run `/wowsync`, then let WoW save SavedVariables (`/reload`, logout, or exit), and retry.
