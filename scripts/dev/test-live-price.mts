// 실반영 테스트: 가격 +10 → 원복. 네이버는 PUT 전후 원상품 JSON 을 비교해 salePrice 외 변경이 없는지 검증.
//   MARKETPLACE_API_DRY_RUN=false npx tsx scripts/dev/test-live-price.mts coupang <vendorItemId> <currentPrice>
//   MARKETPLACE_API_DRY_RUN=false npx tsx scripts/dev/test-live-price.mts smartstore <originProductNo>
import fs from "fs";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { sleep } from "@/lib/marketplace/common";

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const [platform, id, priceArg] = process.argv.slice(2);
console.log("[live] DRY_RUN =", process.env.MARKETPLACE_API_DRY_RUN);

function diffKeys(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return a === b ? [] : [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) out.push(...diffKeys((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  return out;
}

if (platform === "coupang") {
  const c = new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY });
  const cur = Number(priceArg);
  const up = await c.changePrice(id, cur + 10);
  console.log("[live] +10 →", up.status, up.message, JSON.stringify(up.body));
  await sleep(1500);
  const back = await c.changePrice(id, cur);
  console.log("[live] 원복 →", back.status, back.message, JSON.stringify(back.body));
} else {
  const n = new NaverCommerceApiClient({ clientId: env.NAVER_COMMERCE_CLIENT_ID, clientSecret: env.NAVER_COMMERCE_CLIENT_SECRET });
  const before = await n.getOriginProduct(id);
  if (!before.ok || typeof before.body !== "object" || !before.body) throw new Error("GET 실패: " + before.message);
  const cur = before.body.originProduct.salePrice;
  console.log("[live] 현재가", cur, "옵션", before.body.originProduct.detailAttribute?.optionInfo?.optionCombinations?.length ?? 0);
  const up = await n.patchOriginProduct(id, (p) => { p.originProduct.salePrice = cur + 10; });
  console.log("[live] +10 →", up.status, up.message, JSON.stringify(up.body).slice(0, 300));
  await sleep(1500);
  const mid = await n.getOriginProduct(id);
  const midBody = mid.body as typeof before.body;
  console.log("[live] 확인가", midBody.originProduct.salePrice, "| 변경된 필드:", diffKeys(before.body, midBody).filter((k) => !/modifiedDate|salePrice|regDate|discountedPrice|customerBenefit|mobileCustomerBenefit/.test(k)));
  await sleep(1500);
  const back = await n.patchOriginProduct(id, (p) => { p.originProduct.salePrice = cur; });
  console.log("[live] 원복 →", back.status, back.message);
  await sleep(1500);
  const after = await n.getOriginProduct(id);
  const afterBody = after.body as typeof before.body;
  console.log("[live] 최종가", afterBody.originProduct.salePrice, "| 원본 대비 변경 필드:", diffKeys(before.body, afterBody).filter((k) => !/modifiedDate|regDate/.test(k)));
}
