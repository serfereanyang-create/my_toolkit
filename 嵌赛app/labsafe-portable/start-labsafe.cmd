@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found.
  pause
  exit /b 1
)
start "LabSafe Backend" /min node labsafe_serial_bridge_db.mjs COM18 115200 8765
start "LabSafe UI Server" /min node labsafe_portable_server.js 8082
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8082/index.html"
echo LabSafe started.
echo UI: http://127.0.0.1:8082/index.html
echo Backend: http://127.0.0.1:8765
pause
