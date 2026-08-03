param(
  [int[]]$Ports = @(8788,8790)
)

foreach ($port in $Ports) {
  Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      try {
        Stop-Process -Id $_ -Force -ErrorAction Stop
        Write-Host "Stopped PID $_ on port $port"
      } catch {
        Write-Warning "Failed to stop PID $_ on port ${port}: $($_.Exception.Message)"
      }
    }
}
