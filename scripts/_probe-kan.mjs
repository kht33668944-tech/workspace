import { chromium } from "patchright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ locale: "ko-KR" })).newPage();
const calls = [];
p.on("request", (r) => { const u = r.url(); if (/koreannet/.test(u) && !/\.(css|js|png|jpg|gif|woff2?|ico)/.test(u)) calls.push([r.method(), u.replace("https://www.koreannet.or.kr", ""), (r.postData() || "").slice(0, 400)]); });
await p.goto("https://www.koreannet.or.kr/front/allproduct/kanSrchList.do", { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(1500);
await p.click('a[kancode="03"]');
await p.waitForTimeout(2500);
// 중분류 목록 구조
const struct = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll("[data-kancode],[kancode],li a").forEach((a) => {
    const k = a.getAttribute("kancode") || a.getAttribute("data-kancode") || "";
    const t = (a.innerText || "").trim();
    if (t && (k || /세탁|세제|화장지|생리대/.test(t))) out.push(`${k}|${t}|${a.className}`);
  });
  return [...new Set(out)].slice(0, 40);
});
console.log(JSON.stringify(struct, null, 1));
calls.length = 0;
const ok = await p.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => x.innerText.trim() === "세탁세제류" || x.innerText.trim() === "세탁용품");
  if (!a) return null; a.click(); return a.outerHTML.slice(0, 200);
});
console.log("클릭:", ok);
await p.waitForTimeout(2500);
console.log("CALLS", JSON.stringify(calls, null, 1));
await b.close();
