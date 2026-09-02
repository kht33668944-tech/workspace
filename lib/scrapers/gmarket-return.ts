// 지마켓 구매자 반품신청 자동화 스크래퍼
// 흐름(주문상세 → 반품신청 모달): 사유 선택 → 상세사유 입력 → 다음 → 수거방법(기본값) → 다음
//   → [반품비 구매자 부담이면] "환불금액에서 차감" 선택 → 반품 신청하기
// - 고객 반품사유(claim_reason) 키워드로 지마켓 3가지 사유 중 하나를 고른다
//   · 불량/파손 계열 → "상품이 불량이에요" (반품비 판매자 부담 — 결제방법 화면 없음)
//   · 오배송 계열   → "상품이 오배송 됐어요" (〃)
//   · 그 외/단순변심 → "마음이 변했어요" (반품비 구매자 부담 → 환불금액에서 차감)
// - dryRun: "반품 신청하기" 직전까지 진행해 선택 내용을 보고하고 모달을 닫는다 (신청 없음)

import type { BrowserContext, Page, Frame } from "playwright";
import { isBotChallengeText, clickBotChallengeCheckbox } from "@/lib/scrapers/gmarket-purchase";

/** 지마켓 반품 UI 는 mcrex.gmarket.co.kr/Return/* iframe 안에서 렌더된다 (단계마다 URL 변경) */
const RETURN_FRAME_RE = /mcrex\.gmarket\.co\.kr\/Return/i;
/** 사유 라벨 → iframe 라디오 id (실측: 2026-09-02) */
const REASON_RADIO_ID: Record<GmarketReturnReason, string> = {
  "마음이 변했어요": "#radio01",
  "상품이 불량이에요": "#radio02",
  "상품이 오배송 됐어요": "#radio03",
};

export type GmarketReturnReason = "마음이 변했어요" | "상품이 불량이에요" | "상품이 오배송 됐어요";

export interface GmarketReturnInput {
  detailUrl: string;        // orders.purchase_detail_url (my.gmarket.co.kr/ko/pc/detail/basic/{payNo})
  claimReason: string | null; // 고객 반품/교환 사유 원문
  dryRun: boolean;
}

export interface GmarketReturnResult {
  ok: boolean;
  dryRun: boolean;
  selectedReason: GmarketReturnReason;
  detailText: string;        // 입력한 상세 사유
  returnFeeText: string | null; // 화면에 표시된 반품배송비 (있으면)
  error?: string;            // 실패 시 단계명 포함 메시지
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 고객 사유 → 지마켓 반품사유 매핑 */
export function mapClaimReason(claimReason: string | null | undefined): GmarketReturnReason {
  const raw = (claimReason ?? "").trim();
  if (/불량|파손|하자|손상|깨|찢|터|변질|부패|유통기한/.test(raw)) return "상품이 불량이에요";
  if (/오배송|다른\s*상품|잘못\s*(배송|온|왔)|주문한\s*상품과\s*다/.test(raw)) return "상품이 오배송 됐어요";
  return "마음이 변했어요";
}

/** 상세 사유 텍스트 — 고객 사유 인용 (지마켓 100자 제한) */
export function buildDetailText(claimReason: string | null | undefined): string {
  const raw = (claimReason ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "반품 신청합니다.";
  return raw.length > 100 ? raw.slice(0, 100) : raw;
}

/** 주문상세 진입 시 봇 확인 화면 대응 (텍스트 기반 — 상품 DOM 셀렉터는 주문상세에 없음) */
async function handleBotChallengeOnDetail(page: Page): Promise<void> {
  const text = await page.evaluate(() => `${document.title}\n${document.body?.innerText || ""}`).catch(() => "");
  if (!isBotChallengeText(text)) return;
  console.warn("[gmarket-return] 봇 확인 화면 감지 → 체크박스 처리 시도");
  await clickBotChallengeCheckbox(page);
  await sleep(1500);
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await sleep(2000);
  const after = await page.evaluate(() => `${document.title}\n${document.body?.innerText || ""}`).catch(() => "");
  if (isBotChallengeText(after)) throw new Error("봇 확인 화면을 통과하지 못했습니다");
  console.log("[gmarket-return] 봇 확인 화면 통과");
}

/** 반품 iframe(mcrex.gmarket.co.kr/Return)을 재조회 — 단계마다 URL 이 바뀌므로 매번 새로 찾는다 */
async function getReturnFrame(page: Page, timeoutMs = 12000): Promise<Frame | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const f = page.frames().find((fr) => RETURN_FRAME_RE.test(fr.url()));
    if (f) return f;
    await sleep(300);
  }
  return null;
}

/** iframe/페이지 안에서 텍스트로 요소 클릭 (라벨 행·버튼·링크 공용) */
async function clickByText(scope: Frame | Page, text: string, step: string): Promise<void> {
  const target = scope.locator(`label:has-text("${text}"), button:has-text("${text}"), a:has-text("${text}"), [role="radio"]:has-text("${text}"), li:has-text("${text}")`).first();
  try {
    await target.waitFor({ state: "visible", timeout: 8000 });
    await target.click();
  } catch {
    const fallback = scope.getByText(text, { exact: false }).first();
    try {
      await fallback.click({ timeout: 4000 });
    } catch {
      throw new Error(`${step}: "${text}" 요소를 찾지 못했습니다`);
    }
  }
}

/**
 * 지마켓 주문상세에서 반품신청 1건 처리.
 * 컨텍스트는 이미 로그인 상태여야 한다 (gmarket-session.ensureLogin).
 */
export async function requestGmarketReturn(ctx: BrowserContext, input: GmarketReturnInput): Promise<GmarketReturnResult> {
  const selectedReason = mapClaimReason(input.claimReason);
  const detailText = buildDetailText(input.claimReason);
  const base: GmarketReturnResult = { ok: false, dryRun: input.dryRun, selectedReason, detailText, returnFeeText: null };
  const page = await ctx.newPage();

  try {
    // 1. 주문상세 진입
    await page.goto(input.detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    await handleBotChallengeOnDetail(page);

    // 2. 반품신청 버튼 — 여러 개면(묶음 주문) 자동 처리하지 않는다 (잘못된 상품 반품 방지)
    const returnButtons = page.locator('button:has-text("반품신청"), a:has-text("반품신청")');
    const buttonCount = await returnButtons.count();
    if (buttonCount === 0) {
      const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const hint = /반품\s*진행|반품\s*완료|반품\s*접수/.test(bodyText) ? " (이미 반품이 진행 중인 것으로 보입니다)" : "";
      return { ...base, error: `반품신청 버튼 없음${hint}` };
    }
    if (buttonCount > 1) {
      return { ...base, error: `반품신청 버튼이 ${buttonCount}개 — 묶음 주문은 수동 처리 필요` };
    }
    await returnButtons.first().click();

    // 3. 반품 iframe(mcrex.gmarket.co.kr/Return) 대기 — 반품 UI 는 전부 이 iframe 안에 있다
    let frame = await getReturnFrame(page);
    if (!frame) throw new Error("반품 화면(iframe)이 열리지 않았습니다");
    await frame.getByText("반품사유를 선택하세요").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {
      throw new Error("사유 선택 화면이 열리지 않았습니다");
    });

    // 4. 사유 선택 — 실측 라디오 id 우선, 실패 시 라벨 텍스트
    const radioId = REASON_RADIO_ID[selectedReason];
    const radio = frame.locator(radioId).first();
    if (await radio.count() > 0) {
      await radio.check({ force: true }).catch(async () => { await clickByText(frame!, selectedReason, "사유 선택"); });
    } else {
      await clickByText(frame, selectedReason, "사유 선택");
    }
    await sleep(800);

    // 5. 상세 사유 입력 (사유 선택 후 textarea 노출)
    const textarea = frame.locator("textarea").first();
    if (await textarea.isVisible({ timeout: 4000 }).catch(() => false)) {
      await textarea.fill(detailText);
    }
    await clickByText(frame, "다음", "사유 다음");
    await sleep(1500);

    // 6. 수거방법 화면 — "배송받은 택배사에서 재방문" 기본 선택 확인 후 다음
    frame = (await getReturnFrame(page)) ?? frame;
    const pickupText = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (/상품 보낼 방법|택배사에서 재방문|보내실 방법/.test(pickupText)) {
      if (/배송받은 택배사에서 재방문/.test(pickupText)) {
        await clickByText(frame, "배송받은 택배사에서 재방문", "수거방법 선택").catch(() => {});
      }
      await clickByText(frame, "다음", "수거방법 다음");
      await sleep(1500);
      frame = (await getReturnFrame(page)) ?? frame;
    }

    // 7. 마지막 화면 — 반품비 부담 여부에 따라 "결제방법 선택" 이 있을 수도(구매자 부담) 없을 수도(판매자 부담) 있다.
    //    "다음" 클릭 후 iframe 이 새 URL 로 넘어가는 타이밍이 있어, 신청 버튼을 프레임 재조회하며 폴링한다.
    const submitSel = 'button:has-text("반품 신청하기"), a:has-text("반품 신청하기")';
    let submitBtn = frame.locator(submitSel).first();
    const submitDeadline = Date.now() + 15000;
    while (Date.now() < submitDeadline) {
      frame = (await getReturnFrame(page, 2000)) ?? frame;
      submitBtn = frame.locator(submitSel).first();
      if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) break;
      await sleep(700);
    }
    if (!(await submitBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
      throw new Error("반품 신청하기 버튼이 나타나지 않았습니다");
    }

    const finalText = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
    const feeMatch = finalText.match(/반품배송비\s*([\d,]+원)/);
    base.returnFeeText = feeMatch ? feeMatch[1] : null;

    if (/반품비용 결제방법|환불금액에서 차감/.test(finalText)) {
      // 구매자 부담 — 무조건 환불금액에서 차감
      await clickByText(frame, "환불금액에서 차감", "결제방법 선택");
      await sleep(500);
    }

    // 8. 드라이런이면 여기서 중단 — 신청 안 하고 보고만
    if (input.dryRun) {
      console.log(`[gmarket-return] [DRY] 신청 직전 중단 — 사유 "${selectedReason}", 반품배송비 ${base.returnFeeText ?? "0원/미표시"}`);
      return { ...base, ok: true };
    }

    // 9. 실제 신청
    await submitBtn.click();
    await sleep(3000);
    // 완료 판정: iframe 이 닫히거나(반품 프레임 사라짐) 완료 문구 노출
    const gone = !(await getReturnFrame(page, 1500));
    const afterFrame = page.frames().find((fr) => RETURN_FRAME_RE.test(fr.url()));
    const afterText = afterFrame ? await afterFrame.evaluate(() => document.body?.innerText || "").catch(() => "") : "";
    if (!gone && !/신청.*완료|접수.*완료|반품.*접수|처리.*완료/.test(afterText)) {
      return { ...base, error: "신청 클릭 후 완료를 확인하지 못했습니다 — 지마켓에서 직접 확인 필요" };
    }
    console.log(`[gmarket-return] 반품신청 완료 — 사유 "${selectedReason}", 반품배송비 ${base.returnFeeText ?? "0원/미표시"}`);
    return { ...base, ok: true };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await page.close().catch(() => {});
  }
}

export type GmarketReturnProgress = "접수" | "완료" | "기타";

/**
 * basic 구매상세페이지 상단 텍스트로 반품 진행상태를 읽는다 (읽기 전용, 아무것도 클릭 안 함).
 * "반품완료" → 완료, "반품요청/반품접수/반품중/반품처리" → 접수, 그 외 → 기타.
 * 지마켓은 구매자용 API가 없어 이 페이지가 유일한 소스 (2026-09-02 실측).
 */
export async function readGmarketReturnStatus(ctx: BrowserContext, detailUrl: string): Promise<GmarketReturnProgress> {
  const page = await ctx.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    await handleBotChallengeOnDetail(page);
    const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (/반품완료/.test(text)) return "완료";
    if (/반품요청|반품접수|반품중|반품처리/.test(text)) return "접수";
    return "기타";
  } finally {
    await page.close().catch(() => {});
  }
}
