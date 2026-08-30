// 쿠팡에 이미 등록되어 그 바코드를 선점한 목록을 모아 둔다.
//
//   node scripts/claimed-barcodes.mjs <쿠팡작업결과.xlsx> <플레이오토결과.xlsx> ...
//
// 왜 필요한가:
//   쿠팡은 바코드(GTIN) 하나에 상품 하나만 허용한다.
//   묶음 수량만 다른 상품은 낱개 바코드가 같아 두 번째부터 "이미 등록된 상품과 중복"으로 반려된다.
//   → 상품참조번호(12번째 자리)를 올리고 체크디짓을 다시 계산한 변형 GTIN을 쓴다.
//   이때 "이미 등록에 성공한 상품이 쓴 번호"는 건너뛰어야 또 중복이 나지 않는다.
import fs from "fs";
import XLSX from "xlsx-js-style";

const FILE = "scripts/output/claimed-barcodes.json";

/** 결과 엑셀 쌍에서 "등록 성공한 상품이 선점한 바코드"를 뽑는다 */
export function extractClaimed(files) {
  const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };
  const jobs = [], uploads = [];
  for (const f of files) {
    const rows = rd(f);
    if (!rows.length) continue;
    if ("작업결과" in rows[0]) jobs.push(...rows);
    else if ("판매자관리코드" in rows[0]) uploads.push(...rows);
  }
  const byCode = new Map(uploads.map((r) => [String(r["판매자관리코드"]).trim(), r]));
  const claimed = new Set();
  for (const j of jobs) {
    const msg = String(j["결과메세지"] ?? "");
    const ok = String(j["작업결과"]).trim() === "성공";
    // "이미 등록된 상품과 중복"도 그 번호에 임자가 있다는 뜻이므로 똑같이 피해야 한다
    const taken = /이미 등록된 상품과 중복/.test(msg);
    if (!ok && !taken) continue;
    const src = byCode.get(String(j["판매자관리코드"]).trim());
    const bar = String(src?.["옵션바코드"] || src?.["바코드"] || "").trim();
    if (bar) claimed.add(bar);
  }
  return claimed;
}

/** 저장된 선점 목록을 읽는다 */
export function loadClaimed() {
  if (!fs.existsSync(FILE)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch { return new Set(); }
}

// 직접 실행하면 인자로 받은 결과 파일들을 읽어 목록에 더한다
if (process.argv[1]?.endsWith("claimed-barcodes.mjs")) {
  const files = process.argv.slice(2);
  if (!files.length) { console.log("사용법: node scripts/claimed-barcodes.mjs <결과.xlsx> ..."); process.exit(1); }
  const before = loadClaimed();
  const found = extractClaimed(files);
  const merged = new Set([...before, ...found]);
  fs.mkdirSync("scripts/output", { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify([...merged], null, 2));
  console.log(`[claimed] 기존 ${before.size} + 이번 ${found.size} → 누적 ${merged.size}개`);
}
