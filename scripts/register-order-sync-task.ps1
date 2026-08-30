# Register/remove the hourly "OnliveOrderSync" scheduled task (ASCII only: PS 5.1 reads this file as ANSI).
#   register: powershell -ExecutionPolicy Bypass -File scripts\register-order-sync-task.ps1
#   remove:   powershell -ExecutionPolicy Bypass -File scripts\register-order-sync-task.ps1 -Remove
param([switch]$Remove)

$TaskName = "OnliveOrderSync"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cmd = Join-Path $Root "scripts\order-sync-task.cmd"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[$TaskName] removed"
  exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c `"" + $Cmd + "`"") -WorkingDirectory $Root
$start = (Get-Date).Date.AddHours((Get-Date).Hour + 1)
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Onlive marketplace order sync (Coupang/SmartStore API), hourly" -Force | Out-Null

Write-Host "[$TaskName] registered: hourly from $start, log: $Root\logs\order-sync.log"
