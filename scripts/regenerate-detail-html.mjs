// 상세페이지 재생성 — 기존 detail_html을 "완전히 덮어쓴다" (append 아님, 중복 없음)
//
// 사용법:
//   node scripts/regenerate-detail-html.mjs           → 미리보기만 (DB 변경 없음)
//   node scripts/regenerate-detail-html.mjs --apply   → 실제 적용 (적용 전 기존 HTML 자동 백업)
//
// 대상: rebuild_status='조사완료' 이면서 item_info에 스킵사유가 없는 상품
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const APPLY = process.argv.includes("--apply");

// ── lib/detail-html.ts와 동일한 로직 (스크립트는 TS import 불가라 복제) ──
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const stripInternalTags = (v) => String(v).replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\(\s*\)/g, "").replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();

const DISPLAY_FIELDS = [
  ["제품명", "제품명"], ["식품유형", "식품의 유형"], ["제조원", "생산자 및 소재지"], ["판매원", "판매원"],
  ["소비기한", "소비기한"], ["포장단위별용량", "포장단위별 용량·수량"], ["원재료명", "원재료명 및 함량"],
  ["영양성분", "영양성분"], ["품목보고번호", "품목보고번호"], ["유전자변형식품", "유전자변형식품 여부"],
  ["소비자안전주의사항", "소비자안전을 위한 주의사항"], ["수입여부", "수입식품 여부"], ["소비자상담번호", "소비자상담 관련 전화번호"],
];

function buildDetailHtml(productName, thumbnailUrl, itemInfo) {
  if (!itemInfo || itemInfo.스킵사유) return null;
  const rows = DISPLAY_FIELDS.map(([key, label]) => {
    const raw = itemInfo[key];
    if (!raw) return null;
    const value = stripInternalTags(raw);
    if (!value) return null;
    return `<tr>
      <td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:160px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${escapeHtml(value)}</td>
    </tr>`;
  }).filter(Boolean);
  if (!rows.length) return null;

  const safeName = escapeHtml(productName);
  const thumbHtml = thumbnailUrl
    ? `<div style="text-align:center;padding:20px 0;">
    <img src="${escapeHtml(thumbnailUrl)}" alt="${safeName}" style="max-width:800px;width:100%;height:auto;display:block;margin:0 auto;">
  </div>`
    : "";

  return `<div style="max-width:1000px;margin:0 auto;font-family:'맑은 고딕',sans-serif;font-size:14px;color:#333;background:#fff;">
  <div style="background:#222;color:#fff;padding:16px 20px;text-align:center;">
    <h2 style="margin:0;font-size:18px;font-weight:bold;">${safeName}</h2>
  </div>
  ${thumbHtml}
  <div style="padding:20px;">
    <h3 style="font-size:15px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:0;">상품정보제공고시</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${rows.join("\n")}
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#777;line-height:1.7;">
      · 위 정보는 식품의약품안전처 식품안전나라 품목제조보고 자료를 기준으로 작성되었습니다.<br>
      · 제조사 사정에 따라 원재료·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.
    </p>
  </div>
</div>`;
}

// ── 대상 조회 ──
const { data: products, error } = await sb
  .from("products")
  .select("id, product_name, thumbnail_url, detail_html, item_info")
  .eq("rebuild_status", "조사완료")
  .order("sort_order");
if (error) { console.error("[regen] 조회 실패:", error.message); process.exit(1); }

const targets = [];
let skipped = 0;
for (const p of products) {
  const html = buildDetailHtml(p.product_name, p.thumbnail_url, p.item_info);
  if (!html) { skipped++; continue; }
  targets.push({ ...p, newHtml: html });
}

// 외부(원본 판매처) 이미지 참조가 제거되는지 집계
const EXTERNAL = /gi\.esmplus\.com|amazonaws\.com|gmarket|auction|11st|coupangcdn/i;
const hadExternal = targets.filter((t) => t.detail_html && EXTERNAL.test(t.detail_html)).length;
const stillExternal = targets.filter((t) => EXTERNAL.test(t.newHtml)).length;

console.log(`[regen] 조사완료 ${products.length}개 중 재생성 대상 ${targets.length}개 (스킵 ${skipped}개)`);
console.log(`  · 기존 HTML에 외부 판매처 이미지 참조: ${hadExternal}개 → 재생성 후: ${stillExternal}개`);
console.log(`  · 방식: detail_html 전체 교체(덮어쓰기). 기존 내용은 남지 않으므로 중복 없음\n`);

const sample = targets[0];
if (sample) {
  console.log(`── 미리보기: ${sample.product_name} ──`);
  console.log(`기존 길이 ${sample.detail_html?.length ?? 0}자 → 신규 길이 ${sample.newHtml.length}자`);
  console.log(sample.newHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500), "...\n");
}

if (!APPLY) {
  console.log("※ 미리보기 모드입니다. 실제 적용하려면 --apply 옵션을 붙여 다시 실행하세요.");
  process.exit(0);
}

// ── 적용 전 기존 HTML 백업 ──
fs.mkdirSync("backups", { recursive: true });
const stamp = "20260822";
const backupFile = path.join("backups", `detail_html_before_regen_${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify(targets.map((t) => ({ id: t.id, product_name: t.product_name, detail_html: t.detail_html })), null, 1));
console.log(`백업 저장: ${backupFile} (${targets.length}개)`);

let ok = 0, fail = 0;
for (const t of targets) {
  const { error: ue } = await sb.from("products").update({ detail_html: t.newHtml }).eq("id", t.id);
  if (ue) { console.log("실패:", t.product_name, ue.message); fail++; }
  else ok++;
}
console.log(`[regen] 적용 완료 ${ok}건 / 실패 ${fail}건`);
