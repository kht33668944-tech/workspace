import { chromium } from "patchright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ locale:"ko-KR" })).newPage();
for (const q of ["피죤","비트","샤프란","다우니","액츠","테크"]) {
  await p.goto("https://www.koreannet.or.kr/front/allproduct/prodSrchList.do?searchText=" + encodeURIComponent(q) + "&pageNum=1", { waitUntil:"domcontentloaded", timeout:60000 });
  await p.waitForTimeout(1000);
  const txt = await p.evaluate(()=>document.body.innerText);
  const tot = (txt.match(/총\s*:\s*([\d,]+)건/)||[])[1];
  const rows = await p.evaluate(()=>{const o=[];document.querySelectorAll("li,tr").forEach(el=>{const t=el.innerText.replace(/\s+/g," ").trim();const m=t.match(/^(\d{8,14})\s+(.+)$/);if(m)o.push(m[1]+" | "+m[2].slice(0,80));});return [...new Set(o)];});
  console.log(`\n### ${q}  총 ${tot}건`);
  rows.slice(0,4).forEach(r=>console.log("  "+r));
}
await b.close();
