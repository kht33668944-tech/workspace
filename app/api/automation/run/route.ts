import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { AUTOMATIONS, type AutomationKey } from "@/lib/automation-schedule";

const execFileAsync = promisify(execFile);

export const maxDuration = 30;

// 로컬 Windows PC에서만 schtasks 실행 가능 (Railway 등 배포 환경 차단)
function schtasksAvailable(): boolean {
  return process.platform === "win32" && process.env.AUTOMATION_RUN_DISABLED !== "true";
}

/** 즉시 실행 가능 여부 (버튼 활성화 판단용) */
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  return NextResponse.json({ available: schtasksAvailable() });
}

/** 작업 스케줄러 트리거: { task: "tracking-ship" | "price" } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    if (!schtasksAvailable()) {
      return NextResponse.json({ error: "이 서버에서는 로컬 자동화를 실행할 수 없습니다 (로컬 PC 전용)." }, { status: 501 });
    }

    const body = (await request.json().catch(() => ({}))) as { task?: AutomationKey };
    const def = AUTOMATIONS.find((d) => d.key === body.task && d.runVia === "schtasks");
    if (!def || !def.taskName) return NextResponse.json({ error: "지원하지 않는 작업입니다." }, { status: 400 });

    // 이미 실행 중이면 거부 (스케줄러 IgnoreNew 가 2차 방어)
    const since = new Date(Date.now() - def.maxRuntimeMin * 60000).toISOString();
    const { data: running } = await supabase
      .from("marketplace_sync_runs")
      .select("id")
      .in("kind", def.kinds)
      .eq("status", "running")
      .gte("started_at", since)
      .limit(1);
    if (running && running.length > 0) {
      return NextResponse.json({ error: `${def.label}이(가) 이미 실행 중입니다.` }, { status: 409 });
    }

    await execFileAsync("schtasks", ["/Run", "/TN", def.taskName]);
    console.log(`[automation-run] ${def.taskName} 트리거됨 (user=${userData.user.id})`);
    return NextResponse.json({ ok: true, message: `${def.label} 시작 요청됨 — 잠시 후 타임라인에 표시됩니다.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[automation-run] 오류:", message);
    return NextResponse.json({ error: `실행 요청 실패: ${message}` }, { status: 500 });
  }
}
