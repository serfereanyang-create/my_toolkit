@echo off
cd /d "C:\Users\34516\ZCodeProject"
set CONTROL_PORT=8790
"D:\download\EdgeImpulse\NodeJS\node.exe" "C:\Users\34516\ZCodeProject\scripts\api-proxy-dashboard.mjs" 1>>"C:\Users\34516\ZCodeProject\api-proxy-dashboard.log" 2>>"C:\Users\34516\ZCodeProject\api-proxy-dashboard-error.log"
