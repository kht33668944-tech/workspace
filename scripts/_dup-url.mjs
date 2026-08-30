import { serviceClient, fetchAll } from "./_lib.mjs";
const sb = serviceClient();
const ps = await fetchAll(sb, "products", "id, product_name, purchase_url, lowest_price, source_platform, registration_status, rebuild_status, platform_codes");
const live = ps.filter(p=>p.rebuild_status==="조사완료" && p.registration_status!=="판매중지");
const byName=new Map(); live.forEach(p=>{const k=p.product_name.trim().normalize("NFC"); if(!byName.has(k))byName.set(k,[]); byName.get(k).push(p);});
for (const [n,v] of [...byName].filter(([,v])=>v.length>1)) {
  const urls=v.map(p=>String(p.purchase_url??"").trim());
  const same = new Set(urls).size===1;
  console.log(`\n■ ${n}   링크 ${same?"같음 ⚠":"다름 ✅"}`);
  v.forEach(p=>console.log(`   ${String(p.lowest_price).padStart(6)}원  [${Object.keys(p.platform_codes??{}).length}개 마켓코드]  ${String(p.purchase_url??"(없음)").slice(0,95)}`));
}
