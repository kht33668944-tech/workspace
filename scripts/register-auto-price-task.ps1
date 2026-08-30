# Register/remove the 4-hourly "OnliveAutoPrice" scheduled task (ASCII only: PS 5.1 reads this file as ANSI).
#   register: powershell -ExecutionPolicy Bypass -File scripts\register-auto-price-task.ps1
#   remove:   powershell -ExecutionPolicy Bypass -File scripts\register-auto-price-task.ps1 -Remove
param([switch]$Remove, [int]$IntervalHours = 4)

$TaskName = "OnliveAutoPrice"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cmd = Join-Path $Root "scripts\auto-price-task.cmd"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[$TaskName] removed"
  exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c `"" + $Cmd + "`"") -WorkingDirectory $Root
# start at next hour + 15 min: order sync runs at :00, tracking/ship at :30
$start = (Get-Date).Date.AddHours((Get-Date).Hour + 1).AddMinutes(15)
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Onlive lowest-price refresh (reset daily diff, then refresh), every $IntervalHours h" -Force | Out-Null

Write-Host "[$TaskName] registered: every $IntervalHours h from $start, log: $Root\logs\auto-price-task.log"
