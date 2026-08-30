// 바코드가 없는 상품과, 코리안넷에서 찾을 때 쓸 검색어(브랜드)를 뽑는다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const products = [];
for (let off = 0; ; off += 500) {
  const { data, error } = await sb.from("products").select("id, product_name, item_info")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").order("sort_order").range(off, off + 499);
  if (error) { console.error("[nobar] 조회 실패:", error.message); process.exit(1); }
  if (!data?.length) break; products.push(...data); if (data.length < 500) break;
}
// GTIN 13자리 + 체크디짓이 맞아야 쓸 수 있다. 형식이 깨진 바코드는 없는 것으로 본다.
const chk = (d) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const okGtin = (b) => /^\d{13}$/.test(b) && chk(b.slice(0, 12)) === b[12];
const miss = products.filter((p) => !okGtin(String(p.item_info?.바코드 ?? "").trim()));
const brands = new Map();
for (const p of miss) {
  const b = String(p.item_info?.브랜드 || p.product_name.split(/\s+/)[0]).trim();
  brands.set(b, (brands.get(b) ?? 0) + 1);
}
fs.writeFileSync("scripts/output/no-barcode.json", JSON.stringify(miss.map(p=>({id:p.id,name:p.product_name,brand:p.item_info?.브랜드??"", cap:p.item_info?.개당용량??"", wt:p.item_info?.개당중량??"", full:p.item_info?.제품명??""})), null, 1));
console.log(`전체 ${products.length} / 바코드없음 ${miss.length} / 브랜드 ${brands.size}`);
console.log([...brands].sort((a,b)=>b[1]-a[1]).map(([b,n])=>`${b}(${n})`).join(" "));
