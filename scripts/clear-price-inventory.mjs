// 가격·재고 캐시를 비운다 (지우기 전 백업 저장).
//
//   node scripts/clear-price-inventory.mjs <esm|smartstore|coupang> [--apply]
//
// 왜 필요한가:
//   임포트는 상품번호 기준 upsert라 새 파일에 없는 옛 행이 그대로 남는다.
//   상품을 전부 새로 등록한 뒤에는 옛 행이 잔재로 남아 내보내기에 섞이므로 비우고 다시 받는다.
import { serviceClient, fetchAll } from "./_lib.mjs";
import fs from "fs";

const TABLES = { esm: "esm_price_inventory", smartstore: "smartstore_price_inventory", coupang: "coupang_price_inventory" };
const table = TABLES[process.argv[2]];
const APPLY = process.argv.includes("--apply");
if (!table) { console.log(`사용법: node scripts/clear-price-inventory.mjs <${Object.keys(TABLES).join("|")}> [--apply]`); process.exit(1); }

const sb = serviceClient();
const rows = await fetchAll(sb, table, "*", null, 1000);
console.log(`${table} ${rows.length}행`);
if (!rows.length) { console.log("비어 있다. 할 일 없음."); process.exit(0); }
if (!APPLY) { console.log("(지우려면 --apply)"); process.exit(0); }

fs.mkdirSync("scripts/output", { recursive: true });
const backup = `scripts/output/backup_${table}.json`;
fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
console.log(`백업: ${backup}`);

const { error } = await sb.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
if (error) { console.error(`[캐시비우기] 삭제 실패: ${error.message}`); process.exit(1); }
const { count } = await sb.from(table).select("*", { count: "exact", head: true });
console.log(`남은 행 ${count ?? 0}`);
