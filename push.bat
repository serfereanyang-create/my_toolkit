@echo off
setlocal
cd /d D:\codex\my_toolkit

echo [1/5] 设置当前仓库 Git 身份...
git config --local user.name "serferean"
git config --local user.email "serferean@users.noreply.github.com"
if errorlevel 1 goto :fail

echo [2/5] 设置远程仓库...
git remote remove origin >nul 2>nul
git remote add origin https://github.com/serferean/mytoolkit.git
if errorlevel 1 goto :fail

echo [3/5] 添加文件...
git add .
if errorlevel 1 goto :fail

echo [4/5] 提交更改...
git commit -m "update %date% %time%"
if errorlevel 1 (
    echo 可能没有可提交的内容，继续尝试推送...
)

echo [5/5] 推送到 origin/main...
git branch -M main
git push -u origin main
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
