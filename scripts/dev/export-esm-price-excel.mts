// ESM(옥션·지마켓) 가격수정 엑셀을 상품목록 전체(등록완료·판매중지, 판매종료 제외) 기준으로 생성해 바탕화면\가격수정엑셀\<날짜>\ 에 저장
//   npx tsx scripts/dev/export-esm-price-excel.mts
import fs from "fs";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim()];}));
const BASE = (process.env.AUTO_BASE_URL ?? env.AUTO_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;

// 사용자 JWT (매직링크 → 세션)
const { data: userRes } = await admin.auth.admin.getUserById(userId);
const email = userRes.user?.email;
if (!email) throw new Error("사용자 이메일을 찾을 수 없음");
const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
if (linkErr) throw linkErr;
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: sess, error: otpErr } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
if (otpErr || !sess.session) throw otpErr ?? new Error("세션 발급 실패");
const token = sess.session.access_token;

const { data: prods } = await admin.from("products").select("id").eq("user_id", userId).in("registration_status", ["등록완료", "판매중지"]).limit(5000);
const ids = (prods ?? []).map((p) => p.id);
const res = await fetch(`${BASE}/api/esm-price-inventory/export`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ productIds: ids }) });
const json = (await res.json()) as { files?: Array<{ excelBase64: string; filename: string; rowCount: number }>; error?: string; skippedProductIds?: string[] };
if (!res.ok) throw new Error(json.error ?? String(res.status));
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const outDir = path.join(env.AUTO_EXPORT_DIR ?? path.join(os.homedir(), "Desktop", "가격수정엑셀"), today);
fs.mkdirSync(outDir, { recursive: true });
const saved: string[] = [];
for (const f of json.files ?? []) {
  const p = path.join(outDir, `전체_${f.filename}`);
  fs.writeFileSync(p, Buffer.from(f.excelBase64, "base64"));
  saved.push(`${p} (${f.rowCount}행)`);
}
console.log(`ESM 가격수정 엑셀: 상품 ${ids.length}개 요청 → 파일 ${saved.length}개, 미매칭 ${json.skippedProductIds?.length ?? 0}개`);
for (const s of saved) console.log("  ", s);
process.exit(0);
