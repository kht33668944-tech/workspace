import * as XLSX from "xlsx";
import { EXCEL_COLUMN_MAP, LEGACY_EXCEL_COLUMN_MAP } from "./constants";
import type { OrderInsert } from "@/types/database";

interface RawRow {
  [key: string]: string | number | undefined;
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
    }
    // 별칭도 체크
    for (const aliases of Object.values(ALIASES)) {
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        matchCount++;
        break;
      }
    }
  }
  return matchCount >= 2;
}

// 시트에서 헤더 행의 시작 위치를 찾고 파싱
function parseSheet(sheet: XLSX.WorkSheet): { headers: string[]; rows: RawRow[] } {
  // 먼저 기본 파싱 시도
  const defaultRows: RawRow[] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  if (defaultRows.length > 0) {
    const firstRowKeys = Object.keys(defaultRows[0]);
    const headerMap = buildHeaderMap(firstRowKeys);
    const mappedCount = Object.keys(headerMap).length;

    // 매핑된 컬럼이 3개 이상이면 정상
    if (mappedCount >= 3) {
      console.log("[엑셀 파서] 기본 헤더 사용:", firstRowKeys);
      console.log("[엑셀 파서] 매핑 결과:", headerMap);
      return { headers: firstRowKeys, rows: defaultRows };
    }
  }

  // 기본 파싱 실패 → 시트를 2D 배열로 읽어서 헤더 행 탐색
  console.log("[엑셀 파서] 기본 헤더 매핑 부족, 헤더 행 탐색 시작...");
  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

  for (let i = 0; i < Math.min(rawData.length, 10); i++) {
    const row = rawData[i];
    if (isHeaderRow(row)) {
      console.log(`[엑셀 파서] 헤더 행 발견: ${i}행`, row);
      // 빈 헤더는 건너뛰되, 원래 인덱스를 유지하여 데이터 정렬 보존
      const headerEntries: { name: string; idx: number }[] = [];
      row.forEach((cell, idx) => {
        const name = String(cell ?? "").trim();
        if (name) headerEntries.push({ name, idx });
      });
      const headers = headerEntries.map((h) => h.name);
      const dataRows: RawRow[] = [];

      for (let j = i + 1; j < rawData.length; j++) {
        const dataRow = rawData[j];
        const obj: RawRow = {};
        let hasValue = false;
        for (const { name, idx } of headerEntries) {
          const val = dataRow[idx];
          obj[name] = val === null || val === undefined ? "" : val as string | number;
          if (val !== null && val !== undefined && val !== "") hasValue = true;
        }
        if (hasValue) dataRows.push(obj);
      }

      const headerMap = buildHeaderMap(headers);
      console.log("[엑셀 파서] 재매핑 결과:", headerMap);
      console.log("[엑셀 파서] 헤더 인덱스:", headerEntries.map((h) => `${h.name}@${h.idx}`));
      if (dataRows.length > 0) {
        console.log("[엑셀 파서] 첫 행 데이터:", JSON.stringify(dataRows[0]).slice(0, 300));
      }
      return { headers, rows: dataRows };
    }
  }

  // 찾지 못하면 기본 결과 반환
  console.log("[엑셀 파서] 헤더 행을 찾지 못함, 기본 파싱 사용");
  const headers = defaultRows.length > 0 ? Object.keys(defaultRows[0]) : [];
  return { headers, rows: defaultRows };
}

// 기존 발주서 양식 감지: 정산예정/원가/마진/결제방식/구매처 등 고유 헤더가 있으면 레거시
function detectLegacyFormat(headerMap: Record<string, string>): boolean {
  const mapped = new Set(Object.values(headerMap));
  const legacyKeys = ["settlement", "cost", "payment_method", "purchase_source", "tracking_no"];
  const matchCount = legacyKeys.filter((k) => mapped.has(k)).length;
  return matchCount >= 3;
}

// 시트 하나를 파싱하여 주문 목록 반환 (내부 공용)
function parseSheetToOrders(sheet: XLSX.WorkSheet): { orders: OrderInsert[]; headers: string[]; headerMap: Record<string, string> } {
  const { headers, rows } = parseSheet(sheet);
  const headerMap = buildHeaderMap(headers);
  const bundleKey = headers.find((h) => headerMap[h] === "bundle_no");
  const productKey = headers.find((h) => headerMap[h] === "product_name");

  const orders = rows
    .filter((row) => (bundleKey && row[bundleKey]) || (productKey && row[productKey]))
    .map((row) => mapRowToOrder(row, headerMap));

  return { orders, headers, headerMap };
}

export function parseExcelFile(file: File, sheetIndex = 0): Promise<ParsedExcelResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array", cellDates: false });
        const sheetNames = workbook.SheetNames;
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
          sheetOrderCounts = sheetNames.map((name, i) => {
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
            const firstWithData = sheetOrderCounts.findIndex((c) => c > 0);
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

export function parseExcelSheet(file: File, sheetIndex: number): Promise<OrderInsert[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array", cellDates: false });
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
function splitAddress(fullAddress: string): { base: string; detail: string } {
  const trimmed = fullAddress.trim();

  // 도로명주소: ~대로/~번길/~로/~길 + 번지[-번지]
  // 지번주소: ~동/~리/~가 + 번지[-번지]
  const basePattern = /^(.*?(?:대로|번길|로|길|동|리|가)\s+\d+(?:-\d+)?)\s+(.+)$/;
  const match = trimmed.match(basePattern);

  if (!match) {
    return { base: trimmed, detail: "" };
  }

  const base = match[1].trim();
  const rest = match[2].trim();

  // 괄호 기호만 제거하고 내용은 상세주소에 보존
  const detail = rest.replace(/[()]/g, "").replace(/\s+/g, " ").trim();

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
        mapped[engKey] = typeof value === "number" ? Math.round(value) : parseInt(String(value).replace(/,/g, ""), 10) || 0;
        break;
      case "margin":
        // 마진은 수식일 수 있음 — 숫자로 변환, 나중에 settlement - cost로 재계산
        mapped[engKey] = typeof value === "number" ? Math.round(value) : parseInt(String(value).replace(/,/g, ""), 10) || 0;
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
  }
  if (mapped.revenue === undefined) mapped.revenue = 0;

  // 수동 입력 필드 기본값
  if (mapped.settlement === undefined) mapped.settlement = 0;
  if (mapped.cost === undefined) mapped.cost = 0;
  if (mapped.payment_method === undefined) mapped.payment_method = null;
  if (mapped.purchase_id === undefined) mapped.purchase_id = null;
  if (mapped.purchase_source === undefined) mapped.purchase_source = null;
  if (mapped.purchase_order_no === undefined) mapped.purchase_order_no = null;
  if (mapped.courier === undefined) mapped.courier = null;
  if (mapped.tracking_no === undefined) mapped.tracking_no = null;
  if (mapped.delivery_status === undefined) mapped.delivery_status = "결제전";
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
      return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}T${String(date.H || 0).padStart(2, "0")}:${String(date.M || 0).padStart(2, "0")}:${String(date.S || 0).padStart(2, "0")}Z`;
    }
    return null;
  }

  const str = String(value).trim();
  if (!str) return null;

  // "2026-03-05 14:30:00" or "2026/03/05 14:30" or "2026.03.05 14:30:00"
  const dateTimeMatch = str.match(/^(\d{4})[-/.]+(\d{1,2})[-/.]+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dateTimeMatch) {
    const [, y, m, d, h, min, sec] = dateTimeMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${(sec || "0").padStart(2, "0")}Z`;
  }

  // "2026-03-05" or "2026.03.05" or "2026/03/05"
  const dateMatch = str.match(/^(\d{4})[-/.]+(\d{1,2})[-/.]+(\d{1,2})/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00Z`;
  }

  // "03/05/2026" or "03-05-2026" (MM/DD/YYYY)
  const mdyMatch = str.match(/^(\d{1,2})[-/.]+(\d{1,2})[-/.]+(\d{4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00Z`;
  }

  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString();
  console.warn("[엑셀 파서] 날짜 파싱 실패:", str);
  return null;
}

export function exportOrdersToCSV(orders: Record<string, unknown>[], filename: string) {
  const ws = XLSX.utils.json_to_sheet(orders);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "발주서");
  XLSX.writeFile(wb, filename);
}
