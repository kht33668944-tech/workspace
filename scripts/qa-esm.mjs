// ESM(지마켓·옥션) 업로드 엑셀 점검.
//
//   node scripts/qa-esm.mjs [파일패턴]
//
// 등록을 막을 만한 것만 본다. 통과했다고 반드시 등록되는 건 아니지만,
// 여기 걸리는 건 확실히 문제가 된다.
import XLSX from "xlsx-js-style";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import os from "os";
import path from "path";

// 금칙어 목록 (지마켓·옥션은 상세설명에 있으면 등록을 막는다)
const env = fs.readFileSync(".env.local", "utf8");
const gk = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", gk("SUPABASE_SERVICE_ROLE_KEY"));
const { data: fwRows } = await sb.from("forbidden_words").select("word");
const FORBIDDEN = [...new Set((fwRows ?? []).map((r) => String(r.word).trim()).filter(Boolean))];

const dir = path.join(os.homedir(), "Desktop", "상품등록");
const pat = process.argv[2] ?? "지마켓옥션_260824";
const files = fs.readdirSync(dir).filter((f) => f.includes(pat) && f.endsWith(".xlsx")).sort();
const rows = [];
for (const f of files) {
  const wb = XLSX.readFile(path.join(dir, f));
  rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }).map((r) => ({ ...r, _file: f })));
}
console.log(`파일 ${files.length}개 / ${rows.length}행\n`);

const gtinCheck = (d) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const problems = [];
const warn = [];
const add = (list, tag, r, detail) => list.push(`${tag} | ${r["온라인 상품명"]} | ${detail}`);

// 쇼핑몰·템플릿 짝
const PAIR = { "옥션=redgoom00": "2201548", "지마켓=redgoom00": "2201554" };
const byCode = new Map();
for (const r of rows) {
  const nm = String(r["온라인 상품명"] ?? "").trim();
  const shop = String(r["쇼핑몰(계정)"] ?? "").trim();
  const code = String(r["판매자관리코드"] ?? "").trim();

  if (!nm) add(problems, "상품명 없음", r, "");
  if (nm.length > 50) add(warn, "상품명 50자 초과", r, `${nm.length}자`);
  // 소수점(1.5L, 8.0)은 정상이다. 그 밖의 기호만 본다.
  const badCh = nm.replace(/(?<=\d)\.(?=\d)/g, "").match(/[^가-힣a-zA-Z0-9\s]/g);
  if (badCh) add(warn, "상품명 특수문자", r, badCh.join(""));
  if (!code) add(problems, "판매자관리코드 없음", r, "");
  if (!PAIR[shop]) add(problems, "쇼핑몰 값 이상", r, shop);
  else if (String(r["템플릿코드"]).trim() !== PAIR[shop]) add(problems, "템플릿코드 불일치", r, `${shop} → ${r["템플릿코드"]}`);

  if (!(Number(r["판매가"]) > 0)) add(problems, "판매가 이상", r, String(r["판매가"]));
  if (!(Number(r["판매수량"]) > 0)) add(problems, "판매수량 이상", r, String(r["판매수량"]));
  if (!String(r["카테고리코드"]).trim()) add(problems, "카테고리 없음", r, "");
  if (!String(r["기본이미지"]).trim()) add(problems, "썸네일 없음", r, "");

  const html = String(r["상세설명"] ?? "");
  if (!html.trim()) add(problems, "상세설명 없음", r, "");
  if (html.length > 32000) add(problems, "상세설명 길이 초과", r, `${html.length}자 (엑셀 셀 한계 32767)`);
  if (/<img[^>]+src=["']https?:\/\/(?!.*supabase)/.test(html)) add(problems, "외부 이미지", r, "");

  // 고시 칸도 상세페이지에 그대로 노출되므로 함께 본다
  const noticeText = Array.from({ length: 24 }, (_, i) => String(r[`상품정보제공고시${i + 1}`] ?? "")).join(" ");
  const hitWords = FORBIDDEN.filter((w) => nm.includes(w) || html.includes(w) || noticeText.includes(w));
  if (hitWords.length) add(problems, "금칙어", r, hitWords.join(","));

  const bar = String(r["옵션바코드"] ?? "").trim();
  if (bar && !(/^\d{13}$/.test(bar) && gtinCheck(bar.slice(0, 12)) === bar[12])) add(problems, "바코드 형식", r, bar);

  const model = String(r["모델명"] ?? "");
  if (/[^가-힣a-zA-Z0-9\s]/.test(model)) add(problems, "모델명 특수문자", r, model);
  if (!String(r["브랜드"]).trim()) add(warn, "브랜드 없음", r, "");
  if (!String(r["원산지"]).trim()) add(problems, "원산지 없음", r, "");

  // 고시: 값이 비어 있으면 반려된다
  for (let i = 1; i <= 11; i++) {
    const v = String(r[`상품정보제공고시${i}`] ?? "").trim();
    const need = i <= (String(r["상품분류코드"]) === "35" ? 5 : 11);
    if (need && !v) { add(problems, `고시${i} 비어있음`, r, `분류 ${r["상품분류코드"]}`); break; }
  }
  if (!byCode.has(code)) byCode.set(code, new Set());
  byCode.get(code).add(shop);
}

// 한 코드에 두 마켓이 정확히 하나씩인지
let pairBad = 0;
for (const [code, shops] of byCode) if (shops.size !== 2) pairBad++;
if (pairBad) problems.push(`짝 이상 | 옥션·지마켓 두 줄이 아닌 코드 ${pairBad}건`);

const group = (list) => {
  const g = new Map();
  for (const x of list) { const k = x.split(" | ")[0]; if (!g.has(k)) g.set(k, []); g.get(k).push(x); }
  return [...g].sort((a, b) => b[1].length - a[1].length);
};
console.log("■ 등록을 막는 문제");
if (!problems.length) console.log("  없음 ✅");
for (const [k, v] of group(problems)) { console.log(`  [${v.length}] ${k}`); v.slice(0, 3).forEach((x) => console.log(`      ${x}`)); }
console.log("\n■ 확인해 볼 것 (반려는 아닐 수 있음)");
if (!warn.length) console.log("  없음");
for (const [k, v] of group(warn)) { console.log(`  [${v.length}] ${k}`); v.slice(0, 5).forEach((x) => console.log(`      ${x}`)); }
