import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { calcSettlementPrice, calcPlatformPrice, buildRateMap } from "@/lib/product-calculations";
import { COL, TOTAL_COLS, OUTPUT_DATA_START_ROW_INDEX } from "@/lib/smartstore-price-inventory";
import type { Product, CommissionRate, SmartstorePriceInventory } from "@/types/database";

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

    // 2. 스마트스토어 인벤토리 조회
    const inventoryRows: SmartstorePriceInventory[] = [];
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const ids = productIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("smartstore_price_inventory")
        .select("*")
        .in("product_id", ids);
      if (error) return NextResponse.json({ error: `스마트스토어 인벤토리 조회 실패: ${error.message}` }, { status: 400 });
      if (data) inventoryRows.push(...(data as SmartstorePriceInventory[]));
    }
    if (inventoryRows.length === 0) {
      return NextResponse.json({
        error: "선택한 상품에 매칭된 스마트스토어 행이 없습니다. 먼저 스마트스토어 일괄수정 엑셀을 임포트하세요.",
      }, { status: 404 });
    }

    // 3. 수수료 + 가격 계산
    const { data: rates, error: ratesErr } = await supabase.from("commission_rates").select("*");
    if (ratesErr) throw ratesErr;
    const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);

    const priceByProductId = new Map<string, number>();
    const noPriceProductIds: string[] = [];
    for (const p of products) {
      const settlement = calcSettlementPrice(p.lowest_price, p.margin_rate);
      const rate = (rateMap[p.category] ?? {}).smartstore ?? 0;
      let computed: number | null = null;
      if (p.fixed_price_smartstore != null) {
        computed = p.fixed_price_smartstore;
      } else if (rate > 0) {
        computed = calcPlatformPrice(settlement, rate);
      } else {
        // 수수료율도 고정가도 없음 → 원가(최저가) 판매 방지: 제외 + 경고
        noPriceProductIds.push(p.id);
        continue;
      }
      // 스마트스토어는 10원 단위 (calcPlatformPrice 100원 단위로 이미 충족하지만 fixed_price인 경우 보장)
      computed = Math.ceil(computed / 10) * 10;
      priceByProductId.set(p.id, computed);
    }
    if (noPriceProductIds.length > 0) {
      console.warn(`[smartstore-price-inventory/export] 수수료율·고정가 없어 제외된 상품 ${noPriceProductIds.length}개 (원가 판매 방지)`);
    }

    const matchedProductIds = new Set(inventoryRows.map(r => r.product_id).filter((x): x is string => !!x));
    const skippedProductIds = productIds.filter(id => !matchedProductIds.has(id));

    // 4. 템플릿 로드 (exceljs)
    const templatePath = path.join(process.cwd(), "lib", "templates", "smartstore-price-inventory.xlsx");
    const templateBuf = await fs.readFile(templatePath);
    const wb = new ExcelJS.Workbook();
    const ab = templateBuf.buffer.slice(templateBuf.byteOffset, templateBuf.byteOffset + templateBuf.byteLength);
    await wb.xlsx.load(ab as ArrayBuffer);
    const ws = wb.worksheets[0];

    // 5. 시트행 1~2(그룹헤더+컬럼명)만 유지하고 그 아래(가이드 3~5행 + 기존 데이터 412행)는 모두 정리
    //    양식 안내: "파일업로드 시 3~5행의 작성가이드는 삭제하시기 바랍니다."
    while (ws.rowCount > 2) {
      ws.spliceRows(ws.rowCount, 1);
    }

    // 6. smartstore_product_id 중복 제거
    const seenIds = new Set<string>();
    const rowsWithPrice = inventoryRows
      .filter(r => r.product_id && priceByProductId.has(r.product_id))
      .filter(r => {
        const sid = (r.smartstore_product_id ?? "").trim();
        if (!sid) return false;
        if (seenIds.has(sid)) return false;
        seenIds.add(sid);
        return true;
      });

    // 7. 시트행 3(OUTPUT_DATA_START_ROW_INDEX=2, 0-based)부터 raw_row 복원 + F열만 새 가격
    rowsWithPrice.forEach((row, i) => {
      const sheetRowNumber = OUTPUT_DATA_START_ROW_INDEX + 1 + i; // 1-based
      const xRow = ws.getRow(sheetRowNumber);
      const newPrice = priceByProductId.get(row.product_id!);

      for (let c = 0; c < TOTAL_COLS; c++) {
        const cell = xRow.getCell(c + 1); // 1-based
        if (c === COL.sale_price) {
          // F열만 새 가격으로 교체
          cell.value = newPrice ?? null;
        } else if (c === COL.smartstore_product_id) {
          // A열 상품번호는 반드시 text로 (지수표기 방지)
          const v = row.raw_row[String(c)];
          cell.value = v ? String(v) : null;
        } else {
          const v = row.raw_row[String(c)];
          if (v == null || v === "") {
            cell.value = null;
          } else {
            // 숫자 형태로 보이는 값은 number로, 아니면 string. 단, A열·코드 등은 위에서 처리됨.
            const trimmed = String(v).trim();
            // 옵션값/판매자코드 등은 string으로 유지가 안전 → 모두 string으로
            cell.value = trimmed;
          }
        }
      }
      xRow.commit();
    });

    // 8. base64 출력
    const buf = await wb.xlsx.writeBuffer();
    const out = Buffer.from(buf).toString("base64");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `스마트스토어_가격수정_v2_${today}.xlsx`;

    console.log(`[smartstore-price-inventory/export] 완료: ${rowsWithPrice.length}행, skipped ${skippedProductIds.length}개 상품`);

    return NextResponse.json({
      excelBase64: out,
      filename,
      rowCount: rowsWithPrice.length,
      skippedProductIds,
    });
  } catch (err) {
    console.error("[smartstore-price-inventory/export] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "스마트스토어 가격수정 v2 내보내기 실패" }, { status: 500 });
  }
}
