// 다운로드·바탕화면에 있는 모든 등록 결과에서 선점 바코드를 모은다.
import fs from "fs";
import os from "os";
import path from "path";
import { extractClaimed, loadClaimed } from "./claimed-barcodes.mjs";
const files = [];
for (const dir of [path.join(os.homedir(), "Downloads"), path.join(os.homedir(), "Desktop", "상품등록")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".xlsx")) continue;
    if (/쇼핑몰상품_.*엑셀일괄등록_결과|쿠팡\(.*상품등록_작업결과|플레이오토_쿠팡/.test(f)) files.push(path.join(dir, f));
  }
}
console.log(`결과 파일 ${files.length}개`);
const before = loadClaimed();
const found = extractClaimed(files);
const merged = new Set([...before, ...found]);
fs.writeFileSync("scripts/output/claimed-barcodes.json", JSON.stringify([...merged], null, 2));
console.log(`[claimed] 누적 ${merged.size}개`);
