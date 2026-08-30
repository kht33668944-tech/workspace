// 마이그레이션 2개가 Supabase에 적용됐는지 자동 체크
// - coupang_options 컬럼 (products 테이블)
// - uniq_products_user_product_name 유니크 인덱스 (products 테이블)

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

console.log('[check] Supabase 마이그레이션 적용 여부 확인 중...\n');

// 1. coupang_options 컬럼 존재 여부
let columnOk = false;
{
  const { error } = await supabase.from('products').select('coupang_options').limit(1);
  if (!error) {
    columnOk = true;
    console.log('✅ coupang_options 컬럼: 적용됨');
  } else {
    console.log('❌ coupang_options 컬럼: 미적용');
    console.log(`   에러: ${error.message}`);
  }
}

// 2. uniq_products_user_product_name 인덱스 존재 여부
// PostgREST는 pg_indexes 직접 접근 불가 → 중복 데이터 검사로 간접 확인
// (인덱스가 있다면 중복이 0건이어야 함. 단, 0건이라고 해서 인덱스 존재가 100% 보장되진 않음)
let indexLikelyOk = false;
{
  const { data, error } = await supabase
    .from('products')
    .select('user_id, product_name')
    .neq('product_name', '')
    .not('product_name', 'is', null);

  if (error) {
    console.log(`❓ 인덱스 간접 확인 실패: ${error.message}`);
  } else {
    const seen = new Map();
    let duplicates = 0;
    for (const row of data) {
      const key = `${row.user_id}::${row.product_name}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count === 2) duplicates++;
    }
    if (duplicates === 0) {
      indexLikelyOk = true;
      console.log('✅ 중복 상품명 없음 → 유니크 인덱스 적용 가능 상태 (적용됨일 가능성 높음)');
    } else {
      console.log(`⚠️  중복 상품명 ${duplicates}건 발견 → 유니크 인덱스가 적용되지 않은 상태입니다`);
    }
  }
}

console.log('\n──────────────────────────────────────');
if (columnOk && indexLikelyOk) {
  console.log('🎉 두 마이그레이션 모두 적용된 것으로 보입니다.');
} else {
  console.log('⚠️  일부 마이그레이션이 미적용 상태입니다.');
  console.log('   Supabase 대시보드 → SQL Editor 에서 아래 파일을 실행하세요:');
  if (!columnOk) console.log('   - supabase/migrations/coupang_options.sql');
  if (!indexLikelyOk) console.log('   - supabase/migrations/uniq_products_name.sql');
}
