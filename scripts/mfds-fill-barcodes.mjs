// 조사완료 상품의 품목보고번호로 식약처 C005(바코드연계)를 조회해
// item_info에 바코드(GTIN)·소비기한·공장 소재지를 보강한다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

async function c005(reportNo, retry = 0) {
  const r = await fetch(`http://openapi.foodsafetykorea.go.kr/api/${KEY}/C005/json/1/30/PRDLST_REPORT_NO=${reportNo}`);
  const j = JSON.parse(await r.text());
  if (j.C005?.RESULT?.CODE === "INFO-500" && retry < 5) {
    await new Promise((res) => setTimeout(res, 1500 * (retry + 1)));
    return c005(reportNo, retry + 1);
  }
  return j.C005?.row || [];
}

const { data: products } = await sb
  .from("products")
  .select("id, product_name, item_info")
  .eq("rebuild_status", "조사완료");

let ok = 0, miss = 0;
for (const p of products) {
  const info = p.item_info;
  if (!info?.품목보고번호) { miss++; continue; }
  if (info.바코드) { ok++; continue; } // 이미 채움

  // 품목보고번호 문자열에서 번호만 추출 (여러 개면 순서대로 시도)
  const reportNos = [...new Set((info.품목보고번호.match(/\d{9,}/g)) || [])];
  let rows = [];
  for (const no of reportNos) {
    rows = await c005(no);
    if (rows.length) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!rows.length) { console.log("바코드 없음:", p.product_name); miss++; continue; }

  // 바코드 후보: 첫 행 기준. 소비기한·소재지도 함께 보강
  const first = rows[0];
  const barcodes = [...new Set(rows.map((x) => x.BAR_CD).filter(Boolean))];
  info.바코드 = barcodes[0];
  if (barcodes.length > 1) info.바코드_후보 = barcodes.slice(0, 8).join(", ");
  if (first.POG_DAYCNT) info.소비기한 = first.POG_DAYCNT + " (표시일까지)";
  if (first.SITE_ADDR && info.제조원 && !/\d/.test(info.제조원)) {
    info.제조원 = info.제조원.replace(" (소재지는 제품 라벨 표기 참조", ` / ${first.SITE_ADDR} (상세 소재지는 제품 라벨 표기 참조`);
  }

  const { error } = await sb.from("products").update({ item_info: info }).eq("id", p.id);
  if (error) { console.log("저장실패:", p.product_name, error.message); miss++; }
  else { console.log("바코드:", p.product_name, "→", info.바코드); ok++; }
  await new Promise((r) => setTimeout(r, 600));
}
console.log(`[barcodes] 완료 ${ok} / 미확보 ${miss}`);
