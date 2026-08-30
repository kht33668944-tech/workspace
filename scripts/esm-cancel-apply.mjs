// esm-cancel.mjs 결과를 발주서에 반영한다 — 판매취소 성공한 건만 취소준비 → 취소완료.
import { serviceClient } from "./_lib.mjs";
import fs from "fs";

const done = JSON.parse(fs.readFileSync("scripts/_esm-results.json", "utf8"));
console.log(`[발주서반영] 판매취소 완료 ${done.length}건`);
if (!done.length) process.exit(0);

const sb = serviceClient();
let ok = 0;
for (const r of done) {
  const { error } = await sb.from("orders")
    .update({ delivery_status: "취소완료" })
    .eq("id", r.id)
    .eq("delivery_status", "취소준비");   // 그 사이 상태가 바뀌었으면 건드리지 않는다
  if (error) console.log(`[발주서반영] 실패 ${r.수령인명}: ${error.message}`);
  else ok++;
}
console.log(`[발주서반영] 취소완료로 변경: ${ok}건`);
