// 가격수정 v2 (셀러센터 양식) 엑셀 다운로드 클라이언트 유틸 — 상품소싱·발주서 페이지에서 공용 사용
import { downloadExcelFromBase64 } from "@/lib/excel-export";

export type PriceV2Platform = "coupang" | "esm" | "smartstore";

export const PRICE_V2_LABELS: Record<PriceV2Platform, { label: string; rowLabel: string }> = {
  coupang: { label: "쿠팡 양식", rowLabel: "옵션 행" },
  esm: { label: "ESM 상품목록", rowLabel: "옥션·지마켓 행" },
  smartstore: { label: "스마트스토어 일괄수정 엑셀", rowLabel: "스마트스토어 행" },
};

// 다운로드된 파일별 후처리 콜백 (보관함 저장 등)
export type PriceV2FileHandler = (filename: string, excelBase64: string, rowCount: number) => void;

// 단일 플랫폼 가격수정 v2 export — 다운로드를 수행하고 안내 메시지(없으면 null)를 반환
export async function exportPriceV2Platform(
  platform: PriceV2Platform,
  ids: string[],
  accessToken: string,
  onFile?: PriceV2FileHandler,
): Promise<string | null> {
  const { label, rowLabel } = PRICE_V2_LABELS[platform];
  const res = await fetch(`/api/${platform}-price-inventory/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ productIds: ids }),
  });
  const json = await res.json() as {
    files?: Array<{ excelBase64: string; filename: string; rowCount: number }>;
    excelBase64?: string;
    filename?: string;
    rowCount?: number;
    fileCount?: number;
    skippedProductIds?: string[];
    error?: string;
  };
  if (!res.ok) {
    return `${label}: ${json.error ?? "내보내기 실패"}`;
  }
  const files = json.files && json.files.length > 0
    ? json.files
    : (json.excelBase64 && json.filename
      ? [{ excelBase64: json.excelBase64, filename: json.filename, rowCount: json.rowCount ?? 0 }]
      : []);
  if (files.length === 0) {
    return `${label}: ${json.error ?? "생성된 행이 없습니다 (양식 임포트 필요)"}`;
  }
  for (let i = 0; i < files.length; i++) {
    downloadExcelFromBase64(files[i].excelBase64, files[i].filename);
    onFile?.(files[i].filename, files[i].excelBase64, files[i].rowCount);
    // 브라우저가 연속 다운로드를 차단하지 않도록 약간의 지연
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 250));
  }
  const skipped = json.skippedProductIds?.length ?? 0;
  const fileCountMsg = files.length > 1 ? ` (${files.length}개 파일로 분할 — 양식 한 개당 500행 제한)` : "";
  if (skipped > 0) {
    return `${label}: 총 ${json.rowCount}행 생성${fileCountMsg}, ${skipped}개 상품은 ${rowLabel}이 없어 제외됐습니다. ${label}을 다시 임포트하세요.`;
  }
  if (files.length > 1) {
    return `${label}: 총 ${json.rowCount}행${fileCountMsg}`;
  }
  return null;
}

// 쿠팡·옥션/지마켓·스마트스토어 한 번에 다운로드. 한 플랫폼이 실패해도 나머지는 진행. 안내 메시지 목록 반환
export async function exportPriceV2All(ids: string[], accessToken: string, onFile?: PriceV2FileHandler): Promise<string[]> {
  const platforms: PriceV2Platform[] = ["coupang", "esm", "smartstore"];
  const msgs: string[] = [];
  for (const platform of platforms) {
    try {
      const msg = await exportPriceV2Platform(platform, ids, accessToken, onFile);
      if (msg) msgs.push(msg);
    } catch (e) {
      msgs.push(`${PRICE_V2_LABELS[platform].label}: ${e instanceof Error ? e.message : "오류"}`);
    }
    // 플랫폼 간 연속 다운로드 충돌 방지
    await new Promise(r => setTimeout(r, 400));
  }
  return msgs;
}
