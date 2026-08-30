// scripts/seller-code-diffs.json 의 변경사항을 DB에 적용
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

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const diffs = JSON.parse(readFileSync('scripts/seller-code-diffs.json', 'utf-8'));
console.log(`[apply] ${diffs.length}개 상품 업데이트 시작`);

let ok = 0, fail = 0;
for (const d of diffs) {
  // 현재 seller_code 조회
  const { data: cur, error: e1 } = await supabase
    .from('products').select('seller_code').eq('id', d.id).single();
  if (e1) { console.error(`  ✗ ${d.product_name}: 조회 실패 ${e1.message}`); fail++; continue; }

  const next = { ...(cur.seller_code ?? {}) };
  const conflicts = [];
  for (const [group, c] of Object.entries(d.changes)) {
    if (c.conflict) { conflicts.push(group); continue; }
    next[group] = c.to;
  }
  if (conflicts.length) {
    console.error(`  ⚠️ ${d.product_name}: 충돌 그룹 [${conflicts.join(',')}] 건너뜀`);
    fail++; continue;
  }

  const { error: e2 } = await supabase
    .from('products').update({ seller_code: next }).eq('id', d.id);
  if (e2) { console.error(`  ✗ ${d.product_name}: 업데이트 실패 ${e2.message}`); fail++; continue; }
  ok++;
}

console.log(`\n[apply] 완료: 성공 ${ok} / 실패 ${fail}`);
