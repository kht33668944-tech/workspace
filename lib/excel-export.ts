// XLSX를 lazy load하여 클라이언트 번들에서 제외 (~1MB 절감)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let XLSX: any = null;
let _xlsxPromise: Promise<void> | null = null;
async function loadXLSX() {
  if (!_xlsxPromise) _xlsxPromise = import("xlsx-js-style").then(m => { XLSX = m.default; });
  await _xlsxPromise;
}
import type { Order, Product, CommissionRate } from "@/types/database";
import { DEFAULT_COURIER_CODES } from "@/lib/courier-codes";
import { calcPlatformPrice, calcSettlementPrice, buildRateMap } from "@/lib/product-calculations";
import { getSchemaByCode, DEFAULT_SCHEMA } from "@/lib/playauto-schema";
import { formatPurchaseOrders, parsePurchaseOrders } from "@/lib/purchase-orders";
import { formatKoreanDateTime, toKstDateKey } from "@/lib/date-utils";

/** 발주서 양식 엑셀 생성 (현재 발주서 테이블과 동일한 양식) */
export async function generateOrderExcel(orders: Order[]): Promise<{ buffer: ArrayBuffer; filename: string }> {
  await loadXLSX();
  const today = toKstDateKey();
  const data = orders.map((o) => ({
    묶음번호: o.bundle_no,
    주문일시: o.order_date ? formatKoreanDateTime(o.order_date) : null,
    판매처: o.marketplace,
    주문자명: o.marketplace_orderer_name,
    수취인명: o.recipient_name,
    상품명: o.product_name,
    수량: o.quantity,
    수령자번호: o.recipient_phone,
    주문자번호: o.orderer_phone,
    우편번호: o.postal_code,
    기본주소: o.address,
    상세주소: o.address_detail,
    배송메모: o.delivery_memo,
    매출: o.revenue,
    정산예정: o.settlement,
    원가: o.cost,
    마진: o.margin,
    결제방식: o.payment_method,
    구매처: o.purchase_source,
    구매아이디: o.purchase_id,
    주문번호: o.purchase_order_no,
    택배사: o.courier,
    운송장: o.tracking_no,
    배송상태: o.delivery_status,
    최저가링크: o.purchase_url,
    주문상세링크: o.purchase_detail_url,
    // 수량 N개 자동구매의 주문 N건 전체 (참고용 — 가져오기에서는 읽지 않는다)
    구매주문목록: formatPurchaseOrders(parsePurchaseOrders(o.purchase_orders)) || null,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "배송조회수집");
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const filename = `배송조회수집_${today}.xlsx`;

  return { buffer, filename };
}

/**
 * 플레이오토 대량 운송장 전송 양식 엑셀 생성
 * 양식: 묶음번호 | 택배사(코드숫자) | 운송장번호
 * @param courierCodeMap 택배사명 → 코드 매핑 (사용자 설정 or 기본값)
 */
export async function generatePlayAutoTrackingExcel(
  orders: Order[],
  courierCodeMap: Record<string, number> = {}
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  await loadXLSX();
  const today = toKstDateKey();

  // 운송장이 있는 주문만 필터링
  const trackingOrders = orders.filter((o) => o.tracking_no && o.tracking_no.trim() !== "");

  // courierCodeMap → DEFAULT_COURIER_CODES 순으로 조회하여 반드시 코드 숫자로 변환
  const data = trackingOrders.map((o) => {
    const courierName = o.courier || "";
    const code = courierCodeMap[courierName] ?? DEFAULT_COURIER_CODES[courierName] ?? courierName;
    return {
      묶음번호: o.bundle_no || "",
      택배사: code,
      운송장번호: o.tracking_no || "",
    };
  });

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "운송장전송");
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const filename = `플레이오토_운송장_${today}.xlsx`;

  return { buffer, filename };
}

/** 플레이오토 내보내기 지원 플랫폼 */
export type PlayAutoExportPlatform = "smartstore" | "gmarket_auction" | "coupang" | "auction" | "gmarket" | "11st";

/** 플랫폼별 고정값 설정 */
export const PLATFORM_CONFIGS: Record<PlayAutoExportPlatform, {
  shopAccount: string;
  templateCode: string;
  headerFooterTemplateCode: string;
  rateKey: string;   // commissionRates에서 사용할 키
  filenameLabel: string;
}> = {
  smartstore: {
    shopAccount: "스마트스토어=계정명",
    templateCode: "2200901",
    headerFooterTemplateCode: "14672",
    rateKey: "smartstore",
    filenameLabel: "스마트스토어",
  },
  gmarket_auction: {
    shopAccount: "옥션=계정명\n지마켓=계정명",
    templateCode: "2201548\n2201554",
    headerFooterTemplateCode: "14672\n14672",
    rateKey: "esm",
    filenameLabel: "지마켓옥션",
  },
  auction: {
    shopAccount: "옥션=계정명",
    templateCode: "2201548",
    headerFooterTemplateCode: "14672",
    rateKey: "esm",
    filenameLabel: "옥션",
  },
  gmarket: {
    shopAccount: "지마켓=계정명",
    templateCode: "2201554",
    headerFooterTemplateCode: "14672",
    rateKey: "esm",
    filenameLabel: "지마켓",
  },
  "11st": {
    shopAccount: "11번가=계정명",
    templateCode: "2208486",
    headerFooterTemplateCode: "14672",
    rateKey: "esm",
    filenameLabel: "11번가",
  },
  coupang: {
    shopAccount: "쿠팡=계정명",
    templateCode: "2201570",
    headerFooterTemplateCode: "14672",
    rateKey: "coupang",
    filenameLabel: "쿠팡",
  },
};

/** 플랫폼을 seller_code 그룹으로 매핑 */
export function platformToSellerGroup(platform: PlayAutoExportPlatform): string {
  if (platform === "smartstore") return "smartstore";
  if (platform === "coupang") return "coupang";
  return "esm"; // gmarket_auction, auction, gmarket
}

/**
 * 플레이오토 상품 대량등록 엑셀 생성
 * categoryMappings: 내 카테고리 → 플레이오토 코드 매핑 (없으면 기타재화 35)
 */
/** 사용자 커스텀 내보내기 설정 (DB 저장값) */
export interface ExportConfigOverride {
  shopAccount: string;
  templateCode: string;
  headerFooterTemplateCode: string;
  saleQuantity: number;
  productInfoNotice: string;
}

export async function generatePlayAutoProductExcel(
  products: Product[],
  metadataList: Array<{ model: string; brand: string; manufacturer: string }>,
  commissionRates: CommissionRate[],
  categoryMappings: Record<string, string> = {},
  smartstoreCategoryCodes: string[] = [],
  platform: PlayAutoExportPlatform = "smartstore",
  userConfig?: ExportConfigOverride,
  noticeMap?: Record<string, string[]>,
  options?: { useSavedSellerCodes?: boolean; startIndex?: number; sellerCodes?: string[] },
  unitPriceInfoList?: Array<{ display: string; displayAmount: number; displayUnit: string | number; totalAmount: number }>,
  coupangPurchaseOptions?: Array<{ hasOption: boolean; optionName: string; optionValue: string; missingRequired?: string[] }>
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  await loadXLSX();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dateStr = `${yy}${mm}${dd}`;

  const defaults = PLATFORM_CONFIGS[platform];
  const config = {
    ...defaults,
    shopAccount: userConfig?.shopAccount || defaults.shopAccount,
    templateCode: userConfig?.templateCode || defaults.templateCode,
    headerFooterTemplateCode: userConfig?.headerFooterTemplateCode || defaults.headerFooterTemplateCode,
  };
  const saleQuantity = userConfig?.saleQuantity ?? 2000;
  const productInfoNotice = userConfig?.productInfoNotice || "상세페이지 참조";
  const rateMap = buildRateMap(commissionRates);

  // item_info(식약처 조사값)를 가공식품(21) 고시 항목 순서로 변환. 대상 아니면 null → 기존 방식 사용
  const buildItemInfoNotice = (p: Product, playautoCode: string): string[] | null => {
    const info = p.item_info;
    if (!info || playautoCode !== "21") return null;
    // 내부 관리용 [검수필요...] 태그는 마켓에 노출하지 않는다
    const strip = (v?: string | null) =>
      (v ?? "").replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\(\s*\)/g, "").replace(/\s+\)/g, ")").trim();
    // 플레이오토 규격: 수입신고를 필함의 문구는 Y/N만 허용 (국내산 → N)
    const 수입문구 = strip(info.수입여부).startsWith("국내산") || !strip(info.수입여부) ? "N" : "Y";
    return [
      strip(info.제품명) || p.product_name,
      strip(info.식품유형) || "상세페이지 참조",
      strip(info.제조원) || "상세페이지 참조",
      strip(info.소비기한) || "제품 별도 표시일까지",
      strip(info.포장단위별용량) || "상세페이지 참조",
      strip(info.원재료명) || "상세페이지 참조",
      strip(info.영양성분) || "제품 라벨 표기 참조",
      // 플레이오토 규격: 유전자변형식품 표시는 Y/N만 허용
      /^(Y|해당)/.test(strip(info.유전자변형식품)) && !strip(info.유전자변형식품).startsWith("해당없음") ? "Y" : "N",
      strip(info.소비자안전주의사항) || "상세페이지 참조",
      수입문구,
      strip(info.소비자상담번호) || "상세페이지 참조",
    ];
  };

  // 이 배치에서 사용되는 최대 고시 개수를 계산 (컬럼 수 통일)
  const maxFields = products.reduce((max, p) => {
    const code = categoryMappings[p.category] ?? DEFAULT_SCHEMA.code;
    const schema = getSchemaByCode(code);
    return Math.max(max, schema.fields.length);
  }, DEFAULT_SCHEMA.fields.length);

  let newCodeCounter = 1;
  const sellerGroup = platformToSellerGroup(platform);
  const data = products.flatMap((p, i) => {
    const settlementPrice = calcSettlementPrice(p.lowest_price, p.margin_rate);
    const categoryRates = rateMap[p.category] ?? {};
    const platformRate = (categoryRates as Record<string, number>)[config.rateKey] ?? 0;
    const fixedKey = `fixed_price_${config.rateKey}` as keyof Product;
    const fixedPrice = (p as Product)[fixedKey] as number | null | undefined;
    const salePrice = fixedPrice != null
      ? fixedPrice
      : (platformRate > 0 ? calcPlatformPrice(settlementPrice, platformRate) : p.lowest_price);

    const meta = metadataList[i] ?? { model: "", brand: "", manufacturer: "" };
    const savedCode = options?.useSavedSellerCodes
      ? (p.seller_code as Record<string, string> | null)?.[sellerGroup]
      : undefined;
    const sellerCode = options?.sellerCodes?.[i]
      ?? savedCode
      ?? `${dateStr}${String((options?.startIndex ?? 0) + newCodeCounter++).padStart(3, "0")}`;

    const playautoCode = categoryMappings[p.category] ?? DEFAULT_SCHEMA.code;
    const schema = getSchemaByCode(playautoCode);

    const buildRow = (
      shopAccount: string,
      templateCode: string,
      headerFooterTemplateCode: string
    ): Record<string, string | number> => ({
      판매자관리코드: sellerCode,
      카테고리코드: smartstoreCategoryCodes[i] ?? "",
      "쇼핑몰(계정)": shopAccount,
      템플릿코드: templateCode,
      "온라인 상품명": p.product_name,
      판매수량: saleQuantity,
      판매가: salePrice,
      공급가: 0,
      원가: 0,
      시중가: 0,
      옵션조합: (platform === "coupang" && coupangPurchaseOptions?.[i]?.hasOption) ? "조합형" : "옵션없음",
      옵션: (platform === "coupang" && coupangPurchaseOptions?.[i]?.hasOption)
        ? `${coupangPurchaseOptions[i].optionName}\n${coupangPurchaseOptions[i].optionValue}`
        : "",
      원산지: "기타=상세페이지참조",
      복수원산지여부: "N",
      과세여부: "과세",
      배송방법: "무료",
      배송비: 0,
      기본이미지: p.thumbnail_url ?? "",
      상세설명: p.detail_html ?? "",
      "머리말/꼬리말 템플릿코드": headerFooterTemplateCode,
      모델명: meta.model,
      브랜드: meta.brand,
      제조사: meta.manufacturer,
      // 쿠팡 GTIN 의무화(2026-06) 대응: 식약처 조사로 확보한 바코드
      // 쿠팡은 옵션 단위(UID)로 검증하므로 옵션바코드에도 함께 기입
      바코드: p.item_info?.바코드 ?? "",
      옵션바코드: p.item_info?.바코드 ?? "",
      표준상품코드: p.item_info?.바코드 ? `KAN=${p.item_info.바코드}` : "",
      상품분류코드: playautoCode,
    });

    const accountLines = config.shopAccount.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const templateLines = config.templateCode.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const headerFooterLines = config.headerFooterTemplateCode.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    const rows: Array<Record<string, string | number>> = platform === "gmarket_auction"
      ? [
          buildRow(
            accountLines.find((line) => line.startsWith("옥션=")) ?? "옥션=계정명",
            templateLines[0] ?? PLATFORM_CONFIGS.auction.templateCode,
            headerFooterLines[0] ?? PLATFORM_CONFIGS.auction.headerFooterTemplateCode
          ),
          buildRow(
            accountLines.find((line) => line.startsWith("지마켓=")) ?? "지마켓=계정명",
            templateLines[1] ?? PLATFORM_CONFIGS.gmarket.templateCode,
            headerFooterLines[1] ?? PLATFORM_CONFIGS.gmarket.headerFooterTemplateCode
          ),
        ]
      : [buildRow(config.shopAccount, config.templateCode, config.headerFooterTemplateCode)];

    // 스마트스토어: 단위가격 표시 컬럼 추가 (v20 양식 — 2026-04 가격표시제)
    // 표시 여부 Y이면 구성 방식(팩/낱개)·팩 수량·팩당 수량·개당 용량이 필수
    if (platform === "smartstore") {
      const upi = unitPriceInfoList?.[i] ?? { display: "N", displayAmount: 0, displayUnit: 0, totalAmount: 0 };
      const volMatch = p.product_name.match(/(\d+(?:\.\d+)?)\s*(ml|mL|ML|l|L)(?=\s|$|\d)/);
      const volMl = volMatch
        ? parseFloat(volMatch[1]) * (volMatch[2].toLowerCase() === "l" ? 1000 : 1)
        : 0;
      const cntMatch = p.product_name.match(/(\d+)\s*(개|팩|캔|병|입)(?=\s|$)/);
      const cnt = cntMatch ? parseInt(cntMatch[1], 10) : 1;
      rows.forEach((row) => {
        row["단위 가격 표시 여부"] = upi.display;
        row["표시 용량"] = upi.displayAmount;
        row["표시 단위"] = upi.displayUnit;
        if (upi.display === "Y") {
          row["구성 방식"] = cnt > 1 ? "팩" : "낱개";
          row["팩 수량"] = 1;
          row["팩당 수량"] = cnt;
          row["팩당 수량 단위"] = "개";
          row["개당 용량"] = volMl > 0 ? volMl : (upi.totalAmount || 1);
        } else {
          row["구성 방식"] = "낱개";
          row["팩 수량"] = 1;
          row["팩당 수량"] = 1;
          row["팩당 수량 단위"] = "개";
          row["개당 용량"] = volMl > 0 ? volMl : 1;
        }
      });
    }

    // 이 상품의 고시 항목 채우기
    // 우선순위: item_info(식약처 조사 실값) > 사용자 커스텀(noticeMap) > 기본값("상세페이지 참조")
    const itemInfoValues = buildItemInfoNotice(p, playautoCode);
    rows.forEach((row) => {
      for (let n = 1; n <= maxFields; n++) {
        const customValues = noticeMap?.[playautoCode];
        row[`상품정보제공고시${n}`] = n <= schema.fields.length
          ? (itemInfoValues?.[n - 1] || customValues?.[n - 1] || productInfoNotice)
          : "";
      }
    });

    return rows;
  });

  const ws = XLSX.utils.json_to_sheet(data);

  // 멀티라인 필요 컬럼만 wrapText 적용 (상세설명 등 긴 텍스트 컬럼은 제외하여 행 높이 축소)
  const WRAP_HEADERS = new Set(["쇼핑몰(계정)", "템플릿코드", "머리말/꼬리말 템플릿코드", "옵션"]);
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  const wrapCols = new Set<number>();
  for (let C = range.s.c; C <= range.e.c; C++) {
    const hdr = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
    if (hdr && WRAP_HEADERS.has(String(hdr.v))) wrapCols.add(C);
  }
  for (let R = range.s.r + 1; R <= range.e.r; R++) {
    for (const C of wrapCols) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      if (cell && typeof cell.v === "string" && cell.v.includes("\n")) {
        cell.s = { alignment: { wrapText: true, vertical: "top" } };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "대량등록");
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const filename = `플레이오토_${config.filenameLabel}_${dateStr}.xlsx`;

  return { buffer, filename };
}

/** ArrayBuffer를 base64 문자열로 변환 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 문자열을 ArrayBuffer로 변환 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** 엑셀 다운로드 트리거 */
export function downloadExcel(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();

  // Chrome can still be reading the blob URL after click().
  // Revoking/removing it immediately intermittently makes the download fail
  // with "문제가 발생했습니다" in the downloads bubble, especially in
  // automated/remote-debugging Chrome profiles.
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** base64 데이터로부터 엑셀 다운로드 */
export function downloadExcelFromBase64(base64: string, filename: string) {
  const buffer = base64ToArrayBuffer(base64);
  downloadExcel(buffer, filename);
}

/**
 * 가격수정용 엑셀 2종 생성 (일반상품 + 단일상품)
 * 일반상품: 스마트스토어, 쿠팡
 * 단일상품: 지마켓, 옥션
 */
export async function generatePriceUpdateExcel(
  products: Product[],
  commissionRates: CommissionRate[],
  exportConfigs?: Record<string, { shopAccount: string }>
): Promise<{ normal: { buffer: ArrayBuffer; filename: string } | null; single: { buffer: ArrayBuffer; filename: string } | null }> {
  await loadXLSX();
  const today = toKstDateKey().replace(/-/g, "");
  const rateMap = buildRateMap(commissionRates);

  // 플랫폼별 계정 키 목록 (exportConfigs 우선, 없으면 PLATFORM_CONFIGS 기본값)
  const normalAccounts: string[] = []; // 스마트스토어, 쿠팡
  const singleAccounts: string[] = []; // 옥션, 지마켓

  const smartstoreAccount = exportConfigs?.smartstore?.shopAccount || PLATFORM_CONFIGS.smartstore.shopAccount;
  const coupangAccount = exportConfigs?.coupang?.shopAccount || PLATFORM_CONFIGS.coupang.shopAccount;
  const esmAccount = exportConfigs?.gmarket_auction?.shopAccount || PLATFORM_CONFIGS.gmarket_auction.shopAccount;

  normalAccounts.push(...smartstoreAccount.split("\n").map(s => s.trim()).filter(Boolean));
  normalAccounts.push(...coupangAccount.split("\n").map(s => s.trim()).filter(Boolean));
  singleAccounts.push(...esmAccount.split("\n").map(s => s.trim()).filter(Boolean));

  // 플랫폼 계정 → rateKey 매핑
  const accountRateKey = (account: string): string => {
    const lower = account.toLowerCase();
    if (lower.startsWith("스마트스토어")) return "smartstore";
    if (lower.startsWith("쿠팡")) return "coupang";
    if (lower.startsWith("옥션") || lower.startsWith("지마켓")) return "esm";
    return "esm";
  };

  const buildRows = (accounts: string[]) => {
    const rows: Array<{ "쇼핑몰(계정)": string; "쇼핑몰 상품번호": string; 판매가: number }> = [];
    for (const p of products) {
      if (!p.platform_codes) continue;
      const settlementPrice = calcSettlementPrice(p.lowest_price, p.margin_rate);
      const categoryRates = rateMap[p.category] ?? {};

      for (const account of accounts) {
        const code = (p.platform_codes as Record<string, string>)[account];
        if (!code) continue;

        const rateKey = accountRateKey(account);
        const rate = (categoryRates as Record<string, number>)[rateKey] ?? 0;
        const fixedKey = `fixed_price_${rateKey}` as keyof Product;
        const fixedPrice = (p as Product)[fixedKey] as number | null | undefined;
        const salePrice = fixedPrice != null
          ? fixedPrice
          : (rate > 0 ? calcPlatformPrice(settlementPrice, rate) : p.lowest_price);

        rows.push({ "쇼핑몰(계정)": account, "쇼핑몰 상품번호": code, 판매가: salePrice });
      }
    }
    return rows;
  };

  const toExcel = (rows: Array<Record<string, string | number>>, label: string) => {
    if (rows.length === 0) return null;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "쇼핑몰상품");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    return { buffer: buf as ArrayBuffer, filename: `가격수정_${label}_${today}.xlsx` };
  };

  const normalRows = buildRows(normalAccounts);
  const singleRows = buildRows(singleAccounts);

  return {
    normal: toExcel(normalRows, "일반상품"),
    single: toExcel(singleRows, "단일상품"),
  };
}
