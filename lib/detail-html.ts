/**
 * 상세페이지 HTML 생성 (공용)
 *
 * 식약처 품목제조보고에서 수집한 item_info를 근거로 상세페이지를 만든다.
 * 원본 판매처의 상세 이미지·문구를 일절 포함하지 않아 저작권/개인정보 침해 소지가 없고,
 * 상품정보제공고시 필수 항목이 본문에 노출되어 필수표기 누락에도 해당하지 않는다.
 */

/** HTML 특수문자 이스케이프 (XSS 방지) */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 내부 관리용 [검수필요...] 태그는 고객에게 노출하지 않는다 */
function stripInternalTags(value: string): string {
  return value
    .replace(/\s*\[검수필요[^\]]*\]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+\)/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** item_info에서 상세페이지에 노출할 항목만 순서대로 추출 */
const DISPLAY_FIELDS: Array<{ key: string; label: string }> = [
  { key: "제품명", label: "제품명" },
  { key: "식품유형", label: "식품의 유형" },
  { key: "제조원", label: "생산자 및 소재지" },
  { key: "판매원", label: "판매원" },
  { key: "소비기한", label: "소비기한" },
  { key: "포장단위별용량", label: "포장단위별 용량·수량" },
  { key: "원재료명", label: "원재료명 및 함량" },
  { key: "영양성분", label: "영양성분" },
  { key: "품목보고번호", label: "품목보고번호" },
  { key: "유전자변형식품", label: "유전자변형식품 여부" },
  { key: "소비자안전주의사항", label: "소비자안전을 위한 주의사항" },
  { key: "수입여부", label: "수입식품 여부" },
  { key: "소비자상담번호", label: "소비자상담 관련 전화번호" },
];

export function buildDetailHtmlFromItemInfo(
  productName: string,
  thumbnailUrl: string | null,
  itemInfo: Record<string, string> | null
): string | null {
  if (!itemInfo || itemInfo.스킵사유) return null;

  const rows = DISPLAY_FIELDS.map(({ key, label }) => {
    const raw = itemInfo[key];
    if (!raw) return null;
    const value = stripInternalTags(String(raw));
    if (!value) return null;
    return `<tr>
      <td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:160px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${escapeHtml(value)}</td>
    </tr>`;
  }).filter(Boolean);

  if (rows.length === 0) return null;

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
