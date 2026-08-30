// ESM(지마켓·옥션) 판매취소 일괄 처리
//
// 발주서의 "취소준비 + 판매처=지마켓/옥션" 주문을 ESM 발송처리 목록에서 찾아 판매취소한다.
// 목록에는 취소하면 안 되는 주문이 섞여 있으므로, 사전에 _esm-match.mjs로 대조해
// 확정된 주문번호만 체크한다.
//
//   node scripts/esm-cancel.mjs --dry   # 확인 팝업까지만 열고 취소
//   node scripts/esm-cancel.mjs         # 전건 처리
import { chromium } from "playwright";
import fs from "fs";

const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });
const DRY = process.argv.includes("--dry");
const URL = "https://www.esmplus.com/Home/v2/send-processing";

const matched = JSON.parse(fs.readFileSync("scripts/_esm-matched.json", "utf8"));
const 남은 = new Map(matched.map((m) => [m.주문번호, m]));
console.log(`[ESM취소] 대상 ${남은.size}건${DRY ? " (드라이런 — 확인 버튼 안 누름)" : ""}`);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("esmplus.com")) || (await ctx.newPage());
await page.bringToFront();

const frame = () => page.frames().find((f) => f.url().includes("post-tx.esmplus.com"));

const 행읽기 = () => frame().evaluate(() => {
  const tb = [...document.querySelectorAll("table")].find((t) =>
    [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("수령인명")));
  if (!tb) return [];
  const heads = [...tb.querySelectorAll("thead th")].map((th) => (th.innerText || "").trim().replace(/\s+/g, " "));
  const ix = (n) => heads.findIndex((h) => h === n);
  const c = { 주문번호: ix("주문번호"), 수령인명: ix("수령인명"), 구매자명: ix("구매자명"), 상품명: ix("상품명"), 수량: ix("수량") };
  return [...tb.querySelectorAll("tbody tr")].map((tr, i) => {
    const td = [...tr.querySelectorAll("td")];
    const g = (n) => (td[n]?.innerText || "").trim().replace(/\s+/g, " ");
    return { row: i, 주문번호: g(c.주문번호), 수령인명: g(c.수령인명), 구매자명: g(c.구매자명), 상품명: g(c.상품명), 수량: g(c.수량) };
  });
});

const 페이지이동 = async (n) => {
  const ok = await frame().evaluate((p) => {
    const btn = [...document.querySelectorAll(".button__pagination")].find((b) => (b.innerText || "").trim() === String(p));
    if (!btn) return false;
    btn.click();
    return true;
  }, n);
  if (ok) await page.waitForTimeout(4000);
  return ok;
};

const 처리됨 = [];
for (let round = 1; round <= 30 && 남은.size; round++) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => true, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(8000);
  if (!frame()) { console.log("[ESM취소] 목록 프레임 없음 — 중단"); break; }

  // 대상이 있는 페이지를 찾는다
  let 대상 = [];
  let 페이지 = 1;
  for (; 페이지 <= 15; 페이지++) {
    const rows = await 행읽기();
    대상 = rows.filter((r) => 남은.has(r.주문번호));
    if (대상.length) break;
    if (!(await 페이지이동(페이지 + 1))) break;
  }
  if (!대상.length) { console.log("[ESM취소] 남은 대상이 목록에 없다 — 종료"); break; }

  // 대상 행만 체크 — 주문번호로 재확인하고 수령인명·상품명·수량까지 대조한다
  const 체크결과 = await frame().evaluate((목록) => {
    const tb = [...document.querySelectorAll("table")].find((t) =>
      [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("수령인명")));
    const heads = [...tb.querySelectorAll("thead th")].map((th) => (th.innerText || "").trim().replace(/\s+/g, " "));
    const ix = (n) => heads.findIndex((h) => h === n);
    const c = { 주문번호: ix("주문번호"), 수령인명: ix("수령인명"), 상품명: ix("상품명"), 수량: ix("수량") };
    const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
    const byNo = new Map(목록.map((m) => [m.주문번호, m]));
    const 체크됨 = [], 불일치 = [];
    for (const tr of tb.querySelectorAll("tbody tr")) {
      const td = [...tr.querySelectorAll("td")];
      const g = (n) => (td[n]?.innerText || "").trim().replace(/\s+/g, " ");
      const no = g(c.주문번호);
      const m = byNo.get(no);
      if (!m) continue;
      if (norm(g(c.수령인명)) !== norm(m.수령인명) || norm(g(c.상품명)) !== norm(m.상품명) || g(c.수량) !== String(m.수량)) {
        불일치.push({ 주문번호: no, 화면: `${g(c.수령인명)}/${g(c.상품명)}/${g(c.수량)}`, 기대: `${m.수령인명}/${m.상품명}/${m.수량}` });
        continue;
      }
      const cb = tr.querySelector("input[type=checkbox]");
      if (!cb) { 불일치.push({ 주문번호: no, 화면: "체크박스 없음" }); continue; }
      if (!cb.checked) cb.click();
      체크됨.push(no);
    }
    return { 체크됨, 불일치 };
  }, 대상.map((r) => 남은.get(r.주문번호)));

  if (체크결과.불일치.length) {
    console.log("[ESM취소] 대조 불일치 — 중단:", JSON.stringify(체크결과.불일치));
    break;
  }
  console.log(`[ESM취소] ${round}회차 — ${페이지}페이지에서 ${체크결과.체크됨.length}건 체크`);

  // 실제 체크된 개수 확인
  const 실제체크 = await frame().evaluate(() => {
    const tb = [...document.querySelectorAll("table")].find((t) =>
      [...t.querySelectorAll("thead th")].some((th) => th.innerText.includes("수령인명")));
    return [...tb.querySelectorAll("tbody tr input[type=checkbox]")].filter((c) => c.checked).length;
  });
  if (실제체크 !== 체크결과.체크됨.length) {
    console.log(`[ESM취소] 체크 개수 불일치 (화면 ${실제체크} ≠ 기대 ${체크결과.체크됨.length}) — 중단`);
    break;
  }

  // 판매취소
  await frame().evaluate(() => {
    const btn = [...document.querySelectorAll("button, a, input[type=button]")]
      .find((b) => (b.innerText || b.value || "").trim() === "판매취소");
    if (!btn) throw new Error("판매취소 버튼 없음");
    btn.click();
  });
  await page.waitForTimeout(2500);

  // 확인 팝업의 건수 검증
  const 팝업 = await frame().evaluate(() => {
    const t = document.body.innerText || "";
    const m = t.match(/정말\s*(\d+)\s*건을\s*판매취소/);
    return { 문구: (t.match(/정말[^\n]*판매취소[^\n]*/) || [])[0] || "", 건수: m ? Number(m[1]) : null };
  });
  console.log(`[ESM취소] 확인창: ${팝업.문구 || "(문구 없음)"}`);
  await page.screenshot({ path: `${OUT}/esm-confirm-${round}.png` });

  if (팝업.건수 !== 체크결과.체크됨.length) {
    console.log(`[ESM취소] 팝업 건수(${팝업.건수}) ≠ 체크 수(${체크결과.체크됨.length}) — 중단`);
    break;
  }

  if (DRY) {
    await frame().evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((b) => (b.innerText || "").trim() === "취소");
      if (btn) btn.click();
    });
    console.log(`[ESM취소] 드라이런 — 팝업 닫고 종료. 스크린샷: ${OUT}/esm-confirm-${round}.png`);
    break;
  }

  await frame().evaluate(() => {
    const btn = [...document.querySelectorAll("button, a")].find((b) => (b.innerText || "").trim() === "확인");
    if (!btn) throw new Error("확인 버튼 없음");
    btn.click();
  });
  await page.waitForTimeout(6000);
  for (const no of 체크결과.체크됨) { 처리됨.push(남은.get(no)); 남은.delete(no); }
  console.log(`[ESM취소] ${round}회차 완료 — 누적 ${처리됨.length} / 남은 ${남은.size}`);
}

if (!DRY) {
  fs.writeFileSync("scripts/_esm-results.json", JSON.stringify(처리됨, null, 1), "utf8");
  console.log(`[ESM취소] 총 ${처리됨.length}건 판매취소 → scripts/_esm-results.json`);
  if (남은.size) console.log(`[ESM취소] 미처리 ${남은.size}건:`, [...남은.keys()].join(", "));
}
await browser.close();
