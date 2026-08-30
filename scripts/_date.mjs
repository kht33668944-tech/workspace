// KST 날짜 공용 (의존성 0) — .mjs 스크립트는 lib/*.ts 를 import 못 해 별도로 둔다.
// UTC 로 자르면(toISOString) KST 00~09시에 당일이 어제로 계산돼 새벽 실행분이 어제 날짜로 간다.

/** KST 달력 날짜 YYYY-MM-DD */
export const kstYmd = (t = Date.now()) => new Date(t + 9 * 3600000).toISOString().slice(0, 10);

/** 쿠팡윙 조회 기간: 오늘 기준 최근 N일 (31일 이상은 쿠팡윙이 빈 결과를 준다) */
export function wingDateRange(days = 30) {
  const now = Date.now();
  return { from: kstYmd(now - days * 86400000), to: kstYmd(now) };
}
