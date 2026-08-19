<#
.SYNOPSIS
  Installs ReClaude — a flight recorder for the Claude Code context window.
.DESCRIPTION
  Installs the reclaude command globally via npm, then optionally installs the
  /snapshot skill into %USERPROFILE%\.claude\skills and registers a logon task
  so the viewer keeps running (which is what preserves Claude Code's file-history
  backups before it prunes them).
.EXAMPLE
  irm https://raw.githubusercontent.com/natpalmer-e4o4/ReClaude/main/install/install.ps1 | iex
.EXAMPLE
  .\install.ps1 -NoSkill -AtLogon
#>
[CmdletBinding()]
param(
  [switch]$NoSkill,     # skip installing the /snapshot skill
  [switch]$AtLogon,     # register a scheduled task to start ReClaude at logon
  [int]$Port = 7331
)

$ErrorActionPreference = 'Stop'
$Pkg = '@natpalmer-e4o4/reclaude'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- prerequisites -----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js 18+ is required and was not found." -ForegroundColor Red
  Write-Host "Install it with:  winget install OpenJS.NodeJS.LTS"
  exit 1
}
$major = [int](((& node --version) -replace '^v','') -split '\.')[0]
if ($major -lt 18) { Write-Host "Node $major found; ReClaude needs 18 or newer." -ForegroundColor Red; exit 1 }

# --- install -----------------------------------------------------------------
Write-Step "Installing $Pkg"
& npm install -g $Pkg
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed." -ForegroundColor Red; exit 1 }

# npm places shims in its global prefix; make sure it is on PATH for this user
$prefix = (& npm prefix -g).Trim()
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$prefix*") {
  Write-Step "Adding $prefix to your PATH"
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$prefix", 'User')
  $env:Path = "$env:Path;$prefix"
  Write-Host "    (open a new terminal for this to take effect everywhere)"
}

# --- skill -------------------------------------------------------------------
if (-not $NoSkill) {
  Write-Step "Installing the /snapshot skill"
  & reclaude install-skill
}

# --- run at logon ------------------------------------------------------------
if ($AtLogon) {
  Write-Step "Registering a logon task (ReClaude)"
  $exe = (Get-Command reclaude).Source
  $action  = New-ScheduledTaskAction -Execute $exe -Argument "--port $Port --no-open"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'ReClaude' -Action $action -Trigger $trigger `
    -Settings $set -Description 'ReClaude viewer — keeps the file-history mirror running' -Force | Out-Null
  Write-Host "    remove later with:  Unregister-ScheduledTask -TaskName ReClaude -Confirm:`$false"
}

Write-Host ""
Write-Host "ReClaude installed." -ForegroundColor Green
Write-Host "  start it:   reclaude"
Write-Host "  capture:    run /snapshot inside a Claude Code session"
Write-Host "  viewer:     http://127.0.0.1:$Port"
