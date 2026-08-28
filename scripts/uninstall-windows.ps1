<#
.SYNOPSIS
  Remove the telegram-bot-mcp Scheduled Task.
.EXAMPLE
  pwsh -File scripts/uninstall-windows.ps1
#>
[CmdletBinding()]
param([string]$TaskName = "TelegramBotMCP")

$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
} else {
  Write-Host "No scheduled task named '$TaskName' found."
}
