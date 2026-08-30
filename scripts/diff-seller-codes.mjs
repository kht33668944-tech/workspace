// 판매자관리코드 엑셀 vs DB 비교 (dry-run)
// 사용법: node scripts/diff-seller-codes.mjs
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// .env.local 직접 파싱
const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[diff] env 누락');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// 1) 엑셀 읽기
const xlsxPath = process.argv[2] ?? 'C:/Users/sksso/Desktop/판매자관리코드 수정1.xlsx';
const wb = XLSX.readFile(xlsxPath);
console.log(`[diff] 파일: ${xlsxPath}`);
const ws = wb.Sheets['쇼핑몰상품'];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

// 쇼핑몰계정 -> DB 그룹
const SHOP_TO_GROUP = {
  '옥션=redgoom00': 'esm',
  '지마켓=redgoom00': 'esm',
  '11번가=redgoom00': 'esm',
  '스마트스토어=redgoom': 'smartstore',
  '쿠팡=redgoom': 'coupang',
};

console.log(`[diff] 엑셀 ${rows.length}행 로드`);

// 2) DB의 모든 products (user 한 명 가정 - 첫 user_id 사용 또는 전체)
const { data: products, error } = await supabase
  .from('products')
  .select('id, product_name, platform_codes, seller_code, user_id');
if (error) { console.error('[diff] DB 조회 실패:', error.message); process.exit(1); }

console.log(`[diff] DB 상품 ${products.length}개 로드`);

// 3) platform_codes 역인덱스 구성: (shopKey, shopProductNumber) -> productId
const idx = new Map(); // key: `${shopKey}::${shopProductNumber}` -> product
for (const p of products) {
  const pc = p.platform_codes ?? {};
  for (const [shopKey, shopProductNumber] of Object.entries(pc)) {
    if (!shopProductNumber) continue;
    const key = `${shopKey}::${String(shopProductNumber).trim()}`;
    if (!idx.has(key)) idx.set(key, p);
  }
}

console.log(`[diff] platform_codes 인덱스 ${idx.size}개`);

// 4) 엑셀 순회: 매칭 + diff
const diffs = new Map(); // productId -> { product, changes: { group: { from, to, source[] } } }
const unmatched = [];
let matchedRows = 0;

for (const row of rows) {
  const code = String(row['판매자관리코드'] ?? '').trim();
  const shopKey = String(row['쇼핑몰(계정)'] ?? '').trim();
  const shopPid = String(row['쇼핑몰 상품번호'] ?? '').trim();
  const name = String(row['온라인 상품명'] ?? '').trim();
  if (!code || !shopKey || !shopPid) continue;

  const group = SHOP_TO_GROUP[shopKey];
  if (!group) { unmatched.push({ name, shopKey, shopPid, code, reason: 'unknown shopKey' }); continue; }

  const product = idx.get(`${shopKey}::${shopPid}`);
  if (!product) { unmatched.push({ name, shopKey, shopPid, code, reason: 'no DB product' }); continue; }

  matchedRows++;
  const dbCodes = product.seller_code ?? {};
  const dbCode = dbCodes[group];

  if (dbCode !== code) {
    let entry = diffs.get(product.id);
    if (!entry) {
      entry = { product, changes: {} };
      diffs.set(product.id, entry);
    }
    if (!entry.changes[group]) {
      entry.changes[group] = { from: dbCode ?? null, to: code, sources: [] };
    } else if (entry.changes[group].to !== code) {
      // 같은 그룹에 다른 코드가 들어오면 충돌
      entry.changes[group].conflict = true;
    }
    entry.changes[group].sources.push(`${shopKey}/${shopPid}`);
  }
}

console.log(`\n[diff] 매칭된 행: ${matchedRows} / 미매칭: ${unmatched.length}`);
console.log(`[diff] 코드 불일치 상품: ${diffs.size}개\n`);

// 미매칭 미리보기
if (unmatched.length) {
  console.log('--- 미매칭 행 (앞 10개) ---');
  for (const u of unmatched.slice(0, 10)) {
    console.log(`  · ${u.shopKey} / pid=${u.shopPid} / "${u.name}" → ${u.reason}`);
  }
  if (unmatched.length > 10) console.log(`  ... 외 ${unmatched.length - 10}개`);
  console.log();
}

// diff 출력
if (diffs.size === 0) {
  console.log('변경할 항목 없음 (모든 코드가 엑셀과 일치)');
} else {
  console.log('--- 변경 예정 ---');
  let n = 0;
  const out = [];
  for (const { product, changes } of diffs.values()) {
    n++;
    const lines = [`[${n}] ${product.product_name}  (id=${product.id})`];
    for (const [group, c] of Object.entries(changes)) {
      const flag = c.conflict ? ' ⚠️CONFLICT' : '';
      lines.push(`    ${group}: ${c.from ?? '(없음)'} → ${c.to}${flag}  [${c.sources.join(', ')}]`);
    }
    console.log(lines.join('\n'));
    out.push({ id: product.id, product_name: product.product_name, changes });
  }
  // JSON 저장
  const fs = await import('node:fs');
  fs.writeFileSync('scripts/seller-code-diffs.json', JSON.stringify(out, null, 2));
  console.log(`\n[diff] scripts/seller-code-diffs.json 에 저장 완료`);
}
