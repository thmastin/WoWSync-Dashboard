[CmdletBinding()]
param(
    [ValidateSet('Install', 'Run', 'Start', 'Stop', 'Restart', 'Status')]
    [string]$Mode = 'Status',
    [string]$WowRoot,
    [string]$SshTarget,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$TaskName = 'WoWSync DEV Runtime'
$AppDir = Join-Path $env:LOCALAPPDATA 'WoWSync'
$ConfigPath = Join-Path $AppDir 'capture-config.json'
$TokenPath = Join-Path $AppDir 'capture-token.dpapi'
$McpTokenPath = Join-Path $AppDir 'mcp-tunnel-key.dpapi'
$StopPath = Join-Path $AppDir 'stop.requested'
$SupervisorPath = Join-Path $AppDir 'supervisor.json'

function Write-JsonAtomic([string]$Path, $Value) {
    $temp = "$Path.$PID.tmp"
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-Config {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "WoWSync capture is not installed. Run this script with -Mode Install first." }
    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

function Get-Supervisor {
    if (Test-Path -LiteralPath $SupervisorPath) {
        try { return Get-Content -LiteralPath $SupervisorPath -Raw | ConvertFrom-Json } catch { }
    }
    return $null
}

function Get-CaptureStatus {
    $file = Join-Path $AppDir 'status.json'
    if (Test-Path -LiteralPath $file) {
        try { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { }
    }
    return $null
}

function Quote-ProcessArgument([string]$Value) {
    '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Start-Child([string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [string]$LogPrefix) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $AppDir "$LogPrefix-$stamp.out.log"
    $stderr = Join-Path $AppDir "$LogPrefix-$stamp.err.log"
    $argumentLine = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
    Start-Process -FilePath $File -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
}

function Stop-Child($Process) {
    if ($null -ne $Process) {
        try {
            $Process.Refresh()
            if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit(5000) | Out-Null }
        } catch { }
        try { $Process.Dispose() } catch { }
    }
}

function Start-WatcherProcess($Config, [string[]]$Arguments, [string]$Token) {
    $env:WOWSYNC_CAPTURE_TOKEN = $Token
    try { Start-Child $Config.NodePath $Arguments $AppDir 'capture-watcher' }
    finally { Remove-Item Env:WOWSYNC_CAPTURE_TOKEN -ErrorAction SilentlyContinue }
}

function Start-McpTunnelProcess($Config, [string]$Key) {
    $env:CONTROL_PLANE_API_KEY = $Key
    try { Start-Child $Config.McpTunnelPath @('run', '--profile', 'wowsync') $AppDir 'mcp-tunnel' }
    finally { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
}

function Install-Capture {
    if ([string]::IsNullOrWhiteSpace($WowRoot)) { $WowRoot = Read-Host 'WoW install folder (contains _retail_ / _classic_*)' }
    if ([string]::IsNullOrWhiteSpace($SshTarget)) { $SshTarget = Read-Host 'Omarchy SSH target (user@host)' }
    if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Read-Host 'Windows WoWSync-Dashboard checkout folder' }
    $WowRoot = [IO.Path]::GetFullPath($WowRoot)
    $RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
    if (-not (Test-Path -LiteralPath $WowRoot -PathType Container)) { throw "WoW folder not found: $WowRoot" }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'packages/server/src/watchSavedCli.ts') -PathType Leaf)) { throw 'The WoWSync checkout is missing the persistent capture watcher. Update feature/dashboard-integration first.' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $mcpTunnel = Join-Path $RepoRoot 'tools/tunnel-client/tunnel-client.exe'
    $mcpProfile = Join-Path $env:APPDATA 'tunnel-client/wowsync.yaml'
    if (-not (Test-Path -LiteralPath $mcpTunnel -PathType Leaf)) { throw 'The existing Secure MCP Tunnel client is missing from tools/tunnel-client/tunnel-client.exe. Restore the installed local CLI before setup.' }
    if (-not (Test-Path -LiteralPath $mcpProfile -PathType Leaf)) { throw 'The existing wowsync Secure MCP Tunnel profile is missing; setup will not replace or recreate it.' }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'packages/mcp/src/index.ts') -PathType Leaf)) { throw 'The existing read-only WoWSync MCP runtime is missing from this checkout.' }
    $remoteCommand = 'sudo sh -c ''grep -qx WOWSYNC_CAPTURE_TARGET=DEV /etc/wowsync/dev/capture.env && sed -n s/^WOWSYNC_CAPTURE_TOKEN=//p /etc/wowsync/dev/capture.env'''
    $tokenOutput = & $ssh -tt -o LogLevel=ERROR $SshTarget $remoteCommand
    $sshExit = $LASTEXITCODE
    $tokenValue = @($tokenOutput | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^[0-9a-f]{64}$' } | Select-Object -Last 1)
    if ($sshExit -ne 0 -or $tokenValue.Count -ne 1) { throw 'Could not retrieve the DEV capture credential over SSH. Check SSH access and the remote sudo prompt; the value was not displayed.' }
    $secureToken = ConvertTo-SecureString $tokenValue[0] -AsPlainText -Force
    Remove-Variable tokenOutput, tokenValue
    if ($secureToken.Length -lt 32) { throw 'The DEV capture token must be at least 32 characters.' }
    $secureMcpKey = Read-Host 'Least-privilege Secure MCP Tunnel runtime key (Tunnels Read + Use); stored with current-user DPAPI' -AsSecureString
    if ($secureMcpKey.Length -lt 32) { throw 'The Secure MCP Tunnel runtime key is too short.' }

    New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
    $cipher = ConvertFrom-SecureString $secureToken
    Set-Content -LiteralPath $TokenPath -Value $cipher -Encoding ASCII -NoNewline
    $mcpCipher = ConvertFrom-SecureString $secureMcpKey
    Set-Content -LiteralPath $McpTokenPath -Value $mcpCipher -Encoding ASCII -NoNewline
    $secureToken.Dispose()
    $secureMcpKey.Dispose()
    $config = [ordered]@{
        Target = 'DEV'
        SshTarget = $SshTarget.Trim()
        WowRoot = $WowRoot
        RepoRoot = $RepoRoot
        NodePath = $node
        SshPath = $ssh
        McpTunnelPath = $mcpTunnel
        InstalledAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-JsonAtomic $ConfigPath $config

    $installedScript = Join-Path $AppDir 'WoWSync-Capture.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $actionArgs = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Run"
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArgs
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Private DEV-only WoWSync capture, Dashboard and MCP tunnels.' -Force | Out-Null
    Remove-Item -LiteralPath $StopPath -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
    Write-Output 'WoWSync DEV Runtime is installed and starting at Windows sign-in. Credentials are saved with current-user DPAPI; their values were not displayed.'
}

function Run-Supervisor {
    $config = Get-Config
    $secureCipher = Get-Content -LiteralPath $TokenPath -Raw
    $secureToken = ConvertTo-SecureString $secureCipher
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try { $tokenValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer); $secureToken.Dispose() }
    $secureMcpCipher = Get-Content -LiteralPath $McpTokenPath -Raw
    $secureMcpKey = ConvertTo-SecureString $secureMcpCipher
    $mcpPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureMcpKey)
    try { $mcpKeyValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mcpPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mcpPointer); $secureMcpKey.Dispose() }

    $env:WOWSYNC_URL = 'http://127.0.0.1:4175'
    $env:WOWSYNC_CAPTURE_TARGET = 'DEV'
    $env:WOWSYNC_CAPTURE_SPOOL_DIR = Join-Path $AppDir 'outbox'
    $env:WOWSYNC_CAPTURE_STATUS_PATH = Join-Path $AppDir 'status.json'
    $null = New-Item -ItemType Directory -Path $env:WOWSYNC_CAPTURE_SPOOL_DIR -Force
    $watcherScript = Join-Path $config.RepoRoot 'packages/server/src/watchSavedCli.ts'
    $tunnelArgs = @('-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', '127.0.0.1:4174:127.0.0.1:4174', '-L', '127.0.0.1:4175:127.0.0.1:4175', $config.SshTarget)
    $watchArgs = @('--disable-warning=ExperimentalWarning', $watcherScript, '--service', '--wow-dir', $config.WowRoot, '--url', 'http://127.0.0.1:4175', '--capture-target', 'DEV', '--spool-dir', $env:WOWSYNC_CAPTURE_SPOOL_DIR)
    $ssh = $null
    $watcher = $null
    $mcp = $null
    $tunnelRestarts = 0
    $nextTunnelStart = Get-Date
    $watcherRestarts = 0
    $nextWatcherStart = Get-Date
    $mcpRestarts = 0
    $nextMcpStart = Get-Date
    Remove-Item -LiteralPath $StopPath -Force -ErrorAction SilentlyContinue
    try {
        while ($true) {
            if (Test-Path -LiteralPath $StopPath) { break }
            $now = Get-Date
            if (($null -eq $ssh -or $ssh.HasExited) -and $now -ge $nextTunnelStart) {
                if ($null -ne $ssh) { $tunnelRestarts++; $ssh.Dispose() }
                $ssh = Start-Child $config.SshPath $tunnelArgs $config.RepoRoot 'ssh-tunnel'
                $backoff = [Math]::Min(60, [Math]::Pow(2, [Math]::Min(6, $tunnelRestarts + 1)))
                $nextTunnelStart = $now.AddSeconds($backoff)
            }
            if (($null -eq $watcher -or $watcher.HasExited) -and $now -ge $nextWatcherStart) {
                if ($null -ne $watcher) { $watcherRestarts++; $watcher.Dispose() }
                $watcher = Start-WatcherProcess $config $watchArgs $tokenValue
                $nextWatcherStart = $now.AddSeconds(10)
            }
            if (($null -eq $mcp -or $mcp.HasExited) -and $now -ge $nextMcpStart) {
                if ($null -ne $mcp) { $mcpRestarts++; $mcp.Dispose() }
                $mcp = Start-McpTunnelProcess $config $mcpKeyValue
                $nextMcpStart = $now.AddSeconds([Math]::Min(60, [Math]::Pow(2, [Math]::Min(6, $mcpRestarts + 1))))
            }
            $sshAlive = $null -ne $ssh -and -not $ssh.HasExited
            $watcherAlive = $null -ne $watcher -and -not $watcher.HasExited
            $mcpAlive = $null -ne $mcp -and -not $mcp.HasExited
            Write-JsonAtomic $SupervisorPath ([ordered]@{
                target = 'DEV'; state = 'running'; heartbeatAt = $now.ToUniversalTime().ToString('o')
                tunnelRunning = $sshAlive; watcherRunning = $watcherAlive; mcpTunnelRunning = $mcpAlive
                tunnelPid = if ($sshAlive) { $ssh.Id } else { $null }
                watcherPid = if ($watcherAlive) { $watcher.Id } else { $null }
                mcpTunnelPid = if ($mcpAlive) { $mcp.Id } else { $null }
                tunnelRestarts = $tunnelRestarts; watcherRestarts = $watcherRestarts; mcpTunnelRestarts = $mcpRestarts
                dashboardUrl = 'http://127.0.0.1:4174'
            })
            Start-Sleep -Seconds 2
        }
    } finally {
        Stop-Child $watcher
        Stop-Child $ssh
        Stop-Child $mcp
        Remove-Item Env:WOWSYNC_CAPTURE_TOKEN -ErrorAction SilentlyContinue
        Remove-Variable tokenValue -ErrorAction SilentlyContinue
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
        Remove-Variable mcpKeyValue -ErrorAction SilentlyContinue
        Write-JsonAtomic $SupervisorPath ([ordered]@{ target = 'DEV'; state = 'stopped'; heartbeatAt = (Get-Date).ToUniversalTime().ToString('o'); tunnelRunning = $false; watcherRunning = $false; mcpTunnelRunning = $false; dashboardUrl = 'http://127.0.0.1:4174' })
    }
}

function Stop-Capture {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return }
    New-Item -ItemType File -Path $StopPath -Force | Out-Null
    $until = (Get-Date).AddSeconds(30)
    while ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
    if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
}

function Show-CaptureStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $supervisor = Get-Supervisor
    $capture = Get-CaptureStatus
    $outbox = Join-Path $AppDir 'outbox'
    $pending = if (Test-Path -LiteralPath $outbox) { @(Get-ChildItem -LiteralPath $outbox -Filter '*.json' -File).Count } else { 0 }
    $fresh = $capture -and ((Get-Date).ToUniversalTime() - [DateTime]$capture.heartbeatAt).TotalSeconds -lt 90
    $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    $dashboardHttp = 'curl unavailable'
    $receiverHttp = 'curl unavailable'
    if ($curl) {
        try {
            $code = (& $curl -sS --max-time 3 -o NUL -w '%{http_code}' 'http://127.0.0.1:4174/').Trim()
            if ($LASTEXITCODE -eq 0) { $dashboardHttp = "HTTP $code" } else { $dashboardHttp = 'unavailable' }
        } catch { $dashboardHttp = 'unavailable' }
        try {
            $code = (& $curl -sS --max-time 3 -o NUL -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' 'http://127.0.0.1:4175/api/captures').Trim()
            if ($LASTEXITCODE -eq 0 -and $code -eq '401') { $receiverHttp = 'HTTP 401 (reachable)' } else { $receiverHttp = "HTTP $code (expected 401)" }
        } catch { $receiverHttp = 'unavailable' }
    }
    [pscustomobject]@{
        Task = if ($task) { $task.State } else { 'Not installed' }
        Supervisor = if ($supervisor -and $supervisor.state -eq 'running' -and $fresh) { 'Running' } else { 'Not healthy/stale' }
        Target = 'DEV'
        SshTunnel = if ($supervisor) { [bool]$supervisor.tunnelRunning } else { $false }
        Watcher = if ($supervisor) { [bool]$supervisor.watcherRunning -and [bool]$fresh } else { $false }
        McpTunnel = if ($supervisor) { [bool]$supervisor.mcpTunnelRunning } else { $false }
        Dashboard = 'http://127.0.0.1:4174'
        DashboardHttp = $dashboardHttp
        CaptureReceiverHttp = $receiverHttp
        LastSavedVariablesObservation = if ($capture) { $capture.lastSavedVariablesObservation }
        LastAcknowledgement = if ($capture) { $capture.lastAcknowledgement }
        PendingSpoolCount = $pending
        Connectivity = if ($capture) { $capture.connectivity } else { 'unknown' }
        LastError = if ($capture) { $capture.lastError }
        DrainingBacklog = if ($capture) { [bool]$capture.drainingBacklog }
    } | Format-List
}

New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
switch ($Mode) {
    'Install' { Install-Capture }
    'Run' { Run-Supervisor }
    'Start' {
        Remove-Item -LiteralPath $StopPath -Force -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $TaskName
    }
    'Stop' { Stop-Capture }
    'Restart' { Stop-Capture; Remove-Item -LiteralPath $StopPath -Force -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName $TaskName }
    'Status' { Show-CaptureStatus }
}
