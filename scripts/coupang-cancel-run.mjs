// 쿠팡 취소 전체 파이프라인 한 방 실행.
//
//   npm run coupang:cancel          → 크롬 실행 + 로그인 대기 + 대조 + 1건 접수 직전까지 (안전 확인용)
//   npm run coupang:cancel -- --go  → 위 확인 후 전건 접수 + 발주서 취소완료 반영
//
// 크롬은 전용 프로필(.browser-profiles/coupang-wing)로 뜬다. 로그인 세션이 남아 다음부터는 바로 진행된다.
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

// 1. 크롬 준비
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
    "https://wing.coupang.com/",
  ], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 20 && !(await cdpUp()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await cdpUp())) { console.error("[실행] 크롬 디버깅 포트가 열리지 않았다"); process.exit(1); }
}

// 2. 로그인 대기 (이미 로그인돼 있으면 즉시 통과)
step("쿠팡윙 로그인 확인 — 안 돼 있으면 크롬 창에서 로그인하세요", "scripts/_wing-wait-login.mjs");

// 3. 대상 추출 → 윙 목록 수집 → 대조
step("발주서에서 취소준비 쿠팡 주문 추출", "scripts/_cancel-list.mjs");
step("쿠팡윙 상품준비중 목록 수집", "scripts/_wing-collect.mjs");
step("수취인명·상품명 대조", "scripts/_wing-match.mjs");

// 4. 접수
if (!GO) {
  step("1건 접수 직전까지 (드라이런)", "scripts/coupang-cancel.mjs", ["--dry"]);
  console.log("\n[실행] 여기까지 확인했으면 아래로 전건 접수한다:");
  console.log("       npm run coupang:cancel -- --go");
  process.exit(0);
}

step("전건 반품접수", "scripts/coupang-cancel.mjs");
step("발주서 취소완료 반영", "scripts/coupang-cancel-apply.mjs");
console.log("\n[실행] 끝. 결과는 scripts/_cancel-results.json");
