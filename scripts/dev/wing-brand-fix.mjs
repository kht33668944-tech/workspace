// 쿠팡윙 "브랜드 정보 수정" 제안 일괄 수락.
//   node scripts/dev/wing-brand-fix.mjs          → 목록 구조·대상만 확인 (읽기 전용)
//   node scripts/dev/wing-brand-fix.mjs --go     → 전건 수정 (패널 전체선택 → N개 상품 수정하기 반복)
// 사전에 디버깅 크롬(포트 9222, coupang-wing 프로필)이 로그인된 상태여야 한다.
import { chromium } from "playwright";
import fs from "fs";

const GO = process.argv.includes("--go");
const OUT = "C:/Users/sksso/AppData/Local/Temp/claude/C--Users-sksso-Desktop----workspace-dev/df11d88c-b619-46ca-b1d3-209e37185095/scratchpad";
fs.mkdirSync(OUT, { recursive: true });

const URL = "https://wing.coupang.com/vendor-inventory/list?dashboard=BRAND&searchKeywordType=ALL&searchKeywords=&salesMethod=ALL&productStatus=ALL&stockSearchType=ALL&shippingFeeSearchType=ALL&displayCategoryCodes=&listingStartTime=null&listingEndTime=null&saleEndDateSearchType=ALL&bundledShippingSearchType=ALL&upBundling=ALL&displayDeletedProduct=false&shippingMethod=ALL&exposureStatus=BRAND_SUGGESTION&locale=ko_KR&sortMethod=SORT_BY_VI_LEVEL_UNIT_SOLD&countPerPage=50&page=1";

const log = (m) => console.log(`[브랜드수정] ${m}`);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("coupang.com")) || ctx.pages()[0];
await page.bringToFront();

async function loadList() {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const hasBtn = [...document.querySelectorAll("button")].some((b) => (b.innerText || "").trim() === "브랜드 정보 수정");
    const empty = /검색 결과가 없|조회된 상품이 없|상품이 없습니다/.test(document.body.innerText || "");
    return hasBtn || empty;
  }, { timeout: 60000 }).catch(() => log("목록 로딩 대기 초과 — 그대로 진행"));
  await page.waitForTimeout(2000);
}

function listState() {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => (b.innerText || "").trim() === "브랜드 정보 수정");
    const rows = btns.map((b) => {
      const tr = b.closest("tr");
      return tr ? (tr.innerText || "").replace(/\s+/g, " ").slice(0, 160) : "(tr 없음)";
    });
    const totalMatch = (document.body.innerText || "").match(/(?:총|전체)\s*([\d,]+)\s*개/);
    return { btnCount: btns.length, rows: rows.slice(0, 60), totalText: totalMatch ? totalMatch[0] : null };
  });
}

await loadList();
let st = await listState();
log(`목록: 수정 버튼 ${st.btnCount}개, ${st.totalText ?? "총계 표기 없음"}`);
for (const r of st.rows.slice(0, 10)) log(`  · ${r}`);
await page.screenshot({ path: `${OUT}/brand-list.png` });

if (!GO) {
  log("드라이런 끝 — --go 로 실행하면 전건 수정한다");
  await browser.close();
  process.exit(0);
}

let applied = 0;
let batches = 0;
for (let iter = 0; iter < 400; iter++) {
  st = await listState();
  if (st.btnCount === 0) { log("남은 수정 버튼 없음 — 완료"); break; }
  log(`${iter + 1}회차: 남은 버튼 ${st.btnCount}개 — 첫 행 열기`);

  // 1) 첫 "브랜드 정보 수정" 버튼 클릭 → 우측 패널
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "브랜드 정보 수정");
    b?.click();
  });

  // 2) 패널의 "N개 상품 수정하기" 버튼 대기
  const okBtn = await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /\d+개 상품 수정하기/.test((x.innerText || "").trim()));
    return b ? (b.innerText || "").trim() : false;
  }, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!okBtn) {
    await page.screenshot({ path: `${OUT}/brand-panel-missing-${iter}.png` });
    log("패널 수정 버튼을 못 찾음 — 스크린샷 저장 후 목록 새로고침");
    await loadList();
    continue;
  }
  await page.waitForTimeout(1200);

  // 3) 전체선택 체크 ("선택 (N)" 체크박스가 풀려 있으면 켠다)
  await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("input[type=checkbox]")].filter((c) => {
      const label = (c.closest("label, div")?.innerText || "").trim();
      return /^선택\s*\(\d+\)/.test(label);
    });
    for (const c of boxes) if (!c.checked) c.click();
  });
  await page.waitForTimeout(500);

  // 4) "N개 상품 수정하기" 클릭
  const btnText = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /\d+개 상품 수정하기/.test((x.innerText || "").trim()));
    if (!b) return null;
    const t = (b.innerText || "").trim();
    b.click();
    return t;
  });
  if (!btnText) { log("수정 버튼 클릭 실패 — 새로고침"); await loadList(); continue; }
  const n = Number((btnText.match(/(\d+)개/) || [])[1] || 0);
  batches++;
  applied += n;
  log(`  → "${btnText}" 클릭 (누적 ${applied}개)`);

  // 5) 처리 대기: 확인 다이얼로그가 더 뜨면 긍정 버튼 클릭
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^(확인|수정하기|적용)$/.test((x.innerText || "").trim()));
    b?.click();
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/brand-after-${iter}.png` });

  // 6) 목록 새로고침 후 다음 회차
  await loadList();
}

st = await listState();
log(`끝. 배치 ${batches}회, 클릭 기준 ${applied}개 수정. 남은 버튼 ${st.btnCount}개`);
await page.screenshot({ path: `${OUT}/brand-final.png` });
await browser.close();
