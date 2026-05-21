// 옥션·지마켓(ESM) 가격수정 v2 — 상수 + 유틸
//
// 두 종류의 엑셀이 있다:
// 1. "옥션지마켓 데이터.xlsx" — ESM Plus에서 다운로드받은 상품목록 (42컬럼, 1행 헤더, 2행부터 데이터)
//    임포트 시 이 파일을 업로드한다.
// 2. "가격대량수정양식.xlsx" — 실제 ESM Plus에 업로드하는 양식 (3컬럼, 6행부터 데이터)
//    내보내기 시 이 파일을 채워서 다운로드한다.

// ── 데이터 파일 (다운로드받은 상품목록) ──
// 0-based 컬럼 인덱스. 헤더 행은 0, 데이터는 1행부터.
export const DATA_COL = {
  master_product_id: 0, // A: 마스터상품번호
  site_product_id: 1,   // B: 상품번호 (양식의 "사이트 상품번호" 값)
  product_name: 2,      // C: 상품명 (← products.product_name 매칭)
  promo_text: 3,        // D: 프로모션 문구
  seller_code: 4,       // E: 판매자관리코드
  site: 5,              // F: 사이트 (옥션 | 지마켓)
  seller_id: 6,         // G: ID
  sale_status: 7,       // H: 판매상태
  sale_price: 8,        // I: 판매가 (콤마 포함 문자열)
  sale_end: 9,          // J: 판매종료일
  group_setting: 10,    // K: 그룹설정
  discount: 11,         // L: 할인
  stock: 12,            // M: 재고수량
  site_category: 13,    // N: 사이트카테고리
  fee_rate: 14,         // O: 판매이용료
  category: 15,         // P: 카테고리
} as const;

export const DATA_HEADER_ROW_INDEX = 0;
export const DATA_START_ROW_INDEX = 1;

// ── 양식 파일 (업로드용) ──
// 양식 구조: A=빈칸/행번호, B=사이트 상품번호, C=판매가
// 1행=안내, 2행=헤더, 3행=필수, 4행=설명, 5행=예시, 6행부터 데이터
export const TEMPLATE_COL = {
  row_number: 0,        // A
  site_product_id: 1,   // B
  sale_price: 2,        // C
} as const;

export const TEMPLATE_DATA_START_ROW_INDEX = 5; // 0-based, 6행

// ── 유틸 ──
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
  // "22,500" 같은 콤마 포함 문자열도 처리
  const cleaned = String(v).replace(/[,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}
