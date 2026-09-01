import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { toKstDateKey } from "@/lib/date-utils";
import { calcSettlementPrice, calcPlatformPrice, buildRateMap } from "@/lib/product-calculations";
import { TEMPLATE_COL, TEMPLATE_DATA_START_ROW_INDEX } from "@/lib/esm-price-inventory";
import type { Product, CommissionRate, EsmPriceInventory } from "@/types/database";

export const maxDuration = 60;

const MAX_PRODUCTS = 5000;
// ESM Plus "판매가 엑셀 일괄 변경"은 파일당 최대 500행
const MAX_ROWS_PER_FILE = 500;

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
    const { data: rates, error: ratesErr } = await supabase.from("commission_rates").select("*");
    if (ratesErr) throw ratesErr;
    const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);

    const priceByProductId = new Map<string, number>();
    const noPriceProductIds: string[] = [];
    for (const p of products) {
      const settlement = calcSettlementPrice(p.lowest_price, p.margin_rate);
      const rate = (rateMap[p.category] ?? {}).esm ?? 0;
      if (p.fixed_price_esm != null) {
        priceByProductId.set(p.id, p.fixed_price_esm);
      } else if (rate > 0) {
        priceByProductId.set(p.id, calcPlatformPrice(settlement, rate));
      } else {
        // 수수료율도 고정가도 없음 → 원가(최저가) 판매 방지: 제외 + 경고
        noPriceProductIds.push(p.id);
      }
    }
    if (noPriceProductIds.length > 0) {
      console.warn(`[esm-price-inventory/export] 수수료율·고정가 없어 제외된 상품 ${noPriceProductIds.length}개 (원가 판매 방지)`);
    }

    const matchedProductIds = new Set(inventoryRows.map(r => r.product_id).filter((x): x is string => !!x));
    const skippedProductIds = productIds.filter(id => !matchedProductIds.has(id));

    // 4. site_product_id 중복 제거 + 가격이 산정된 행만 남기기
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

    if (rowsWithPrice.length === 0) {
      return NextResponse.json({
        error: "내보낼 옥션·지마켓 행이 없습니다.",
      }, { status: 404 });
    }

    // 5. 템플릿 버퍼 미리 로드 (청크마다 새 워크북에 로드)
    const templatePath = path.join(process.cwd(), "lib", "templates", "esm-price-inventory.xlsx");
    const templateBuf = await fs.readFile(templatePath);

    const today = toKstDateKey().replace(/-/g, "");
    const totalFiles = Math.ceil(rowsWithPrice.length / MAX_ROWS_PER_FILE);
    const files: Array<{ excelBase64: string; filename: string; rowCount: number }> = [];

    // 6. 500행씩 청크로 나누어 파일 생성
    for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
      const start = fileIdx * MAX_ROWS_PER_FILE;
      const chunkRows = rowsWithPrice.slice(start, start + MAX_ROWS_PER_FILE);

      const wb = new ExcelJS.Workbook();
      const ab = templateBuf.buffer.slice(templateBuf.byteOffset, templateBuf.byteOffset + templateBuf.byteLength);
      await wb.xlsx.load(ab as ArrayBuffer);
      const ws = wb.worksheets[0];

      // 1~5행만 유지 (안내·헤더·필수·설명·예시), 6행 이하 기존 행 제거
      while (ws.rowCount > 5) {
        ws.spliceRows(ws.rowCount, 1);
      }

      chunkRows.forEach((row, i) => {
        const rowNumber = TEMPLATE_DATA_START_ROW_INDEX + 1 + i; // 0-based 5 → 6행
        const xRow = ws.getRow(rowNumber);
        const newPrice = priceByProductId.get(row.product_id!);
        xRow.getCell(TEMPLATE_COL.row_number + 1).value = i + 1;
        xRow.getCell(TEMPLATE_COL.site_product_id + 1).value = row.site_product_id;
        xRow.getCell(TEMPLATE_COL.sale_price + 1).value = newPrice ?? null;
        xRow.commit();
      });

      const buf = await wb.xlsx.writeBuffer();
      const out = Buffer.from(buf).toString("base64");
      const suffix = totalFiles > 1 ? `_${fileIdx + 1}of${totalFiles}` : "";
      const filename = `옥션지마켓_가격수정_v2_${today}${suffix}.xlsx`;
      files.push({ excelBase64: out, filename, rowCount: chunkRows.length });
    }

    console.log(`[esm-price-inventory/export] 완료: ${rowsWithPrice.length}행, ${files.length}개 파일, skipped ${skippedProductIds.length}개 상품`);

    return NextResponse.json({
      files,
      // 호환성: 단일 파일이면 기존 필드도 유지
      excelBase64: files.length === 1 ? files[0].excelBase64 : undefined,
      filename: files.length === 1 ? files[0].filename : undefined,
      rowCount: rowsWithPrice.length,
      fileCount: files.length,
      skippedProductIds,
    });
  } catch (err) {
    console.error("[esm-price-inventory/export] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "옥션·지마켓 가격수정 v2 내보내기 실패" }, { status: 500 });
  }
}
