import { serviceClient, fetchAll } from "./_lib.mjs";
const sb = serviceClient();
const ps = await fetchAll(sb, "products", "id, product_name, purchase_url, lowest_price, platform_codes, registration_status, rebuild_status");
const live = ps.filter(p=>p.rebuild_status==="조사완료" && p.registration_status!=="판매중지");
const byName=new Map(); live.forEach(p=>{const k=p.product_name.trim().normalize("NFC"); if(!byName.has(k))byName.set(k,[]); byName.get(k).push(p);});
// spm 등 추적 파라미터를 빼고 실제 상품번호만 본다
const goods=(u)=>String(u??"").match(/goodscode=(\d+)/)?.[1] ?? String(u??"").slice(0,60);
let realDup=0, realDiff=0;
for (const [n,v] of [...byName].filter(([,v])=>v.length>1)) {
  const codes=v.map(p=>goods(p.purchase_url));
  const same=new Set(codes).size===1;
  if(same)realDup++; else realDiff++;
  console.log(`\n■ ${n}   ${same?"같은 상품 ⚠ (goodscode 동일)":"다른 상품 ✅"}`);
  v.forEach((p,i)=>console.log(`   ${String(p.lowest_price).padStart(6)}원  goodscode=${codes[i]}  마켓코드 ${Object.keys(p.platform_codes??{}).length}개`));
}
console.log(`\n실제 중복 ${realDup}쌍 / 별개 상품 ${realDiff}쌍`);
