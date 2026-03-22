import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { groundedSearch } from "@/lib/gemini";
import { launchBrowser } from "@/lib/scrapers/browser";

export const maxDuration = 300;

interface RequestBody {
  productId: string;
  productName: string;
  purchaseUrl: string;
  thumbnailUrl: string | null;
}

type SpecValue = string | string[] | Record<string, string | number> | undefined;

interface ProductSpecs {
  [key: string]: SpecValue;
}

/** 어떤 타입의 값이든 표시용 문자열로 변환 */
function specValueToString(key: string, value: SpecValue): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.map((v) => `• ${v}`).join("<br>");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) => `${k}: ${v}`)
      .join("<br>");
  }
  const str = String(value);
  if (key === "영양성분") {
    return str.replace(/,\s*/g, "<br>").replace(/;\s*/g, "<br>");
  }
  return str.replace(/\n/g, "<br>");
}

// 한국 식품 표시 법정 순서
const FIELD_ORDER = [
  "제품명", "품목명", "식품유형", "용량", "브랜드",
  "생산자", "수입자", "제조원", "판매원",
  "소비기한", "유통기한", "제조연월일",
  "원재료", "성분", "영양성분", "주의사항",
  "원산지", "인증정보", "보관방법",
];

const PLACEHOLDER_RE = /^(상품?\s*상세\s*(페이지\s*)?(참조|기재)|상세\s*설명\s*참조|상세\s*페이지\s*(참조|기재)|해당\s*사항?\s*없음|해당\s*없음|상세\s*참조|별도\s*표기|후면\s*표기|제품\s*참조|판매자\s*정보\s*참조|별도\s*표시|제품\s*표시사항\s*참조|-+)$/i;

function isPlaceholder(value: SpecValue): boolean {
  if (!value) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return PLACEHOLDER_RE.test(String(value).trim());
}

function countFilledFields(specs: ProductSpecs): number {
  return Object.values(specs).filter((v) => !isPlaceholder(v as SpecValue)).length;
}

function buildDetailHtml(productName: string, thumbnailUrl: string | null, specs: ProductSpecs): string {
  const allKeys = Object.keys(specs).filter((k) => {
    const v = specs[k];
    if (!v) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim().length > 0;
  });
  const orderedKeys = [
    ...FIELD_ORDER.filter((k) => allKeys.includes(k)),
    ...allKeys.filter((k) => !FIELD_ORDER.includes(k)),
  ];

  const specRows = orderedKeys
    .map((key) => {
      const displayValue = specValueToString(key, specs[key]);
      return `<tr>
      <td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:140px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${key}</td>
      <td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${displayValue}</td>
    </tr>`;
    })
    .join("\n");

  const thumbHtml = thumbnailUrl
    ? `<div style="text-align:center;padding:20px 0;">
    <img src="${thumbnailUrl}" alt="${productName}" style="max-width:800px;width:100%;height:auto;display:block;margin:0 auto;">
  </div>`
    : "";

  return `<div style="max-width:1000px;margin:0 auto;font-family:'맑은 고딕',sans-serif;font-size:14px;color:#333;background:#fff;">
  <div style="background:#222;color:#fff;padding:16px 20px;text-align:center;">
    <h2 style="margin:0;font-size:18px;font-weight:bold;">${productName}</h2>
  </div>
  ${thumbHtml}
  <div style="padding:20px;">
    <h3 style="font-size:15px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:0;">상품 정보</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${specRows || '<tr><td style="padding:16px;text-align:center;color:#999;">상세 정보 없음</td></tr>'}
    </table>
  </div>
</div>`;
}

/**
 * Gemini 웹 검색 Grounding으로 상품 정보를 직접 검색하여 상세페이지 생성.
 *
 * 데이터 소스:
 * 1. 식품의약품안전처(식약처) 식품안전나라 — 품목제조보고 공식 등록 정보
 * 2. 제조사 공식 홈페이지 — 상품정보제공고시, 영양성분표
 * 3. 쿠팡/마켓컬리/SSG 등 대형 유통사 — 뒷면 라벨 데이터
 */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const { productId, productName, purchaseUrl, thumbnailUrl } = body;
  if (!productId || !productName) {
    return NextResponse.json({ error: "productId와 productName 필요" }, { status: 400 });
  }

  // ── 1. Gemini 웹 검색 Grounding으로 상품 정보 검색 ────────────────────────
  const groundingPrompt = `아래 제품의 정확한 상품 정보를 검색해서 알려주세요.

제품명: ${productName}
${purchaseUrl ? `판매 URL: ${purchaseUrl}` : ""}

검색 우선순위:
1. 식품의약품안전처(식약처) 식품안전나라 — 품목제조보고 공식 등록 정보
2. 제조사 공식 홈페이지 (예: CJ제일제당, 동원F&B, 삼양식품 등) — 상품정보제공고시, 영양성분표
3. 쿠팡, 마켓컬리, SSG닷컴 등 대형 유통사 — 제품 상세페이지의 상품정보제공고시

아래 JSON 형식으로만 응답하세요 (코드블록 없이, 순수 JSON만):
{
  "제품명": "",
  "품목명": "",
  "식품유형": "",
  "용량": "",
  "브랜드": "",
  "원재료": "",
  "영양성분": "",
  "보관방법": "",
  "주의사항": [],
  "제조원": "",
  "판매원": "",
  "생산자": "",
  "소비기한": "",
  "유통기한": "",
  "원산지": "",
  "인증정보": ""
}

규칙:
- 반드시 공식 데이터 소스에서 검색한 실제 정보만 기입
- 확인할 수 없는 항목은 빈 문자열로 두세요
- 영양성분은 "열량 XXkcal, 나트륨 XXmg(X%), 탄수화물 XXg(X%)" 형태로 한 줄 정리
- 원재료는 실제 제품 라벨에 표기된 전체 내용 기입
- "상세페이지 참조" 같은 의미없는 값은 절대 넣지 마세요
- 추가 설명 없이 JSON만 출력`;

  console.log("[detail] Gemini Grounding 검색 시작:", productName);
  const groundedResult = await groundedSearch(groundingPrompt);

  let specs: ProductSpecs = {};
  if (groundedResult) {
    try {
      const cleaned = groundedResult.replace(/```json\n?|\n?```/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as ProductSpecs;
        // placeholder 제거
        for (const [key, value] of Object.entries(parsed)) {
          if (!isPlaceholder(value as SpecValue)) {
            specs[key] = value as SpecValue;
          }
        }
      }
    } catch {
      console.warn("[detail] Gemini JSON 파싱 실패");
    }
  }

  console.log("[detail] Gemini Grounding 결과:", countFilledFields(specs), "개 필드");

  // ── 2. 결과 부족 시 2차 검색 (다른 각도로) ─────────────────────────────────
  if (countFilledFields(specs) < 3) {
    console.log("[detail] 1차 결과 부족, 2차 검색 시도");
    const fallbackPrompt = `"${productName}" 제품의 뒷면 라벨 정보를 검색해주세요.

쿠팡, 네이버 쇼핑, 11번가 등에서 이 제품의 상품정보제공고시(상품정보 테이블)를 찾아주세요.

아래 JSON 형식으로만 응답하세요 (코드블록 없이, 순수 JSON만):
{
  "제품명": "",
  "품목명": "",
  "식품유형": "",
  "용량": "",
  "브랜드": "",
  "원재료": "",
  "영양성분": "",
  "보관방법": "",
  "주의사항": [],
  "제조원": "",
  "판매원": "",
  "소비기한": "",
  "유통기한": "",
  "원산지": ""
}

규칙:
- 검색으로 확인된 실제 정보만 기입
- 확인할 수 없는 항목은 빈 문자열
- 추가 설명 없이 JSON만 출력`;

    const fallbackResult = await groundedSearch(fallbackPrompt);
    if (fallbackResult) {
      try {
        const cleaned = fallbackResult.replace(/```json\n?|\n?```/g, "").trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as ProductSpecs;
          for (const [key, value] of Object.entries(parsed)) {
            if (!isPlaceholder(value as SpecValue) && isPlaceholder(specs[key])) {
              specs[key] = value as SpecValue;
            }
          }
        }
      } catch {
        // 무시
      }
    }
    console.log("[detail] 2차 검색 후:", countFilledFields(specs), "개 필드");
  }

  if (countFilledFields(specs) === 0) {
    return NextResponse.json(
      { error: "상품 정보를 검색할 수 없습니다. 상품명을 확인해주세요." },
      { status: 422 }
    );
  }

  // ── 3. HTML 생성 ────────────────────────────────────────────────────────
  const detailHtml = buildDetailHtml(productName, thumbnailUrl, specs);

  // 스크린샷용: 썸네일을 base64로 변환
  let screenshotThumbnail: string | null = thumbnailUrl;
  if (thumbnailUrl) {
    try {
      const imgRes = await fetch(thumbnailUrl);
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get("content-type") || "image/jpeg";
        screenshotThumbnail = `data:${ct};base64,${buf.toString("base64")}`;
      }
    } catch (e) {
      console.warn("[detail] 썸네일 fetch 오류:", (e as Error).message);
    }
  }
  const screenshotHtml = buildDetailHtml(productName, screenshotThumbnail, specs);

  // ── 4. Playwright로 HTML → PNG 스크린샷 ────────────────────────────────
  const serviceClient = getServiceSupabaseClient();
  let detailImageUrl: string | null = null;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    browser = await launchBrowser();
    const screenshotCtx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await screenshotCtx.newPage();

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;background:#fff;}</style></head><body>${screenshotHtml}</body></html>`;
    await page.setContent(fullHtml, { waitUntil: "load" });

    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 1000, height: Math.max(height, 100) });

    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    await screenshotCtx.close();

    const storagePath = `products/${user.id}/ai_detail_${Date.now()}.png`;
    const { error: uploadError } = await serviceClient.storage
      .from("product-images")
      .upload(storagePath, screenshot, { contentType: "image/png", upsert: true });

    if (!uploadError) {
      const { data: { publicUrl } } = serviceClient.storage
        .from("product-images")
        .getPublicUrl(storagePath);
      detailImageUrl = publicUrl;
    }
  } catch (e) {
    console.error("[detail] Playwright 스크린샷 실패:", e);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // ── 5. DB 업데이트 ───────────────────────────────────────────────────────
  const { error: updateError } = await serviceClient
    .from("products")
    .update({ detail_html: detailHtml, detail_image_url: detailImageUrl })
    .eq("id", productId)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "DB 업데이트 실패" }, { status: 500 });
  }

  return NextResponse.json({
    detailHtml,
    detailImageUrl,
    specsFound: countFilledFields(specs),
  });
}
