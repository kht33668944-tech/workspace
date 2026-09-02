import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { toKstDateKey } from "@/lib/date-utils";
import { buildRateMap } from "@/lib/product-calculations";
import { computeCoupangTargetPrice } from "@/lib/marketplace-api-helpers";
import { COL, DATA_START_ROW_INDEX } from "@/lib/coupang-price-inventory";
import type { Product, CommissionRate, CoupangPriceInventory } from "@/types/database";

export const maxDuration = 60;

const MAX_PRODUCTS = 5000;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { productIds } = await request.json() as { productIds?: string[] };
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return NextResponse.json({ error: "productIds가 비었습니다." }, { status: 400 });
    }
    if (productIds.length > MAX_PRODUCTS) {
      return NextResponse.json({ error: `최대 ${MAX_PRODUCTS}개 상품까지 처리 가능합니다.` }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);

    // 1. 상품 조회 (청크 200)
    const CHUNK = 200;
    const products: Product[] = [];
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const ids = productIds.slice(i, i + CHUNK);
      const { data, error } = await supabase.from("products").select("*").in("id", ids);
      if (error) return NextResponse.json({ error: `상품 조회 실패: ${error.message}` }, { status: 400 });
      if (data) products.push(...(data as Product[]));
    }
    if (products.length === 0) {
      return NextResponse.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });
    }

    // 2. 쿠팡 옵션 행 조회 (product_id IN)
    const inventoryRows: CoupangPriceInventory[] = [];
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const ids = productIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("coupang_price_inventory")
        .select("*")
        .in("product_id", ids);
      if (error) return NextResponse.json({ error: `쿠팡 옵션 조회 실패: ${error.message}` }, { status: 400 });
      if (data) inventoryRows.push(...(data as CoupangPriceInventory[]));
    }
    if (inventoryRows.length === 0) {
      return NextResponse.json({
        error: "선택한 상품에 매칭된 쿠팡 옵션 행이 없습니다. 먼저 쿠팡 양식을 임포트하세요.",
      }, { status: 404 });
    }

    // 3. 수수료 조회 + 가격 맵 빌드
    const { data: rates, error: ratesErr } = await supabase.from("commission_rates").select("*");
    if (ratesErr) throw ratesErr;
    const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);

    // 4. product_id → 쿠팡 판매가 계산
    const priceByProductId = new Map<string, number>();
    const noPriceProductIds: string[] = [];
    for (const p of products) {
      // API apply 경로와 동일 계산(고정가 10원 올림 포함) — 엑셀과 API가 다른 가격을 보내지 않도록 헬퍼 공유
      const price = computeCoupangTargetPrice(p, rateMap);
      if (price != null && price > 0) {
        priceByProductId.set(p.id, price);
      } else {
        // 수수료율도 고정가도 없음 → 원가(최저가) 판매 방지: 제외 + 경고
        noPriceProductIds.push(p.id);
      }
    }
    if (noPriceProductIds.length > 0) {
      console.warn(`[coupang-price-inventory/export] 수수료율·고정가 없어 제외된 상품 ${noPriceProductIds.length}개 (원가 판매 방지)`);
    }

    const matchedProductIds = new Set(inventoryRows.map(r => r.product_id).filter((x): x is string => !!x));
    const skippedProductIds = productIds.filter(id => !matchedProductIds.has(id));

    // 5. 템플릿 .xlsx 로드 (exceljs는 스타일·데이터검증·병합·시트보호를 모두 보존)
    const templatePath = path.join(process.cwd(), "lib", "templates", "coupang-price-inventory.xlsx");
    const templateBuf = await fs.readFile(templatePath);
    const wb = new ExcelJS.Workbook();
    // Buffer → ArrayBuffer (exceljs.load는 ArrayBuffer/Uint8Array 호환)
    const ab = templateBuf.buffer.slice(templateBuf.byteOffset, templateBuf.byteOffset + templateBuf.byteLength);
    await wb.xlsx.load(ab as ArrayBuffer);
    const ws = wb.worksheets[0];

    // 템플릿 .xlsx는 1~3행(안내·헤더)만 유지하고 4행 이후의 기존 데이터를 모두 제거
    // (쿠팡 셀러센터에서 받은 양식에 본인 상품이 미리 채워져 있을 수 있어 그대로 두면 중복 검증 에러)
    while (ws.rowCount > 3) {
      ws.spliceRows(ws.rowCount, 1);
    }

    // 6. 4행부터 데이터 채우기 (exceljs는 1-based row/col 인덱스)
    //    쿠팡은 같은 vendor_item_id가 여러 행에 있으면 거부 → 첫 행만 남기고 중복 제거
    const seenVendorItemIds = new Set<string>();
    const rowsWithPrice = inventoryRows
      .filter(r => r.product_id && priceByProductId.has(r.product_id))
      .filter(r => {
        const vid = (r.vendor_item_id ?? "").trim();
        if (!vid) return true; // vendor_item_id 비어있으면 그대로 통과 (드문 케이스)
        if (seenVendorItemIds.has(vid)) return false;
        seenVendorItemIds.add(vid);
        return true;
      });
    rowsWithPrice.forEach((row, i) => {
      const rowNumber = DATA_START_ROW_INDEX + 1 + i; // 0-based DATA_START_ROW_INDEX=3 → 4행
      const xRow = ws.getRow(rowNumber);
      const setVal = (col0: number, value: string | number | null) => {
        const cell = xRow.getCell(col0 + 1); // 0-based → 1-based
        if (value == null || value === "") {
          cell.value = null;
        } else {
          cell.value = value;
        }
      };
      setVal(COL.vendor_item_id, row.vendor_item_id);
      setVal(COL.coupang_product_id, row.coupang_product_id);
      setVal(COL.option_id, row.option_id);
      setVal(COL.product_status, row.product_status);
      setVal(COL.barcode, row.barcode);
      setVal(COL.vendor_item_code, row.vendor_item_code);
      setVal(COL.coupang_display_name, row.coupang_display_name);
      setVal(COL.registered_name, row.registered_name);
      setVal(COL.option_name, row.option_name);
      setVal(COL.sale_price, row.sale_price);
      setVal(COL.discount_base_price, row.discount_base_price);
      setVal(COL.sale_status, row.sale_status);
      setVal(COL.stock, row.stock);
      setVal(COL.sales_count, row.sales_count);
      setVal(COL.approval_status, row.approval_status);
      const newPrice = priceByProductId.get(row.product_id!);
      if (newPrice != null) {
        setVal(COL.new_sale_price, newPrice);
        setVal(COL.new_discount_base, newPrice);
      }
      xRow.commit();
    });

    // 7. base64 출력
    const buf = await wb.xlsx.writeBuffer();
    const out = Buffer.from(buf).toString("base64");
    const today = toKstDateKey().replace(/-/g, "");
    const filename = `쿠팡_가격수정_v2_${today}.xlsx`;

    console.log(`[coupang-price-inventory/export] 완료(exceljs): ${rowsWithPrice.length}행, skipped ${skippedProductIds.length}개 상품`);

    return NextResponse.json({
      excelBase64: out,
      filename,
      rowCount: rowsWithPrice.length,
      skippedProductIds,
    });
  } catch (err) {
    console.error("[coupang-price-inventory/export] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "쿠팡 가격수정 v2 내보내기 실패" }, { status: 500 });
  }
}
