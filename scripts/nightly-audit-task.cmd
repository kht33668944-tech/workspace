@echo off
rem Nightly full audit at 23:00 (run by Windows Task Scheduler "OnliveNightlyAudit")
cd /d "%~dp0.."
if not exist logs mkdir logs
call npx tsx scripts\nightly-audit.mts >> logs\nightly-audit-task.log 2>&1
