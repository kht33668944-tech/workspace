@echo off
rem Tracking collect -> marketplace invoice upload -> ESM excel (Windows Task Scheduler "OnliveTrackingShip", every 3h)
cd /d "%~dp0.."
if not exist logs mkdir logs
call npx tsx scripts\tracking-and-ship.mts >> logs\tracking-ship-task.log 2>&1
