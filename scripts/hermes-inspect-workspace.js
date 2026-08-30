const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE = 'C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-default';
const OUTDIR = 'C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-run-evidence';
fs.mkdirSync(OUTDIR, { recursive: true });

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    args: ['--profile-directory=Default'],
    acceptDownloads: true,
    downloadsPath: OUTDIR,
    viewport: { width: 1440, height: 1000 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const events = [];
  page.on('console', msg => events.push({ type: 'console', level: msg.type(), text: msg.text().slice(0, 500) }));
  page.on('pageerror', err => events.push({ type: 'pageerror', text: err.message }));
  page.on('response', res => {
    const u = res.url();
    if (/orders|tracking|collect|api/.test(u) && res.status() >= 400) events.push({ type:'response', status: res.status(), url: u });
  });
  await page.goto('http://localhost:3000/workspace/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(OUTDIR, 'workspace-initial.png'), fullPage: true });
  const info = await page.evaluate(() => {
    const text = document.body.innerText;
    const buttons = [...document.querySelectorAll('button, a, [role=button]')].map((el, i) => ({ i, text: (el.innerText || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0,120), tag: el.tagName, disabled: !!el.disabled })).filter(x => x.text);
    const inputs = [...document.querySelectorAll('input')].map((el, i)=>({i, type: el.type, placeholder: el.placeholder, checked: el.checked, aria: el.getAttribute('aria-label')}));
    return { url: location.href, title: document.title, text: text.slice(0, 5000), buttons: buttons.slice(0, 200), inputs: inputs.slice(0, 50) };
  });
  console.log(JSON.stringify({ ok: true, outdir: OUTDIR, info, events }, null, 2));
  await ctx.close();
})().catch(e => { console.error(JSON.stringify({ ok:false, error:e.message, stack:e.stack }, null, 2)); process.exit(1); });
