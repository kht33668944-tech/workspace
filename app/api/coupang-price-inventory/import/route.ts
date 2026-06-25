import { NextRequest, NextResponse } from "next/server";
import XLSX from "xlsx-js-style";
import { getAccessToken, getSupabaseClient, fetchAllRows } from "@/lib/api-helpers";
import {
  COL,
  HEADER_ROW_INDEX,
  DATA_START_ROW_INDEX,
  cellString,
  cellInt,
  normalizeName,
} from "@/lib/coupang-price-inventory";
import type { CoupangPriceInventoryInsert } from "@/types/database";

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

    // 쿠팡 양식은 !ref가 헤더 행까지만 잘려있는 경우가 있어 실제 셀 키로 범위 재계산
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

    // 2D 배열로 읽음 (header=1) — 3행을 헤더로, 4행부터 데이터
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
    if (aoa.length <= DATA_START_ROW_INDEX) {
      return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    }

    // 헤더 검증 (3행 일부 키워드만 확인)
    const headerRow = (aoa[HEADER_ROW_INDEX] ?? []).map(c => cellString(c));
    const headerJoined = headerRow.join("|");
    const missing: string[] = [];
    if (!headerJoined.includes("옵션 ID")) missing.push("옵션 ID");
    if (!headerJoined.includes("업체 등록 상품명")) missing.push("업체 등록 상품명");
    if (missing.length > 0) {
      return NextResponse.json({
        error: `필수 컬럼을 찾을 수 없습니다: ${missing.join(", ")}. 쿠팡 셀러센터에서 받은 가격수정 양식인지 확인하세요.`,
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

    // 사용자 정보 — RLS와 일치하는 user_id 확보
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
    for (const p of products) {
      productMap.set(normalizeName(p.product_name), p.id);
    }

    // 행 → upsert payload 변환
    const inserts: CoupangPriceInventoryInsert[] = [];
    const unmatchedSet = new Set<string>();
    let matchedRowCount = 0;

    for (const row of dataRows) {
      const optionId = cellString(row[COL.option_id]);
      if (!optionId) continue; // 옵션ID 없는 행 스킵

      const displayName = cellString(row[COL.coupang_display_name]);
      const registeredName = cellString(row[COL.registered_name]);
      // 매칭은 H열 '업체 등록 상품명'으로 (사용자가 직접 등록한 이름) — G열은 쿠팡이 자동 변형한 노출용
      const productId = productMap.get(normalizeName(registeredName)) ?? null;
      if (productId) {
        matchedRowCount++;
      } else if (registeredName) {
        unmatchedSet.add(registeredName);
      }

      inserts.push({
        user_id: userId,
        product_id: productId,
        vendor_item_id: cellString(row[COL.vendor_item_id]) || null,
        coupang_product_id: cellString(row[COL.coupang_product_id]) || null,
        option_id: optionId,
        product_status: cellString(row[COL.product_status]) || null,
        barcode: cellString(row[COL.barcode]) || null,
        vendor_item_code: cellString(row[COL.vendor_item_code]) || null,
        coupang_display_name: displayName || null,
        registered_name: cellString(row[COL.registered_name]) || null,
        option_name: cellString(row[COL.option_name]) || null,
        sale_price: cellInt(row[COL.sale_price]),
        discount_base_price: cellInt(row[COL.discount_base_price]),
        sale_status: cellString(row[COL.sale_status]) || null,
        stock: cellInt(row[COL.stock]),
        sales_count: cellInt(row[COL.sales_count]),
        approval_status: cellString(row[COL.approval_status]) || null,
      });
    }

    if (inserts.length === 0) {
      return NextResponse.json({ error: "옵션 ID가 있는 행이 없습니다." }, { status: 400 });
    }

    // 청크 단위 upsert (option_id 기준)
    let upsertedCount = 0;
    for (let i = 0; i < inserts.length; i += UPSERT_CHUNK) {
      const chunk = inserts.slice(i, i + UPSERT_CHUNK);
      const { error: upErr, count } = await supabase
        .from("coupang_price_inventory")
        .upsert(chunk, { onConflict: "user_id,option_id", count: "exact" });
      if (upErr) {
        console.error(`[coupang-price-inventory/import] upsert 실패 (${i}~${i + chunk.length}):`, upErr.message);
        return NextResponse.json({ error: `DB 저장 실패: ${upErr.message}` }, { status: 500 });
      }
      upsertedCount += count ?? chunk.length;
    }

    console.log(`[coupang-price-inventory/import] 완료: ${inserts.length}행 처리, 매칭 ${matchedRowCount}행, 미매칭 상품 ${unmatchedSet.size}개`);

    return NextResponse.json({
      total: inserts.length,
      rowsUpserted: upsertedCount,
      matched: matchedRowCount,
      unmatchedProductNames: [...unmatchedSet],
    });
  } catch (err) {
    console.error("[coupang-price-inventory/import] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "쿠팡 양식 임포트 실패" }, { status: 500 });
  }
}
