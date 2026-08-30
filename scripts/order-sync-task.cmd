@echo off
rem Hourly marketplace order sync (run by Windows Task Scheduler "OnliveOrderSync")
cd /d "%~dp0.."
if not exist logs mkdir logs
call npx tsx scripts\marketplace-order-sync.mts --platform all --days 3 >> logs\order-sync-task.log 2>&1
