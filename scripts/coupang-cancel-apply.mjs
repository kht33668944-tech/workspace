// coupang-cancel.mjs 결과를 발주서에 반영한다 — 접수 성공한 건만 취소준비 → 취소완료.
import { serviceClient } from "./_lib.mjs";
import fs from "fs";

const results = JSON.parse(fs.readFileSync("scripts/_cancel-results.json", "utf8"));
const done = results.filter((r) => r.result === "완료");
console.log(`[발주서반영] 접수 완료 ${done.length}건 / 전체 ${results.length}건`);
if (!done.length) process.exit(0);

const sb = serviceClient();
let ok = 0;
for (const r of done) {
  const { error } = await sb.from("orders")
    .update({ delivery_status: "취소완료" })
    .eq("id", r.id)
    .eq("delivery_status", "취소준비");   // 그 사이 상태가 바뀌었으면 건드리지 않는다
  if (error) console.log(`[발주서반영] 실패 ${r.recipient_name}: ${error.message}`);
  else ok++;
}
console.log(`[발주서반영] 취소완료로 변경: ${ok}건`);
