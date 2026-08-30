# 윈도우 작업 스케줄러에 "OnliveOrderSync" (1시간마다 마켓 주문 수집) 등록/해제
#   등록: powershell -ExecutionPolicy Bypass -File scripts\register-order-sync-task.ps1
#   해제: powershell -ExecutionPolicy Bypass -File scripts\register-order-sync-task.ps1 -Remove
param([switch]$Remove)

$TaskName = "OnliveOrderSync"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ($Remove) {
  schtasks /Delete /TN $TaskName /F | Out-Null
  Write-Host "[$TaskName] 삭제됨"
  exit 0
}

$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $npx) { $npx = "npx.cmd" }
$cmd = "cmd /c cd /d `"$Root`" && `"$npx`" tsx scripts\marketplace-order-sync.mts --platform all --days 3 >> logs\order-sync-task.log 2>&1"

New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

# 매시 정각, 로그인 사용자 권한, 놓친 회차는 다음 가능 시점에 실행, 배터리에서도 실행
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c cd /d `"$Root`" && `"$npx`" tsx scripts\marketplace-order-sync.mts --platform all --days 3 >> logs\order-sync-task.log 2>&1")
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours((Get-Date).Hour + 1) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "온리브 마켓 주문 자동 수집 (쿠팡·스마트스토어 API)" -Force | Out-Null

Write-Host "[$TaskName] 등록됨 — 매시 정각 실행, 로그: $Root\logs\order-sync.log"
Write-Host "명령: $cmd"
