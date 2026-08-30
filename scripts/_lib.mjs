// 스크립트 공용 헬퍼.
//
// 같은 코드가 스크립트마다 복사돼 있었다 (.env 파싱 57곳, GTIN 체크디짓 5곳, 페이지네이션 10여 곳).
// 새 스크립트는 여기서 가져다 쓴다.
import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";

const SUPABASE_URL = "https://ygunjfbtyowsumtxkukr.supabase.co";

/** .env.local에서 값 하나를 읽는다 */
export function env(key) {
  const src = fs.readFileSync(".env.local", "utf8");
  return (src.match(new RegExp("^" + key + "=(.*)$", "m")) || [])[1]?.trim();
}

/** service_role 클라이언트 (RLS 우회 — 배치 작업용) */
export function serviceClient() {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) { console.error("[공용] SUPABASE_SERVICE_ROLE_KEY가 .env.local에 없다"); process.exit(1); }
  return createClient(SUPABASE_URL, key);
}

/**
 * 테이블 전건을 받는다. Supabase는 한 번에 1000행까지만 주므로 나눠 받는다.
 *   fetchAll(sb, "products", "id, product_name", (q) => q.eq("rebuild_status", "조사완료"))
 */
export async function fetchAll(sb, table, select = "*", refine = null, pageSize = 500) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    let q = sb.from(table).select(select).range(from, from + pageSize - 1);
    if (refine) q = refine(q);
    const { data, error } = await q;
    if (error) { console.error(`[공용] ${table} 조회 실패: ${error.message}`); process.exit(1); }
    if (!data?.length) break;
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

/** 등록 대상 상품 (판매중지는 절대 포함하지 않는다) */
export function fetchTargetProducts(sb, select) {
  return fetchAll(sb, "products", select,
    (q) => q.eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").order("sort_order"));
}

/** GTIN-13 체크디짓 */
export function gtinCheckDigit(first12) {
  const sum = String(first12).split("").reduce((a, n, i) => a + Number(n) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

/** 13자리 숫자이고 체크디짓이 맞는가 */
export function isValidGtin13(barcode) {
  const b = String(barcode ?? "").trim();
  return /^\d{13}$/.test(b) && gtinCheckDigit(b.slice(0, 12)) === b[12];
}

/** 엑셀 첫 시트를 객체 배열로 읽는다 */
export function readSheet(file) {
  const wb = XLSX.readFile(file);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

/** 바탕화면 상품등록 폴더 (없으면 만든다) */
export function outDir() {
  const dir = path.join(os.homedir(), "Desktop", "상품등록");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 그 폴더에서 패턴에 맞는 엑셀을 모아 한 배열로 읽는다. 각 행에 _file을 붙인다. */
export function readSheetsIn(pattern, dir = outDir()) {
  const files = fs.readdirSync(dir).filter((f) => f.includes(pattern) && f.endsWith(".xlsx")).sort();
  const rows = [];
  for (const f of files) rows.push(...readSheet(path.join(dir, f)).map((r) => ({ ...r, _file: f })));
  return { files, rows };
}

/** "태그 | 상품명 | 상세" 목록을 태그별로 묶어 많은 순으로 출력한다 */
export function printGrouped(title, list, emptyText, sampleCount = 3) {
  console.log(title);
  if (!list.length) { console.log(`  ${emptyText}`); return; }
  const groups = new Map();
  for (const x of list) {
    const k = x.split(" | ")[0];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  for (const [k, v] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  [${v.length}] ${k}`);
    v.slice(0, sampleCount).forEach((x) => console.log(`      ${x}`));
  }
}
