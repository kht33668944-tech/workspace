import fs from "fs";
const src = fs.readFileSync("scripts/koreannet-match.mjs","utf8");
// match 함수만 떼어내 검사
const cat = JSON.parse(fs.readFileSync("scripts/output/koreannet-catalog.json","utf8"));
const gtinCheck=(d)=>{let s=0;for(let i=0;i<12;i++)s+=Number(d[i])*(i%2?3:1);return String((10-(s%10))%10);};
const validGtin=(b)=>/^\d{13}$/.test(b)&&gtinCheck(b.slice(0,12))===b[12];
function caps(text){const out=new Set();const re=/(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|밀리리터|L|l|리터|g|G|그램|kg|KG|킬로그램)(?![a-zA-Z가-힣])/g;let m;while((m=re.exec(text))){const v=Number(m[1].replace(",","."));const u=m[2].toLowerCase();if(u==="ml"||u==="밀리리터")out.add("v"+v);else if(u==="l"||u==="리터")out.add("v"+v*1000);else if(u==="g"||u==="그램")out.add("w"+v);else out.add("w"+v*1000);}return out;}
const isBundle=(nm)=>/[x×]\s*\d+\s*(개|캔|병|입|ea|EA|팩|포)?|\d+\s*(캔|병|입|매|포|봉|팩)\s*\)?$/.test(nm)||/\(\s*\d/.test(nm);
const STOP=/^(개|캔|병|펫|입|봉|매|포|팩|세트|기획|증정|리필|용기|겸용|대용량|묶음|무료배송|무라벨)$/;
const tok=(s)=>String(s).replace(/[^가-힣A-Za-z0-9]/g," ").split(/\s+/).filter(t=>t&&!STOP.test(t)&&!/^\d+$/.test(t));
const name="백설 하얀 설탕 1kg 16개";
const myCaps=caps(name); console.log("myCaps",[...myCaps]);
const bare=name.replace(/(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|KG)(?![a-zA-Z가-힣])/g," ").replace(/\d+\s*(개|캔|병|펫|입|봉|매|포|팩|종)/g," ");
console.log("bare",JSON.stringify(bare));
const my=[...new Set(tok(bare))]; console.log("my",my);
for(const r of cat["백설"]){
  if(!validGtin(r.bar))continue;
  if(isBundle(r.nm))continue;
  const rc=caps(r.nm);
  if(![...myCaps].some(c=>rc.has(c)))continue;
  const cn=r.nm.replace(/\s+/g,"");
  const missing=my.filter(t=>!cn.includes(t));
  if(missing.length){ if(/하얀설탕 1kg/.test(r.nm)) console.log("탈락",r.nm,"missing",missing); continue;}
  console.log("HIT",r.bar,r.nm);
}
