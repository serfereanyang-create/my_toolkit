@echo off
setlocal EnableExtensions

cd /d "%~dp0" || goto fail

set http_proxy=http://127.0.0.1:7890
set https_proxy=http://127.0.0.1:7890
set all_proxy=socks5://127.0.0.1:7890

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
goto done

:commit
echo [5/6] Commit changes
git commit -m "update %date% %time%"
if errorlevel 1 goto fail

echo [6/6] Push to origin/main
git branch -M main
git -c http.sslBackend=openssl push -u origin HEAD:main
if errorlevel 1 goto fail

:done
echo.
echo Push completed.
pause
exit /b 0

:fail
echo.
echo Push failed.
pause
exit /b 1
