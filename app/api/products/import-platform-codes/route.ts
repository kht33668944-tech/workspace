import { NextRequest, NextResponse } from "next/server";
import XLSX from "xlsx-js-style";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { excelBase64, overwrite } = await request.json() as { excelBase64: string; overwrite?: boolean };
    if (!excelBase64) return NextResponse.json({ error: "엑셀 데이터가 없습니다." }, { status: 400 });

    // 파일 크기 제한 (5MB)
    const MAX_EXCEL_SIZE = 5 * 1024 * 1024;
    if (excelBase64.length > MAX_EXCEL_SIZE * 1.37) {
      return NextResponse.json({ error: "파일 크기가 초과되었습니다 (최대 5MB)." }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);

    // 1. 엑셀 파싱
    const buffer = Buffer.from(excelBase64, "base64");
    if (buffer.length > MAX_EXCEL_SIZE) {
      return NextResponse.json({ error: "파일 크기가 초과되었습니다 (최대 5MB)." }, { status: 400 });
    }
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });

    const MAX_ROWS = 10000;
    if (rows.length === 0) return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    if (rows.length > MAX_ROWS) return NextResponse.json({ error: `최대 ${MAX_ROWS}행까지 처리 가능합니다.` }, { status: 400 });

    // 2. 헤더 검증
    const firstRow = rows[0];
    const keys = Object.keys(firstRow);
    const nameCol = keys.find(k => k.includes("온라인 상품명") || k === "온라인 상품명");
    const accountCol = keys.find(k => k.includes("쇼핑몰(계정)") || k === "쇼핑몰(계정)");
    const codeCol = keys.find(k => k.includes("쇼핑몰 상품번호") || k === "쇼핑몰 상품번호");
    const sellerCodeCol = keys.find(k => k.includes("판매자관리코드") || k === "판매자관리코드");

    if (!nameCol || !accountCol || !codeCol) {
      return NextResponse.json({
        error: "필수 컬럼을 찾을 수 없습니다. '온라인 상품명', '쇼핑몰(계정)', '쇼핑몰 상품번호' 컬럼이 필요합니다.",
      }, { status: 400 });
    }

    // 3. 사용자 상품 조회
    const { data: products, error: fetchErr } = await supabase
      .from("products")
      .select("id, product_name, platform_codes, seller_code");
    if (fetchErr) throw fetchErr;

    // 상품명 → product Map
    const productMap = new Map<string, { id: string; platform_codes: Record<string, string> | null; seller_code: Record<string, string> | null }>();
    for (const p of products ?? []) {
      productMap.set(p.product_name, { id: p.id, platform_codes: p.platform_codes, seller_code: p.seller_code as Record<string, string> | null });
    }

    // 쇼핑몰 계정 → seller_code 그룹 매핑
    const accountToSellerGroup = (account: string): string => {
      const lower = account.toLowerCase();
      if (lower.startsWith("스마트스토어")) return "smartstore";
      if (lower.startsWith("쿠팡")) return "coupang";
      return "esm";
    };

    // 4. 엑셀 행 처리 — 상품별로 코드 수집
    const updates = new Map<string, { id: string; platform_codes: Record<string, string>; seller_code: Record<string, string> | null }>();
    const unmatchedNames = new Set<string>();
    let duplicateCount = 0;

    for (const row of rows) {
      const productName = String(row[nameCol]).trim();
      const account = String(row[accountCol]).trim();
      const code = String(row[codeCol]).trim();
      const sellerCode = sellerCodeCol ? String(row[sellerCodeCol]).trim() : "";

      if (!productName || !account || !code) continue;

      const product = productMap.get(productName);
      if (!product) {
        unmatchedNames.add(productName);
        continue;
      }

      if (!updates.has(product.id)) {
        const hadExisting = product.platform_codes !== null && Object.keys(product.platform_codes).length > 0;
        if (hadExisting) duplicateCount++;
      }

      const existing = updates.get(product.id) ?? {
        id: product.id,
        platform_codes: overwrite ? {} : { ...(product.platform_codes ?? {}) },
        seller_code: overwrite ? null : (product.seller_code ? { ...product.seller_code } : null),
      };
      existing.platform_codes[account] = code;
      // 판매자관리코드를 해당 플랫폼 그룹에 저장
      if (sellerCode) {
        const group = accountToSellerGroup(account);
        if (!existing.seller_code) existing.seller_code = {};
        if (!existing.seller_code[group]) {
          existing.seller_code[group] = sellerCode;
        }
      }
      updates.set(product.id, existing);
    }

    // overwrite 미지정 + 중복 존재 → 확인 요청 (아직 DB 업데이트 안 함)
    if (duplicateCount > 0 && !overwrite) {
      return NextResponse.json({
        confirmOverwrite: true,
        duplicateCount,
        matched: updates.size,
        unmatched: [...unmatchedNames],
        total: rows.length,
      });
    }

    // 5. DB 배치 업데이트 (10개씩 병렬)
    let matched = 0;
    const updateEntries = [...updates.values()];
    const BATCH = 10;
    for (let i = 0; i < updateEntries.length; i += BATCH) {
      const batch = updateEntries.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(({ id, platform_codes, seller_code }) =>
          supabase.from("products").update({ platform_codes, seller_code }).eq("id", id)
        )
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && !r.value.error) {
          matched++;
        } else {
          const errMsg = r.status === "fulfilled" ? r.value.error?.message : r.reason;
          console.error(`[import-platform-codes] 업데이트 실패 (${batch[j].id}):`, errMsg);
        }
      }
    }

    console.log(`[import-platform-codes] 완료: ${matched}개 매칭, ${unmatchedNames.size}개 미매칭${overwrite ? " (덮어쓰기)" : ""}`);

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
