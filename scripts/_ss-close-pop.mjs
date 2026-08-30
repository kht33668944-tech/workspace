import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
for (const p of browser.contexts()[0].pages()) {
  if (p.url().includes("cancelSaleBySelection")) { await p.close(); console.log("[팝업] 닫음"); }
}
await browser.close();
