// ESM 발송처리 목록 전 페이지 수집 — 읽기 전용
import { chromium } from "playwright";
import fs from "fs";
const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });
const URL = "https://www.esmplus.com/Home/v2/send-processing";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("esmplus.com")) || (await ctx.newPage());
await page.bringToFront();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);

const getFrame = () => page.frames().find((f) => f.url().includes("post-tx.esmplus.com"));

const scrape = async () => {
  const frame = getFrame();
  return frame.evaluate(() => {
    const tb = [...document.querySelectorAll("table")].find((t) =>
      [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("수령인명")));
    if (!tb) return [];
    const heads = [...tb.querySelectorAll("thead th")].map((th) => (th.innerText || "").trim().replace(/\s+/g, " "));
    const ix = (n) => heads.findIndex((h) => h === n);
    const c = { 판매아이디: ix("판매아이디"), 주문번호: ix("주문번호"), 주문상태: ix("주문상태"), 상품명: ix("상품명"), 수령인명: ix("수령인명"), 구매자명: ix("구매자명"), 수량: ix("수량") };
    return [...tb.querySelectorAll("tbody tr")].map((tr) => {
      const td = [...tr.querySelectorAll("td")];
      const g = (n) => (td[n]?.innerText || "").trim().replace(/\s+/g, " ");
      return {
        마켓: g(c.판매아이디).startsWith("A") ? "옥션" : "지마켓",
        주문번호: g(c.주문번호), 주문상태: g(c.주문상태), 상품명: g(c.상품명),
        수령인명: g(c.수령인명), 구매자명: g(c.구매자명), 수량: g(c.수량),
      };
    });
  });
};

const all = [];
for (let p = 1; p <= 15; p++) {
  all.push(...(await scrape()).map((r) => ({ ...r, 페이지: p })));
  const moved = await getFrame().evaluate((next) => {
    const btn = [...document.querySelectorAll(".button__pagination")].find((b) => (b.innerText || "").trim() === String(next));
    if (!btn) return false;
    btn.click();
    return true;
  }, p + 1);
  if (!moved) break;
  await page.waitForTimeout(4000);
}
fs.writeFileSync(`${OUT}/esm-rows.json`, JSON.stringify(all, null, 1), "utf8");
const mk = {}; for (const r of all) mk[r.마켓] = (mk[r.마켓] || 0) + 1;
console.log("[ESM수집] 총", all.length, "행 |", JSON.stringify(mk));
await browser.close();
