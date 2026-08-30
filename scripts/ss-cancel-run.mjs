// 스마트스토어 취소 전체 파이프라인.
//
//   npm run ss:cancel          → 크롬 실행 + 대조 + 확인창까지만 (안전 확인용)
//   npm run ss:cancel -- --go  → 위 확인 후 전건 판매취소
//
// 반영은 목록에서 실제로 빠졌는지 확인한 뒤 수동으로 실행한다:
//   node scripts/ss-cancel-apply.mjs
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const GO = process.argv.includes("--go");
const PROFILE = path.resolve(".browser-profiles/coupang-wing");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => fs.existsSync(p));

async function cdpUp() {
  try {
    const r = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function step(name, file, args = []) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync("node", [file, ...args], { stdio: "inherit" });
  if (r.status !== 0) { console.error(`[실행] ${name} 실패 — 중단한다`); process.exit(1); }
}

if (await cdpUp()) {
  console.log("[실행] 디버깅 크롬이 이미 떠 있다 — 그대로 사용한다");
} else {
  if (!CHROME) { console.error("[실행] chrome.exe를 찾지 못했다"); process.exit(1); }
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log("[실행] 크롬 실행 —", PROFILE);
  spawn(CHROME, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://sell.smartstore.naver.com/",
  ], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 20 && !(await cdpUp()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await cdpUp())) { console.error("[실행] 크롬 디버깅 포트가 열리지 않았다"); process.exit(1); }
  console.log("[실행] 스마트스토어센터에 로그인이 안 돼 있으면 크롬 창에서 로그인한 뒤 다시 실행하세요");
}

step("발주서에서 취소준비 스마트스토어 주문 추출", "scripts/_ss-list.mjs");
step("발주/발송관리 목록 수집", "scripts/_ss-collect.mjs");
step("수취인명·구매자명·상품명·수량 대조", "scripts/_ss-match.mjs");

if (!GO) {
  step("확인창까지 (드라이런)", "scripts/ss-cancel.mjs", ["--dry"]);
  console.log("\n[실행] 여기까지 확인했으면 아래로 전건 판매취소한다:");
  console.log("       npm run ss:cancel -- --go");
  process.exit(0);
}

step("전건 판매취소", "scripts/ss-cancel.mjs");
console.log("\n[실행] 목록에서 실제로 빠졌는지 확인한 뒤 발주서에 반영한다:");
console.log("       node scripts/_ss-collect.mjs && node scripts/ss-cancel-apply.mjs");
