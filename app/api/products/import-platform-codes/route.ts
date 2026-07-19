import { NextRequest, NextResponse } from "next/server";
import XLSX from "xlsx-js-style";
import { getAccessToken, getSupabaseClient, fetchAllRows } from "@/lib/api-helpers";

function normalizeHeader(value: unknown) {
  return String(value ?? "").replace(/[\s\u00A0\u3000\t\r\n]/g, "").trim();
}

function findColumnIndex(headers: unknown[], aliases: string[]) {
  return headers.findIndex((header) => {
    const normalized = normalizeHeader(header);
    return aliases.some((alias) => normalized.includes(normalizeHeader(alias)) || normalized === normalizeHeader(alias));
  });
}

function cellString(row: unknown[], index: number) {
  if (index < 0) return "";
  return String(row[index] ?? "").trim();
}

function normalizeProductKey(value: string) {
  return value
    .normalize("NFC")
    .replace(/[^\uAC00-\uD7A3\u3130-\u318Fa-zA-Z0-9.]+/g, "")
    .toLowerCase();
}

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
    if (!ws) return NextResponse.json({ error: "엑셀 시트를 찾을 수 없습니다." }, { status: 400 });

    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: false, blankrows: false });

    const MAX_ROWS = 10000;
    if (rawRows.length <= 1) return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    if (rawRows.length - 1 > MAX_ROWS) return NextResponse.json({ error: `최대 ${MAX_ROWS}행까지 처리 가능합니다.` }, { status: 400 });

    // 2. 헤더 검증
    const headers = rawRows[0] ?? [];
    const nameCol = findColumnIndex(headers, ["온라인 상품명"]);
    const accountCol = findColumnIndex(headers, ["쇼핑몰(계정)"]);
    const codeCol = findColumnIndex(headers, ["쇼핑몰 상품번호"]);
    const sellerCodeCol = findColumnIndex(headers, ["판매자관리코드"]);
    // 쿠팡 가격수정 양식용 옵션 캐시 (선택)
    const optionCombineCol = findColumnIndex(headers, ["옵션조합"]);
    const optionCol = headers.findIndex((header) => {
      const normalized = normalizeHeader(header);
      return normalized === "옵션" || (normalized.includes("옵션") && !normalized.includes("조합"));
    });

    if (nameCol < 0 || accountCol < 0 || codeCol < 0) {
      return NextResponse.json({
        error: "필수 컬럼을 찾을 수 없습니다. 플레이오토 상품 목록의 '온라인 상품명', '쇼핑몰(계정)', '쇼핑몰 상품번호' 컬럼이 필요합니다.",
      }, { status: 400 });
    }

    // 3. 사용자 상품 조회 (RLS 스코프 + 1000행 초과 누락 방지: 전건 페이지네이션)
    const products = await fetchAllRows<{ id: string; product_name: string; platform_codes: Record<string, string> | null; seller_code: Record<string, string> | null }>(
      (from, to) => supabase
        .from("products")
        .select("id, product_name, platform_codes, seller_code")
        .range(from, to),
    );

    // 판매자관리코드/상품명 → product Map
    const productMap = new Map<string, { id: string; platform_codes: Record<string, string> | null; seller_code: Record<string, string> | null }>();
    const normalizedProductMap = new Map<string, { id: string; platform_codes: Record<string, string> | null; seller_code: Record<string, string> | null }>();
    const sellerCodeMap = new Map<string, { id: string; platform_codes: Record<string, string> | null; seller_code: Record<string, string> | null }>();
    for (const p of products) {
      const product = { id: p.id, platform_codes: p.platform_codes, seller_code: p.seller_code as Record<string, string> | null };
      productMap.set(p.product_name, product);
      normalizedProductMap.set(normalizeProductKey(p.product_name), product);
      for (const sellerCode of Object.values(p.seller_code ?? {})) {
        if (sellerCode) sellerCodeMap.set(String(sellerCode).trim(), product);
      }
    }

    // 쇼핑몰 계정 → seller_code 그룹 매핑
    const accountToSellerGroup = (account: string): string => {
      const lower = account.toLowerCase();
      if (lower.startsWith("스마트스토어")) return "smartstore";
      if (lower.startsWith("쿠팡")) return "coupang";
      return "esm";
    };

    // 4. 엑셀 행 처리 — 상품별로 코드 수집
    type CoupangOptions = { hasOption: boolean; optionName: string; optionValue: string };
    type UpdateEntry = {
      id: string;
      platform_codes: Record<string, string>;
      seller_code: Record<string, string> | null;
      coupang_options?: CoupangOptions;
    };
    const updates = new Map<string, UpdateEntry>();
    const unmatchedNames = new Set<string>();
    let duplicateCount = 0;
    let ignored11stCount = 0;

    const dataRows = rawRows.slice(1);
    for (const row of dataRows) {
      const productName = cellString(row, nameCol);
      const account = cellString(row, accountCol);
      const code = cellString(row, codeCol);
      const sellerCode = sellerCodeCol >= 0 ? cellString(row, sellerCodeCol) : "";

      if (!productName || !account || !code) continue;
      if (account.toLowerCase().startsWith("11번가")) {
        ignored11stCount++;
        continue;
      }

      const product =
        (sellerCode ? sellerCodeMap.get(sellerCode) : undefined)
        ?? productMap.get(productName)
        ?? normalizedProductMap.get(normalizeProductKey(productName));
      if (!product) {
        unmatchedNames.add(sellerCode ? `${sellerCode} / ${productName}` : productName);
        continue;
      }

      // 같은 플랫폼 계정의 코드가 이미 존재하고 값이 다른 경우만 충돌로 판정
      if (!updates.has(product.id)) {
        const existingCodes = product.platform_codes ?? {};
        if (existingCodes[account] && existingCodes[account] !== code) {
          duplicateCount++;
        }
      }

      const existing: UpdateEntry = updates.get(product.id) ?? {
        id: product.id,
        // 새 플레이오토 목록에는 일부 판매처만 들어올 수 있다. 해당 판매처 코드만 최신값으로
        // 교체하고, 다른 판매처의 기존 코드는 보존한다.
        platform_codes: { ...(product.platform_codes ?? {}) },
        seller_code: product.seller_code ? { ...product.seller_code } : null,
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
      // 쿠팡 행 + 옵션 컬럼 있으면 coupang_options 추출 (한 상품당 1회)
      if (
        optionCombineCol >= 0 &&
        account.toLowerCase().startsWith("쿠팡") &&
        existing.coupang_options === undefined
      ) {
        const combine = cellString(row, optionCombineCol);
        const optionRaw = optionCol >= 0 ? cellString(row, optionCol) : "";
        if (combine === "조합형" && optionRaw) {
          const parts = optionRaw.split(/\r?\n/);
          existing.coupang_options = {
            hasOption: true,
            optionName: (parts[0] ?? "").trim(),
            optionValue: (parts[1] ?? "").trim(),
          };
        } else if (combine === "옵션없음") {
          existing.coupang_options = { hasOption: false, optionName: "", optionValue: "" };
        }
        // 그 외 (빈 값 등)는 추출 보류 → DB 미변경 → 추후 가격수정 시 Gemini fallback
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
        total: dataRows.length,
      });
    }

    // 5. DB 배치 업데이트 (10개씩 병렬)
    let matched = 0;
    const updateEntries = [...updates.values()];
    const BATCH = 10;
    for (let i = 0; i < updateEntries.length; i += BATCH) {
      const batch = updateEntries.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(({ id, platform_codes, seller_code, coupang_options }) => {
          const payload: Record<string, unknown> = { platform_codes, seller_code };
          if (coupang_options !== undefined) payload.coupang_options = coupang_options;
          return supabase.from("products").update(payload).eq("id", id);
        })
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

    console.log(`[import-platform-codes] 플레이오토 임포트 확인 완료: ${matched}개 매칭, ${unmatchedNames.size}개 미매칭, 11번가 제외 ${ignored11stCount}행${overwrite ? " (최신 정보 갱신)" : ""}`);

    return NextResponse.json({
      matched,
      unmatched: [...unmatchedNames],
      total: dataRows.length,
      ignored11st: ignored11stCount,
    });
  } catch (err) {
    console.error("[import-platform-codes] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "플레이오토 임포트 확인 실패" }, { status: 500 });
  }
}
