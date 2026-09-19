#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Registers Desked as elevated Windows Scheduled Tasks.

.DESCRIPTION
    Windows UIPI (User Interface Privilege Isolation) prevents a Medium
    Integrity Level process from injecting input into a High IL process
    (e.g. Task Manager).  Running Node via Task Scheduler with RunLevel=Highest
    gives it a High IL token — bypassing UIPI — without a UAC prompt each time.

    Two tasks are created:
      - DeskedServer  : node server.js  (Highest privilege, no UAC)
      - DeskedTunnel  : cloudflared.exe (Limited privilege is fine)
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Paths ────────────────────────────────────────────────────────────────────
$dir       = Split-Path -Parent $PSScriptRoot
$envFile   = Join-Path $dir ".env"
$nodePath  = (Get-Command node -ErrorAction Stop).Source
$cfExe     = Join-Path $dir "cloudflared.exe"

# ── Read TUNNEL_TOKEN from .env ───────────────────────────────────────────────
$tunnelArgs = $null
if (Test-Path $envFile) {
    $envLines = Get-Content $envFile
    foreach ($line in $envLines) {
        if ($line -match '^\s*TUNNEL_TOKEN\s*=\s*(.+)$') {
            $token = $Matches[1].Trim().Trim('"').Trim("'")
            $tunnelArgs = "tunnel --no-autoupdate --protocol http2 run --token $token"
            break
        }
    }
}
if (-not $tunnelArgs) {
    # Fallback: quick-tunnel (no token needed, URL printed to cloudflare.log)
    $tunnelArgs = "tunnel --no-autoupdate --url http://localhost:3389"
    Write-Warning "TUNNEL_TOKEN not found in .env — using quick-tunnel fallback."
}

$taskUser = "$env:USERDOMAIN\$env:USERNAME"

# ── Shared settings ───────────────────────────────────────────────────────────
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

# ── 1. Node server — HIGH integrity (bypasses UIPI) ──────────────────────────
Write-Host "[*] Registering DeskedServer task (RunLevel: Highest)..." -ForegroundColor Cyan

$nodeAction = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "server.js" `
    -WorkingDirectory $dir

# RunLevel Highest  →  High Integrity Level token
# LogonType Interactive  →  can access the user's desktop session
$nodePrincipal = New-ScheduledTaskPrincipal `
    -UserId $taskUser `
    -RunLevel Highest `
    -LogonType Interactive

$null = Register-ScheduledTask `
    -TaskName "DeskedServer" `
    -Action   $nodeAction `
    -Trigger  $trigger `
    -Settings $settings `
    -Principal $nodePrincipal `
    -Force

Write-Host "[+] DeskedServer registered." -ForegroundColor Green

# ── 2. Cloudflare tunnel — standard privilege ─────────────────────────────────
Write-Host "[*] Registering DeskedTunnel task..." -ForegroundColor Cyan

$cfAction = New-ScheduledTaskAction `
    -Execute $cfExe `
    -Argument $tunnelArgs `
    -WorkingDirectory $dir

$cfPrincipal = New-ScheduledTaskPrincipal `
    -UserId $taskUser `
    -RunLevel Limited `
    -LogonType Interactive

$null = Register-ScheduledTask `
    -TaskName "DeskedTunnel" `
    -Action   $cfAction `
    -Trigger  $trigger `
    -Settings $settings `
    -Principal $cfPrincipal `
    -Force

Write-Host "[+] DeskedTunnel registered." -ForegroundColor Green

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ✅  Both tasks registered. They start automatically at next logon." -ForegroundColor Green
Write-Host ""
Write-Host "  To start RIGHT NOW (without rebooting):" -ForegroundColor Yellow
Write-Host "    Start-ScheduledTask -TaskName 'DeskedServer'" -ForegroundColor Yellow
Write-Host "    Start-ScheduledTask -TaskName 'DeskedTunnel'" -ForegroundColor Yellow
Write-Host ""
Write-Host "  ⚠️  Remove the old VBS shortcut from the Startup folder (if present):" -ForegroundColor Yellow
Write-Host "    $env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Desked.vbs" -ForegroundColor Yellow
Write-Host ""
Write-Host "  To uninstall: npm run uninstall-service" -ForegroundColor Gray
