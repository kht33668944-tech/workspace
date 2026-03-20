import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { analyzeImageFromUrl, groundedSearch } from "@/lib/gemini";
import { launchBrowser, createGmarketContext } from "@/lib/scrapers/browser";

export const maxDuration = 300;

interface RequestBody {
  productId: string;
  productName: string;
  purchaseUrl: string;
  thumbnailUrl: string | null;
}

type SpecValue = string | string[] | Record<string, string | number> | undefined;

interface ProductSpecs {
  품목명?: string;
  제품명?: string;
  식품유형?: string;
  용량?: string;
  원재료?: string;
  성분?: string;
  영양성분?: string | Record<string, string | number>;
  주의사항?: string[];
  제조원?: string;
  판매원?: string;
  생산자?: string;
  수입자?: string;
  소비기한?: string;
  유통기한?: string;
  제조연월일?: string;
  원산지?: string;
  인증정보?: string;
  [key: string]: SpecValue;
}

/** 어떤 타입의 값이든 표시용 문자열로 변환 */
function specValueToString(key: string, value: SpecValue): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.map((v) => `• ${v}`).join("<br>");
  if (typeof value === "object") {
    // 영양성분 등 중첩 객체: "열량: 95kcal, 나트륨: 85mg(4%)" 형태로 한 줄씩
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

// 한국 식품 표시 법정 순서에 맞는 출력 키 우선순위
const FIELD_ORDER = [
  "제품명", "품목명", "식품유형", "용량", "생산자", "수입자", "제조원", "판매원",
  "소비기한", "유통기한", "제조연월일", "원재료", "성분", "영양성분", "주의사항",
  "원산지", "인증정보",
];

const OCR_PROMPT = `이 상품 상세 이미지에서 상품 정보/스펙을 모두 추출해주세요.

아래 JSON 형식으로만 응답하세요 (코드블록 없이, 순수 JSON만):
{
  "제품명": "",
  "품목명": "",
  "식품유형": "",
  "용량/규격": "",
  "원재료 및 함량": "",
  "영양성분": "",
  "소비기한": "",
  "유통기한": "",
  "제조원": "",
  "판매원": "",
  "원산지": "",
  "주의사항": [],
  "인증/허가": "",
  "기타": ""
}

규칙:
- 이미지에 보이는 텍스트를 그대로 추출하세요
- 영양성분표가 있으면 "열량 55kcal, 나트륨 85mg(4%), 탄수화물 12g(4%)" 형태로 한 줄 정리
- 상품 정보가 없는 이미지(광고/배너/배송안내)면 모든 값을 빈 문자열로 두세요
- 추출할 수 없는 항목은 빈 문자열로 두세요
- 없는 키를 추가하지 마세요`;

// "상품상세참조" 등 의미없는 placeholder 패턴
const PLACEHOLDER_RE = /^(상품\s*상세\s*참조|상세\s*설명\s*참조|상세\s*페이지\s*기재|해당\s*사항?\s*없음|해당\s*없음|상세\s*참조|별도\s*표기|후면\s*표기|제품\s*참조)$/i;

function isPlaceholder(value: SpecValue): boolean {
  if (!value) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return PLACEHOLDER_RE.test(String(value).trim());
}

/** 첫 번째로 넣은 specs가 우선, 뒤에 오는 것은 빈 칸 채우기 */
function mergeSpecs(specsList: ProductSpecs[]): ProductSpecs {
  const merged: ProductSpecs = {};
  for (const specs of specsList) {
    for (const [key, value] of Object.entries(specs)) {
      if (isPlaceholder(value as SpecValue)) continue;
      const existing = merged[key];
      if (isPlaceholder(existing)) {
        merged[key] = value as SpecValue;
      }
    }
  }
  return merged;
}

function countFilledFields(specs: ProductSpecs): number {
  return Object.values(specs).filter((v) => !isPlaceholder(v as SpecValue)).length;
}

function buildDetailHtml(productName: string, thumbnailUrl: string | null, specs: ProductSpecs): string {
  // 우선순위 순으로 정렬 후 나머지 키 추가
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

  // ── 1. G마켓 상세페이지 스크래핑 + 5. 스크린샷에 브라우저 재사용 ─────────
  let detailImageUrls: string[] = [];
  let htmlTableSpecs: ProductSpecs = {};
  let sharedBrowser: Awaited<ReturnType<typeof launchBrowser>> | null = null;

  if (purchaseUrl) {
    try {
      sharedBrowser = await launchBrowser();
      const ctx = await createGmarketContext(sharedBrowser);

      // ── 1-A. 메인 상품 페이지: 상품정보고시 테이블 파싱 ──────
      const mainPage = await ctx.newPage();
      await mainPage.goto(purchaseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await mainPage.waitForSelector(".box__product-notice-list", { timeout: 8000 }).catch(() => {});

      const { tableSpecs, iframeSrc } = await mainPage.evaluate((): {
        tableSpecs: Record<string, string>;
        iframeSrc: string;
      } => {
        const result: Record<string, string> = {};

        // 상품정보고시 테이블 (.box__product-notice-list > table.table_productinfo)
        const noticeBox = document.querySelector(".box__product-notice-list");
        if (noticeBox) {
          noticeBox.querySelectorAll("table.table_productinfo tr").forEach((row) => {
            const cells = row.querySelectorAll("th, td");
            if (cells.length >= 2) {
              const key = (cells[0].textContent ?? "").replace(/\s+/g, " ").trim();
              const value = (cells[1].textContent ?? "").replace(/\s+/g, " ").trim();
              // 유의미한 값만 (단순 "상세페이지 기재"는 skip)
              if (key && value && key.length < 40 && !["상품번호", "부가세 면세여부", "영수증발행", "사업자구분", "과세자구분", "주문후 예상 배송기간"].includes(key)) {
                result[key] = value;
              }
            }
          });
        }

        // 상세설명 iframe src 추출
        const iframe = document.querySelector<HTMLIFrameElement>("iframe#detail1, iframe[id*='detail']");
        return { tableSpecs: result, iframeSrc: iframe?.src ?? "" };
      });

      htmlTableSpecs = tableSpecs as ProductSpecs;
      console.log("[detail] 상품정보고시:", Object.keys(htmlTableSpecs).length, "개 필드, iframe:", iframeSrc ? "있음" : "없음");
      await mainPage.close();

      // ── 1-B. 상세설명 iframe: 판매자 업로드 이미지 추출 ───────
      if (iframeSrc) {
        const iframePage = await ctx.newPage();
        await iframePage.goto(iframeSrc, { waitUntil: "domcontentloaded", timeout: 30000 });
        await iframePage.waitForSelector('img[alt="상품 상세 이미지입니다."]', { timeout: 8000 }).catch(() => {});

        detailImageUrls = await iframePage.evaluate((): string[] => {
          // 1순위: 상세 이미지 alt 표준 텍스트
          const stdImgs = Array.from(
            document.querySelectorAll<HTMLImageElement>('img[alt="상품 상세 이미지입니다."]')
          ).map((img) => img.src).filter((s) => s.startsWith("http"));

          if (stdImgs.length > 0) return stdImgs;

          // 2순위: 모든 img (btn/icon/banner 제외)
          return Array.from(document.querySelectorAll<HTMLImageElement>("img"))
            .map((img) => img.src || img.dataset.src || "")
            .filter((s) => s.startsWith("http") && !s.includes("btn") && !s.includes("icon") && !s.includes("banner") && !s.includes("stardelivery"));
        });

        console.log("[detail] 상세 이미지:", detailImageUrls.length, "장");
        await iframePage.close();
      }
    } catch (e) {
      console.warn("[detail] 스크래핑 실패:", e);
      // 스크래핑 실패 시 브라우저 닫기 (스크린샷에서 재사용 불가)
      if (sharedBrowser) { await sharedBrowser.close().catch(() => {}); sharedBrowser = null; }
    }
  }

  // 아무 데이터도 없으면 에러
  const hasHtmlData = Object.keys(htmlTableSpecs).length >= 2;
  if (detailImageUrls.length === 0 && !hasHtmlData) {
    return NextResponse.json({ error: "상세페이지 정보를 찾을 수 없습니다. G마켓 상품 URL이 맞는지 확인해주세요." }, { status: 422 });
  }

  // ── 2. OCR: 최대 8장 병렬 분석 ──────────────────────────────────────────
  const specsList: ProductSpecs[] = [];

  if (detailImageUrls.length > 0) {
    const urlsToOcr = detailImageUrls.slice(0, 8);
    const ocrResults = await Promise.allSettled(
      urlsToOcr.map((url) => analyzeImageFromUrl(url, OCR_PROMPT))
    );

    for (const result of ocrResults) {
      if (result.status === "fulfilled" && result.value) {
        try {
          const cleaned = result.value.replace(/```json\n?|\n?```/g, "").trim();
          const parsed = JSON.parse(cleaned) as ProductSpecs;
          specsList.push(parsed);
        } catch {
          // 파싱 실패 무시
        }
      }
    }
  }

  // 병합 우선순위: HTML 테이블 실제값 우선, OCR이 나머지 채움
  // mergeSpecs 내부에서 placeholder 자동 제거되므로 별도 필터 불필요
  let mergedSpecs = mergeSpecs([htmlTableSpecs, ...specsList]);

  // ── 3. 웹 검색 Grounding (스펙 부족 시) ────────────────────────────────
  if (countFilledFields(mergedSpecs) < 4) {
    const groundingPrompt = `아래 제품의 공식 스펙 정보를 검색해서 알려주세요.
제품명: ${productName}

아래 JSON 형식으로만 응답해주세요:
{
  "품목명": "",
  "제품명": "",
  "식품유형": "",
  "용량": "",
  "원재료": "",
  "성분": "",
  "영양성분": "",
  "주의사항": [],
  "제조원": "",
  "판매원": "",
  "생산자": "",
  "소비기한": "",
  "유통기한": "",
  "원산지": ""
}`;
    const groundedResult = await groundedSearch(groundingPrompt);
    if (groundedResult) {
      try {
        const cleaned = groundedResult.replace(/```json\n?|\n?```/g, "").trim();
        const groundedSpecs = JSON.parse(cleaned) as ProductSpecs;
        mergedSpecs = mergeSpecs([mergedSpecs, groundedSpecs]);
      } catch {
        // 파싱 실패 무시
      }
    }
  }

  // ── 4. HTML 생성 ────────────────────────────────────────────────────────
  // DB 저장/복사용: 원본 URL 유지 (가벼운 HTML)
  const detailHtml = buildDetailHtml(productName, thumbnailUrl, mergedSpecs);

  // 스크린샷용: 썸네일을 서버에서 fetch해 base64로 변환 후 buildDetailHtml 재호출
  // - page.route()는 setContent()에서 인터셉트 안 될 수 있어서 base64 임베드 방식 사용
  // - String.replace() 쓰지 않고 buildDetailHtml 재호출 → base64의 $ 치환 오작동 방지
  let screenshotThumbnail: string | null = thumbnailUrl;
  if (thumbnailUrl) {
    try {
      const imgRes = await fetch(thumbnailUrl);
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get("content-type") || "image/jpeg";
        screenshotThumbnail = `data:${ct};base64,${buf.toString("base64")}`;
        console.log("[detail] 썸네일 base64 변환 성공, bytes:", buf.length);
      } else {
        console.warn("[detail] 썸네일 fetch 실패, status:", imgRes.status, thumbnailUrl.slice(-60));
      }
    } catch (e) {
      console.warn("[detail] 썸네일 fetch 오류:", (e as Error).message, thumbnailUrl.slice(-60));
    }
  }
  const screenshotHtml = buildDetailHtml(productName, screenshotThumbnail, mergedSpecs);

  // ── 5. Playwright로 HTML → PNG 스크린샷 (스크래핑 브라우저 재사용) ────────
  const serviceClient = getServiceSupabaseClient();
  let detailImageUrl: string | null = null;
  try {
    // 스크래핑에 사용한 브라우저 재사용, 없으면 새로 생성
    if (!sharedBrowser) sharedBrowser = await launchBrowser();
    const screenshotCtx = await sharedBrowser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await screenshotCtx.newPage();

    // base64 임베드된 HTML 사용 → 외부 이미지 요청 없음
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;background:#fff;}</style></head><body>${screenshotHtml}</body></html>`;
    await page.setContent(fullHtml, { waitUntil: "load" });

    // 실제 콘텐츠 높이에 맞게 뷰포트 재설정
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 1000, height: Math.max(height, 100) });

    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    await screenshotCtx.close();

    // Supabase Storage 업로드
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
    // 이미지 생성 실패해도 HTML은 저장
  } finally {
    if (sharedBrowser) await sharedBrowser.close().catch(() => {});
  }

  // ── 6. DB 업데이트 ───────────────────────────────────────────────────────
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
    specsFound: countFilledFields(mergedSpecs),
    htmlTableFields: Object.keys(htmlTableSpecs).length,
    usedGrounding: countFilledFields(mergedSpecs) < 4,
  });
}
