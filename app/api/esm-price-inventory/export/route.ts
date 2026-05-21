import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { calcSettlementPrice, calcPlatformPrice, buildRateMap } from "@/lib/product-calculations";
import { TEMPLATE_COL, TEMPLATE_DATA_START_ROW_INDEX } from "@/lib/esm-price-inventory";
import type { Product, CommissionRate, EsmPriceInventory } from "@/types/database";

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

    // 2. ESM 인벤토리 행 조회
    const inventoryRows: EsmPriceInventory[] = [];
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const ids = productIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("esm_price_inventory")
        .select("*")
        .in("product_id", ids);
      if (error) return NextResponse.json({ error: `ESM 인벤토리 조회 실패: ${error.message}` }, { status: 400 });
      if (data) inventoryRows.push(...(data as EsmPriceInventory[]));
    }
    if (inventoryRows.length === 0) {
      return NextResponse.json({
        error: "선택한 상품에 매칭된 옥션·지마켓 행이 없습니다. 먼저 ESM 상품목록 엑셀을 임포트하세요.",
      }, { status: 404 });
    }

    // 3. 수수료 + 가격 계산
    const { data: rates } = await supabase.from("commission_rates").select("*");
    const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);

    const priceByProductId = new Map<string, number>();
    for (const p of products) {
      const settlement = calcSettlementPrice(p.lowest_price, p.margin_rate);
      const rate = (rateMap[p.category] ?? {}).esm ?? 0;
      const computed = p.fixed_price_esm != null
        ? p.fixed_price_esm
        : (rate > 0 ? calcPlatformPrice(settlement, rate) : p.lowest_price);
      priceByProductId.set(p.id, computed);
    }

    const matchedProductIds = new Set(inventoryRows.map(r => r.product_id).filter((x): x is string => !!x));
    const skippedProductIds = productIds.filter(id => !matchedProductIds.has(id));

    // 4. 템플릿 .xlsx 로드 — 안내문/헤더/예시 행/병합 보존
    const templatePath = path.join(process.cwd(), "lib", "templates", "esm-price-inventory.xlsx");
    const templateBuf = await fs.readFile(templatePath);
    const wb = new ExcelJS.Workbook();
    const ab = templateBuf.buffer.slice(templateBuf.byteOffset, templateBuf.byteOffset + templateBuf.byteLength);
    await wb.xlsx.load(ab as ArrayBuffer);
    const ws = wb.worksheets[0];

    // 5. 6행부터의 기존 데이터(빈 행번호 1,2,3,... 포함) 정리
    // 1~5행만 유지 (안내·헤더·필수·설명·예시)
    while (ws.rowCount > 5) {
      ws.spliceRows(ws.rowCount, 1);
    }

    // 6. site_product_id 중복 제거 후 6행부터 채우기
    //    같은 site_product_id가 여러 번 임포트되었을 가능성에 대비
    const seenSiteProductIds = new Set<string>();
    const rowsWithPrice = inventoryRows
      .filter(r => r.product_id && priceByProductId.has(r.product_id))
      .filter(r => {
        const sid = (r.site_product_id ?? "").trim();
        if (!sid) return false;
        if (seenSiteProductIds.has(sid)) return false;
        seenSiteProductIds.add(sid);
        return true;
      });

    rowsWithPrice.forEach((row, i) => {
      const rowNumber = TEMPLATE_DATA_START_ROW_INDEX + 1 + i; // 0-based 5 → 6행
      const xRow = ws.getRow(rowNumber);
      const newPrice = priceByProductId.get(row.product_id!);
      xRow.getCell(TEMPLATE_COL.row_number + 1).value = i + 1;
      xRow.getCell(TEMPLATE_COL.site_product_id + 1).value = row.site_product_id;
      xRow.getCell(TEMPLATE_COL.sale_price + 1).value = newPrice ?? null;
      xRow.commit();
    });

    // 7. base64 출력
    const buf = await wb.xlsx.writeBuffer();
    const out = Buffer.from(buf).toString("base64");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `옥션지마켓_가격수정_v2_${today}.xlsx`;

    console.log(`[esm-price-inventory/export] 완료: ${rowsWithPrice.length}행, skipped ${skippedProductIds.length}개 상품`);

    return NextResponse.json({
      excelBase64: out,
      filename,
      rowCount: rowsWithPrice.length,
      skippedProductIds,
    });
  } catch (err) {
    console.error("[esm-price-inventory/export] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "옥션·지마켓 가격수정 v2 내보내기 실패" }, { status: 500 });
  }
}
