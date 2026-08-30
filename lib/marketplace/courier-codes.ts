// 택배사명(DB 표준명, lib/scrapers/constants.ts COURIER_MAP 결과) → 마켓 API 택배사 코드
//  쿠팡: developers.coupang.com 택배사 코드 표 / 네이버: 커머스API 택배사 코드 (롯데=HYUNDAI)

export interface MarketplaceCourierCode {
  coupang: string;
  naver: string;
}

export const MARKETPLACE_COURIER_CODES: Record<string, MarketplaceCourierCode> = {
  "CJ대한통운": { coupang: "CJGLS", naver: "CJGLS" },
  "한진택배": { coupang: "HANJIN", naver: "HANJIN" },
  "롯데택배": { coupang: "HYUNDAI", naver: "HYUNDAI" },
  "우체국택배": { coupang: "EPOST", naver: "EPOST" },
  "로젠택배": { coupang: "KGB", naver: "KGB" },
  "경동택배": { coupang: "KDEXP", naver: "KDEXP" },
  "대신택배": { coupang: "DAESIN", naver: "DAESIN" },
  "일양로지스": { coupang: "ILYANG", naver: "ILYANG" },
  "합동택배": { coupang: "HDEXP", naver: "HDEXP" },
  "천일택배": { coupang: "CHUNIL", naver: "CHUNIL" },
  "건영택배": { coupang: "KUNYOUNG", naver: "KUNYOUNG" },
  "SLX": { coupang: "SLX", naver: "SLX" },
};

/** 마켓별 택배사 코드. 없으면 null (전송 제외 + "택배사 코드 없음" 사유) */
export function getMarketplaceCourierCode(courier: string | null | undefined, platform: "coupang" | "smartstore"): string | null {
  if (!courier) return null;
  const entry = MARKETPLACE_COURIER_CODES[courier.trim()];
  if (!entry) return null;
  return platform === "coupang" ? entry.coupang : entry.naver;
}
