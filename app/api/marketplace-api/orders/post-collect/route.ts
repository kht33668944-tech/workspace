import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { shipOrders, type ShipResult } from "@/lib/marketplace/order-ship";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";
import { notifyShipResults } from "@/lib/marketplace/order-sync-notify";
import { exportEsmTrackingExcel, type EsmExportResult } from "@/lib/tracking/esm-export";
import { isDryRun } from "@/lib/marketplace/common";

export const maxDuration = 300;

/**
 * 운송장 수집 직후 후처리: 미전송 운송장 쿠팡·스토어 API 전송 + ESM 운송장 엑셀을 바탕화면(ESM운송장)에 저장
 * (서버가 이 PC에서 돌기 때문에 바탕화면에 직접 쓸 수 있다)
 */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;
    // notify:false — 수집 모달이 수집+전송+ESM 을 합쳐 1회만 보낸다
    const body = (await request.json().catch(() => ({}))) as { notify?: boolean };

    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform").in("platform", ["coupang", "smartstore"]);
    const results: ShipResult[] = [];
    const errors: string[] = [];
    for (const platform of ["coupang", "smartstore"] as SyncPlatform[]) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      try {
        const clients = platform === "coupang"
          ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
          : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
        results.push(await shipOrders({ supabase, userId, platform, credentialId: cred.id, trigger: "manual", ...clients }));
      } catch (err) { errors.push(`${platform}: ${err instanceof Error ? err.message : String(err)}`); }
    }

    let esm: EsmExportResult | null = null;
    try {
      esm = await exportEsmTrackingExcel(supabase, userId, { markExported: !isDryRun() });
    } catch (err) { errors.push(`ESM 엑셀: ${err instanceof Error ? err.message : String(err)}`); }

    if (body.notify !== false) await notifyShipResults(results, "manual", { esm });
    return NextResponse.json({ dryRun: isDryRun(), results, esm, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[post-collect] 오류:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
