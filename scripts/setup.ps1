<#
.SYNOPSIS
  One-command setup for telegram-bot-mcp.

  Installs dependencies, builds, configures the optional local Bot API server
  (for files up to 2 GB), installs auto-start, registers the MCP bridge for every
  Claude Code session, and starts the daemon.

  Safe to re-run: every step is idempotent and skips what is already done.

.PARAMETER SkipLocalApi
  Do not set up the local Bot API server (files over 50 MB will then be
  compressed or split instead of sent as-is).

.PARAMETER SkipGlobalMcp
  Do not register the bridge in your user-level Claude Code config.

.EXAMPLE
  pwsh -File scripts/setup.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipLocalApi,
  [switch]$SkipGlobalMcp
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    !!  $msg" -ForegroundColor Yellow }

try {
  # ---- 1. prerequisites -----------------------------------------------------
  Step 1 "Checking prerequisites"
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) { throw "Node.js not found. Install Node >= 22.5 and re-run." }
  $nodeMajor = [int](& node -e "console.log(process.versions.node.split('.')[0])")
  if ($nodeMajor -lt 22) { throw "Node $nodeMajor is too old; need >= 22.5." }
  Ok "node $(& node -v)"
  if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "claude CLI present" }
  else { Warn "claude CLI not found - the bot can run, but agent sessions will fail until it is installed and logged in." }

  # ---- 2. secrets -----------------------------------------------------------
  Step 2 "Checking .env"
  if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Warn "Created .env from the example. Put your BOT_TOKEN in it, then re-run this script."
    Warn "Get a token from @BotFather in Telegram."
    exit 1
  }
  $envText = Get-Content ".env" -Raw
  if ($envText -notmatch 'BOT_TOKEN=\S{20,}') { throw "BOT_TOKEN is missing or looks empty in .env" }
  Ok "BOT_TOKEN present"
  $hasApiCreds = ($envText -match 'TELEGRAM_API_ID=\d+') -and ($envText -match 'TELEGRAM_API_HASH=\w{16,}')

  # ---- 3. build -------------------------------------------------------------
  Step 3 "Installing dependencies and building"
  if (-not (Test-Path "node_modules")) { npm ci } else { Ok "node_modules present" }
  npm run build | Out-Null
  if (-not (Test-Path "dist\main.js")) { throw "Build produced no dist\main.js" }
  Ok "built"

  # ---- 4. local Bot API server (optional, lifts 50 MB -> 2000 MB) ----------
  Step 4 "Local Bot API server (files up to 2 GB)"
  if ($SkipLocalApi) { Warn "skipped by request" }
  elseif (-not $hasApiCreds) {
    Warn "No TELEGRAM_API_ID / TELEGRAM_API_HASH in .env - skipping."
    Warn "Get them at https://my.telegram.org to send files over 50 MB untouched."
  }
  elseif (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Warn "Docker not installed - skipping. Files over 50 MB will be compressed or split."
  }
  else {
    docker ps 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Warn "Docker is installed but the engine is not running. Start Docker Desktop and re-run to enable 2 GB uploads."
    }
    else {
      $existing = (docker ps -a --filter "name=telegram-bot-api" --format "{{.Names}}")
      if ($existing) { Ok "container exists"; docker start telegram-bot-api | Out-Null }
      else {
        $apiId   = ([regex]::Match($envText, 'TELEGRAM_API_ID=(\d+)')).Groups[1].Value
        $apiHash = ([regex]::Match($envText, 'TELEGRAM_API_HASH=(\w+)')).Groups[1].Value
        docker pull aiogram/telegram-bot-api:latest | Out-Null
        # Bound to 127.0.0.1 only - never exposed to the network.
        docker run -d --name telegram-bot-api --restart unless-stopped `
          -p 127.0.0.1:8081:8081 `
          -e TELEGRAM_API_ID=$apiId -e TELEGRAM_API_HASH=$apiHash `
          -v tbapi-data:/var/lib/telegram-bot-api `
          aiogram/telegram-bot-api:latest | Out-Null
        Ok "container created"
      }
      Start-Sleep -Seconds 5
      $up = (docker ps --filter "name=telegram-bot-api" --format "{{.Status}}")
      if ($up) { Ok "local Bot API server: $up" } else { Warn "container did not stay up; check: docker logs telegram-bot-api" }
    }
  }

  # ---- 5. auto-start --------------------------------------------------------
  Step 5 "Auto-start at logon"
  & pwsh -File (Join-Path $PSScriptRoot "install-windows.ps1")
  Ok "auto-start installed"

  # ---- 6. global MCP registration ------------------------------------------
  Step 6 "Registering the bridge for every Claude Code session"
  if ($SkipGlobalMcp) { Warn "skipped by request" }
  elseif (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Warn "claude CLI missing - skipping" }
  else { node scripts/register-global-mcp.mjs; Ok "registered" }

  # ---- 7. start -------------------------------------------------------------
  Step 7 "Starting the daemon"
  $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*dist*main.js*" -and $_.Name -eq "node.exe" }
  if ($running) { Ok "already running (pid $($running.ProcessId))" }
  else {
    wscript (Join-Path $PSScriptRoot "tbm-launch.vbs")
    Start-Sleep -Seconds 10
    Ok "started"
  }

  Write-Host "`nDone." -ForegroundColor Green
  Write-Host "Next: open a private chat with your bot in Telegram and send /start to claim ownership."
  Write-Host "Logs:      Get-Content `"$root\data\daemon.log`" -Wait"
  Write-Host "Uninstall: pwsh -File scripts\uninstall-windows.ps1"
}
finally { Pop-Location }
