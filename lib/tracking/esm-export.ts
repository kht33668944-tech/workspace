// ESM(지마켓·옥션·11번가) 판매분 운송장 → 플레이오토 운송장 엑셀 파일로 저장 (Node 전용, 스케줄러/스크립트용)
//  대상: tracking_no 있음 AND tracking_exported_at IS NULL (includeExported 면 최근 N일 전체)

import fs from "fs";
import path from "path";
import os from "os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePlayAutoTrackingExcel } from "@/lib/excel-export";
import type { Order } from "@/types/database";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export const ESM_MARKETS = ["지마켓", "옥션", "11번가"];

export function defaultTrackingExportDir() {
  return process.env.TRACKING_EXPORT_DIR || path.join(os.homedir(), "Desktop", "ESM운송장");
}

export interface EsmExportResult {
  count: number;
  file: string | null;
  orderIds: string[];
}

export async function exportEsmTrackingExcel(
  supabase: AnySupabase,
  userId: string,
  opts: { dir?: string; includeExported?: boolean; days?: number; markExported?: boolean } = {},
): Promise<EsmExportResult> {
  const dir = opts.dir ?? defaultTrackingExportDir();
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = supabase
    .from("orders")
    .select("*")
    .eq("user_id", userId)
    .not("tracking_no", "is", null)
    .neq("tracking_no", "")
    .gte("order_date", since)
    .order("order_date", { ascending: true })
    .limit(2000);
  if (!opts.includeExported) q = q.is("tracking_exported_at", null);
  const { data, error } = await q;
  if (error) throw new Error(`발주서 조회 실패: ${error.message}`);
  const orders = ((data ?? []) as Order[]).filter((o) => ESM_MARKETS.some((m) => (o.marketplace ?? "").includes(m)) && o.bundle_no);
  if (orders.length === 0) return { count: 0, file: null, orderIds: [] };

  const { data: codes } = await supabase.from("courier_codes").select("courier_name, courier_code").eq("user_id", userId);
  const codeMap: Record<string, number> = {};
  for (const c of (codes ?? []) as Array<{ courier_name: string; courier_code: number }>) codeMap[c.courier_name] = c.courier_code;

  const { buffer } = await generatePlayAutoTrackingExcel(orders, codeMap);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const file = path.join(dir, `플레이오토_운송장_${stamp}.xlsx`);
  fs.writeFileSync(file, Buffer.from(buffer));

  const orderIds = orders.map((o) => o.id);
  if (opts.markExported !== false) {
    for (let i = 0; i < orderIds.length; i += 200) {
      const { error: upErr } = await supabase.from("orders").update({ tracking_exported_at: now.toISOString() }).in("id", orderIds.slice(i, i + 200)).eq("user_id", userId);
      if (upErr) console.warn("[esm-export] tracking_exported_at 기록 실패:", upErr.message);
    }
  }
  console.log(`[esm-export] ${orders.length}건 → ${file}`);
  return { count: orders.length, file, orderIds };
}
