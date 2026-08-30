const { chromium } = require('playwright');
(async()=>{
 const ctx=await chromium.launchPersistentContext('C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-default',{channel:'chrome',headless:false,args:['--profile-directory=Default'],viewport:{width:1440,height:1000}});
 const page=ctx.pages()[0]||await ctx.newPage();
 await page.goto('http://localhost:3000/workspace/orders?tab=orders&month=2026-07',{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2000);
 await page.locator('input[type="checkbox"]').first().click(); await page.waitForTimeout(500);
 await page.getByRole('button',{name:'자동화'}).click(); await page.waitForTimeout(1000);
 const info=await page.evaluate(()=>({text:document.body.innerText.slice(0,1500), buttons:[...document.querySelectorAll('button,a,[role=button]')].map((el,i)=>({i,text:(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,150), tag:el.tagName, disabled:!!el.disabled, display:getComputedStyle(el).display, visibility:getComputedStyle(el).visibility})).filter(x=>x.text).slice(0,80)}));
 console.log(JSON.stringify(info,null,2)); await ctx.close();
})().catch(e=>{console.error(e);process.exit(1)});
