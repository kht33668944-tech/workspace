import { serviceClient, fetchAll } from "./_lib.mjs";
const sb = serviceClient();
const ps = await fetchAll(sb, "products", "id, product_name, registration_status, rebuild_status, platform_codes");
const live = ps.filter(p=>p.rebuild_status==="조사완료" && p.registration_status!=="판매중지");
const has=(p,k)=>Object.keys(p.platform_codes??{}).some(x=>x.includes(k));
// 이름 중복 (임포트가 상품명으로 붙으므로 한쪽만 연결된다)
const byName=new Map(); live.forEach(p=>{const k=p.product_name.trim().normalize("NFC"); if(!byName.has(k))byName.set(k,[]); byName.get(k).push(p);});
const dupNames=new Set([...byName].filter(([,v])=>v.length>1).map(([k])=>k));
for (const [label,key] of [["스마트스토어","스마트스토어"],["쿠팡","쿠팡"],["지마켓","지마켓"],["옥션","옥션"]]) {
  const miss = live.filter(p=>!has(p,key));
  const dupPart = miss.filter(p=>dupNames.has(p.product_name.trim().normalize("NFC")));
  console.log(`\n■ ${label} 미보유 ${miss.length}건 (그중 이름중복 탓 ${dupPart.length}건)`);
  miss.slice(0,12).forEach(p=>console.log(`   - ${p.product_name}${dupNames.has(p.product_name.trim().normalize("NFC"))?"   ← 이름중복":""}`));
  if(miss.length>12) console.log(`   … 외 ${miss.length-12}건`);
}
console.log(`\n이름 중복 ${dupNames.size}쌍:`);
[...dupNames].forEach(n=>console.log("   ", n));
