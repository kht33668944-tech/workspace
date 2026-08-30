// 실제 등록 결과에서 "카테고리코드별로 통과한 옵션 조합"을 뽑는다.
//
//   node scripts/coupang-option-evidence.mjs
//
// 플레이오토는 우리가 넣은 스마트스토어 카테고리코드를 자기 기준으로 쿠팡 카테고리에 다시 이어붙인다.
// 그래서 쿠팡 공식 정의만 보고 옵션을 만들면 어긋날 수 있다.
// 이미 올려 본 결과가 가장 확실한 근거이므로, 통과/반려 실적을 카테고리별로 모아 둔다.
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";

const OUT = "scripts/output/coupang-option-evidence.json";
const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };

const dl = path.join(os.homedir(), "Downloads");
const desk = path.join(os.homedir(), "Desktop", "상품등록");
const rows = [];   // 우리가 올린 원본 (카테고리코드 + 옵션 + 판매자관리코드)
const results = []; // 플레이오토 등록결과 (결과 컬럼 포함, 원본 데이터도 함께)

for (const dir of [dl, desk]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx") && /플레이오토_쿠팡|쇼핑몰상품_단일_엑셀일괄등록_결과/.test(f))) {
    let r; try { r = rd(path.join(dir, f)); } catch { continue; }
    if (!r.length) continue;
    const k = Object.keys(r[0]);
    if (!k.includes("판매자관리코드") || !k.includes("옵션")) continue;
    if (k.includes("결과")) results.push(...r);
    rows.push(...r);
  }
}
const byCode = new Map(rows.map((r) => [String(r["판매자관리코드"]).trim(), r]));

// 쿠팡 작업결과 (실제 마켓 반영 여부)
const jobs = [];
for (const f of fs.readdirSync(dl).filter((f) => /쿠팡\(.*상품등록_작업결과/.test(f) && f.endsWith(".xlsx"))) {
  try { jobs.push(...rd(path.join(dl, f))); } catch { /* 건너뜀 */ }
}

const optName = (o) => String(o).split("\n")[0].trim();
const stat = new Map(); // 카테고리코드 -> { 옵션조합 -> {ok, ng, msg} }
function note(cat, opt, ok, msg) {
  if (!cat || !opt) return;
  if (!stat.has(cat)) stat.set(cat, new Map());
  const m = stat.get(cat);
  if (!m.has(opt)) m.set(opt, { ok: 0, ng: 0, msg: "" });
  const e = m.get(opt);
  if (ok) e.ok++; else { e.ng++; if (msg && !e.msg) e.msg = msg; }
}

for (const r of results) {
  const ok = String(r["결과"]).trim() === "성공";
  note(String(r["카테고리코드"]).trim(), optName(r["옵션"]), ok, ok ? "" : String(r["결과"]).trim());
}
for (const j of jobs) {
  const s = byCode.get(String(j["판매자관리코드"]).trim());
  if (!s) continue;
  const ok = String(j["작업결과"]).trim() === "성공";
  const msg = String(j["결과메세지"] ?? "");
  // 바코드 때문에 막힌 건 옵션 문제가 아니다
  if (!ok && /UID|GTIN|MPN/.test(msg)) continue;
  note(String(s["카테고리코드"]).trim(), optName(s["옵션"]), ok, msg.slice(0, 80));
}

const good = {}, bad = {};
for (const [cat, m] of stat) {
  for (const [opt, e] of m) {
    if (e.ok > 0 && e.ng === 0) (good[cat] ??= []).push(opt);
    if (e.ng > 0) (bad[cat] ??= []).push({ opt, ng: e.ng, ok: e.ok, msg: e.msg });
  }
}
fs.writeFileSync(OUT, JSON.stringify({ good, bad }, null, 1));
console.log(`카테고리 ${stat.size}개 실적 정리 → ${OUT}`);
console.log(`\n== 반려가 난 조합 ==`);
for (const [cat, list] of Object.entries(bad)) {
  console.log(`\n${cat}  통과조합: ${(good[cat] ?? []).join(" , ") || "(없음)"}`);
  for (const b of list) console.log(`   ✗ ${b.opt}  실패${b.ng}/성공${b.ok}  ${b.msg}`);
}
