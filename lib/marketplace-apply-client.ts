// 쿠팡·스마트스토어 API 즉시 반영 클라이언트 (변동가 price / 품절 stop / 재입고 resume)
// scripts/auto-price-refresh.mjs 의 applyToMarketplaces 와 동일 경로 — 원가갱신 "적용하기" 등에서 사용.
// ESM(지마켓·옥션·11번가)은 API 미지원 → 가격수정 엑셀로 처리.

export interface MarketApplyCounts {
  price: number;
  stop: number;
  resume: number;
  failed: number;
  blocked: number;
  dry: boolean;
  errors: string[];
}

export interface MarketApplyResult {
  coupang: MarketApplyCounts | null;
  smartstore: MarketApplyCounts | null;
  skipped: string | null;
}

export interface MarketApplyInput {
  changedIds: string[];
  soldOutIds: string[];
  restoredIds: string[];
}

export async function applyPriceChangesToMarketplaces(token: string, { changedIds, soldOutIds, restoredIds }: MarketApplyInput): Promise<MarketApplyResult> {
  const out: MarketApplyResult = { coupang: null, smartstore: null, skipped: null };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  let creds: Array<{ id: string; platform: string }> = [];
  try {
    const res = await fetch("/api/marketplace-api/credentials", { headers });
    creds = res.ok ? await res.json() : [];
  } catch (e) {
    out.skipped = `API 계정 조회 실패: ${e instanceof Error ? e.message : String(e)}`;
    return out;
  }

  const jobs: Array<{ action: "price" | "stop" | "resume"; ids: string[] }> = [
    { action: "price", ids: [...new Set([...changedIds, ...restoredIds])] },
    { action: "stop", ids: soldOutIds },
    { action: "resume", ids: restoredIds },
  ];

  for (const platform of ["coupang", "smartstore"] as const) {
    const cred = creds.find((c) => c.platform === platform);
    if (!cred) continue;
    const r: MarketApplyCounts = { price: 0, stop: 0, resume: 0, failed: 0, blocked: 0, dry: false, errors: [] };
    out[platform] = r;
    for (const job of jobs) {
      if (job.ids.length === 0) continue;
      for (let i = 0; i < job.ids.length; i += 200) {
        const chunk = job.ids.slice(i, i + 200);
        try {
          const res = await fetch(`/api/marketplace-api/${platform}/apply`, {
            method: "POST",
            headers,
            body: JSON.stringify({ credentialId: cred.id, productIds: chunk, action: job.action }),
          });
          const json = await res.json().catch(() => ({})) as {
            error?: string; successCount?: number; failCount?: number; dryRun?: boolean;
            blocked?: unknown[]; results?: Array<{ status: string; productName?: string; message?: string }>;
          };
          if (!res.ok) { r.errors.push(`${job.action}: ${json.error ?? res.status}`); continue; }
          r[job.action] += json.successCount ?? 0;
          r.failed += json.failCount ?? 0;
          r.blocked += Array.isArray(json.blocked) ? json.blocked.length : 0;
          if (json.dryRun) r.dry = true;
          for (const x of (json.results ?? []).filter((x) => x.status === "failed").slice(0, 3)) {
            r.errors.push(`${x.productName}: ${x.message}`);
          }
        } catch (e) {
          r.errors.push(`${job.action}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return out;
}

/** 로그·토스트용 한 줄 요약 (예: "쿠팡 가격 3·중지 1 / 스토어 가격 3") */
export function summarizeMarketApply(result: MarketApplyResult): string {
  if (result.skipped) return `마켓 반영 건너뜀: ${result.skipped}`;
  const parts: string[] = [];
  for (const [platform, label] of [["coupang", "쿠팡"], ["smartstore", "스토어"]] as const) {
    const r = result[platform];
    if (!r) continue;
    const items: string[] = [];
    if (r.price) items.push(`가격 ${r.price}`);
    if (r.stop) items.push(`중지 ${r.stop}`);
    if (r.resume) items.push(`재개 ${r.resume}`);
    if (r.failed) items.push(`실패 ${r.failed}`);
    if (r.blocked) items.push(`미연동 ${r.blocked}`);
    parts.push(`${label} ${items.length ? items.join("·") : "대상 없음"}${r.dry ? " [DRY]" : ""}`);
  }
  return parts.length ? parts.join(" / ") : "연동된 마켓 API 계정 없음";
}
