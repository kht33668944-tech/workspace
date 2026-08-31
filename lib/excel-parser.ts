type WorkSheet = Record<string, unknown> & { "!ref"?: string };

// xlsx-js-style을 lazy load하여 클라이언트 번들에서 제외 (~1MB 절감)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let XLSX: any = null;
let _xlsxPromise: Promise<void> | null = null;
async function loadXLSX() {
  if (!_xlsxPromise) _xlsxPromise = import("xlsx-js-style").then(m => { XLSX = m.default ?? m; });
  await _xlsxPromise;
}
import { EXCEL_COLUMN_MAP, LEGACY_EXCEL_COLUMN_MAP } from "./constants";
import { sanitizeAddressDetail } from "./scrapers/types";
import type { OrderInsert } from "@/types/database";

const MAX_EXCEL_FILE_SIZE = 25 * 1024 * 1024;
const MAX_EXCEL_SHEETS = 30;
const MAX_EXCEL_ROWS = 100_000;
const MAX_EXCEL_COLUMNS = 250;
const MAX_EXCEL_CELLS = 1_000_000;
const ALLOWED_EXCEL_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);

// 판매처별 정산 비율 (판매가 × rate = 정산예정금액)
export const SETTLEMENT_RATES: [string, number][] = [
  ["스마트스토어", 0.93],
  ["쿠팡", 0.88],
  ["옥션", 0.85],
  ["지마켓", 0.87],
  ["11번가", 0.92],
];

interface RawRow {
  [key: string]: string | number | undefined;
}

function validateExcelFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXCEL_EXTENSIONS.has(extension)) {
    throw new Error("엑셀 파일만 업로드할 수 있습니다. (.xlsx, .xls, .csv)");
  }
  if (file.size > MAX_EXCEL_FILE_SIZE) {
    throw new Error("엑셀 파일이 너무 큽니다. 25MB 이하 파일만 업로드할 수 있습니다.");
  }
}

function assertWorkbookBounds(sheetNames: string[]) {
  if (sheetNames.length === 0) {
    throw new Error("엑셀 파일에 시트가 없습니다.");
  }
  if (sheetNames.length > MAX_EXCEL_SHEETS) {
    throw new Error(`엑셀 시트가 너무 많습니다. 최대 ${MAX_EXCEL_SHEETS}개까지 처리할 수 있습니다.`);
  }
}

function assertSheetBounds(sheet: WorkSheet) {
  const ref = sheet["!ref"];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  const cells = rows * columns;

  if (rows > MAX_EXCEL_ROWS) {
    throw new Error(`엑셀 행이 너무 많습니다. 최대 ${MAX_EXCEL_ROWS.toLocaleString()}행까지 처리할 수 있습니다.`);
  }
  if (columns > MAX_EXCEL_COLUMNS) {
    throw new Error(`엑셀 열이 너무 많습니다. 최대 ${MAX_EXCEL_COLUMNS.toLocaleString()}열까지 처리할 수 있습니다.`);
  }
  if (cells > MAX_EXCEL_CELLS) {
    throw new Error(`엑셀 데이터가 너무 큽니다. 최대 ${MAX_EXCEL_CELLS.toLocaleString()}개 셀까지 처리할 수 있습니다.`);
  }
}

function sheetToRows(sheet: WorkSheet): unknown[][] {
  assertSheetBounds(sheet);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true, blankrows: false });
}

function rowsFromHeader(rawData: unknown[][], headerRowIndex: number): { headers: string[]; rows: RawRow[] } {
  const headerRow = rawData[headerRowIndex] ?? [];
  const headerEntries: { name: string; idx: number }[] = [];
  headerRow.forEach((cell, idx) => {
    const name = String(cell ?? "").trim();
    if (name) headerEntries.push({ name, idx });
  });

  const headers = headerEntries.map((h) => h.name);
  const rows: RawRow[] = [];
  for (let i = headerRowIndex + 1; i < rawData.length; i++) {
    const dataRow = rawData[i];
    const obj: RawRow = {};
    let hasValue = false;
    for (const { name, idx } of headerEntries) {
      const val = dataRow[idx];
      obj[name] = val === null || val === undefined ? "" : val as string | number;
      if (val !== null && val !== undefined && val !== "") hasValue = true;
    }
    if (hasValue) rows.push(obj);
  }

  return { headers, rows };
}

// 금액/수량 셀을 숫자로 파싱. 콤마/통화기호 제거 후 변환.
// "무료"/"-" 등 파싱 불가 값은 0이 아니라 경고 로깅 후 0 사용 (조용한 손실 방지).
function parseNumericCell(value: string | number, engKey: string): number {
  if (typeof value === "number") return Math.round(value);
  const cleaned = String(value).replace(/[,\s₩원]/g, "");
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) {
    console.warn(`[엑셀 파서] 숫자 변환 실패 (${engKey}): "${value}" → 0 처리`);
    return 0;
  }
  return Math.round(n);
}

export interface ParsedExcelResult {
  sheetNames: string[];
  orders: OrderInsert[];
  debugHeaders?: string[]; // 디버그용
  isLegacyFormat?: boolean; // 기존 발주서 양식 감지
  sheetOrderCounts?: number[]; // 시트별 주문 건수
}

// 헤더 정규화: 공백, 특수문자 제거
function normalizeHeader(header: string): string {
  return header.replace(/[\s\u00A0\u3000\t\r\n]/g, "").trim();
}

// 알려진 컬럼명 목록 (헤더 행 감지용)
const KNOWN_HEADERS = [
  "묶음번호", "주문번호", "주문일시", "주문일", "판매처", "수취인명", "수취인",
  "상품주문번호", "구매자명", "주문자명", "스마트스토어주문번호",
  "상품명", "품명", "수량", "수령자번호", "수취인번호", "주문자번호",
  "우편번호", "주소", "배송메모", "매출", "판매금액", "결제금액",
  "배송지", "수취인연락처", "수령자연락처", "주문자연락처",
  "묶음배송번호", "묶음배송", "배송요청사항",
  // 플레이오토 발주양식 전용 헤더
  "결제완료일", "소핑몰", "쇼핑몰", "수량자명", "온라인상품명",
  "수량자휴대폰번호", "수령자휴대폰번호", "주문자휴대폰번호", "배송메세지", "금액",
  // 기존 발주서(구글 드라이브) 전용 헤더
  "정산예정", "원가", "마진", "결제방식", "구매처", "아이디", "주문번호", "택배사", "운송장",
  "수령자 번호", "주문자 번호",
];

// 추가 별칭 (플레이오토 엑셀의 다양한 헤더 형식 대응)
const ALIASES: Record<string, string[]> = {
  bundle_no: ["묶음번호", "묶음 번호", "묶음No", "묶음배송번호", "묶음배송", "묶음관리번호", "Bundle"],
  order_date: ["주문일시", "주문일", "주문 일시", "결제일", "결제일시", "주문날짜", "주문시간", "결제시간", "주문일자", "결제일자", "발주일", "발주일시", "발주일자", "결제완료일", "결제완료일시", "OrderDate"],
  marketplace: ["판매처", "판매 처", "마켓", "쇼핑몰", "소핑몰", "채널", "판매채널"],
  marketplace_order_no: ["스마트스토어주문번호", "판매처주문번호", "마켓주문번호", "marketplaceOrderNo", "orderId"],
  marketplace_product_order_no: ["상품주문번호", "상품 주문번호", "상품주문ID", "productOrderId"],
  marketplace_orderer_name: ["구매자명", "구매자 명", "구매자", "주문자명", "주문자 명", "주문자"],
  recipient_name: ["수취인명", "수취인 명", "수취인", "받는분", "받는사람", "수령인", "수령자명", "수령자", "수량자명"],
  product_name: ["상품명", "상품 명", "품명", "제품명", "상품", "온라인상품명", "온라인 상품명"],
  quantity: ["수량", "주문수량"],
  recipient_phone: ["수령자번호", "수령자 번호", "수취인번호", "수취인 번호", "수취인연락처", "수취인 연락처", "수령자연락처", "수령자 연락처", "수취인전화번호", "받는분연락처", "수령자전화", "받는분전화번호", "수취인핸드폰", "수량자휴대폰번호", "수령자휴대폰번호", "수취인휴대폰번호"],
  orderer_phone: ["주문자번호", "주문자 번호", "주문자연락처", "주문자 연락처", "주문자전화번호", "주문자전화", "주문자핸드폰", "주문자휴대폰번호"],
  postal_code: ["우편번호", "우편 번호", "zipcode", "zip"],
  address: ["주소", "배송지", "배송 주소", "배송지주소", "배송주소", "받는분주소"],
  delivery_memo: ["배송메모", "배송 메모", "배송메세지", "배송 메세지", "배송요청사항", "배송 요청사항", "요청사항", "배송시요청사항", "배송메시지"],
  revenue: ["매출", "매출액", "판매가", "판매금액", "결제금액", "상품금액", "주문금액", "금액"],
  settlement: ["정산예정", "정산금", "정산금액", "정산"],
  cost: ["원가", "매입가", "매입금액", "구매가"],
  payment_method: ["결제방식", "결제수단", "결제방법"],
  purchase_source: ["구매처"],
  purchase_id: ["아이디", "구매아이디", "구매ID"],
  purchase_url: ["최저가링크", "구매링크", "구매URL", "상품URL", "상품링크"],
  purchase_detail_url: ["주문상세링크", "주문상세", "구매주문링크"],
  purchase_order_no: ["주문번호", "발주번호"],
  courier: ["택배사", "배송업체"],
  tracking_no: ["운송장", "운송장번호", "송장번호", "송장"],
};

// 엑셀 헤더 → DB 컬럼 매핑
function buildHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (!normalized) continue;

    // 1. EXCEL_COLUMN_MAP + LEGACY_EXCEL_COLUMN_MAP 정확한 매칭
    if (EXCEL_COLUMN_MAP[header]) {
      map[header] = EXCEL_COLUMN_MAP[header];
      continue;
    }
    if (LEGACY_EXCEL_COLUMN_MAP[header]) {
      map[header] = LEGACY_EXCEL_COLUMN_MAP[header];
      continue;
    }

    // 2. 두 맵 정규화 매칭
    for (const colMap of [EXCEL_COLUMN_MAP, LEGACY_EXCEL_COLUMN_MAP]) {
      for (const [korKey, engKey] of Object.entries(colMap)) {
        if (normalizeHeader(korKey) === normalized) {
          map[header] = engKey;
          break;
        }
      }
      if (map[header]) break;
    }
    if (map[header]) continue;

    // 3. 별칭 정확 매칭
    for (const [engKey, aliases] of Object.entries(ALIASES)) {
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        map[header] = engKey;
        break;
      }
    }
    if (map[header]) continue;

    // 4. 별칭 부분 포함 매칭
    for (const [engKey, aliases] of Object.entries(ALIASES)) {
      if (aliases.some((alias) => {
        const na = normalizeHeader(alias);
        return (normalized.includes(na) || na.includes(normalized)) && normalized.length >= 2;
      })) {
        if (!map[header]) {
          map[header] = engKey;
          break;
        }
      }
    }
  }

  return map;
}

// 헤더 행인지 확인 (알려진 컬럼명이 2개 이상 포함되면 헤더 행)
function isHeaderRow(row: unknown[]): boolean {
  let matchCount = 0;
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    const normalized = normalizeHeader(String(cell));
    if (KNOWN_HEADERS.some((kh) => normalizeHeader(kh) === normalized)) {
      matchCount++;
    } else {
      // KNOWN_HEADERS에 없을 때만 별칭 체크 (이중 카운트 방지)
      for (const aliases of Object.values(ALIASES)) {
        if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
          matchCount++;
          break;
        }
      }
    }
  }
  return matchCount >= 2;
}

// 시트에서 헤더 행의 시작 위치를 찾고 파싱
function parseSheet(sheet: WorkSheet): { headers: string[]; rows: RawRow[] } {
  const rawData = sheetToRows(sheet);

  if (rawData.length > 0) {
    const firstRowKeys = (rawData[0] ?? []).map((cell) => String(cell ?? "").trim()).filter(Boolean);
    const headerMap = buildHeaderMap(firstRowKeys);
    const mappedCount = Object.keys(headerMap).length;

    // 매핑된 컬럼이 3개 이상이면 정상
    if (mappedCount >= 3) {
      console.log("[엑셀 파서] 기본 헤더 사용:", firstRowKeys);
      console.log("[엑셀 파서] 매핑 결과:", headerMap);
      return rowsFromHeader(rawData, 0);
    }
  }

  // 기본 파싱 실패 → 시트를 2D 배열로 읽어서 헤더 행 탐색
  console.log("[엑셀 파서] 기본 헤더 매핑 부족, 헤더 행 탐색 시작...");

  for (let i = 0; i < Math.min(rawData.length, 10); i++) {
    const row = rawData[i];
    if (isHeaderRow(row)) {
      console.log(`[엑셀 파서] 헤더 행 발견: ${i}행`, row);
      const { headers, rows: dataRows } = rowsFromHeader(rawData, i);

      const headerMap = buildHeaderMap(headers);
      console.log("[엑셀 파서] 재매핑 결과:", headerMap);
      if (dataRows.length > 0) {
        console.log("[엑셀 파서] 첫 행 데이터:", JSON.stringify(dataRows[0]).slice(0, 300));
      }
      return { headers, rows: dataRows };
    }
  }

  // 찾지 못하면 기본 결과 반환
  console.log("[엑셀 파서] 헤더 행을 찾지 못함, 기본 파싱 사용");
  return rawData.length > 0 ? rowsFromHeader(rawData, 0) : { headers: [], rows: [] };
}

// 기존 발주서 양식 감지: 정산예정/원가/마진/결제방식/구매처 등 고유 헤더가 있으면 레거시
function detectLegacyFormat(headerMap: Record<string, string>): boolean {
  const mapped = new Set(Object.values(headerMap));
  const legacyKeys = ["settlement", "cost", "payment_method", "purchase_source", "tracking_no"];
  const matchCount = legacyKeys.filter((k) => mapped.has(k)).length;
  return matchCount >= 3;
}

// 시트 하나를 파싱하여 주문 목록 반환 (내부 공용)
function parseSheetToOrders(sheet: WorkSheet): { orders: OrderInsert[]; headers: string[]; headerMap: Record<string, string> } {
  const { headers, rows } = parseSheet(sheet);
  const parsedHeaderMap = buildHeaderMap(headers);
  const headerMap = normalizeSmartstoreHeaderMap(headers, rows, parsedHeaderMap);
  const bundleKey = headers.find((h) => headerMap[h] === "bundle_no");
  const productKey = headers.find((h) => headerMap[h] === "product_name");
  const revenueKey = headers.find((h) => headerMap[h] === "revenue");

  const orders = rows
    .filter((row) => (bundleKey && row[bundleKey]) || (productKey && row[productKey]))
    .filter((row) => {
      if (!revenueKey) return true;
      const revenueValue = row[revenueKey];
      if (revenueValue === undefined) return false;
      return parseNumericCell(revenueValue, "revenue") > 0;
    })
    .map((row) => mapRowToOrder(row, headerMap));

  return { orders, headers, headerMap };
}

// 스마트스토어 주문 엑셀은 일반 발주서와 같은 "주문번호" 헤더를 사용하지만,
// 내부 DB의 purchase_order_no는 소싱처 구매번호이므로 별도 판매처 주문번호로 분리한다.
function normalizeSmartstoreHeaderMap(headers: string[], rows: RawRow[], headerMap: Record<string, string>): Record<string, string> {
  const normalized = headers.map(normalizeHeader);
  const sellerHeader = headers.find((header) => ["판매아이디", "판매처", "쇼핑몰", "소핑몰"].includes(normalizeHeader(header)));
  const sellerValues = sellerHeader
    ? rows.slice(0, 30).map((row) => String(row[sellerHeader] ?? "").toLowerCase())
    : [];
  const hasKnownNonSmartstoreSeller = sellerValues.some((value) =>
    ["지마켓", "옥션", "쿠팡", "11번가", "gmarket", "auction", "coupang"].some((name) => value.includes(name))
  );
  const hasExplicitSmartstoreIdentifier = normalized.includes("상품주문번호") ||
    normalized.includes("상품주문ID") ||
    normalized.includes("스마트스토어주문번호") ||
    Object.values(headerMap).includes("marketplace_product_order_no");
  const hasSmartstoreSeller = sellerValues.some((value) => value.includes("스마트스토어") || value.includes("smartstore") || value.includes("네이버") || value.includes("naver"));
  const isSmartstore = hasExplicitSmartstoreIdentifier || hasSmartstoreSeller ||
    (!sellerHeader && (normalized.includes("구매자명") || normalized.includes("주문자명")));

  // 판매처가 명확히 ESM/쿠팡이면 기존 purchase_order_no 의미를 보존한다.
  if (hasKnownNonSmartstoreSeller && !hasExplicitSmartstoreIdentifier && !hasSmartstoreSeller) {
    return headerMap;
  }

  if (!isSmartstore) return headerMap;

  const next = { ...headerMap };
  const plainOrderNoHeader = headers.find((header) => normalizeHeader(header) === "주문번호");
  if (plainOrderNoHeader && next[plainOrderNoHeader] === "purchase_order_no") {
    next[plainOrderNoHeader] = "marketplace_order_no";
  }
  return next;
}

export async function parseExcelFile(file: File, sheetIndex = 0): Promise<ParsedExcelResult> {
  validateExcelFile(file);
  await loadXLSX();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array", cellDates: false });
        const sheetNames = workbook.SheetNames;
        assertWorkbookBounds(sheetNames);
        const sheet = workbook.Sheets[sheetNames[sheetIndex] || sheetNames[0]];
        const { orders, headers, headerMap } = parseSheetToOrders(sheet);
        const isLegacyFormat = detectLegacyFormat(headerMap);

        console.log("[엑셀 파서] 최종 헤더:", headers);
        console.log("[엑셀 파서] 최종 매핑:", headerMap);
        console.log("[엑셀 파서] 레거시 양식:", isLegacyFormat);
        if (orders.length > 0) {
          console.log("[엑셀 파서] 첫 주문:", orders[0]);
        }

        // 여러 시트가 있으면 시트별 건수 미리 계산
        let sheetOrderCounts: number[] | undefined;
        if (sheetNames.length > 1) {
          sheetOrderCounts = sheetNames.map((name: string, i: number) => {
            if (i === (sheetIndex || 0)) return orders.length;
            try {
              const s = workbook.Sheets[name];
              const { orders: sheetOrders } = parseSheetToOrders(s);
              return sheetOrders.length;
            } catch {
              return 0;
            }
          });

          // 현재 시트에 데이터가 없으면 데이터가 있는 첫 시트로 자동 전환
          if (orders.length === 0) {
            const firstWithData = sheetOrderCounts!.findIndex((c) => c > 0);
            if (firstWithData >= 0 && firstWithData !== sheetIndex) {
              const altSheet = workbook.Sheets[sheetNames[firstWithData]];
              const alt = parseSheetToOrders(altSheet);
              resolve({
                sheetNames,
                orders: alt.orders,
                debugHeaders: alt.headers,
                isLegacyFormat: detectLegacyFormat(alt.headerMap),
                sheetOrderCounts,
              });
              return;
            }
          }
        }

        resolve({ sheetNames, orders, debugHeaders: headers, isLegacyFormat, sheetOrderCounts });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.readAsArrayBuffer(file);
  });
}

export async function parseExcelSheet(file: File, sheetIndex: number): Promise<OrderInsert[]> {
  validateExcelFile(file);
  await loadXLSX();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array", cellDates: false });
        assertWorkbookBounds(workbook.SheetNames);
        const sheet = workbook.Sheets[workbook.SheetNames[sheetIndex]];
        const { orders } = parseSheetToOrders(sheet);
        resolve(orders);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.readAsArrayBuffer(file);
  });
}

// 주소를 기본주소/상세주소로 분리
// 규칙: 도로명/지번 + 번지까지 = 기본주소, 나머지(괄호 내용 포함) = 상세주소
export function splitAddress(fullAddress: string): { base: string; detail: string } {
  const trimmed = fullAddress.trim();

  // 도로명주소: ~대로/~번길/~로/~길 + 번지[-번지]
  // 지번주소: ~동/~리/~가 + 번지[-번지]
  const basePattern = /^(.*?(?:대로|번길|로|길|동|리|가)\s+\d+(?:-\d+)?)(?:\s+|(?=\())(.+)$/;
  const match = trimmed.match(basePattern);

  if (!match) {
    return { base: trimmed, detail: "" };
  }

  const base = match[1].trim();
  const rest = match[2].trim();

  // 특수문자(·, /, 괄호 등)는 제거하고 내용은 상세주소에 보존 (마켓 배송지 폼이 특수문자 저장을 거부)
  const detail = sanitizeAddressDetail(rest);

  return { base, detail };
}

function mapRowToOrder(row: RawRow, headerMap: Record<string, string>): OrderInsert {
  const mapped: Record<string, unknown> = {
    user_id: "",
  };

  for (const [excelHeader, engKey] of Object.entries(headerMap)) {
    const value = row[excelHeader];
    if (value === undefined || value === "") {
      mapped[engKey] = null;
      continue;
    }

    // 숫자 0도 유효한 값으로 처리
    if (value === 0 && engKey !== "quantity" && engKey !== "revenue") {
      mapped[engKey] = engKey === "bundle_no" || engKey === "recipient_phone" || engKey === "orderer_phone" || engKey === "postal_code"
        ? "0"
        : null;
      continue;
    }

    switch (engKey) {
      case "bundle_no":
      case "marketplace_order_no":
      case "marketplace_product_order_no":
      case "recipient_phone":
      case "orderer_phone":
      case "postal_code":
        // 숫자로 올 수 있는 필드 → 문자열로 변환
        mapped[engKey] = String(value);
        break;
      case "quantity":
      case "revenue":
      case "settlement":
      case "cost":
        mapped[engKey] = parseNumericCell(value, engKey);
        break;
      case "margin":
        // 마진은 수식일 수 있음 — 숫자로 변환, 나중에 settlement - cost로 재계산
        mapped[engKey] = parseNumericCell(value, engKey);
        break;
      case "order_date":
        mapped[engKey] = parseDate(value);
        break;
      default:
        mapped[engKey] = String(value);
    }
  }

  // 스마트 감지: 수취인명에 전화번호가 들어간 경우 → 수령자번호로 이동
  if (mapped.recipient_name && typeof mapped.recipient_name === "string") {
    const cleaned = mapped.recipient_name.replace(/[-\s()]/g, "");
    if (/^0\d{8,10}$/.test(cleaned) && !mapped.recipient_phone) {
      mapped.recipient_phone = mapped.recipient_name;
      mapped.recipient_name = null;
    }
  }

  // 매핑되지 않은 필드 기본값 설정
  if (mapped.bundle_no === undefined) mapped.bundle_no = null;
  if (mapped.order_date === undefined) mapped.order_date = null;
  if (mapped.marketplace === undefined) mapped.marketplace = null;
  if (mapped.marketplace_order_no === undefined) mapped.marketplace_order_no = null;
  if (mapped.marketplace_product_order_no === undefined) mapped.marketplace_product_order_no = null;
  if (mapped.marketplace_orderer_name === undefined) mapped.marketplace_orderer_name = null;
  if (mapped.recipient_name === undefined) mapped.recipient_name = null;
  if (mapped.product_name === undefined) mapped.product_name = null;
  if (mapped.quantity === undefined) mapped.quantity = 1;
  if (mapped.recipient_phone === undefined) mapped.recipient_phone = null;
  if (mapped.orderer_phone === undefined) mapped.orderer_phone = null;
  if (mapped.postal_code === undefined) mapped.postal_code = null;
  if (mapped.address === undefined) mapped.address = null;
  if (mapped.address_detail === undefined) mapped.address_detail = null;
  if (mapped.delivery_memo === undefined) mapped.delivery_memo = null;

  // 주소가 있고 상세주소가 없으면 자동 분리
  if (mapped.address && typeof mapped.address === "string" && !mapped.address_detail) {
    const { base, detail } = splitAddress(mapped.address);
    mapped.address = base;
    mapped.address_detail = detail || null;
  } else if (mapped.address_detail && typeof mapped.address_detail === "string") {
    // 엑셀에 상세주소 컬럼이 별도로 온 경우에도 특수문자 정리
    mapped.address_detail = sanitizeAddressDetail(mapped.address_detail) || null;
  }
  if (mapped.revenue === undefined) mapped.revenue = 0;

  // 정산예정금액 자동 계산 (판매처별 수수료율)
  // 사용자가 엑셀에 정산 컬럼을 제공한 경우(매핑됨)에는 그 값을 존중 — 정상 0원 정산을 덮어쓰지 않음.
  // 컬럼 자체가 없을 때만 매출×수수료율로 자동 계산.
  const hasSettlementColumn = Object.values(headerMap).includes("settlement");
  if (!hasSettlementColumn) {
    const revenue = (mapped.revenue as number) || 0;
    const mp = typeof mapped.marketplace === "string" ? mapped.marketplace : "";
    const rate = SETTLEMENT_RATES.find(([key]) => mp.includes(key));
    if (revenue > 0 && rate) {
      mapped.settlement = Math.round(revenue * rate[1]);
    }
  }

  // 수동 입력 필드 기본값
  if (mapped.settlement === undefined) mapped.settlement = 0;
  if (mapped.cost === undefined) mapped.cost = 0;
  if (mapped.payment_method === undefined) mapped.payment_method = null;
  if (mapped.purchase_id === undefined) mapped.purchase_id = null;
  if (mapped.purchase_source === undefined) mapped.purchase_source = null;
  if (mapped.purchase_url === undefined) mapped.purchase_url = null;
  if (mapped.purchase_detail_url === undefined) mapped.purchase_detail_url = null;
  if (mapped.purchase_order_no === undefined) mapped.purchase_order_no = null;
  if (mapped.courier === undefined) mapped.courier = null;
  if (mapped.tracking_no === undefined) mapped.tracking_no = null;
  if (mapped.delivery_status === undefined) mapped.delivery_status = "구매대기";
  if (mapped.delivery_status === "재고부족") mapped.delivery_status = "발송불가"; // 구 명칭 엑셀 호환
  if (mapped.delivery_status === "결제전") mapped.delivery_status = "구매대기"; // 구 명칭 엑셀 호환
  if (mapped.consultation_logs === undefined) mapped.consultation_logs = [];
  if (mapped.memo === undefined) mapped.memo = null;

  // margin은 DB에서 자동 계산 (generated column) — 직접 전달하지 않음
  delete mapped.margin;

  return mapped as unknown as OrderInsert;
}

function parseDate(value: string | number | undefined): string | null {
  if (!value && value !== 0) return null;

  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}T${String(date.H || 0).padStart(2, "0")}:${String(date.M || 0).padStart(2, "0")}:${String(date.S || 0).padStart(2, "0")}+09:00`;
    }
    return null;
  }

  const str = String(value).trim();
  if (!str) return null;

  // "2026-03-05 14:30:00" or "2026/03/05 14:30" or "2026.03.05 14:30:00"
  const dateTimeMatch = str.match(/^(\d{4})[-/.]+(\d{1,2})[-/.]+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dateTimeMatch) {
    const [, y, m, d, h, min, sec] = dateTimeMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${(sec || "0").padStart(2, "0")}+09:00`;
  }

  // "2026-03-05" or "2026.03.05" or "2026/03/05"
  const dateMatch = str.match(/^(\d{4})[-/.]+(\d{1,2})[-/.]+(\d{1,2})/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00+09:00`;
  }

  // "03/05/2026" or "03-05-2026" (MM/DD/YYYY)
  const mdyMatch = str.match(/^(\d{1,2})[-/.]+(\d{1,2})[-/.]+(\d{4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00+09:00`;
  }

  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString();
  console.warn("[엑셀 파서] 날짜 파싱 실패:", str);
  return null;
}

// 정산 엑셀 파싱 (옥션/지마켓 정산예정금액)
export interface SettlementRow {
  recipientName: string;
  ordererName: string;
  orderDate: string | null;
  recipientPhone: string;
  ordererPhone: string;
  marketplaceOrderNo: string;
  marketplaceProductOrderNo: string;
  productName: string;
  saleAmount: number;
  settlementAmount: number;
  marketplace: string; // "지마켓" | "옥션"
}

export async function parseSettlementExcel(file: File): Promise<{ rows: SettlementRow[]; sheetName: string }> {
  validateExcelFile(file);
  await loadXLSX();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array", cellDates: false });
        assertWorkbookBounds(workbook.SheetNames);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawData = sheetToRows(sheet);

        // 헤더 행 찾기 — ESM은 수령인명, 스마트스토어는 상품주문번호/주문자명을 사용할 수 있다.
        let headerRowIdx = -1;
        let headers: string[] = [];
        for (let i = 0; i < Math.min(rawData.length, 10); i++) {
          const row = rawData[i];
          const strs = row.map((c) => String(c ?? "").trim());
          const normalizedHeaders = strs.map(normalizeHeader);
          const hasSettlement = normalizedHeaders.some((h) => ["정산예정금액", "정산금액", "예상정산금액"].includes(h));
          const hasIdentity = normalizedHeaders.some((h) => [
            "수령인명", "수취인명", "상품주문번호", "상품주문ID", "구매자명", "주문자명", "주문번호",
          ].includes(h));
          if (hasSettlement && hasIdentity) {
            headerRowIdx = i;
            headers = strs;
            break;
          }
        }

        if (headerRowIdx === -1) {
          reject(new Error("정산 엑셀 양식이 아닙니다. 정산예정금액과 주문 식별정보(상품주문번호·주문번호·수령인명 중 하나)가 필요합니다."));
          return;
        }

        const normalizedHeaders = headers.map(normalizeHeader);
        const findIndex = (...names: string[]) => {
          const normalizedNames = names.map(normalizeHeader);
          return normalizedHeaders.findIndex((header) => normalizedNames.includes(header));
        };
        const idxRecipient = findIndex("수령인명", "수취인명", "수령인", "수취인", "받는분");
        const idxOrderer = findIndex("구매자명", "주문자명", "구매자", "주문자");
        const idxProductOrderNo = findIndex("상품주문번호", "상품주문ID", "productOrderId");
        const idxOrderNo = findIndex("스마트스토어주문번호", "판매처주문번호", "주문번호", "orderId");
        const idxOrderDate = findIndex("결제완료일", "결제일", "결제일시", "주문일", "주문일시", "구매확정일");
        const idxRecipientPhone = findIndex("수령자휴대폰번호", "수취인휴대폰번호", "수령자번호", "수취인번호", "수령인연락처", "수취인연락처");
        const idxOrdererPhone = findIndex("주문자휴대폰번호", "주문자번호", "주문자연락처", "구매자연락처");
        const idxProduct = findIndex("상품명", "상품 명", "상품명(옵션명)");
        const idxSaleAmount = findIndex("판매금액", "결제금액", "주문금액", "상품금액", "매출액");
        const idxSettlement = findIndex("정산예정금액", "정산금액", "예상정산금액");
        const idxSeller = findIndex("판매아이디", "판매자아이디");
        const idxMarketplace = findIndex("판매처", "판매처명", "마켓", "쇼핑몰");

        const rows: SettlementRow[] = [];
        for (let i = headerRowIdx + 1; i < rawData.length; i++) {
          const row = rawData[i];
          const recipientName = idxRecipient >= 0 ? String(row[idxRecipient] ?? "").trim() : "";
          const ordererName = idxOrderer >= 0 ? String(row[idxOrderer] ?? "").trim() : "";
          const orderDateRaw = idxOrderDate >= 0 ? row[idxOrderDate] : undefined;
          const orderDate = typeof orderDateRaw === "string" || typeof orderDateRaw === "number"
            ? parseDate(orderDateRaw)
            : null;
          const recipientPhone = idxRecipientPhone >= 0 ? String(row[idxRecipientPhone] ?? "").trim() : "";
          const ordererPhone = idxOrdererPhone >= 0 ? String(row[idxOrdererPhone] ?? "").trim() : "";
          const marketplaceOrderNo = idxOrderNo >= 0 ? String(row[idxOrderNo] ?? "").trim() : "";
          const marketplaceProductOrderNo = idxProductOrderNo >= 0 ? String(row[idxProductOrderNo] ?? "").trim() : "";
          const settlementRaw = row[idxSettlement];
          const settlementAmount = typeof settlementRaw === "number"
            ? Math.round(settlementRaw)
            : parseInt(String(settlementRaw).replace(/,/g, ""), 10) || 0;

          if ((!recipientName && !ordererName && !marketplaceProductOrderNo && !marketplaceOrderNo) || settlementAmount === 0) continue;

          const productName = idxProduct >= 0 ? String(row[idxProduct] ?? "").trim() : "";
          const saleAmountRaw = idxSaleAmount >= 0 ? row[idxSaleAmount] : 0;
          const saleAmount = typeof saleAmountRaw === "number"
            ? Math.round(saleAmountRaw)
            : parseInt(String(saleAmountRaw).replace(/,/g, ""), 10) || 0;

          // 판매아이디에서 마켓플레이스 추출: "지마켓(redgoom00)" → "지마켓"
          let marketplace = "";
          if (idxSeller >= 0) {
            const seller = String(row[idxSeller] ?? "");
            if (seller.includes("지마켓")) marketplace = "지마켓";
            else if (seller.includes("옥션")) marketplace = "옥션";
          }
          if (!marketplace && idxMarketplace >= 0) marketplace = String(row[idxMarketplace] ?? "").trim();
          if (!marketplace && (marketplaceProductOrderNo || ordererName)) marketplace = "스마트스토어";

          rows.push({
            recipientName: recipientName || ordererName,
            ordererName,
            orderDate,
            recipientPhone,
            ordererPhone,
            marketplaceOrderNo,
            marketplaceProductOrderNo,
            productName,
            saleAmount,
            settlementAmount,
            marketplace,
          });
        }

        resolve({ rows, sheetName });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.readAsArrayBuffer(file);
  });
}

export async function exportOrdersToCSV(orders: Record<string, unknown>[], filename: string) {
  await loadXLSX();
  const ws = XLSX.utils.json_to_sheet(orders);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "발주서");
  XLSX.writeFile(wb, filename);
}

/** 판매처명으로 정산 비율(추정) — 마켓 API 수집 시 정산예정금액 계산에 사용 */
export function getSettlementRate(marketplace: string | null | undefined): number {
  const name = (marketplace ?? "").toLowerCase();
  for (const [key, rate] of SETTLEMENT_RATES) if (name.includes(key.toLowerCase())) return rate;
  return 0.9;
}
