import { chromium } from "playwright";
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    const pages = browser.contexts()[0].pages();
    const wing = pages.find((p) => p.url().startsWith("https://wing.coupang.com"));
    if (wing) {
      console.log("[로그인대기] 로그인 완료:", wing.url());
      await browser.close();
      process.exit(0);
    }
    await browser.close();
  } catch (e) {
    console.log("[로그인대기] 재시도:", e instanceof Error ? e.message : String(e));
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("[로그인대기] 10분 내 로그인 안 됨");
process.exit(1);
