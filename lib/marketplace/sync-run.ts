// marketplace_sync_runs 실행 기록 공용 헬퍼 — 자동화 페이지 타임라인용.
// 기록 실패는 log 만 남기고 본작업을 절대 막지 않는다. 호출부는 try/finally 로
// finishSyncRun 을 보장해 running 좀비 행을 남기지 않는 것을 권장.

import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export interface SyncRunPatch {
  status: "success" | "partial" | "failed";
  remote_count?: number;
  confirmed?: number;
  error?: string | null;
  detail?: unknown;
}

export async function startSyncRun(
  supabase: AnySupabase,
  fields: { userId: string; platform: string; kind: string; trigger: string; dryRun?: boolean },
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("marketplace_sync_runs")
      .insert({ user_id: fields.userId, platform: fields.platform, kind: fields.kind, trigger: fields.trigger, dry_run: fields.dryRun ?? false })
      .select("id")
      .single();
    return data?.id ?? null;
  } catch (e) {
    console.warn(`[sync-run] 실행 기록 생성 실패(${fields.kind}):`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function finishSyncRun(supabase: AnySupabase, runId: string | null, patch: SyncRunPatch): Promise<void> {
  if (!runId) return;
  try {
    const { error } = await supabase
      .from("marketplace_sync_runs")
      .update({ finished_at: new Date().toISOString(), ...patch })
      .eq("id", runId);
    if (error) console.warn("[sync-run] 실행 기록 마무리 실패:", error.message);
  } catch (e) {
    console.warn("[sync-run] 실행 기록 마무리 실패:", e instanceof Error ? e.message : String(e));
  }
}
