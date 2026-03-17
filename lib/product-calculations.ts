import type { CommissionRate, CommissionPlatform } from "@/types/database";

/** 정산가 = 최저가 / (1 - 순마진율/100) */
export function calcSettlementPrice(lowestPrice: number, marginRate: number): number {
  if (marginRate <= 0 || marginRate >= 100) return lowestPrice;
  return Math.round(lowestPrice / (1 - marginRate / 100));
}

/** 순마진 = 정산가 - 최저가 */
export function calcNetMargin(lowestPrice: number, marginRate: number): number {
  return calcSettlementPrice(lowestPrice, marginRate) - lowestPrice;
}

/** 플랫폼 판매가 = 정산가 / (1 - 총수수료/100), 100원 단위 올림 */
export function calcPlatformPrice(settlementPrice: number, totalRate: number): number {
  if (totalRate <= 0 || totalRate >= 100) return settlementPrice;
  return Math.ceil(settlementPrice / (1 - totalRate / 100) / 100) * 100;
}

/** 수수료 데이터에서 카테고리+플랫폼별 총수수료 맵 생성 */
export function buildRateMap(
  rates: CommissionRate[]
): Record<string, Record<CommissionPlatform, number>> {
  const map: Record<string, Record<string, number>> = {};
  for (const r of rates) {
    if (!map[r.category]) map[r.category] = {};
    map[r.category][r.platform] = r.total_rate;
  }
  return map as Record<string, Record<CommissionPlatform, number>>;
}

/** 상품의 모든 계산 필드를 한번에 계산 */
export function calcProductFields(
  lowestPrice: number,
  marginRate: number,
  productName: string,
  category: string,
  rateMap: Record<string, Record<CommissionPlatform, number>>
) {
  const nameLength = productName.length;
  const settlementPrice = calcSettlementPrice(lowestPrice, marginRate);
  const netMargin = settlementPrice - lowestPrice;

  const categoryRates = rateMap[category] || {};
  const priceSmartstore = categoryRates.smartstore
    ? calcPlatformPrice(settlementPrice, categoryRates.smartstore)
    : 0;
  const priceEsm = categoryRates.esm
    ? calcPlatformPrice(settlementPrice, categoryRates.esm)
    : 0;
  const priceCoupang = categoryRates.coupang
    ? calcPlatformPrice(settlementPrice, categoryRates.coupang)
    : 0;
  const priceMyeolchi = categoryRates.myeolchi
    ? calcPlatformPrice(settlementPrice, categoryRates.myeolchi)
    : 0;

  return { nameLength, settlementPrice, netMargin, priceSmartstore, priceEsm, priceCoupang, priceMyeolchi };
}
