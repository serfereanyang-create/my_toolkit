@echo off
git add .
git commit -m "update %date% %time%"
git push origin main
echo 推送完成
pause