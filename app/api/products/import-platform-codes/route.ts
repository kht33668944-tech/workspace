import { NextRequest, NextResponse } from "next/server";
import XLSX from "xlsx-js-style";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { excelBase64 } = await request.json() as { excelBase64: string };
    if (!excelBase64) return NextResponse.json({ error: "엑셀 데이터가 없습니다." }, { status: 400 });

    const supabase = getSupabaseClient(token);

    // 1. 엑셀 파싱
    const buffer = Buffer.from(excelBase64, "base64");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });

    if (rows.length === 0) return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });

    // 2. 헤더 검증
    const firstRow = rows[0];
    const keys = Object.keys(firstRow);
    const nameCol = keys.find(k => k.includes("온라인 상품명") || k === "온라인 상품명");
    const accountCol = keys.find(k => k.includes("쇼핑몰(계정)") || k === "쇼핑몰(계정)");
    const codeCol = keys.find(k => k.includes("쇼핑몰 상품번호") || k === "쇼핑몰 상품번호");

    if (!nameCol || !accountCol || !codeCol) {
      return NextResponse.json({
        error: "필수 컬럼을 찾을 수 없습니다. '온라인 상품명', '쇼핑몰(계정)', '쇼핑몰 상품번호' 컬럼이 필요합니다.",
      }, { status: 400 });
    }

    // 3. 사용자 상품 조회
    const { data: products, error: fetchErr } = await supabase
      .from("products")
      .select("id, product_name, platform_codes");
    if (fetchErr) throw fetchErr;

    // 상품명 → product Map
    const productMap = new Map<string, { id: string; platform_codes: Record<string, string> | null }>();
    for (const p of products ?? []) {
      productMap.set(p.product_name, { id: p.id, platform_codes: p.platform_codes });
    }

    // 4. 엑셀 행 처리 — 상품별로 코드 병합
    const updates = new Map<string, { id: string; platform_codes: Record<string, string> }>();
    const unmatchedNames = new Set<string>();

    for (const row of rows) {
      const productName = String(row[nameCol]).trim();
      const account = String(row[accountCol]).trim();
      const code = String(row[codeCol]).trim();

      if (!productName || !account || !code) continue;

      const product = productMap.get(productName);
      if (!product) {
        unmatchedNames.add(productName);
        continue;
      }

      const existing = updates.get(product.id) ?? {
        id: product.id,
        platform_codes: { ...(product.platform_codes ?? {}) },
      };
      existing.platform_codes[account] = code;
      updates.set(product.id, existing);
    }

    // 5. DB 일괄 업데이트
    let matched = 0;
    for (const { id, platform_codes } of updates.values()) {
      const { error: updateErr } = await supabase
        .from("products")
        .update({ platform_codes })
        .eq("id", id);
      if (updateErr) {
        console.error(`[import-platform-codes] 업데이트 실패 (${id}):`, updateErr.message);
      } else {
        matched++;
      }
    }

    console.log(`[import-platform-codes] 완료: ${matched}개 매칭, ${unmatchedNames.size}개 미매칭`);

    return NextResponse.json({
      matched,
      unmatched: [...unmatchedNames],
      total: rows.length,
    });
  } catch (err) {
    console.error("[import-platform-codes] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "플랫폼 코드 가져오기 실패" }, { status: 500 });
  }
}
