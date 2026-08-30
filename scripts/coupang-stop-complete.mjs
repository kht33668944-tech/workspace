// 쿠팡윙 출고중지요청 → 출고중지완료 일괄 처리
//
// 반품접수(coupang-cancel.mjs) 후 주문은 "출고중지 요청"에 쌓인다.
// 여기서 [출고중지완료]를 눌러야 환불까지 최종 처리된다.
//
//   node scripts/coupang-stop-complete.mjs --dry   # 확인창까지만 열고 취소 (안전 확인용)
//   node scripts/coupang-stop-complete.mjs         # 전건 처리
//
// 대상: 배송상태 "상품준비중" + 출고중지 완료일 "출고중지 전"인 행만.
// 이미 출고된 건([이미출고] 대상)은 건드리지 않는다.
import { chromium } from "playwright";
import fs from "fs";

const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });
const DRY = process.argv.includes("--dry");
const d = (t) => new Date(t + 9 * 3600000).toISOString().slice(0, 10); // KST 날짜 (UTC면 오전 9시 전 실행 시 오늘 건이 조회에서 빠짐)
const URL = `https://wing.coupang.com/tenants/sfl-portal/stop-shipment/list?shipmentStopSearchType=SHIPMENT_STOP_REQUEST&from=${d(Date.now() - 30 * 86400000)}&to=${d(Date.now())}`;

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("coupang.com"));
await page.bringToFront();

const listTable = () => page.evaluate(() => {
  const tb = [...document.querySelectorAll("table")].find((t) =>
    [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("출고중지 처리")));
  return !!tb;
});

let 처리 = 0;
const 처리목록 = [];
// 처리한 행은 목록에서 빠지므로, 목록이 빌 때까지 1페이지를 반복해 훑는다 (한 회차당 최대 10건 일괄)
for (let round = 1; round <= 40; round++) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const tb = [...document.querySelectorAll('table')].find((t) =>
      [...t.querySelectorAll('thead th')].some((th) => th.innerText.includes('출고중지 처리')));
    if (!tb) return false;
    // 행이 그려졌거나, 빈 목록 안내가 떴을 때만 통과 (로딩 중 0행을 '없음'으로 오판하지 않는다)
    const rows = [...tb.querySelectorAll('tbody tr')];
    // 빈 목록은 '데이터가 없습니다.' 한 줄짜리 행으로 표시된다. 페이지 전체 텍스트로 판정하면 오판한다
    if (rows.length === 1 && /데이터가 없습니다/.test(rows[0].innerText || '')) return true;
    return rows.length > 0;
  }, { timeout: 60000 }).catch(() => console.log('[출고중지] 목록 로딩 대기 초과'));
  await page.waitForTimeout(2500);
  if (!(await listTable())) { console.log("[출고중지] 목록 테이블을 찾지 못했다 — 중단"); break; }


  // 대상 행만 체크
  const picked = await page.evaluate(() => {
    const tb = [...document.querySelectorAll("table")].find((t) =>
      [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("출고중지 처리")));
    const out = [];
    for (const tr of tb.querySelectorAll("tbody tr")) {
      const td = [...tr.querySelectorAll("td")];
      if (td.length < 14) continue;   // "데이터가 없습니다." placeholder 행
      const 배송상태 = (td[4]?.innerText || "").trim();
      const 완료일 = (td[13]?.innerText || "").trim();
      if (배송상태 !== "상품준비중" || !완료일.includes("출고중지 전")) continue;
      const cb = tr.querySelector("input[type=checkbox]");
      if (!cb || cb.checked) continue;
      cb.click();
      out.push({ 수취인: (td[8]?.innerText || "").trim(), 주문번호: (td[11]?.innerText || "").trim(), 접수번호: (td[3]?.innerText || "").trim() });
    }
    return out;
  });
  console.log(`[출고중지] ${round}회차 — 대상 ${picked.length}건`);
  if (!picked.length) { console.log("[출고중지] 처리할 건이 없다 — 종료"); break; }

  // 상단 일괄 버튼
  await page.evaluate(() => {
    const tb = [...document.querySelectorAll("table")].find((t) =>
      [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("출고중지 처리")));
    const top = tb.getBoundingClientRect().top;
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.offsetParent && (b.innerText || "").trim() === "출고중지완료" && b.getBoundingClientRect().top < top);
    if (!btn) throw new Error("상단 출고중지완료 버튼 없음");
    btn.click();
  });
  await page.waitForFunction(() => /출고중지 완료 하시겠습니까/.test(document.body.innerText || ""), { timeout: 30000 });
  await page.waitForTimeout(1000);

  const 안내 = await page.evaluate(() => (document.body.innerText.match(/하기\s*[\d,]+건을[^\n]*/) || [])[0] || "?");
  console.log(`[출고중지] 확인창: ${안내}`);
  await page.screenshot({ path: `${OUT}/stop-confirm-${round}.png` });

  if (DRY) {
    await page.getByRole("button", { name: "취소", exact: true }).last().click();
    console.log(`[출고중지] 드라이런 — 취소하고 종료. 스크린샷: ${OUT}/stop-confirm-${round}.png`);
    console.log(JSON.stringify(picked.slice(0, 5), null, 1));
    break;
  }

  await page.getByRole("button", { name: "완료", exact: true }).last().click();
  await page.waitForFunction(() => !/출고중지 완료 하시겠습니까/.test(document.body.innerText || ""), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  처리 += picked.length;
  처리목록.push(...picked);
  console.log(`[출고중지] ${round}회차 완료 — 누적 ${처리}건`);
}

if (!DRY) {
  fs.writeFileSync("scripts/_stop-complete-results.json", JSON.stringify(처리목록, null, 1), "utf8");
  console.log(`[출고중지] 총 ${처리}건 처리 → scripts/_stop-complete-results.json`);
}
await browser.close();
