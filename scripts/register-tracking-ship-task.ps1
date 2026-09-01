# Register/remove the 3-hourly "OnliveTrackingShip" scheduled task (ASCII only: PS 5.1 reads this file as ANSI).
#   register: powershell -ExecutionPolicy Bypass -File scripts\register-tracking-ship-task.ps1
#   remove:   powershell -ExecutionPolicy Bypass -File scripts\register-tracking-ship-task.ps1 -Remove
param([switch]$Remove, [int]$IntervalHours = 3)

$TaskName = "OnliveTrackingShip"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cmd = Join-Path $Root "scripts\tracking-ship-task.cmd"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[$TaskName] removed"
  exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c `"" + $Cmd + "`"") -WorkingDirectory $Root
# fixed anchor 02:30 + every N hours (:30 avoids the hourly order sync at :00).
# MUST match lib/automation-schedule.ts (anchorHour 2, minute 30) - the automation page timeline
# and health checks assume this anchor, so re-registering at any time keeps the same slots.
$start = (Get-Date).Date.AddHours(2).AddMinutes(30)
while ($start -le (Get-Date)) { $start = $start.AddHours($IntervalHours) }
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 40) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Onlive tracking collect + marketplace invoice upload + ESM excel, every $IntervalHours h" -Force | Out-Null

Write-Host "[$TaskName] registered: every $IntervalHours h from $start, log: $Root\logs\tracking-ship.log"
