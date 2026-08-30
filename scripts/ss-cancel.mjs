// 스마트스토어 판매자 직접취소 일괄 처리
//
//   node scripts/ss-cancel.mjs --dry        # 확인창까지만 열고 취소
//   node scripts/ss-cancel.mjs --limit 1    # 1건만 처리
//   node scripts/ss-cancel.mjs              # 전건 처리
//
// 흐름: 목록에서 대상 체크 → [판매자 직접취소 처리] → 네이티브 confirm 수락
//       → 별도 팝업창(cancelSaleBySelection)이 열린다 → 취소 사유 선택 → [판매취소 처리]
// 확인만 누르면 끝나는 게 아니다. 팝업에서 사유를 고르고 확정해야 실제로 취소된다.
import { chromium } from "playwright";
import fs from "fs";

const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });
const DRY = process.argv.includes("--dry");
const LIMIT = Number(process.argv[process.argv.indexOf("--limit") + 1]) || 0;
const URL = "https://sell.smartstore.naver.com/#/naverpay/sale/delivery?summaryInfoType=NEW_ORDERS_DELIVERY_OPERATED_AFTER";
const REASON = "DELAYED_DELIVERY";   // 배송지연
const REASON_DETAIL = "배송 장기 지연";   // 구매고객에게 노출된다

let matched = JSON.parse(fs.readFileSync("scripts/_ss-matched.json", "utf8"));
if (LIMIT) matched = matched.slice(0, LIMIT);
const 남은 = new Map(matched.map((m) => [m.상품주문번호, m]));
console.log(`[스토어취소] 대상 ${남은.size}건${DRY ? " (드라이런 — 확인 안 누름)" : ""}`);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("smartstore.naver.com")) || (await ctx.newPage());
await page.bringToFront();

let 기대건수 = 0;
let 팝업로그 = [];
let 중단사유 = null;

// 목록 화면의 네이티브 confirm — "N개 판매취소 가능합니다"
page.on("dialog", async (dlg) => {
  const msg = (dlg.message() || "").replace(/\s+/g, " ");
  팝업로그.push(msg);
  console.log(`[스토어취소] 확인창: ${msg.slice(0, 80)}...`);
  const m = msg.match(/(\d+)\s*개\s*판매취소\s*가능/);
  if (m) {
    const 가능 = Number(m[1]);
    if (가능 !== 기대건수) { 중단사유 = `확인창 건수(${가능}) ≠ 체크 수(${기대건수})`; await dlg.dismiss(); return; }
    if (DRY) { await dlg.dismiss(); return; }
    await dlg.accept();
    return;
  }
  await dlg.accept().catch(() => {});
});

const frame = () => page.frames().find((f) => f.url().includes("/o/v3/n/sale/delivery"));
const click = (text) => frame().evaluate((t) => {
  const b = [...document.querySelectorAll("button, a, label")].find((x) => (x.innerText || "").trim() === t);
  if (!b) return false;
  b.click();
  return true;
}, text);

/** 판매취소 팝업창이 열릴 때까지 기다린다 */
async function 팝업대기(ms = 30000) {
  const 끝 = Date.now() + ms;
  while (Date.now() < 끝) {
    const p = ctx.pages().find((x) => x.url().includes("cancelSaleBySelection"));
    if (p) { await p.waitForLoadState("domcontentloaded").catch(() => {}); return p; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const 처리됨 = [];
for (let round = 1; round <= 10 && 남은.size && !중단사유; round++) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);
  if (!frame()) { console.log("[스토어취소] 본문 프레임 없음 — 중단"); break; }

  await click("3개월");
  await page.waitForTimeout(1500);
  await click("검색");
  await page.waitForFunction(() => document.querySelectorAll(".tui-grid-lside-area .tui-grid-body-area tbody tr").length > 0,
    { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 대상 행 체크 — 상품주문번호로 식별하고 수취인명·상품명·수량을 다시 대조한다
  const 결과 = await frame().evaluate((목록) => {
    const head = (side) => [...document.querySelectorAll(`.tui-grid-${side}side-area .tui-grid-head-area th`)]
      .map((th) => (th.innerText || "").trim().replace(/\s+/g, " "));
    const body = (side) => [...document.querySelectorAll(`.tui-grid-${side}side-area .tui-grid-body-area tbody tr`)];
    const L = head("l"), R = head("r"), lr = body("l"), rr = body("r");
    const cells = (tr) => [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim().replace(/\s+/g, " "));
    const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
    const byNo = new Map(목록.map((m) => [m.상품주문번호, m]));
    const 체크됨 = [], 불일치 = [];
    for (let i = 0; i < lr.length; i++) {
      const lc = cells(lr[i]), rc = cells(rr[i] || lr[i]);
      const lOff = lc.length - L.length;   // 좌측 맨 앞에 체크박스 열이 하나 더 있다
      const g = (name) => {
        let k = L.indexOf(name);
        if (k >= 0) return lc[k + lOff] ?? "";
        k = R.indexOf(name);
        return k >= 0 ? (rc[k] ?? "") : "";
      };
      const no = g("상품주문번호");
      const m = byNo.get(no);
      if (!m) continue;
      if (norm(g("수취인명")) !== norm(m.수취인명) || norm(g("상품명")) !== norm(m.상품명) || g("수량") !== String(m.수량)) {
        불일치.push({ 상품주문번호: no, 화면: `${g("수취인명")}/${g("상품명")}/${g("수량")}`, 기대: `${m.수취인명}/${m.상품명}/${m.수량}` });
        continue;
      }
      const cb = lr[i].querySelector("input[type=checkbox]");
      if (!cb) { 불일치.push({ 상품주문번호: no, 화면: "체크박스 없음" }); continue; }
      if (!cb.checked) cb.click();
      체크됨.push(no);
    }
    const 실제 = document.querySelectorAll(".tui-grid-lside-area .tui-grid-body-area tbody input[type=checkbox]:checked").length;
    return { 체크됨, 불일치, 실제 };
  }, [...남은.values()]);

  if (결과.불일치.length) { console.log("[스토어취소] 대조 불일치 — 중단:", JSON.stringify(결과.불일치)); break; }
  if (!결과.체크됨.length) { console.log("[스토어취소] 목록에서 대상을 찾지 못했다 — 종료"); break; }
  if (결과.실제 !== 결과.체크됨.length) {
    console.log(`[스토어취소] 체크 개수 불일치 (화면 ${결과.실제} ≠ 기대 ${결과.체크됨.length}) — 중단`);
    break;
  }
  기대건수 = 결과.체크됨.length;
  console.log(`[스토어취소] ${round}회차 — ${기대건수}건 체크`);

  팝업로그 = [];
  await click("판매자 직접취소 처리");
  await page.waitForTimeout(4000);

  if (중단사유) { console.log(`[스토어취소] ${중단사유} — 중단`); break; }
  if (!팝업로그.length) { console.log("[스토어취소] 확인창이 뜨지 않았다 — 중단"); break; }
  if (DRY) { console.log("[스토어취소] 드라이런 — 확인창 거부하고 종료"); break; }

  // 사유 선택 팝업창
  const pop = await 팝업대기();
  if (!pop) { console.log("[스토어취소] 판매취소 팝업창이 열리지 않았다 — 중단"); break; }
  pop.on("dialog", async (d) => {
    console.log(`[스토어취소] 팝업 알림: ${(d.message() || "").replace(/\s+/g, " ").slice(0, 100)}`);
    await d.accept().catch(() => {});
  });
  await pop.waitForTimeout(2500);

  const 사유설정 = await pop.evaluate(({ code, detail }) => {
    const s = document.querySelector("select[name=claimRequestReasonType]");
    if (!s) return "사유 select 없음";
    if (![...s.options].some((o) => o.value === code)) return `사유 코드 ${code} 없음`;
    s.value = code;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
    // 상세 사유는 필수다. 비워두면 "구매고객에게 노출 할 판매취소 사유를 입력해주세요" 알림만 뜨고 처리되지 않는다
    const ta = document.querySelector("textarea[name=reqDetailContent]");
    if (!ta) return "상세사유 textarea 없음";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, detail);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    if (ta.value !== detail) return "상세사유 입력 실패";
    return s.value === code ? "ok" : "설정 실패";
  }, { code: REASON, detail: REASON_DETAIL });
  console.log(`[스토어취소] 취소 사유(배송지연 / "${REASON_DETAIL}") 설정: ${사유설정}`);
  await pop.screenshot({ path: `${OUT}/ss-pop-${round}.png`, fullPage: true });
  if (사유설정 !== "ok") { console.log("[스토어취소] 사유 설정 실패 — 중단"); break; }

  await pop.evaluate(() => {
    const b = [...document.querySelectorAll("button, a, input[type=button], input[type=submit]")]
      .find((x) => (x.innerText || x.value || "").trim() === "판매취소 처리");
    if (!b) throw new Error("판매취소 처리 버튼 없음");
    b.click();
  });
  // 처리에 성공하면 팝업이 스스로 닫힌다 — pop을 기준으로 기다리면 닫히는 순간 예외가 난다
  await page.waitForTimeout(6000);

  const 닫힘 = pop.isClosed() || !ctx.pages().some((x) => x.url().includes("cancelSaleBySelection"));
  console.log(`[스토어취소] 팝업 종료 여부: ${닫힘}`);
  if (!닫힘) {
    await pop.screenshot({ path: `${OUT}/ss-pop-fail-${round}.png`, fullPage: true }).catch(() => {});
    console.log("[스토어취소] 팝업이 닫히지 않았다 — 처리되지 않았을 수 있으니 중단하고 화면을 확인할 것");
    break;
  }

  for (const no of 결과.체크됨) { 처리됨.push(남은.get(no)); 남은.delete(no); }
  console.log(`[스토어취소] ${round}회차 처리 — 누적 ${처리됨.length} / 남은 ${남은.size}`);
}

if (!DRY) {
  fs.writeFileSync("scripts/_ss-results.json", JSON.stringify(처리됨, null, 1), "utf8");
  console.log(`[스토어취소] 총 ${처리됨.length}건 → scripts/_ss-results.json`);
  console.log("[스토어취소] 반드시 _ss-collect.mjs로 목록에서 빠졌는지 확인한 뒤 발주서에 반영할 것");
}
await browser.close();
