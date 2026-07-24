# Launch aicode in a standalone window (Windows Terminal preferred).
# Not system32\cmd — window/tab title is "aicode".
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path (Join-Path $Root 'dist\src\index.js'))) {
  npm run build | Out-Null
}

# Default live demo route the user has been using: yunqiao + grok-4.5.
# Override with AICODE_USE_ENV_PROVIDER=1 to honor OPENAI_* from the environment instead.
$UseEnv = ($env:AICODE_USE_ENV_PROVIDER -eq '1' -or $env:AICODE_USE_ENV_PROVIDER -eq 'true')
if ($UseEnv -and $env:OPENAI_API_KEY) {
  $Key = $env:OPENAI_API_KEY
  $Base = if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { 'https://api.openai.com/v1' }
  $Model = if ($env:OPENAI_MODEL) { $env:OPENAI_MODEL } else { 'gpt-5.5' }
  Write-Host "using env provider model=$Model base=$Base" -ForegroundColor DarkGray
} else {
  $Key = if ($env:AICODE_LIVE_KEY) { $env:AICODE_LIVE_KEY } else { 'sk-E4s71gjGqTDuavc30JgfjQDVd3lOE8MsNg0uIv5XDaU2XSHN' }
  $Base = if ($env:AICODE_LIVE_BASE) { $env:AICODE_LIVE_BASE } else { 'https://yunqiaoai.dpdns.org/v1' }
  $Model = if ($env:AICODE_LIVE_MODEL) { $env:AICODE_LIVE_MODEL } else { 'grok-4.5' }
  Write-Host "using yunqiao/grok-4.5 (set AICODE_USE_ENV_PROVIDER=1 to use OPENAI_* instead)" -ForegroundColor DarkGray
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
  $wtArgs = @(
    '-w', '0',
    'new-tab',
    '--title', 'aicode',
    '--startingDirectory', $Root,
    $Node
  ) + $Args
  Start-Process -FilePath $Wt -ArgumentList $wtArgs | Out-Null
  Write-Output "launched-wt aicode model=$Model base=$Base"
  exit 0
}

Start-Process -FilePath $Node -ArgumentList $Args -WorkingDirectory $Root | Out-Null
Write-Output "launched-node aicode model=$Model base=$Base"
