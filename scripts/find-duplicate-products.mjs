// products 테이블에서 같은 (user_id, product_name) 중복 상품을 찾아서 상세 정보 출력

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from('products')
  .select('id, user_id, product_name, lowest_price, margin_rate, category, purchase_url, registration_status, created_at, updated_at')
  .neq('product_name', '')
  .not('product_name', 'is', null)
  .order('product_name', { ascending: true })
  .order('created_at', { ascending: true });

if (error) {
  console.error('조회 실패:', error.message);
  process.exit(1);
}

// (user_id, product_name) 그룹화
const groups = new Map();
for (const row of data) {
  const key = `${row.user_id}::${row.product_name}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const duplicates = [...groups.entries()].filter(([, rows]) => rows.length > 1);

if (duplicates.length === 0) {
  console.log('✅ 중복 상품 없음');
  process.exit(0);
}

console.log(`⚠️  중복 상품명 ${duplicates.length}건 발견\n`);

let group = 1;
for (const [key, rows] of duplicates) {
  const productName = key.split('::')[1];
  console.log(`━━━ 그룹 ${group}: "${productName}" (${rows.length}개) ━━━`);
  rows.forEach((r, i) => {
    console.log(`  [${i + 1}] id=${r.id}`);
    console.log(`      카테고리: ${r.category ?? '-'}`);
    console.log(`      최저가: ${r.lowest_price ?? '-'}원 / 마진율: ${r.margin_rate ?? '-'}% / 등록상태: ${r.registration_status ?? '-'}`);
    console.log(`      구매URL: ${r.purchase_url ?? '-'}`);
    console.log(`      생성일: ${r.created_at?.slice(0, 19).replace('T', ' ')}`);
    console.log(`      수정일: ${r.updated_at?.slice(0, 19).replace('T', ' ')}`);
  });
  console.log('');
  group++;
}

console.log('💡 각 그룹마다 어느 row(=[1], [2]...)를 남기실지 알려주세요.');
console.log('   보통 "최근에 수정된 것" 또는 "가격 정보가 있는 것"을 남기는 것이 안전합니다.');
