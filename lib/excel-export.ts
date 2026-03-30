import XLSX from "xlsx-js-style";
import type { Order, Product, CommissionRate } from "@/types/database";
import { DEFAULT_COURIER_CODES } from "@/lib/courier-codes";
import { calcPlatformPrice, calcSettlementPrice, buildRateMap } from "@/lib/product-calculations";
import { getSchemaByCode, DEFAULT_SCHEMA } from "@/lib/playauto-schema";

/** 발주서 양식 엑셀 생성 (현재 발주서 테이블과 동일한 양식) */
export function generateOrderExcel(orders: Order[]): { buffer: ArrayBuffer; filename: string } {
  const today = new Date().toISOString().slice(0, 10);
  const data = orders.map((o) => ({
    묶음번호: o.bundle_no,
    주문일시: o.order_date ? o.order_date.slice(0, 16).replace("T", " ") : null,
    판매처: o.marketplace,
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
export function generatePlayAutoTrackingExcel(
  orders: Order[],
  courierCodeMap: Record<string, number> = {}
): { buffer: ArrayBuffer; filename: string } {
  const today = new Date().toISOString().slice(0, 10);

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
export type PlayAutoExportPlatform = "smartstore" | "gmarket_auction" | "coupang" | "myeolchi";

/** 플랫폼별 고정값 설정 */
export const PLATFORM_CONFIGS: Record<PlayAutoExportPlatform, {
  shopAccount: string;
  templateCode: string;
  headerFooterTemplateCode: string;
  rateKey: string;   // commissionRates에서 사용할 키
  filenameLabel: string;
}> = {
  smartstore: {
    shopAccount: "스마트스토어=redgoom",
    templateCode: "2200901",
    headerFooterTemplateCode: "14672",
    rateKey: "smartstore",
    filenameLabel: "스마트스토어",
  },
  gmarket_auction: {
    shopAccount: "옥션=redgoom00\n지마켓=redgoom00",
    templateCode: "2201548\n2201554",
    headerFooterTemplateCode: "14672\n14672",
    rateKey: "esm",
    filenameLabel: "지마켓옥션",
  },
  coupang: {
    shopAccount: "쿠팡=redgoom",
    templateCode: "2201570",
    headerFooterTemplateCode: "14672",
    rateKey: "coupang",
    filenameLabel: "쿠팡",
  },
  myeolchi: {
    shopAccount: "",
    templateCode: "",
    headerFooterTemplateCode: "",
    rateKey: "myeolchi",
    filenameLabel: "멸치쇼핑",
  },
};

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

export function generatePlayAutoProductExcel(
  products: Product[],
  metadataList: Array<{ model: string; brand: string; manufacturer: string }>,
  commissionRates: CommissionRate[],
  categoryMappings: Record<string, string> = {},
  smartstoreCategoryCodes: string[] = [],
  platform: PlayAutoExportPlatform = "smartstore",
  userConfig?: ExportConfigOverride,
  noticeMap?: Record<string, string[]>
): { buffer: ArrayBuffer; filename: string } {
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

  // 이 배치에서 사용되는 최대 고시 개수를 계산 (컬럼 수 통일)
  const maxFields = products.reduce((max, p) => {
    const code = categoryMappings[p.category] ?? DEFAULT_SCHEMA.code;
    const schema = getSchemaByCode(code);
    return Math.max(max, schema.fields.length);
  }, DEFAULT_SCHEMA.fields.length);

  const data = products.map((p, i) => {
    const settlementPrice = calcSettlementPrice(p.lowest_price, p.margin_rate);
    const categoryRates = rateMap[p.category] ?? {};
    const platformRate = (categoryRates as Record<string, number>)[config.rateKey] ?? 0;
    const salePrice = platformRate > 0
      ? calcPlatformPrice(settlementPrice, platformRate)
      : p.lowest_price;

    const meta = metadataList[i] ?? { model: "", brand: "", manufacturer: "" };
    const sellerCode = `${dateStr}${String(i + 1).padStart(3, "0")}`;

    const playautoCode = categoryMappings[p.category] ?? DEFAULT_SCHEMA.code;
    const schema = getSchemaByCode(playautoCode);

    const row: Record<string, string | number> = {
      판매자관리코드: sellerCode,
      카테고리코드: smartstoreCategoryCodes[i] ?? "",
      "쇼핑몰(계정)": config.shopAccount,
      템플릿코드: config.templateCode,
      "온라인 상품명": p.product_name,
      판매수량: saleQuantity,
      판매가: salePrice,
      공급가: 0,
      원가: 0,
      시중가: 0,
      옵션조합: "옵션없음",
      원산지: "기타=상세페이지참조",
      복수원산지여부: "N",
      과세여부: "과세",
      배송방법: "무료",
      배송비: 0,
      기본이미지: p.thumbnail_url ?? "",
      상세설명: p.detail_html ?? "",
      "머리말/꼬리말 템플릿코드": config.headerFooterTemplateCode,
      모델명: meta.model,
      브랜드: meta.brand,
      제조사: meta.manufacturer,
      상품분류코드: playautoCode,
    };

    // 이 상품의 고시 항목 채우기 (해당 카테고리 개수만큼 "상세페이지 참조", 나머지 빈칸)
    for (let n = 1; n <= maxFields; n++) {
      const customValues = noticeMap?.[playautoCode];
      row[`상품정보제공고시${n}`] = n <= schema.fields.length
        ? (customValues?.[n - 1] || productInfoNotice)
        : "";
    }

    return row;
  });

  const ws = XLSX.utils.json_to_sheet(data);

  // 줄바꿈(\n) 포함 셀에 wrapText 스타일 적용 (플토 업로드 시 멀티라인 인식 필수)
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
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
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** base64 데이터로부터 엑셀 다운로드 */
export function downloadExcelFromBase64(base64: string, filename: string) {
  const buffer = base64ToArrayBuffer(base64);
  downloadExcel(buffer, filename);
}

/**
 * 가격수정용 엑셀 2종 생성 (일반상품 + 단일상품)
 * 일반상품: 스마트스토어, 쿠팡
 * 단일상품: 지마켓, 옥션, 11번가
 */
export function generatePriceUpdateExcel(
  products: Product[],
  commissionRates: CommissionRate[],
  exportConfigs?: Record<string, { shopAccount: string }>
): { normal: { buffer: ArrayBuffer; filename: string } | null; single: { buffer: ArrayBuffer; filename: string } | null } {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rateMap = buildRateMap(commissionRates);

  // 플랫폼별 계정 키 목록 (exportConfigs 우선, 없으면 PLATFORM_CONFIGS 기본값)
  const normalAccounts: string[] = []; // 스마트스토어, 쿠팡
  const singleAccounts: string[] = []; // 옥션, 지마켓, 11번가

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
    if (lower.startsWith("11번가")) return "esm";
    return "esm";
  };

  const buildRows = (accounts: string[]) => {
    const rows: Array<{ "쇼핑몰 상품번호": string; 판매가: number }> = [];
    for (const p of products) {
      if (!p.platform_codes) continue;
      const settlementPrice = calcSettlementPrice(p.lowest_price, p.margin_rate);
      const categoryRates = rateMap[p.category] ?? {};

      for (const account of accounts) {
        const code = (p.platform_codes as Record<string, string>)[account];
        if (!code) continue;

        const rateKey = accountRateKey(account);
        const rate = (categoryRates as Record<string, number>)[rateKey] ?? 0;
        const salePrice = rate > 0 ? calcPlatformPrice(settlementPrice, rate) : p.lowest_price;

        rows.push({ "쇼핑몰 상품번호": code, 판매가: salePrice });
      }
    }
    return rows;
  };

  const toExcel = (rows: Array<Record<string, string | number>>, label: string) => {
    if (rows.length === 0) return null;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
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
