$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
$outFile = Join-Path $dataDir 'device-scan.js'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Get-RawPnpEntries {
  $entries = @()

  try {
    $entries = @(
      Get-CimInstance Win32_PnPEntity -ErrorAction Stop | ForEach-Object {
        [pscustomobject]@{
          status = [string]$_.Status
          class = [string]$_.PNPClass
          friendlyName = [string]$_.Name
          instanceId = [string]$_.PNPDeviceID
        }
      }
    )
  } catch {
    $entries = @()
  }

  if ($entries.Count -gt 0) {
    return $entries
  }

  try {
    return @(
      Get-PnpDevice -ErrorAction Stop | ForEach-Object {
        [pscustomobject]@{
          status = [string]$_.Status
          class = [string]$_.Class
          friendlyName = [string]$_.FriendlyName
          instanceId = [string]$_.InstanceId
        }
      }
    )
  } catch {
    return @()
  }
}

function Get-UsbId([string]$instanceId) {
  if ([string]::IsNullOrWhiteSpace($instanceId)) {
    return ''
  }

  $vidMatch = [regex]::Match($instanceId, 'VID_([0-9A-F]{4})', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $pidMatch = [regex]::Match($instanceId, 'PID_([0-9A-F]{4})', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

  if (-not $vidMatch.Success -and -not $pidMatch.Success) {
    return ''
  }

  $parts = New-Object System.Collections.Generic.List[string]
  if ($vidMatch.Success) {
    [void]$parts.Add('VID_' + $vidMatch.Groups[1].Value.ToUpperInvariant())
  }
  if ($pidMatch.Success) {
    [void]$parts.Add('PID_' + $pidMatch.Groups[1].Value.ToUpperInvariant())
  }

  return ($parts -join ' ')
}

function Get-ComPort([string]$friendlyName, [string]$instanceId) {
  foreach ($text in @($friendlyName, $instanceId)) {
    if ([string]::IsNullOrWhiteSpace($text)) {
      continue
    }

    $match = [regex]::Match($text, '\((COM\d+)\)|\b(COM\d+)\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) {
      if ($match.Groups[1].Success) {
        return $match.Groups[1].Value.ToUpperInvariant()
      }
      if ($match.Groups[2].Success) {
        return $match.Groups[2].Value.ToUpperInvariant()
      }
    }
  }

  return $null
}

function Get-BoardType([string]$friendlyName, [string]$instanceId) {
  $name = [string]$friendlyName
  $id = [string]$instanceId

  $has303A = $id.IndexOf('VID_303A', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $has1A86 = $id.IndexOf('VID_1A86', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $hasPid0012 = $id.IndexOf('PID_0012', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $hasPid1001 = $id.IndexOf('PID_1001', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $hasPid4001 = $id.IndexOf('PID_4001', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $isCh34x = $has1A86 -or ($name -match 'CH340|CH343')

  if (($name -match 'ESP32-P4') -or ($has303A -and $hasPid0012)) {
    return 'ESP32-P4'
  }
  if ($has303A -and $hasPid1001) {
    return 'ESP32 Series (USB JTAG/Serial)'
  }
  if ($has303A -and $hasPid4001) {
    return 'Espressif USB Device'
  }
  if ($isCh34x) {
    return 'USB Bridge (CH34x)'
  }
  if ($has303A -or $name -match 'ESP32|Espressif') {
    return 'ESP32 Series Board'
  }

  return 'Unknown Board'
}

function Get-IsCandidate([string]$friendlyName, [string]$instanceId) {
  $name = [string]$friendlyName
  $id = [string]$instanceId

  return (
    ($id -match 'VID_303A|VID_1A86') -or
    ($name -match 'ESP32|Espressif|USB-SERIAL|CH340|CH343|JTAG/Serial')
  )
}

function Get-Priority([psobject]$device) {
  if ($device.isEsp32P4) {
    return 0
  }
  if ($device.isEspressifDirect) {
    return 1
  }
  if ($device.isUsbBridge) {
    return 2
  }
  return 3
}

function Get-ComSortValue([string]$portLabel) {
  if ($portLabel -match '^COM(\d+)$') {
    return [int]$Matches[1]
  }
  return 999999
}

$rawEntries = @(Get-RawPnpEntries)
$candidateMap = @{}

foreach ($entry in $rawEntries) {
  $friendlyName = if ([string]::IsNullOrWhiteSpace($entry.friendlyName)) { 'Unnamed Device' } else { [string]$entry.friendlyName }
  $instanceId = [string]$entry.instanceId

  if (-not (Get-IsCandidate -friendlyName $friendlyName -instanceId $instanceId)) {
    continue
  }

  $boardType = Get-BoardType -friendlyName $friendlyName -instanceId $instanceId
  $usbId = Get-UsbId -instanceId $instanceId
  $com = Get-ComPort -friendlyName $friendlyName -instanceId $instanceId
  $isEsp32P4 = $boardType -eq 'ESP32-P4'
  $isUsbBridge = $boardType -eq 'USB Bridge (CH34x)'
  $isEspressifDirect = @(
    'ESP32-P4',
    'ESP32 Series (USB JTAG/Serial)',
    'Espressif USB Device',
    'ESP32 Series Board'
  ) -contains $boardType

  $key = if (-not [string]::IsNullOrWhiteSpace($instanceId)) {
    $instanceId
  } elseif (-not [string]::IsNullOrWhiteSpace($com)) {
    'COM:' + $com
  } else {
    'NAME:' + $friendlyName
  }

  $candidate = [pscustomobject]@{
    status = [string]$entry.status
    class = [string]$entry.class
    friendlyName = $friendlyName
    instanceId = $instanceId
    usbId = $usbId
    com = $com
    boardType = $boardType
    isEspressif = ($isEspressifDirect -or $isEsp32P4)
    isEspressifDirect = $isEspressifDirect
    isUsbBridge = $isUsbBridge
    isEsp32P4 = $isEsp32P4
    priority = 0
  }
  $candidate.priority = Get-Priority -device $candidate

  if ($candidateMap.ContainsKey($key)) {
    $existing = $candidateMap[$key]
    if (-not $existing.com -and $candidate.com) {
      $existing.com = $candidate.com
    }
    if ((-not $existing.usbId) -and $candidate.usbId) {
      $existing.usbId = $candidate.usbId
    }
    if ($existing.priority -gt $candidate.priority) {
      $candidateMap[$key] = $candidate
    }
    continue
  }

  $candidateMap[$key] = $candidate
}

$candidateDevices = @(
  $candidateMap.Values | Sort-Object @(
    @{ Expression = 'priority'; Ascending = $true },
    @{ Expression = { Get-ComSortValue $_.com }; Ascending = $true },
    @{ Expression = 'boardType'; Ascending = $true },
    @{ Expression = 'friendlyName'; Ascending = $true }
  )
)

$recommended = @($candidateDevices | Where-Object { $_.com } | Select-Object -First 1)[0]
if (-not $recommended) {
  $recommended = @($candidateDevices | Select-Object -First 1)[0]
}

$preferredPorts = @($candidateDevices | Where-Object { $_.com } | Select-Object -ExpandProperty com -Unique)
$preferredBoards = @($candidateDevices | Select-Object -ExpandProperty boardType -Unique)

$summary = [ordered]@{
  scannedAt = (Get-Date).ToString('s')
  totalPnPEntries = $rawEntries.Count
  total = $candidateDevices.Count
  candidateCount = $candidateDevices.Count
  espCandidates = @($candidateDevices | Where-Object { $_.isEspressif -or $_.isUsbBridge }).Count
  esp32p4Detected = (@($candidateDevices | Where-Object { $_.isEsp32P4 }).Count -gt 0)
  recommendedBoard = if ($recommended) { $recommended.boardType } else { $null }
  recommendedPort = if ($recommended) { $recommended.com } else { $null }
  recommendedIsP4 = if ($recommended) { [bool]$recommended.isEsp32P4 } else { $false }
  preferredPorts = $preferredPorts
  preferredBoards = $preferredBoards
  devices = @(
    $candidateDevices | ForEach-Object {
      [ordered]@{
        status = $_.status
        class = $_.class
        friendlyName = $_.friendlyName
        instanceId = $_.instanceId
        usbId = $_.usbId
        com = $_.com
        boardType = $_.boardType
        isEspressif = [bool]$_.isEspressif
        isEspressifDirect = [bool]$_.isEspressifDirect
        isUsbBridge = [bool]$_.isUsbBridge
        isEsp32P4 = [bool]$_.isEsp32P4
        priority = [int]$_.priority
      }
    }
  )
}

$json = $summary | ConvertTo-Json -Depth 6
$js = 'window.__LABSAFE_DEVICE_SCAN__ = ' + $json + ';' + [Environment]::NewLine
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($outFile, $js, $utf8WithBom)

Write-Host ('DEVICE_SCAN_WRITTEN ' + $outFile)
Write-Host ('DEVICE_SCAN_EXISTS ' + (Test-Path -LiteralPath $outFile))
Write-Host ('CANDIDATE_COUNT ' + $summary.candidateCount)
Write-Host ('RECOMMENDED_BOARD ' + $summary.recommendedBoard)
Write-Host ('RECOMMENDED_PORT ' + $summary.recommendedPort)
Write-Host ('ESP32P4_DETECTED ' + $summary.esp32p4Detected)
Write-Host ('PREFERRED_PORTS ' + ($summary.preferredPorts -join ','))
Write-Host ('PREFERRED_BOARDS ' + ($summary.preferredBoards -join ','))
