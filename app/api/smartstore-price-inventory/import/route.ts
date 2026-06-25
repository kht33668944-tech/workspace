import { NextRequest, NextResponse } from "next/server";
import XLSX from "xlsx-js-style";
import { getAccessToken, getSupabaseClient, fetchAllRows } from "@/lib/api-helpers";
import {
  COL,
  TOTAL_COLS,
  HEADER_COL_ROW_INDEX,
  DATA_START_ROW_INDEX,
  cellString,
  cellInt,
  normalizeName,
} from "@/lib/smartstore-price-inventory";
import type { SmartstorePriceInventoryInsert } from "@/types/database";

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

    // 스마트스토어 양식은 A열에 매우 긴 정수 상품번호가 있어 number로 읽으면 정확도 손실.
    // raw:false로 셀의 텍스트(formatted) 값을 받는다.
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return NextResponse.json({ error: "엑셀 시트를 찾을 수 없습니다." }, { status: 400 });

    // !ref가 잘려있을 수 있어 실제 셀 키로 재계산
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

    // raw:false로 셀 텍스트 받기 (A열 지수표기 방지)
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "", raw: false });
    if (aoa.length <= DATA_START_ROW_INDEX) {
      return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    }

    // 헤더 검증 (시트행 2 = 0-based 1)
    const headerRow = (aoa[HEADER_COL_ROW_INDEX] ?? []).map(c => cellString(c));
    const headerJoined = headerRow.join("|");
    const missing: string[] = [];
    if (!headerJoined.includes("상품번호")) missing.push("상품번호");
    if (!headerJoined.includes("상품명")) missing.push("상품명");
    if (!headerJoined.includes("판매가")) missing.push("판매가");
    if (missing.length > 0) {
      return NextResponse.json({
        error: `필수 컬럼을 찾을 수 없습니다: ${missing.join(", ")}. 스마트스토어 센터에서 받은 상품 일괄수정 엑셀인지 확인하세요.`,
      }, { status: 400 });
    }

    // 시트행 3~5(가이드)는 스킵하고 시트행 6(0-based 5)부터 데이터
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

    const inserts: SmartstorePriceInventoryInsert[] = [];
    const unmatchedSet = new Set<string>();
    let matchedRowCount = 0;
    let optionRowCount = 0; // 옵션형태 ≠ 설정안함

    for (const row of dataRows) {
      const smartstoreProductId = cellString(row[COL.smartstore_product_id]);
      if (!smartstoreProductId) continue; // A열 없는 빈 행 스킵

      const productName = cellString(row[COL.product_name]);
      const productId = productMap.get(normalizeName(productName)) ?? null;
      if (productId) {
        matchedRowCount++;
      } else if (productName) {
        unmatchedSet.add(productName);
      }

      const optionType = cellString(row[COL.option_type]);
      if (optionType && optionType !== "설정안함") optionRowCount++;

      // 94컬럼 raw 값을 모두 string으로 보존
      const rawRow: Record<string, string> = {};
      for (let i = 0; i < TOTAL_COLS; i++) {
        const v = row[i];
        if (v != null && v !== "") rawRow[String(i)] = String(v);
      }

      inserts.push({
        user_id: userId,
        product_id: productId,
        smartstore_product_id: smartstoreProductId,
        seller_product_code: cellString(row[COL.seller_product_code]) || null,
        category_code: cellString(row[COL.category_code]) || null,
        product_name: productName || null,
        product_status: cellString(row[COL.product_status]) || null,
        sale_price: cellInt(row[COL.sale_price]),
        option_type: optionType || null,
        raw_row: rawRow,
      });
    }

    if (inserts.length === 0) {
      return NextResponse.json({ error: "상품번호가 있는 행이 없습니다." }, { status: 400 });
    }

    let upsertedCount = 0;
    for (let i = 0; i < inserts.length; i += UPSERT_CHUNK) {
      const chunk = inserts.slice(i, i + UPSERT_CHUNK);
      const { error: upErr, count } = await supabase
        .from("smartstore_price_inventory")
        .upsert(chunk, { onConflict: "user_id,smartstore_product_id", count: "exact" });
      if (upErr) {
        console.error(`[smartstore-price-inventory/import] upsert 실패 (${i}~${i + chunk.length}):`, upErr.message);
        return NextResponse.json({ error: `DB 저장 실패: ${upErr.message}` }, { status: 500 });
      }
      upsertedCount += count ?? chunk.length;
    }

    console.log(`[smartstore-price-inventory/import] 완료: ${inserts.length}행, 매칭 ${matchedRowCount}, 미매칭 ${unmatchedSet.size}, 옵션상품 ${optionRowCount}`);

    return NextResponse.json({
      total: inserts.length,
      rowsUpserted: upsertedCount,
      matched: matchedRowCount,
      unmatchedProductNames: [...unmatchedSet],
      optionRowCount,
    });
  } catch (err) {
    console.error("[smartstore-price-inventory/import] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "스마트스토어 양식 임포트 실패" }, { status: 500 });
  }
}
