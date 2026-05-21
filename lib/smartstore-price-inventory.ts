// 스마트스토어 가격수정 v2 — 상수 + 유틸
//
// 스마트스토어 일괄수정 양식은 다운로드 파일 자체가 업로드 양식이다.
// 사용자가 받은 엑셀의 F열(판매가)만 수정해서 그대로 재업로드한다.
//
// 시트행 1: 그룹헤더 (병합 셀)
// 시트행 2: 컬럼명 (94개)
// 시트행 3~5: 작성가이드 — 양식 안내문에 따르면 업로드 전 삭제
// 시트행 6부터: 실제 데이터

// 핵심 컬럼만 인덱스 상수로 관리. 나머지(6~93)는 raw_row JSONB에서 그대로 복원.
export const COL = {
  smartstore_product_id: 0,  // A: 수정불가 — 스마트스토어 상품번호 (식별 키)
  seller_product_code:   1,  // B: 판매자 상품코드
  category_code:         2,  // C: 카테고리코드
  product_name:          3,  // D: 상품명 (← products.product_name 매칭 키)
  product_status:        4,  // E: 상품상태
  sale_price:            5,  // F: 판매가 (← 교체 대상)
  option_type:          13,  // N: 옵션형태 ("단독형" | "조합형" | "설정안함")
} as const;

export const TOTAL_COLS = 94; // A~CP

export const HEADER_GROUP_ROW_INDEX = 0; // 시트행 1
export const HEADER_COL_ROW_INDEX   = 1; // 시트행 2
// 시트행 3~5(0-based 2~4) = 가이드. 출력 시 제거.
export const DATA_START_ROW_INDEX   = 5; // 시트행 6 — 임포트 시 데이터 시작

// 양식 안내문: "파일업로드 시 3~5행의 작성가이드는 삭제하시기 바랍니다."
// → 출력 시 시트행 1~2만 유지하고 시트행 3부터 데이터를 채운다.
export const OUTPUT_DATA_START_ROW_INDEX = 2; // 시트행 3 (0-based)

export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).trim().normalize("NFC");
}

export function cellString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

export function cellInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v);
  const cleaned = String(v).replace(/[,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}
