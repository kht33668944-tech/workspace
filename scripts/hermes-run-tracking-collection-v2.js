const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx-js-style');
const PROFILE='C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-default';
const OUTDIR='C:/Users/kht33/AppData/Local/hermes/chrome-profiles/workspace-run-evidence';
fs.mkdirSync(OUTDIR,{recursive:true});
const runStart=Date.now();
function parseWorkbook(file){const wb=XLSX.readFile(file);const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:''});return rows.map(r=>({묶음번호:String(r['묶음번호']??''),주문일시:String(r['주문일시']??''),판매처:String(r['판매처']??''),수취인명:String(r['수취인명']??r['수취인']??''),상품명:String(r['상품명']??''),구매아이디:String(r['구매아이디']??''),주문번호:String(r['주문번호']??''),택배사:String(r['택배사']??''),운송장:String(r['운송장']??r['운송장번호']??'')}));}
(async()=>{
 const ctx=await chromium.launchPersistentContext(PROFILE,{channel:'chrome',headless:false,args:['--profile-directory=Default'],acceptDownloads:true,downloadsPath:OUTDIR,viewport:{width:1440,height:1000}});
 const page=ctx.pages()[0]||await ctx.newPage();
 const events=[]; const downloads=[];
 page.on('download',async d=>{const suggested=d.suggestedFilename(); const target=path.join(OUTDIR,suggested); await d.saveAs(target); downloads.push({suggested,path:target,size:fs.statSync(target).size,mtime:fs.statSync(target).mtimeMs});});
 page.on('console',msg=>{if(['error','warning'].includes(msg.type()))events.push({type:'console',level:msg.type(),text:msg.text().slice(0,500)})});
 page.on('pageerror',e=>events.push({type:'pageerror',text:e.message}));
 page.on('response',res=>{const u=res.url();if(/api|orders|tracking|collect/.test(u)&&res.status()>=400)events.push({type:'response',status:res.status(),url:u})});
 await page.goto('http://localhost:3000/workspace/orders?tab=orders&month=2026-07',{waitUntil:'domcontentloaded',timeout:30000}); await page.waitForTimeout(2500);
 const before=await page.locator('body').innerText(); const total=(before.match(/총\s*(\d+)건/)||[])[1]||null;
 await page.locator('input[type="checkbox"]').first().click(); await page.waitForTimeout(700);
 const selected=await page.locator('body').innerText(); const selectedCount=(selected.match(/(\d+)건 삭제/)||[])[1]||null;
 await page.getByRole('button',{name:'자동화'}).click(); await page.waitForTimeout(500);
 await page.getByRole('button',{name:/배송조회\s*수집/}).click(); await page.waitForTimeout(1200);
 const modalBefore=await page.locator('body').innerText(); const collectible=(modalBefore.match(/자동 수집\s*\((\d+)건\)/)||[])[1]||null;
 await page.screenshot({path:path.join(OUTDIR,'tracking-before-auto-collect.png'),fullPage:true});
 await page.getByRole('button',{name:/자동\s*수집/}).click();
 const start=Date.now(); let body='';
 while(Date.now()-start<420000){
   await page.waitForTimeout(3000);
   body=await page.locator('body').innerText().catch(()=>body);
   const hasExport=await page.getByRole('button',{name:/엑셀\s*내보내기/}).count().catch(()=>0);
   const noAuto=await page.getByRole('button',{name:/자동\s*수집/}).count().catch(()=>0);
   if(hasExport>0 || /등록할 운송장이 없습니다|성공\s*0건/.test(body) || (/성공\s*\d+건/.test(body)&&/실패\s*\d+건/.test(body)&&noAuto===0)) break;
 }
 await page.screenshot({path:path.join(OUTDIR,'tracking-after-auto-collect.png'),fullPage:true});
 body=await page.locator('body').innerText();
 const success=Number((body.match(/성공\s*(\d+)건/)||[])[1]||0); const failMatch=body.match(/실패\s*(\d+)건/); const fail=failMatch?Number(failMatch[1]):null;
 if(success>0){
   await page.getByRole('button',{name:/엑셀\s*내보내기/}).click();
   await page.waitForTimeout(10000);
 }
 const recent=fs.readdirSync(OUTDIR).filter(f=>f.toLowerCase().endsWith('.xlsx')).map(f=>{const p=path.join(OUTDIR,f);const st=fs.statSync(p);return{suggested:f,path:p,size:st.size,mtime:st.mtimeMs}}).filter(x=>x.mtime>=runStart-30000).sort((a,b)=>b.mtime-a.mtime);
 for(const r of recent) if(!downloads.some(d=>d.path===r.path)) downloads.push(r);
 const detailFile=downloads.find(d=>/배송조회수집/.test(d.suggested)); const playautoFile=downloads.find(d=>/플레이오토|playauto/i.test(d.suggested));
 const rows=detailFile?parseWorkbook(detailFile.path):[];
 console.log(JSON.stringify({ok:true,outdir:OUTDIR,total:Number(total),selectedCount:Number(selectedCount),collectible:Number(collectible),success,fail,downloads,detailFile,playautoFile,rows,modalText:body.slice(0,4000),events},null,2));
 await ctx.close();
})().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,stack:e.stack},null,2));process.exit(1)});
