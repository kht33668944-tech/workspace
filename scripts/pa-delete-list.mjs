// 플레이오토에 이미 쇼핑몰상품이 만들어진 판매자관리코드 목록을 뽑는다.
//
//   node scripts/pa-delete-list.mjs
//
// 플레이오토는 같은 판매자관리코드로 두 번 올리면 "이미 존재"로 막는다.
// 쿠팡 전송만 실패한 상품은 플레이오토에는 남아 있으므로, 재업로드 전에 지워야 한다.
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";

const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };
const dl = path.join(os.homedir(), "Downloads");
const desk = path.join(os.homedir(), "Desktop", "상품등록");

const paOk = new Set();     // 플레이오토에 상품이 만들어진 코드
const name = new Map();
for (const f of fs.readdirSync(dl).filter((f) => /26082[34].*엑셀일괄등록_결과.*\.xlsx$/.test(f))) {
  for (const r of rd(path.join(dl, f))) {
    const code = String(r["판매자관리코드"] ?? "").trim();
    if (!code) continue;
    if (r["온라인 상품명"]) name.set(code, String(r["온라인 상품명"]).trim());
    if (String(r["결과"]).trim() === "성공") paOk.add(code);
  }
}
// 재시도 대상 = 통합결과에서 실패로 남은 것
const merged = rd(path.join(desk, "통합결과_쿠팡.xlsx"));
const need = merged.filter((r) => String(r["결과"]).trim() !== "성공").map((r) => String(r["판매자관리코드"]).trim());
const del = need.filter((c) => paOk.has(c));

const rows = del.map((c) => ({ 판매자관리코드: c, 상품명: name.get(c) ?? "" }));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "삭제대상");
XLSX.writeFile(wb, path.join(desk, "플레이오토_삭제대상.xlsx"));
fs.writeFileSync(path.join(desk, "플레이오토_삭제대상.txt"), del.join("\n"));
console.log(`재시도 대상 ${need.length}건 중 플레이오토에 이미 있는 것 ${del.length}건`);
console.log(`생성: ${path.join(desk, "플레이오토_삭제대상.xlsx")} / .txt`);
