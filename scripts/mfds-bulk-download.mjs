// 식약처 품목제조보고(C002)·바코드연계(C005) 전체 데이터를 로컬로 통째 내려받는다.
//
//   node scripts/mfds-bulk-download.mjs          C002 + C005 전부
//   node scripts/mfds-bulk-download.mjs C002     하나만
//
// 왜 이렇게 하나:
//   오픈API 제한은 "하루 1,000회"이고 1회에 최대 1,000건을 받을 수 있다.
//   상품마다 이름으로 검색하면 1개당 8~10회를 써서 하루 100개가 한계지만,
//   페이지 단위로 통째 받으면 몇백 회로 전체 DB가 손에 들어온다.
//   그다음부터 매칭은 로컬에서 하므로 API 호출이 0이 된다.
//
// 저장: scripts/output/mfds-C002.json, mfds-C005.json  (이어받기 지원)
import fs from "fs";
import path from "path";

const env = fs.readFileSync(".env.local", "utf8");
const KEY = (env.match(/^MFDS_API_KEY=(.*)$/m) || [])[1].trim();

const PAGE = 1000;           // 1회 요청당 건수 (API 최대)
const SERVICES = process.argv.slice(2).filter((a) => /^C\d+$/.test(a));
const TARGETS = SERVICES.length ? SERVICES : ["C002", "C005", "C006"];

const outDir = path.join("scripts", "output");
fs.mkdirSync(outDir, { recursive: true });

/** 일일 한도(INFO-300)에 걸리면 자정(KST) 리셋까지 기다린다 */
async function waitForQuotaReset() {
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
  const nextKst = new Date(nowKst);
  nextKst.setUTCHours(0, 5, 0, 0);
  if (nextKst <= nowKst) nextKst.setUTCDate(nextKst.getUTCDate() + 1);
  const waitMs = nextKst - nowKst;
  console.log(`[bulk] 일일 한도 소진 — ${new Date(Date.now() + waitMs).toLocaleString("ko-KR")}까지 ${(waitMs / 3600000).toFixed(1)}시간 대기`);
  const step = 30 * 60 * 1000;
  for (let left = waitMs; left > 0; left -= step) {
    await new Promise((s) => setTimeout(s, Math.min(step, left)));
    if (left > step) console.log(`[bulk] 대기 중… 남은 시간 ${((left - step) / 3600000).toFixed(1)}시간`);
  }
  console.log("[bulk] 한도 리셋 — 재개");
}

async function fetchPage(service, start, end, retry = 0) {
  const url = `http://openapi.foodsafetykorea.go.kr/api/${KEY}/${service}/json/${start}/${end}`;
  try {
    const r = await fetch(url);
    const j = JSON.parse(await r.text());
    const box = j[service];
    const code = box?.RESULT?.CODE;
    if (code === "INFO-500" && retry < 8) {                  // 동시접속 1개 제한
      await new Promise((s) => setTimeout(s, 1500 * (retry + 1)));
      return fetchPage(service, start, end, retry + 1);
    }
    if (code === "INFO-300") {                                // 일일 한도
      await waitForQuotaReset();
      return fetchPage(service, start, end, 0);
    }
    return { rows: box?.row || [], total: Number(box?.total_count || 0), code };
  } catch (e) {
    if (retry < 8) {
      await new Promise((s) => setTimeout(s, 2000 * (retry + 1)));
      return fetchPage(service, start, end, retry + 1);
    }
    return { rows: [], total: 0, code: "ERROR" };
  }
}

// 서비스별로 남길 필드만 추린다 (전체를 다 담으면 파일이 수백 MB가 된다)
const PICK = {
  C002: (x) => ({
    nm: x.PRDLST_NM,           // 제품명
    dc: x.PRDLST_DCNM,         // 식품유형
    bssh: x.BSSH_NM,           // 제조업소
    no: x.PRDLST_REPORT_NO,    // 품목보고번호
    pog: x.POG_DAYCNT || "",   // 소비기한
    raw: x.RAWMTRL_NM || "",   // 원재료
  }),
  // C005는 제품명·식품유형·업소·소재지·소비기한·바코드를 모두 갖고 있다 (원재료만 없음)
  C005: (x) => ({
    nm: x.PRDLST_NM,
    dc: x.PRDLST_DCNM || "",
    bssh: x.BSSH_NM || "",
    no: x.PRDLST_REPORT_NO,
    pog: x.POG_DAYCNT || "",
    bar: x.BAR_CD || "",
    site: x.SITE_ADDR || "",
  }),
  // C006은 축산물(우유·가공유·포장육). 원재료가 한 줄에 하나씩 나뉘어 있어 나중에 합친다.
  C006: (x) => ({
    nm: x.PRDLST_NM,
    dc: x.PRDLST_DCNM || "",
    bssh: x.BSSH_NM || "",
    no: x.PRDLST_REPORT_NO,
    raw: x.RAWMTRL_NM || "",
  }),
};

for (const service of TARGETS) {
  const file = path.join(outDir, `mfds-${service}.json`);
  let rows = [];
  let start = 1;
  if (fs.existsSync(file)) {                                  // 이어받기
    try {
      rows = JSON.parse(fs.readFileSync(file, "utf8"));
      start = rows.length + 1;
      console.log(`[bulk] ${service} 기존 ${rows.length}건 발견 — ${start}부터 이어받는다`);
    } catch { rows = []; start = 1; }
  }

  const first = await fetchPage(service, start, start + PAGE - 1);
  const total = first.total;
  if (!total) { console.log(`[bulk] ${service} total_count 없음 (code=${first.code}) — 건너뜀`); continue; }
  console.log(`[bulk] ${service} 전체 ${total.toLocaleString()}건 / 예상 ${Math.ceil((total - start + 1) / PAGE)}회 호출`);

  let batch = first.rows;
  while (batch.length) {
    rows.push(...batch.map(PICK[service]));
    if (rows.length % 20000 < PAGE) {
      fs.writeFileSync(file, JSON.stringify(rows));
      console.log(`  · ${rows.length.toLocaleString()} / ${total.toLocaleString()} (${((rows.length / total) * 100).toFixed(1)}%) 저장`);
    }
    start += PAGE;
    if (start > total) break;
    await new Promise((s) => setTimeout(s, 350));             // 동시접속 제한 회피
    batch = (await fetchPage(service, start, start + PAGE - 1)).rows;
  }

  fs.writeFileSync(file, JSON.stringify(rows));
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`[bulk] ${service} 완료 — ${rows.length.toLocaleString()}건, ${mb}MB → ${file}`);
}

console.log("[bulk] 전체 완료");
