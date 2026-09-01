<#
.SYNOPSIS
  Remove the telegram-bot-mcp Scheduled Task.
.EXAMPLE
  pwsh -File scripts/uninstall-windows.ps1
#>
[CmdletBinding()]
param([string]$TaskName = "TelegramBotMCP")

$ErrorActionPreference = "Stop"
$removed = $false

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  $removed = $true
}

# Also clear the no-admin Startup-folder installation, if present.
$link = Join-Path ([Environment]::GetFolderPath('Startup')) "TelegramBotMCP.vbs"
if (Test-Path $link) {
  Remove-Item $link -Force
  Write-Host "Removed Startup launcher: $link" -ForegroundColor Green
  $removed = $true
}

if (-not $removed) { Write-Host "Nothing installed to remove." }
Write-Host "Note: a daemon already running is not stopped by this script."
