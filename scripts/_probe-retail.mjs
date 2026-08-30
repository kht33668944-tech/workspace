// 대형마트 온라인몰이 상품 상세에 바코드를 노출하는지 확인한다.
import { chromium } from "patchright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await b.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();
const tries = [
  ["홈플러스", "https://front.homeplus.co.kr/search?keyword=" + encodeURIComponent("피죤 섬유유연제 3100ml")],
  ["이마트몰", "https://emart.ssg.com/search.ssg?target=all&query=" + encodeURIComponent("피죤 섬유유연제 3100ml")],
];
for (const [nm, url] of tries) {
  try {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await p.waitForTimeout(4000);
    const t = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 600));
    const bars = await p.evaluate(() => [...document.body.innerText.matchAll(/\b(88\d{11})\b/g)].map((m) => m[1]).slice(0, 5));
    console.log(`\n### ${nm}\n  ${t.slice(0, 300)}\n  바코드후보: ${JSON.stringify(bars)}`);
  } catch (e) { console.log(`\n### ${nm} 실패: ${e instanceof Error ? e.message : String(e)}`); }
}
await b.close();
