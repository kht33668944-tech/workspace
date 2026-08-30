@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [쿠팡취소] 드라이런 실행 (1건 접수 직전까지)
call npm run coupang:cancel
echo.
echo 확인 후 전건 접수하려면: npm run coupang:cancel -- --go
pause
