# Register/remove the daily 23:00 "OnliveNightlyAudit" scheduled task (ASCII only: PS 5.1 reads this file as ANSI).
#   register: powershell -ExecutionPolicy Bypass -File scripts\register-nightly-audit-task.ps1
#   remove:   powershell -ExecutionPolicy Bypass -File scripts\register-nightly-audit-task.ps1 -Remove
param([switch]$Remove)

$TaskName = "OnliveNightlyAudit"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cmd = Join-Path $Root "scripts\nightly-audit-task.cmd"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[$TaskName] removed"
  exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c `"" + $Cmd + "`"") -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Daily -At "23:00"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Onlive nightly full audit report to Discord, daily 23:00" -Force | Out-Null

Write-Host "[$TaskName] registered: daily 23:00, log: $Root\logs\nightly-audit.log"
