import { serviceClient, fetchAll } from "./_lib.mjs";
const sb = serviceClient();
const ps = await fetchAll(sb, "products", "id, product_name, registration_status, rebuild_status, platform_codes, seller_code");
console.log(`상품 ${ps.length}건`);
const has=(p,k)=>Object.keys(p.platform_codes??{}).some(x=>x.includes(k));
const live = ps.filter(p=>p.rebuild_status==="조사완료" && p.registration_status!=="판매중지");
console.log(`등록 대상 ${live.length}건 (판매중지 ${ps.filter(p=>p.registration_status==="판매중지").length} / 재정비대기 ${ps.filter(p=>p.rebuild_status!=="조사완료").length})`);
console.log("\n마켓별 상품번호 보유 (임포트로 채워짐)");
for (const [label,key] of [["스마트스토어","스마트스토어"],["지마켓","지마켓"],["옥션","옥션"],["쿠팡","쿠팡"]]) {
  const n = live.filter(p=>has(p,key)).length;
  console.log(`  ${label.padEnd(7)} ${String(n).padStart(5)} / ${live.length}   미보유 ${live.length-n}`);
}
for (const t of ["smartstore_price_inventory","esm_price_inventory","coupang_price_inventory"]) {
  const rows = await fetchAll(sb, t, "product_id", null, 1000);
  console.log(`${t.padEnd(28)} ${String(rows.length).padStart(5)}행 / 연결된 상품 ${new Set(rows.map(r=>r.product_id).filter(Boolean)).size}`);
}
const st=new Map(); ps.forEach(p=>st.set(String(p.registration_status),(st.get(String(p.registration_status))??0)+1));
console.log("\n등록상태:", JSON.stringify([...st].sort((a,b)=>b[1]-a[1])));
