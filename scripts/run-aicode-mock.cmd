@echo off
cd /d C:\Users\34516\ZCodeProject\cli
node dist\src\index.js --provider mock --approval ask
echo.
echo [ aicode exited with %errorlevel% ]
pause
