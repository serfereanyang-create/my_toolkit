@echo off
setlocal
cd /d D:\codex\my_toolkit

set http_proxy=http://127.0.0.1:7890
set https_proxy=http://127.0.0.1:7890
set all_proxy=socks5://127.0.0.1:7890
set GIT_SSL_NO_VERIFY=

echo [1/6] 设置当前仓库 Git 身份...
git config --local user.name "serferean"
git config --local user.email "serferean@users.noreply.github.com"
if errorlevel 1 goto :fail

echo [2/6] 设置远程仓库...
git remote remove origin >nul 2>nul
git remote add origin https://github.com/serfereanyang-create/my_toolkit.git
if errorlevel 1 goto :fail

echo [3/6] 设置本次推送使用代理与 OpenSSL...
git config --local http.sslBackend openssl
if errorlevel 1 goto :fail

echo [4/6] 添加文件...
git add .
if errorlevel 1 goto :fail

echo [5/6] 提交更改...
git commit -m "update %date% %time%"
if errorlevel 1 (
    echo 可能没有可提交的内容，继续尝试推送...
)

echo [6/6] 推送到 origin/main...
git branch -M main
git -c http.sslBackend=openssl push -u origin main
if errorlevel 1 goto :fail

echo.
echo 推送完成。
pause
exit /b 0

:fail
echo.
echo 执行失败，请检查上面的 Git 输出。
pause
exit /b 1
