import { NextRequest, NextResponse } from "next/server";
import XLSX from "xlsx-js-style";
import { getAccessToken, getSupabaseClient, fetchAllRows } from "@/lib/api-helpers";
import {
  DATA_COL,
  DATA_HEADER_ROW_INDEX,
  DATA_START_ROW_INDEX,
  cellString,
  cellInt,
  normalizeName,
} from "@/lib/esm-price-inventory";
import type { EsmPriceInventoryInsert } from "@/types/database";

export const maxDuration = 60;

const MAX_EXCEL_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROWS = 10000;
const UPSERT_CHUNK = 500;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { excelBase64 } = await request.json() as { excelBase64?: string };
    if (!excelBase64) return NextResponse.json({ error: "엑셀 데이터가 없습니다." }, { status: 400 });
    if (excelBase64.length > MAX_EXCEL_SIZE * 1.37) {
      return NextResponse.json({ error: "파일 크기가 초과되었습니다 (최대 5MB)." }, { status: 400 });
    }

    const buffer = Buffer.from(excelBase64, "base64");
    if (buffer.length > MAX_EXCEL_SIZE) {
      return NextResponse.json({ error: "파일 크기가 초과되었습니다 (최대 5MB)." }, { status: 400 });
    }

    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return NextResponse.json({ error: "엑셀 시트를 찾을 수 없습니다." }, { status: 400 });

    // ESM 다운로드 엑셀도 !ref가 잘려있을 수 있어 실제 셀 키로 범위 재계산
    const cellKeys = Object.keys(ws).filter(k => !k.startsWith("!"));
    if (cellKeys.length > 0) {
      let maxR = 0, maxC = 0;
      for (const k of cellKeys) {
        const decoded = XLSX.utils.decode_cell(k);
        if (decoded.r > maxR) maxR = decoded.r;
        if (decoded.c > maxC) maxC = decoded.c;
      }
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    }

    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
    if (aoa.length <= DATA_START_ROW_INDEX) {
      return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    }

    // 헤더 검증 (1행)
    const headerRow = (aoa[DATA_HEADER_ROW_INDEX] ?? []).map(c => cellString(c));
    const headerJoined = headerRow.join("|");
    const missing: string[] = [];
    if (!headerJoined.includes("상품번호")) missing.push("상품번호");
    if (!headerJoined.includes("상품명")) missing.push("상품명");
    if (!headerJoined.includes("사이트")) missing.push("사이트");
    if (missing.length > 0) {
      return NextResponse.json({
        error: `필수 컬럼을 찾을 수 없습니다: ${missing.join(", ")}. ESM Plus에서 받은 상품목록 엑셀인지 확인하세요. (가격대량수정 양식이 아닙니다)`,
      }, { status: 400 });
    }

    const dataRows = aoa.slice(DATA_START_ROW_INDEX);
    if (dataRows.length === 0) {
      return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    }
    if (dataRows.length > MAX_ROWS) {
      return NextResponse.json({ error: `최대 ${MAX_ROWS}행까지 처리 가능합니다.` }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    // 상품명 → product_id 매핑 (1000행 초과 누락 방지: 전건 페이지네이션)
    const products = await fetchAllRows<{ id: string; product_name: string }>(
      (from, to) => supabase
        .from("products")
        .select("id, product_name")
        .eq("user_id", userId)
        .range(from, to),
    );
    const productMap = new Map<string, string>();
    for (const p of products) productMap.set(normalizeName(p.product_name), p.id);

    // 행 → upsert payload 변환
    const inserts: EsmPriceInventoryInsert[] = [];
    const unmatchedSet = new Set<string>();
    let matchedRowCount = 0;

    for (const row of dataRows) {
      const siteProductId = cellString(row[DATA_COL.site_product_id]);
      if (!siteProductId) continue; // 상품번호 없는 행 스킵

      const productName = cellString(row[DATA_COL.product_name]);
      const productId = productMap.get(normalizeName(productName)) ?? null;
      if (productId) {
        matchedRowCount++;
      } else if (productName) {
        unmatchedSet.add(productName);
      }

      inserts.push({
        user_id: userId,
        product_id: productId,
        master_product_id: cellString(row[DATA_COL.master_product_id]) || null,
        site_product_id: siteProductId,
        site: cellString(row[DATA_COL.site]) || null,
        product_name: productName || null,
        seller_code: cellString(row[DATA_COL.seller_code]) || null,
        seller_id: cellString(row[DATA_COL.seller_id]) || null,
        sale_status: cellString(row[DATA_COL.sale_status]) || null,
        sale_price: cellInt(row[DATA_COL.sale_price]),
        stock: cellInt(row[DATA_COL.stock]),
        category: cellString(row[DATA_COL.category]) || null,
        site_category: cellString(row[DATA_COL.site_category]) || null,
      });
    }

    if (inserts.length === 0) {
      return NextResponse.json({ error: "상품번호가 있는 행이 없습니다." }, { status: 400 });
    }

    // 청크 단위 upsert
    let upsertedCount = 0;
    for (let i = 0; i < inserts.length; i += UPSERT_CHUNK) {
      const chunk = inserts.slice(i, i + UPSERT_CHUNK);
      const { error: upErr, count } = await supabase
        .from("esm_price_inventory")
        .upsert(chunk, { onConflict: "user_id,site_product_id", count: "exact" });
      if (upErr) {
        console.error(`[esm-price-inventory/import] upsert 실패 (${i}~${i + chunk.length}):`, upErr.message);
        return NextResponse.json({ error: `DB 저장 실패: ${upErr.message}` }, { status: 500 });
      }
      upsertedCount += count ?? chunk.length;
    }

    console.log(`[esm-price-inventory/import] 완료: ${inserts.length}행, 매칭 ${matchedRowCount}, 미매칭 상품명 ${unmatchedSet.size}`);

    return NextResponse.json({
      total: inserts.length,
      rowsUpserted: upsertedCount,
      matched: matchedRowCount,
      unmatchedProductNames: [...unmatchedSet],
    });
  } catch (err) {
    console.error("[esm-price-inventory/import] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "ESM 양식 임포트 실패" }, { status: 500 });
  }
}
