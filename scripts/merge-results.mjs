// 여러 배치의 등록 결과를 한 파일로 합친다 (재시도 대상 산출용).
//
//   node scripts/merge-results.mjs <결과파일...>
//
// 플레이오토 등록결과와 쿠팡 작업결과가 섞여 있어도 알아서 가린다.
// 한 상품이 여러 파일에 나오면 "한 번이라도 성공"이면 성공으로 본다.
// 결과는 "플레이오토 등록결과" 형식(결과·판매자관리코드·온라인 상품명·카테고리코드)으로 내보낸다.
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";

const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };
const files = process.argv.slice(2);
if (!files.length) { console.log("사용법: node scripts/merge-results.mjs <결과.xlsx> ..."); process.exit(1); }

const info = new Map();  // 판매자관리코드 -> { name, cat }
const state = new Map(); // 판매자관리코드 -> { ok, msg }
for (const f of files) {
  let rows; try { rows = rd(f); } catch (e) { console.error(`읽기 실패 ${f}: ${e instanceof Error ? e.message : String(e)}`); continue; }
  if (!rows.length) continue;
  const k = Object.keys(rows[0]);
  for (const r of rows) {
    const code = String(r["판매자관리코드"] ?? "").trim();
    if (!code) continue;
    if (r["온라인 상품명"]) info.set(code, { name: String(r["온라인 상품명"]).trim(), cat: String(r["카테고리코드"] ?? "").trim() });
    // 쇼핑몰 작업결과가 최종 판정이다. 플레이오토 결과는 그보다 앞 단계라 우선순위가 낮다.
    let ok = null, msg = "", rank = 0;
    if (k.includes("작업결과")) { ok = String(r["작업결과"]).trim() === "성공"; msg = String(r["결과메세지"] ?? ""); rank = 2; }
    else if (k.includes("결과")) { ok = String(r["결과"]).trim() === "성공"; msg = String(r["결과"] ?? ""); rank = 1; }
    if (ok === null) continue;
    const prev = state.get(code);
    if (!prev || rank >= prev.rank) state.set(code, { ok, msg, rank });
  }
}

const out = [];
for (const [code, st] of state) {
  const i = info.get(code);
  if (!i?.name) continue;
  out.push({ 결과: st.ok ? "성공" : (st.msg || "실패"), 판매자관리코드: code, "온라인 상품명": i.name, 카테고리코드: i.cat });
}
const ok = out.filter((r) => r.결과 === "성공").length;
const dir = path.join(os.homedir(), "Desktop", "상품등록");
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, "통합결과_쿠팡.xlsx");
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), "결과");
XLSX.writeFile(wb, dest);
console.log(`[merge] 총 ${out.length}행 / 성공 ${ok} / 실패 ${out.length - ok}`);
console.log(`생성: ${dest}`);
