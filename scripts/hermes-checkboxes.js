const { chromium } = require('playwright');
(async()=>{
 const ctx=await chromium.launchPersistentContext('C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-default',{channel:'chrome',headless:false,args:['--profile-directory=Default'],viewport:{width:1440,height:1000}});
 const page=ctx.pages()[0]||await ctx.newPage();
 await page.goto('http://localhost:3000/workspace/orders?tab=orders&month=2026-07',{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2000);
 const data=await page.evaluate(()=>[...document.querySelectorAll('input[type=checkbox]')].map((el,i)=>{const r=el.getBoundingClientRect(); let p=el.parentElement; let texts=[]; for(let k=0;k<4&&p;k++,p=p.parentElement){texts.push((p.innerText||p.textContent||'').trim().replace(/\s+/g,' ').slice(0,250));} return {i, checked:el.checked, x:r.x,y:r.y,w:r.width,h:r.height, parentTexts:texts};}));
 console.log(JSON.stringify(data,null,2)); await ctx.close();
})().catch(e=>{console.error(e);process.exit(1)});
