const KOREA_TIME_ZONE = "Asia/Seoul";

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();
  if (!raw) return null;

  // DB 값은 보통 timezone이 붙어 오지만, 사용자가 직접 입력한 ISO 형태에는 timezone이 없을 수 있다.
  // timezone이 없으면 한국시간으로 해석해야 엑셀의 결제시간과 화면 표시가 일치한다.
  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)
    ? `${raw.replace(" ", "T")}+09:00`
    : raw;

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatKoreanDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "";

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).slice(0, 16);
}

export function getKoreanDateKey(value: string | Date | null | undefined): string | null {
  const formatted = formatKoreanDateTime(value);
  return formatted ? formatted.slice(0, 10) : null;
}

export function getKoreanMonthKey(value: string | Date | null | undefined): string | null {
  const dateKey = getKoreanDateKey(value);
  return dateKey ? dateKey.slice(0, 7) : null;
}

/**
 * KST 달력 날짜 YYYY-MM-DD — 마켓 API 날짜 파라미터·파일명용.
 * UTC 로 자르면(toISOString().slice(0,10)) KST 00~09시에 당일이 어제로 계산돼
 * 새벽 주문이 조회에서 빠지고 새벽 생성 파일이 어제 날짜로 간다.
 */
export function toKstDateKey(value: Date | number = Date.now()): string {
  return getKoreanDateKey(value instanceof Date ? value : new Date(value)) ?? "";
}
