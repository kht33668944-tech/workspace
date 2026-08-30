const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PROFILE = 'C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-default';
const OUTDIR = 'C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-run-evidence';
fs.mkdirSync(OUTDIR, { recursive: true });
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel:'chrome', headless:false, args:['--profile-directory=Default'], acceptDownloads:true, downloadsPath:OUTDIR, viewport:{width:1440,height:1000} });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('http://localhost:3000/workspace/', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByText('배송준비중', { exact: false }).first().click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUTDIR, 'orders-shipping-ready.png'), fullPage: true });
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0,8000),
    buttons: [...document.querySelectorAll('button,a,[role=button]')].map((el,i)=>({i, text:(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,160), tag:el.tagName, disabled:!!el.disabled})).filter(x=>x.text).slice(0,200),
    inputs: [...document.querySelectorAll('input')].map((el,i)=>({i, type:el.type, checked:el.checked, aria:el.getAttribute('aria-label'), placeholder:el.placeholder, name:el.name, id:el.id})).slice(0,100)
  }));
  console.log(JSON.stringify({ok:true,outdir:OUTDIR,info},null,2));
  await ctx.close();
})().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message, stack:e.stack},null,2));process.exit(1)});
