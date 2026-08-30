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
  await page.waitForTimeout(1500);
  await page.getByText('배송준비중', { exact:false }).first().click();
  await page.waitForTimeout(2500);
  await page.locator('input[type="checkbox"]').nth(3).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '자동화' }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUTDIR, 'automation-menu.png'), fullPage:true });
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0,5000),
    buttons: [...document.querySelectorAll('button,a,[role=button]')].map((el,i)=>({i, text:(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,180), tag:el.tagName, disabled:!!el.disabled})).filter(x=>x.text).slice(0,100),
    checked: [...document.querySelectorAll('input[type=checkbox]')].map((el,i)=>({i, checked:el.checked}))
  }));
  console.log(JSON.stringify({ok:true,info},null,2));
  await ctx.close();
})().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message, stack:e.stack},null,2));process.exit(1)});
