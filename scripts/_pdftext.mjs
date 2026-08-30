// PDF에서 텍스트 조각을 뽑는다 (FlateDecode 스트림 → PDF 문자열 연산자)
import fs from "fs";
import zlib from "zlib";

const buf = fs.readFileSync(process.argv[2]);
const s = buf.toString("latin1");
const out = [];
const re = /stream\r?\n/g;
let m;
while ((m = re.exec(s))) {
  const start = m.index + m[0].length;
  const end = s.indexOf("endstream", start);
  if (end < 0) continue;
  try { out.push(zlib.inflateSync(buf.subarray(start, end)).toString("latin1")); } catch { /* 이미지 등은 건너뜀 */ }
}
const txt = out.join("\n");
const strs = [...txt.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]);
fs.writeFileSync("scripts/output/esm-pdf-raw.txt", strs.join("\n"));
console.log(`스트림 ${out.length} / 문자열 ${strs.length}`);
console.log(strs.slice(0, 60).join(" | ").slice(0, 900));
