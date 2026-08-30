// 썸네일 URL이 실제로 열리는지 표본 검사 (플레이오토 S3 링크는 만료되어 403이 나기도 한다)
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";
const dir = path.join(os.homedir(), "Desktop", "상품등록");
const rows = [];
for (const f of fs.readdirSync(dir).filter((f) => f.includes("지마켓옥션_260824") && f.endsWith(".xlsx"))) {
  const wb = XLSX.readFile(path.join(dir, f));
  rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }));
}
const urls = [...new Set(rows.map((r) => String(r["기본이미지"]).trim()).filter(Boolean))];
const host = new Map();
urls.forEach((u) => { const h = new URL(u).host; host.set(h, (host.get(h) ?? 0) + 1); });
console.log("썸네일 고유 URL", urls.length);
[...host].forEach(([h, n]) => console.log("  ", n, h));
const sample = urls.filter((_, i) => i % Math.ceil(urls.length / 40) === 0).slice(0, 40);
let bad = 0;
await Promise.all(sample.map(async (u) => {
  try {
    const r = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.log("  ✗", r.status, u); bad++; }
  } catch (e) { console.log("  ✗ 실패", u, e instanceof Error ? e.message : String(e)); bad++; }
}));
console.log(`표본 ${sample.length}건 중 열리지 않음 ${bad}건`);
