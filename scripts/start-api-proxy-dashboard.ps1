param(
  [int]$ControlPort = 8790
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ScriptPath = Join-Path $ProjectRoot 'scripts\api-proxy-dashboard.mjs'
$LogPath = Join-Path $ProjectRoot 'api-proxy-dashboard.log'
$ErrorLogPath = Join-Path $ProjectRoot 'api-proxy-dashboard-error.log'
$CmdPath = Join-Path $ProjectRoot 'scripts\run-api-proxy-dashboard.cmd'

if (-not (Test-Path $ScriptPath)) {
  throw "Dashboard script not found: $ScriptPath"
}

$node = (Get-Command node.exe -ErrorAction Stop).Source

$existing = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $ControlPort -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Write-Host "Dashboard already running: http://127.0.0.1:$ControlPort (PID $($existing.OwningProcess))"
  Start-Process "http://127.0.0.1:$ControlPort"
  exit 0
}

$cmd = @"
@echo off
cd /d "$ProjectRoot"
set CONTROL_PORT=$ControlPort
"$node" "$ScriptPath" 1>>"$LogPath" 2>>"$ErrorLogPath"
"@
Set-Content -Path $CmdPath -Value $cmd -Encoding ASCII

# Fully detach from this PowerShell/ZCode command. The child is a separate cmd.exe
# windowless process, so ZCode command timeouts do not kill the dashboard.
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'start', '"api-proxy-dashboard"', '/min', 'cmd.exe', '/c', "`"$CmdPath`"") -WorkingDirectory $ProjectRoot -WindowStyle Hidden

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $ControlPort -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    Write-Host "Dashboard started: http://127.0.0.1:$ControlPort (PID $($listener.OwningProcess))"
    Start-Process "http://127.0.0.1:$ControlPort"
    exit 0
  }
}

if (Test-Path $ErrorLogPath) {
  Write-Host "--- stderr ---"
  Get-Content $ErrorLogPath -Tail 40
}
throw "Dashboard did not listen on 127.0.0.1:$ControlPort"
