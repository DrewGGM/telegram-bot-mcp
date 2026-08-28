<#
.SYNOPSIS
  Install telegram-bot-mcp as a Windows Scheduled Task that starts at logon and
  restarts on failure (T5.4). Runs in YOUR user session so it uses your existing
  `claude` login. No admin rights required.

.NOTES
  Run this yourself from an interactive PowerShell — it is NOT invoked by the
  agent (the guardrail deny-list blocks schtasks from agent sessions by design).

.EXAMPLE
  pwsh -File scripts/install-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = "TelegramBotMCP"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Write-Host "Project: $projectRoot"

# 1. Ensure dependencies + a fresh build.
Push-Location $projectRoot
try {
  if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "Installing dependencies..."
    npm ci
  }
  Write-Host "Building..."
  npm run build

  $entry = Join-Path $projectRoot "dist\main.js"
  if (-not (Test-Path $entry)) { throw "Build did not produce dist\main.js" }
  if (-not (Test-Path (Join-Path $projectRoot ".env"))) {
    Write-Warning "No .env found. Copy .env.example to .env and set BOT_TOKEN before the bot will run."
  }

  $node = (Get-Command node).Source

  # 2. Define the scheduled task: at logon, restart every 1 min up to 999 times.
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $projectRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Updating existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description "Telegram <-> Claude Code bridge daemon" | Out-Null

  Write-Host "`nInstalled scheduled task '$TaskName'." -ForegroundColor Green
  Write-Host "Start it now with:  Start-ScheduledTask -TaskName $TaskName"
  Write-Host "Watch logs with:    Get-Content `"$projectRoot\data\*.log`" -Wait  (or check the console)"
  Write-Host "Uninstall with:     pwsh -File scripts\uninstall-windows.ps1"
}
finally {
  Pop-Location
}
