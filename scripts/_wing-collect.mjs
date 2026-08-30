// 배송관리(상품준비중) 전체 행 수집 — 읽기 전용. 페이지네이션 순회.
import { chromium } from "playwright";
import fs from "fs";
import { wingDateRange } from "./_date.mjs";
const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });

const { from, to } = wingDateRange();
const URL = `https://wing.coupang.com/tenants/sfl-portal/delivery/management?deliverStatus=INSTRUCT&startDate=${from}&endDate=${to}`;

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("coupang.com"));
await page.bringToFront();
await page.goto(URL, { waitUntil: "domcontentloaded" });
// 행이 그려질 때까지 기다린다 (고정 대기는 느린 날 0행으로 새어나간다)
await page.waitForFunction(() => {
  const tb = document.querySelector("table.search-table");
  if (!tb) return false;
  return tb.querySelectorAll("tbody tr").length > 0 || /결과가 없|조회된 내역이 없/.test(document.body.innerText || "");
}, { timeout: 60000 }).catch(() => console.log("[수집] 행 로딩 대기 시간 초과 — 그대로 진행한다"));
await page.waitForTimeout(1500);

// 페이지당 개수 셀렉트 찾기
const selects = await page.evaluate(() =>
  [...document.querySelectorAll("select")].map((s, i) => ({
    i, cls: s.className, name: s.name, id: s.id,
    opts: [...s.options].map((o) => o.value + ":" + o.text).slice(0, 8),
  })).filter((s) => s.opts.some((o) => /10|20|50/.test(o)) && s.opts.length <= 8)
);
console.log("[수집] 개수 셀렉트 후보:", JSON.stringify(selects));

// 페이지네이션 요소
const pager = await page.evaluate(() => {
  const el = document.querySelector(".pagination, .paging, [class*=pagination]");
  return el ? { cls: el.className, text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 200) } : null;
});
console.log("[수집] 페이저:", JSON.stringify(pager));

function scrape(p) {
  return p.evaluate(() => {
    const tb = document.querySelector("table.search-table");
    return [...tb.querySelectorAll("tbody tr")].map((tr) => {
      const td = [...tr.querySelectorAll("td")];
      const txt = (n) => (td[n]?.innerText || "").trim().replace(/\s+/g, " ");
      return {
        orderNo: txt(1),
        product: txt(6),
        recipient: txt(7).split(" ")[0],
        recipientFull: txt(7),
        status: txt(9),
        orderedAt: txt(10),
        bundleNo: txt(11),
      };
    });
  });
}

const all = [];
for (let pageNo = 1; pageNo <= 30; pageNo++) {
  all.push(...(await scrape(page)));
  const moved = await page.evaluate((next) => {
    const links = [...document.querySelectorAll("a, button")].filter((a) => (a.innerText || "").trim() === String(next));
    if (!links.length) return false;
    links[0].click();
    return true;
  }, pageNo + 1);
  if (!moved) break;
  await page.waitForTimeout(3000);
}
fs.writeFileSync(`${OUT}/wing-rows.json`, JSON.stringify(all, null, 1), "utf8");
console.log("[수집] 총", all.length, "행");
console.log(JSON.stringify(all.slice(0, 2), null, 1));
await browser.close();
