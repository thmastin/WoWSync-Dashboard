[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$CheckHealth
)
# System tray front end for the WoWSync capture collector. The collector itself stays the
# "WoWSync DEV Runtime" logon task (WoWSync-Capture.ps1 -Mode Run, auto-restart); this only shows its
# state and drives the existing Start/Stop/Restart/Status modes. Exiting the tray leaves capture running.

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $env:LOCALAPPDATA 'WoWSync'
$CaptureScript = Join-Path $AppDir 'WoWSync-Capture.ps1'
$TrayScript = Join-Path $AppDir 'WoWSync-Tray.ps1'
$Launcher = Join-Path $AppDir 'WoWSync-Tray.vbs'
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'WoWSync Tray.lnk'
$DashboardUrl = 'http://127.0.0.1:4174'

function Install-Tray {
    if (-not (Test-Path -LiteralPath $CaptureScript -PathType Leaf)) { throw 'WoWSync capture is not installed (WoWSync-Capture.ps1 missing); install it first.' }
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($TrayScript)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $TrayScript -Force
    }
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $command = '"{0}" -NoLogo -NoProfile -WindowStyle Hidden -STA -ExecutionPolicy Bypass -File "{1}"' -f $powershell, $TrayScript
    Set-Content -LiteralPath $Launcher -Encoding ASCII -Value ("Set shell = CreateObject(`"WScript.Shell`")`r`nshell.Run `"{0}`", 0, False`r`n" -f $command.Replace('"', '""'))
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($StartupLink)
    $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $link.Arguments = "//B //NoLogo `"$Launcher`""
    $link.WorkingDirectory = $AppDir
    $link.Description = 'WoWSync capture tray icon'
    $link.Save()
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "//B //NoLogo `"$Launcher`""
    Write-Output "WoWSync tray installed: starts at sign-in (shortcut in your Startup folder) and is starting now."
}

function Uninstall-Tray {
    Remove-Item -LiteralPath $StartupLink -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Launcher -Force -ErrorAction SilentlyContinue
    Write-Output 'WoWSync tray removed from sign-in. Capture keeps running; close the tray icon with Exit.'
}

if ($Install) { Install-Tray; return }
if ($Uninstall) { Uninstall-Tray; return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function New-StatusIcon([System.Drawing.Color]$Color) {
    $bitmap = New-Object System.Drawing.Bitmap 32, 32
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $brush = New-Object System.Drawing.SolidBrush $Color
    $graphics.FillEllipse($brush, 1, 1, 30, 30)
    $font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('W', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $format)
    $graphics.Dispose(); $brush.Dispose(); $font.Dispose()
    [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}
$Icons = @{
    Green = New-StatusIcon ([System.Drawing.Color]::FromArgb(46, 160, 67))
    Amber = New-StatusIcon ([System.Drawing.Color]::FromArgb(212, 140, 20))
    Red = New-StatusIcon ([System.Drawing.Color]::FromArgb(200, 50, 50))
    Grey = New-StatusIcon ([System.Drawing.Color]::FromArgb(120, 120, 120))
}

function Read-Json([string]$Name) {
    $path = Join-Path $AppDir $Name
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}
function Age-Seconds($When) {
    if (-not $When) { return $null }
    try { return ([DateTimeOffset]::UtcNow - [DateTimeOffset]$When).TotalSeconds } catch { return $null }
}
function Format-Age($Seconds) {
    if ($null -eq $Seconds) { return 'unknown' }
    if ($Seconds -lt 90) { return 'just now' }
    if ($Seconds -lt 5400) { return ('{0} min ago' -f [Math]::Round($Seconds / 60)) }
    if ($Seconds -lt 172800) { return ('{0} h ago' -f [Math]::Round($Seconds / 3600)) }
    return ('{0} days ago' -f [Math]::Round($Seconds / 86400))
}

# Same health rules as WoWSync-Capture.ps1 -Mode Status, read from the files the collector writes.
function Get-Health {
    $supervisor = Read-Json 'supervisor.json'
    $capture = Read-Json 'status.json'
    $outbox = Join-Path $AppDir 'outbox'
    $pending = 0
    if (Test-Path -LiteralPath $outbox) { $pending = @(Get-ChildItem -LiteralPath $outbox -Filter '*.json' -File -ErrorAction SilentlyContinue).Count }
    $supervisorAge = if ($supervisor) { Age-Seconds $supervisor.heartbeatAt } else { $null }
    $captureAge = if ($capture) { Age-Seconds $capture.heartbeatAt } else { $null }
    $supervisorFresh = $supervisor -and $supervisor.state -eq 'running' -and $null -ne $supervisorAge -and $supervisorAge -lt 90
    $watcherFresh = $supervisorFresh -and [bool]$supervisor.watcherRunning -and $null -ne $captureAge -and $captureAge -lt 90
    $tunnelUp = $supervisorFresh -and [bool]$supervisor.tunnelRunning
    $connected = $capture -and $capture.connectivity -eq 'connected'
    $last = if ($capture) { $capture.lastAcknowledgement } else { $null }
    $lastText = 'No capture delivered yet'
    if ($last -and $last.at) { $lastText = ('{0} ({1}) {2}' -f $last.character, $last.version, (Format-Age (Age-Seconds $last.at))) }

    $state = 'Green'; $summary = 'Capturing'
    if (-not $supervisor) { $state = 'Grey'; $summary = 'Collector not installed or never started' }
    elseif (-not $supervisorFresh) { $state = 'Red'; $summary = 'Collector stopped' }
    elseif (-not $watcherFresh) { $state = 'Red'; $summary = 'Watcher not running' }
    elseif (-not $tunnelUp -or -not $connected) { $state = 'Amber'; $summary = 'Not connected to DEV (captures are queued)' }
    elseif ($pending -gt 0 -or ($capture -and $capture.drainingBacklog)) { $state = 'Amber'; $summary = "Sending queued captures ($pending)" }
    [pscustomobject]@{ State = $state; Summary = $summary; LastCapture = $lastText; Pending = $pending
        Running = [bool]$supervisorFresh; LastError = if ($capture) { $capture.lastError } else { $null } }
}

if ($CheckHealth) { Get-Health | Format-List; return }

# ---- Single instance
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\WoWSyncTray', [ref]$createdNew)
if (-not $createdNew) { return }

function Invoke-Capture([string]$Mode) {
    $powershell = (Get-Command powershell.exe).Source
    Start-Process -FilePath $powershell -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$CaptureScript`"", '-Mode', $Mode) | Out-Null
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $Icons.Grey
$tray.Text = 'WoWSync'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$headerItem = $menu.Items.Add('WoWSync')
$headerItem.Enabled = $false
$headerItem.Font = New-Object System.Drawing.Font($headerItem.Font, [System.Drawing.FontStyle]::Bold)
$lastItem = $menu.Items.Add('Last capture: ...')
$lastItem.Enabled = $false
$pendingItem = $menu.Items.Add('Queued: 0')
$pendingItem.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$dashboardItem = $menu.Items.Add('Open Dashboard')
$dashboardItem.add_Click({ Start-Process $DashboardUrl })
$detailsItem = $menu.Items.Add('Status details...')
$detailsItem.add_Click({
    [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::WaitCursor
    try {
        $powershell = (Get-Command powershell.exe).Source
        $text = (& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $CaptureScript -Mode Status | Out-String -Width 160).Trim()
    } catch { $text = "Status failed: $($_.Exception.Message)" }
    [System.Windows.Forms.MessageBox]::Show($text, 'WoWSync status', 'OK', 'Information') | Out-Null
})
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$restartItem = $menu.Items.Add('Restart collector')
$restartItem.add_Click({ Invoke-Capture 'Restart'; $tray.ShowBalloonTip(3000, 'WoWSync', 'Restarting the collector...', 'Info') })
$startStopItem = $menu.Items.Add('Stop collector')
$startStopItem.add_Click({
    if ($script:lastHealth -and $script:lastHealth.Running) {
        $answer = [System.Windows.Forms.MessageBox]::Show('Stop capturing? Exports will not reach the Dashboard until you start it again (it also restarts at next sign-in).', 'WoWSync', 'YesNo', 'Question')
        if ($answer -eq 'Yes') { Invoke-Capture 'Stop' }
    } else { Invoke-Capture 'Start' }
})
$logsItem = $menu.Items.Add('Open logs folder')
$logsItem.add_Click({ Start-Process explorer.exe $AppDir })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add('Exit tray (capture keeps running)')
$exitItem.add_Click({ $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ $detailsItem.PerformClick() })

$script:lastHealth = $null
$script:lastState = $null
function Update-Tray {
    $health = Get-Health
    $script:lastHealth = $health
    $tray.Icon = $Icons[$health.State]
    $tip = "WoWSync: $($health.Summary)`n$($health.LastCapture)"
    if ($tip.Length -gt 127) { $tip = $tip.Substring(0, 127) }
    $tray.Text = $tip
    $headerItem.Text = "WoWSync: $($health.Summary)"
    $lastItem.Text = "Last capture: $($health.LastCapture)"
    $pendingItem.Text = "Queued: $($health.Pending)"
    $startStopItem.Text = if ($health.Running) { 'Stop collector' } else { 'Start collector' }
    # Notify on transitions into or out of trouble, not on every poll.
    if ($null -ne $script:lastState -and $script:lastState -ne $health.State) {
        if ($health.State -eq 'Red') { $tray.ShowBalloonTip(5000, 'WoWSync', $health.Summary, 'Warning') }
        elseif ($health.State -eq 'Green' -and $script:lastState -in @('Red', 'Amber')) { $tray.ShowBalloonTip(3000, 'WoWSync', 'Capturing again', 'Info') }
    }
    $script:lastState = $health.State
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.add_Tick({ try { Update-Tray } catch { } })
Update-Tray
$timer.Start()
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop(); $tray.Visible = $false; $tray.Dispose()
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
