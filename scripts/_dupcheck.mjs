// "동일 판매자관리코드로 이미 존재"로 막힌 상품들이 실제로 쿠팡에 올라가 있는지 본다.
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";
const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };
const dl = path.join(os.homedir(), "Downloads"), desk = path.join(os.homedir(), "Desktop", "상품등록");
const files = [];
for (const d of [dl, desk]) for (const f of fs.readdirSync(d))
  if (f.endsWith(".xlsx") && /엑셀일괄등록_결과|상품등록_작업결과|플레이오토_쿠팡/.test(f)) files.push(path.join(d, f));

const nameByCode = new Map();
const coupang = new Map();   // 코드 -> [성공여부, 메시지]
const dupCodes = new Set();  // 이번에 "이미 존재"로 막힌 코드
for (const f of files) {
  let rows; try { rows = rd(f); } catch { continue; }
  for (const r of rows) {
    const code = String(r["판매자관리코드"] ?? "").trim(); if (!code) continue;
    if (r["온라인 상품명"]) nameByCode.set(code, String(r["온라인 상품명"]).trim());
    if ("작업결과" in r) coupang.set(code, [String(r["작업결과"]).trim() === "성공", String(r["결과메세지"] ?? "").replace(/\s+/g, " ")]);
    if ("결과" in r && /동일 판매자관리코드/.test(String(r["결과"])) && /26082409/.test(path.basename(f))) dupCodes.add(code);
  }
}
// 상품명별로 쿠팡 등록 성공 여부
const okByName = new Set();
for (const [code, [ok]] of coupang) if (ok) okByName.add(nameByCode.get(code));

const buckets = { "쿠팡 등록됨": [], "GTIN 임자있음": [], "UID 없음": [], "기타": [] };
for (const c of dupCodes) {
  const nm = nameByCode.get(c) ?? c;
  const [ok, msg] = coupang.get(c) ?? [false, "(쿠팡 결과 없음)"];
  if (ok || okByName.has(nm)) buckets["쿠팡 등록됨"].push(`${nm}`);
  else if (/이미 등록된 상품과 중복/.test(msg)) buckets["GTIN 임자있음"].push(`${nm}  ${(msg.match(/중복 상품 ID: (\d+)/) || [])[1] ?? ""}`);
  else if (/UID/.test(msg)) buckets["UID 없음"].push(nm);
  else buckets["기타"].push(`${nm} | ${msg.slice(0, 70)}`);
}
console.log(`"이미 존재"로 막힌 코드 ${dupCodes.size}건\n`);
for (const [k, v] of Object.entries(buckets)) {
  console.log(`【${k}】 ${v.length}건`);
  v.slice(0, 8).forEach((x) => console.log("   ·", x));
  if (v.length > 8) console.log(`   ... 외 ${v.length - 8}건`);
  console.log("");
}
