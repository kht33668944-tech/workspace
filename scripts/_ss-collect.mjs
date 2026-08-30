// 스마트스토어 발주/발송관리 목록 수집 — 읽기 전용.
// 목록은 TOAST UI Grid다. 좌측 고정영역(.tui-grid-lside-area)과 우측(.tui-grid-rside-area)이
// 컬럼을 나눠 갖고 있어, 헤더를 각각 읽어 인덱스를 맞춘 뒤 같은 행끼리 합쳐야 한다.
import { chromium } from "playwright";
import fs from "fs";
const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });
const URL = "https://sell.smartstore.naver.com/#/naverpay/sale/delivery?summaryInfoType=NEW_ORDERS_DELIVERY_OPERATED_AFTER";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("smartstore.naver.com")) || (await ctx.newPage());
await page.bringToFront();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const frame = () => page.frames().find((f) => f.url().includes("/o/v3/n/sale/delivery"));
if (!frame()) { console.log("[스토어수집] 본문 프레임 없음"); await browser.close(); process.exit(1); }

const click = (text) => frame().evaluate((t) => {
  const b = [...document.querySelectorAll("button, a, label")].find((x) => (x.innerText || "").trim() === t);
  if (!b) return false;
  b.click();
  return true;
}, text);

await click("3개월");
await page.waitForTimeout(1500);
await click("검색");
await page.waitForFunction(() => document.querySelectorAll(".tui-grid-lside-area .tui-grid-body-area tbody tr").length > 0,
  { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);

const rows = await frame().evaluate(() => {
  const head = (side) => [...document.querySelectorAll(`.tui-grid-${side}side-area .tui-grid-head-area th`)]
    .map((th) => (th.innerText || "").trim().replace(/\s+/g, " "));
  const body = (side) => [...document.querySelectorAll(`.tui-grid-${side}side-area .tui-grid-body-area tbody tr`)];
  const L = head("l"), R = head("r");
  const lr = body("l"), rr = body("r");
  const cells = (tr) => [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim().replace(/\s+/g, " "));
  const out = [];
  for (let i = 0; i < lr.length; i++) {
    const lc = cells(lr[i]), rc = cells(rr[i] || lr[i]);
    // 좌측은 맨 앞에 체크박스 열이 하나 더 있다
    const lOff = lc.length - L.length;
    const g = (name) => {
      let k = L.indexOf(name);
      if (k >= 0) return lc[k + lOff] ?? "";
      k = R.indexOf(name);
      return k >= 0 ? (rc[k] ?? "") : "";
    };
    out.push({
      rowKey: lr[i].getAttribute("data-row-key"),
      상품주문번호: g("상품주문번호"),
      주문번호: g("주문번호"),
      구매자명: g("구매자명"),
      수취인명: g("수취인명"),
      주문상태: g("주문상태"),
      상품명: g("상품명"),
      옵션정보: g("옵션정보"),
      수량: g("수량"),
    });
  }
  return out;
});
fs.writeFileSync(`${OUT}/ss-rows.json`, JSON.stringify(rows, null, 1), "utf8");
console.log("[스토어수집]", rows.length, "행");
for (const r of rows.slice(0, 5)) console.log(`   ${r.수취인명}/${r.구매자명} | ${r.상품명} | ${r.옵션정보} | ${r.수량}개 | ${r.주문상태} | ${r.상품주문번호}`);
await browser.close();
