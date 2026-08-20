# 최저가 자동 갱신 실행 래퍼 (Windows 작업 스케줄러용)
# 절전(Modern Standby)에서 깨어나 실행될 때, 작업이 끝날 때까지 시스템이 다시 잠들지 않도록 붙잡는다.
param(
  [string]$Label = "자동",
  [switch]$Reset
)

$ErrorActionPreference = "Continue"

# ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001): 이 프로세스가 살아있는 동안 절전 진입 금지
Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name PowerUtil -Namespace Win32
[Win32.PowerUtil]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null

try {
  $script = Join-Path $PSScriptRoot "auto-price-refresh.mjs"
  $nodeArgs = @($script, "--label", $Label)
  if ($Reset) { $nodeArgs += "--reset" }
  & node @nodeArgs
  exit $LASTEXITCODE
} finally {
  # 잠금 해제 (원래 절전 정책으로 복귀)
  [Win32.PowerUtil]::SetThreadExecutionState([uint32]"0x80000000") | Out-Null
}
