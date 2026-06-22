/**
 * 쿠팡 필수 구매옵션 "값 채우기" 규칙 분류
 *
 * `coupang-category-options.ts`(자동 생성 데이터)와 분리된 수기 관리 파일.
 * 전체 카테고리에 쓰이는 옵션은 30종뿐이며, 모두 아래 3그룹 중 하나로 분류한다.
 * 새 카테고리가 추가돼도 이 30종 조합이면 자동 대응된다.
 *
 * - QTY: 수량 계열 → 파싱된 수량으로 채움
 * - MEASURE: 단위측정 계열 → 파싱된 unitVal+unitType로 채움 (ID별 허용 unitType 정의)
 * - DESCRIPTIVE: 서술형(사이즈/맛/색상 등) → 상품명에서 텍스트 추출(Gemini)
 */
import { COUPANG_OPTION_IDS } from "./coupang-category-options";

/** 수량 계열 옵션 ID */
export const QTY_OPTION_IDS = new Set<number>([
  COUPANG_OPTION_IDS.QUANTITY,        // 7652 수량
  COUPANG_OPTION_IDS.TOTAL_QUANTITY,  // 7663 총 수량
]);

/** 단위측정 옵션 ID → 허용 unitType 집합. unitType이 매칭되면 `${unitVal}${unitType}`로 채움 */
export const MEASURE_OPTION_UNIT_TYPES: Record<number, Set<string>> = {
  [COUPANG_OPTION_IDS.PER_UNIT_WEIGHT]: new Set(["g", "kg"]),                         // 7637 개당 중량
  [COUPANG_OPTION_IDS.MIN_WEIGHT]: new Set(["g", "kg"]),                              // 939 최소 중량
  [COUPANG_OPTION_IDS.PER_UNIT_CAPACITY]: new Set(["ml", "L"]),                       // 7823 개당 용량
  [COUPANG_OPTION_IDS.MIN_CAPACITY]: new Set(["ml", "L"]),                            // 14326 최소 용량
  [COUPANG_OPTION_IDS.CAPACITY]: new Set(["ml", "L"]),                                // 11147 용량
  [COUPANG_OPTION_IDS.PER_UNIT_COUNT]: new Set(["매", "장", "시트", "롤", "입", "개"]), // 7935 개당 수량
  [COUPANG_OPTION_IDS.PER_UNIT_CAPSULE]: new Set(["정", "캡슐", "포", "알"]),          // 14264 개당 캡슐/정
  [COUPANG_OPTION_IDS.GRAMMAGE]: new Set(["매", "g", "gsm"]),                         // 10921 평량
  11157: new Set(["m", "cm"]),                                                       // 11157 길이
};

/** 서술형 옵션 ID (상품명에서 값 추출 대상) */
export const DESCRIPTIVE_OPTION_IDS = new Set<number>([
  7783, 10554, 2643, 10340, 11034, 14267, // 사이즈 계열
  11880,                                   // 기저귀 단계
  7655, 10475,                             // 맛(가공식품맛/간식 맛)
  10474,                                   // 사료/간식 주원료
  2439, 11771,                             // 색상/색상·향
  10495, 7650,                             // 향(반려용품/생활용품)
  7923,                                    // 구성품
  11068,                                   // 원두 분쇄타입
  11747,                                   // 두께
  12420,                                   // 쌀 등급
  12758,                                   // 급여포인트
]);
