@echo off
setlocal EnableExtensions

cd /d "%~dp0" || goto fail

set "USE_PROXY=0"
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',7890); exit 0 } catch { exit 1 } finally { $c.Close() }" >nul 2>nul
if not errorlevel 1 set "USE_PROXY=1"

if "%USE_PROXY%"=="1" (
    set http_proxy=http://127.0.0.1:7890
    set https_proxy=http://127.0.0.1:7890
    set all_proxy=socks5://127.0.0.1:7890
) else (
    set http_proxy=
    set https_proxy=
    set all_proxy=
)

echo [1/6] Configure git identity
git config --local user.name "serferean"
if errorlevel 1 goto fail
git config --local user.email "serferean@users.noreply.github.com"
if errorlevel 1 goto fail

echo [2/6] Configure remote
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    git remote add origin https://github.com/serfereanyang-create/my_toolkit.git
) else (
    git remote set-url origin https://github.com/serfereanyang-create/my_toolkit.git
)
if errorlevel 1 goto fail

echo [3/6] Configure ssl backend
git config --local http.sslBackend openssl
if errorlevel 1 goto fail

echo [4/6] Stage files
git add -A
if errorlevel 1 goto fail

git diff --cached --quiet
if errorlevel 1 goto commit
goto push

:commit
echo [5/6] Commit changes
git commit -m "update %date% %time%"
if errorlevel 1 goto fail

:push
echo [6/6] Push to origin/main
git branch -M main
git -c http.sslBackend=openssl push -u origin HEAD:main
if errorlevel 1 goto fail

echo.
echo Push completed.
pause
exit /b 0

:fail
echo.
echo Push failed.
pause
exit /b 1
