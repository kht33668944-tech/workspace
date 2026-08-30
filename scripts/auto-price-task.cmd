@echo off
rem Lowest-price refresh, every 4h (Windows Task Scheduler "OnliveAutoPrice"): reset today's diff first, then refresh all
cd /d "%~dp0.."
if not exist logs mkdir logs
powershell -ExecutionPolicy Bypass -File "%~dp0run-auto-price.ps1" -Label auto -Reset >> logs\auto-price-task.log 2>&1
