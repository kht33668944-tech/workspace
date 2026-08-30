const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx-js-style');

const PROFILE = 'C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-default';
const OUTDIR = 'C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-run-evidence';
fs.mkdirSync(OUTDIR, { recursive: true });
const now = Date.now();

function parseWorkbook(file) {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows.map(r => ({
    묶음번호: String(r['묶음번호'] ?? r['묶음 번호'] ?? ''),
    주문일시: String(r['주문일시'] ?? ''),
    판매처: String(r['판매처'] ?? ''),
    수취인명: String(r['수취인명'] ?? r['수취인'] ?? ''),
    상품명: String(r['상품명'] ?? ''),
    구매아이디: String(r['구매아이디'] ?? r['구매 아이디'] ?? ''),
    주문번호: String(r['주문번호'] ?? r['주문 번호'] ?? ''),
    택배사: String(r['택배사'] ?? ''),
    운송장: String(r['운송장'] ?? r['운송장번호'] ?? ''),
  }));
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: false, args: ['--profile-directory=Default'],
    acceptDownloads: true, downloadsPath: OUTDIR, viewport: { width: 1440, height: 1000 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const downloads = [];
  const events = [];
  page.on('download', async d => {
    const suggested = d.suggestedFilename();
    const target = path.join(OUTDIR, suggested);
    await d.saveAs(target).catch(async () => {
      const tmp = await d.path().catch(()=>null);
      if (tmp) fs.copyFileSync(tmp, target);
    });
    downloads.push({ suggested, path: target, size: fs.existsSync(target) ? fs.statSync(target).size : 0 });
  });
  page.on('console', msg => { if (['error','warning'].includes(msg.type())) events.push({ type:'console', level:msg.type(), text:msg.text().slice(0,500) }); });
  page.on('pageerror', e => events.push({ type:'pageerror', text:e.message }));
  page.on('response', res => { const u=res.url(); if (/api|orders|tracking|collect/.test(u) && res.status()>=400) events.push({type:'response',status:res.status(),url:u}); });

  await page.goto('http://localhost:3000/workspace/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.getByText('배송준비중', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  const beforeText = await page.locator('body').innerText();
  const totalMatch = beforeText.match(/총\s*(\d+)건/);
  const total = totalMatch ? Number(totalMatch[1]) : null;

  // header checkbox is the first checkbox inside the order table.
  await page.locator('input[type="checkbox"]').first().click();
  await page.waitForTimeout(800);
  const selectedText = await page.locator('body').innerText();
  await page.getByRole('button', { name: '자동화' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /배송조회\s*수집/ }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUTDIR, 'tracking-modal-before-start.png'), fullPage: true });
  await page.getByRole('button', { name: /자동\s*수집/ }).click();

  const start = Date.now();
  let body = '';
  while (Date.now() - start < 420000) {
    await page.waitForTimeout(3000);
    body = await page.locator('body').innerText().catch(()=>body);
    if (/엑셀\s*내보내기|완료|성공\s*\d+건|실패\s*\d+건|등록할 운송장이 없습니다/.test(body) && !/수집 중|처리 중|진행 중/.test(body)) break;
  }
  await page.screenshot({ path: path.join(OUTDIR, 'tracking-modal-after-collect.png'), fullPage: true });
  body = await page.locator('body').innerText();
  const successMatch = body.match(/성공\s*(\d+)건/);
  const failMatch = body.match(/실패\s*(\d+)건/);
  const success = successMatch ? Number(successMatch[1]) : null;
  const fail = failMatch ? Number(failMatch[1]) : null;

  if (success && success > 0) {
    const exportBtn = page.getByRole('button', { name: /엑셀\s*내보내기/ });
    await exportBtn.waitFor({ state: 'visible', timeout: 30000 });
    await exportBtn.click();
    await page.waitForTimeout(8000);
  }

  // include any recent xlsx in downloads dir modified during run
  const recentXlsx = fs.readdirSync(OUTDIR)
    .filter(f => f.toLowerCase().endsWith('.xlsx'))
    .map(f => ({ suggested: f, path: path.join(OUTDIR, f), size: fs.statSync(path.join(OUTDIR, f)).size, mtime: fs.statSync(path.join(OUTDIR, f)).mtimeMs }))
    .filter(x => x.mtime >= now - 30000)
    .sort((a,b)=>b.mtime-a.mtime);
  for (const x of recentXlsx) if (!downloads.some(d => d.path === x.path)) downloads.push(x);

  let detailFile = downloads.find(d => /배송조회수집/.test(d.suggested || d.path));
  let playautoFile = downloads.find(d => /플레이오토|playauto/i.test(d.suggested || d.path));
  let rows = [];
  if (detailFile && fs.existsSync(detailFile.path)) rows = parseWorkbook(detailFile.path);

  const result = { ok:true, outdir:OUTDIR, total, selectedSnippet:selectedText.slice(0,500), success, fail, downloads, detailFile, playautoFile, rows, modalText: body.slice(0,5000), events };
  console.log(JSON.stringify(result, null, 2));
  await ctx.close();
})().catch(e => { console.error(JSON.stringify({ ok:false, error:e.message, stack:e.stack }, null, 2)); process.exit(1); });
