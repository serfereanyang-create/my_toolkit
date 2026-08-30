Start-Process -FilePath 'C:\Users\34516\Desktop\YOYcode IDE 新建.lnk'
Start-Sleep -Seconds 3
Get-Process electron -ErrorAction SilentlyContinue | Select-Object -First 5 ProcessName,Id | Format-Table -HideTableHeaders
