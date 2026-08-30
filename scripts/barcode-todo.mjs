// 아직 바코드가 없는 상품 목록을 만든다 (실물 포장에서 읽어 채울 대상).
//
//   node scripts/barcode-todo.mjs
//
// 채워 넣을 때는 "바코드" 칸에 13자리 숫자만 적으면 된다.
import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const chk = (d) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const ok = (b) => /^\d{13}$/.test(b) && chk(b.slice(0, 12)) === b[12];

const products = [];
for (let off = 0; ; off += 500) {
  const { data, error } = await sb.from("products").select("id, product_name, item_info, purchase_url")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").order("sort_order").range(off, off + 499);
  if (error) { console.error("[todo] 조회 실패:", error.message); process.exit(1); }
  if (!data?.length) break; products.push(...data); if (data.length < 500) break;
}
const miss = products.filter((p) => !ok(String(p.item_info?.바코드 ?? "").trim()));
const rows = miss.map((p) => ({
  상품명: p.product_name,
  바코드: "",
  품목군: p.item_info?.품목군 ?? "",
  제조사: p.item_info?.제조회사 ?? p.item_info?.제조원 ?? "",
  구매링크: p.purchase_url ?? "",
  id: p.id,
}));
const dir = path.join(os.homedir(), "Desktop", "상품등록");
fs.mkdirSync(dir, { recursive: true });
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);
ws["!cols"] = [{ wch: 46 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 40 }, { wch: 38 }];
XLSX.utils.book_append_sheet(wb, ws, "바코드필요");
XLSX.writeFile(wb, path.join(dir, "바코드_채울목록.xlsx"));
const byKind = {};
miss.forEach((p) => { const k = p.item_info?.품목군 ?? "기타"; byKind[k] = (byKind[k] ?? 0) + 1; });
console.log(`바코드 없는 상품 ${miss.length}건`);
Object.entries(byKind).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${n}\t${k}`));
console.log(`생성: ${path.join(dir, "바코드_채울목록.xlsx")}`);
