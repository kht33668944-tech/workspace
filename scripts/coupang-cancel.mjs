// 쿠팡윙 반품(취소) 일괄 접수
//
// 발주서에서 "취소준비 + 판매처=쿠팡"인 주문을 쿠팡윙 배송관리에서 하나씩 찾아 반품접수한다.
// 쿠팡윙 주문번호와 발주서 묶음번호는 체계가 달라, 수취인명 + 상품명으로 대조한다.
//
// 사전 준비: 크롬을 디버깅 포트로 띄우고 쿠팡윙에 로그인해둔다.
//   chrome.exe --remote-debugging-port=9222 --user-data-dir=".browser-profiles/coupang-wing"
//
// 사용법:
//   node scripts/coupang-cancel.mjs --dry            # 1건을 접수 직전까지만 (스크린샷 후 중단)
//   node scripts/coupang-cancel.mjs --limit 1        # 1건만 실제 접수
//   node scripts/coupang-cancel.mjs                  # 매칭된 전건 접수
import { chromium } from "playwright";
import fs from "fs";

const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });

// 조회 기간: 오늘 기준 최근 30일 (31일 이상은 쿠팡윙이 빈 결과를 준다)
function dateRange(days = 30) {
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  const now = Date.now();
  return { from: d(now - days * 86400000), to: d(now) };
}
const { from, to } = dateRange();
const LIST_URL = `https://wing.coupang.com/tenants/sfl-portal/delivery/management?deliverStatus=INSTRUCT&startDate=${from}&endDate=${to}`;

// 반품접수 창 고정 입력값
const REASON_CODE = "LATEDELIVERED";   // 배송 지연
const REASON_DETAIL = "배송 장기 지연";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = Number((args.find((a) => a.startsWith("--limit")) || "").split("=")[1] || args[args.indexOf("--limit") + 1] || 0) || (DRY ? 1 : 0);

const targets = JSON.parse(fs.readFileSync("scripts/_cancel-matched.json", "utf8"));
const queue = LIMIT ? targets.slice(0, LIMIT) : targets;
console.log(`[쿠팡취소] 대상 ${queue.length}건${DRY ? " (드라이런 — 접수 버튼 안 누름)" : ""}`);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("coupang.com"));
await page.bringToFront();

const results = [];
for (const [i, t] of queue.entries()) {
  const tag = `[${i + 1}/${queue.length}] ${t.recipient_name} / ${t.wingProduct} / ${t.quantity}개`;
  try {
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
    // 검색 영역이 그려질 때까지 기다린다 (고정 대기는 느린 날 실패한다)
    await page.waitForFunction(() =>
      [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.text === "주문번호")),
      { timeout: 60000 });
    await page.waitForTimeout(1000);

    // 주문번호로 단건 검색
    const filled = await page.evaluate((no) => {
      const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.text === "주문번호"));
      if (!sel) return "select 없음";
      sel.value = [...sel.options].find((o) => o.text === "주문번호").value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      const box = sel.getBoundingClientRect();
      const target = [...document.querySelectorAll("input[type=text]")]
        .filter((x) => x.offsetParent !== null)
        .find((x) => Math.abs(x.getBoundingClientRect().top - box.top) < 40 && x.getBoundingClientRect().left > box.left);
      if (!target) return "input 없음";
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(target, no);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    }, t.orderNo);
    if (filled !== "ok") throw new Error(`검색창 조작 실패: ${filled}`);

    await page.getByRole("button", { name: "검색" }).first().click();
    // 검색 결과가 갱신될 때까지 기다린다
    await page.waitForFunction((no) => {
      const tb = document.querySelector("table.search-table");
      if (!tb) return false;
      const rows = [...tb.querySelectorAll("tbody tr")];
      return rows.length === 0 || rows.every((tr) => (tr.innerText || "").includes(no));
    }, t.orderNo, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // 검색 결과 검증 — 주문번호/수취인명/상품명이 모두 맞아야 진행
    const rows = await page.evaluate(() => {
      const tb = document.querySelector("table.search-table");
      return [...tb.querySelectorAll("tbody tr")].map((tr) => {
        const td = [...tr.querySelectorAll("td")];
        return {
          orderNo: (td[1]?.innerText || "").trim(),
          product: (td[6]?.innerText || "").trim().replace(/\s+/g, " "),
          recipient: (td[7]?.innerText || "").trim().replace(/\s+/g, " "),
          status: (td[9]?.innerText || "").trim(),
        };
      });
    });
    if (rows.length !== 1) throw new Error(`검색 결과 ${rows.length}건 (1건이어야 함)`);
    const r = rows[0];
    const norm = (s) => (s || "").replace(/\s+/g, "");
    if (r.orderNo !== t.orderNo) throw new Error(`주문번호 불일치: ${r.orderNo}`);
    if (!norm(r.recipient).startsWith(norm(t.recipient_name))) throw new Error(`수취인 불일치: ${r.recipient}`);
    if (!norm(r.product).includes(norm(t.wingProduct))) throw new Error(`상품명 불일치: ${r.product.slice(0, 60)}`);
    if (r.status !== "상품준비중") throw new Error(`배송상태가 상품준비중이 아님: ${r.status}`);

    // 반품접수 모달 열기
    await page.locator("table.search-table tbody tr").first().getByText("반품접수", { exact: true }).click();
    await page.waitForSelector(".order-info-head", { timeout: 20000 });
    const head = (await page.locator(".order-info-head").innerText()).trim();
    if (!head.includes(t.orderNo)) throw new Error(`모달 주문번호 불일치: ${head}`);

    // 1) 반품접수수량
    const qtyInput = page.locator(".order-info-table input[type=number]").first();
    await qtyInput.fill(String(t.quantity));
    // 2) 반품사유 = 판매자사유 (기본값이지만 명시적으로)
    await page.locator("label", { hasText: /^판매자사유$/ }).first().click();
    // 3) 사유 드롭다운 = 배송 지연
    await page.locator(".reason-dropdown select").selectOption(REASON_CODE);
    // 4) 상세사유
    await page.locator(".reason-row-textarea textarea").fill(REASON_DETAIL);
    // 5) 배송비 부담주체 = 판매자
    await page.locator("label", { hasText: /^판매자$/ }).first().click();
    // 6) 반품상품 회수여부 = 회수 불필요
    await page.locator("label", { hasText: /^회수가 불필요합니다/ }).first().click();
    await page.waitForTimeout(700);

    // 7) 환불예정금액 조회
    await page.getByRole("button", { name: "환불예정금액 조회" }).click();
    // 접수 버튼이 열릴 때까지 기다린다
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "접수");
      return b && !b.disabled;
    }, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);

    const shot = `${OUT}/cancel-${i + 1}-${t.orderNo}.png`;
    await page.screenshot({ path: shot });

    if (DRY) {
      console.log(`${tag} → 접수 직전까지 완료. 스크린샷: ${shot}`);
      results.push({ ...t, result: "dry", shot });
      break;
    }

    // 8) 접수
    const submit = page.getByRole("button", { name: "접수", exact: true });
    if (await submit.isDisabled()) throw new Error("접수 버튼이 비활성 상태 (환불예정금액 조회 실패?)");
    await submit.click();
    // 완료 문구를 기다린다 — 고정 대기로 놓치면 성공한 건이 실패로 기록된다
    const done = await page.waitForFunction(
      () => (document.body.innerText || "").includes("접수가 완료되었습니다"),
      { timeout: 60000 }).then(() => true).catch(() => false);
    if (!done) throw new Error("완료 문구를 찾지 못함 — 윙에서 실제 접수 여부를 직접 확인할 것");
    await page.screenshot({ path: `${OUT}/cancel-done-${i + 1}-${t.orderNo}.png` });

    // 9) 닫기
    await page.getByRole("button", { name: "닫기", exact: true }).last().click();
    await page.waitForTimeout(1500);

    console.log(`${tag} → 접수 완료 (${t.orderNo})`);
    results.push({ ...t, result: "완료" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${tag} → 실패: ${msg}`);
    await page.screenshot({ path: `${OUT}/cancel-fail-${i + 1}-${t.orderNo}.png` }).catch(() => {});
    results.push({ ...t, result: "실패", error: msg });
  }
}

fs.writeFileSync("scripts/_cancel-results.json", JSON.stringify(results, null, 1), "utf8");
const ok = results.filter((r) => r.result === "완료").length;
console.log(`[쿠팡취소] 완료 ${ok} / 실패 ${results.filter((r) => r.result === "실패").length} / 전체 ${results.length}`);
await browser.close();
