# Launch aicode in a standalone window (Windows Terminal preferred).
# Not system32\cmd — window/tab title is "aicode".
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Ensure dist is built.
if (-not (Test-Path (Join-Path $Root 'dist\src\index.js'))) {
  npm run build | Out-Null
}

# Resolve credentials: prefer user OPENAI_*, else known working fallback for local demo.
$Key = $env:OPENAI_API_KEY
if (-not $Key) { $Key = $env:OPENCODE_API_KEY_OPENAI }
$Base = $env:OPENAI_BASE_URL
$Model = $env:OPENAI_MODEL

if (-not $Key) {
  # Temporary local fallback only when nothing else is configured.
  $Key = 'sk-E4s71gjGqTDuavc30JgfjQDVd3lOE8MsNg0uIv5XDaU2XSHN'
  $Base = 'https://yunqiaoai.dpdns.org/v1'
  $Model = 'grok-4.5'
  Write-Host 'Note: using temporary yunqiao/grok-4.5 fallback (set OPENAI_API_KEY + OPENAI_BASE_URL for your own model).' -ForegroundColor DarkYellow
} else {
  if (-not $Base) { $Base = 'https://api.openai.com/v1' }
  if (-not $Model) { $Model = 'gpt-5.5' }
}

$Node = (Get-Command node -ErrorAction Stop).Source
$Entry = Join-Path $Root 'dist\src\index.js'
$Args = @(
  $Entry,
  '--provider', 'openai',
  '--model', $Model,
  '--base-url', $Base,
  '--approval', 'ask'
)

$env:OPENAI_API_KEY = $Key
$env:OPENAI_BASE_URL = $Base
$env:OPENAI_MODEL = $Model

$Wt = $null
foreach ($candidate in @(
  (Get-Command wt.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe",
  "$env:ProgramFiles\Windows Terminal\wt.exe"
)) {
  if ($candidate -and (Test-Path $candidate)) { $Wt = $candidate; break }
}

if ($Wt) {
  # New Windows Terminal window/tab titled aicode — no cmd.exe shell chrome.
  $wtArgs = @(
    '-w', '0',
    'new-tab',
    '--title', 'aicode',
    '--startingDirectory', $Root,
    $Node
  ) + $Args
  Start-Process -FilePath $Wt -ArgumentList $wtArgs | Out-Null
  Write-Output "launched-wt aicode model=$Model"
  exit 0
}

# Fallback: start node.exe directly (window title set by process.title = aicode).
Start-Process -FilePath $Node -ArgumentList $Args -WorkingDirectory $Root | Out-Null
Write-Output "launched-node aicode model=$Model"
