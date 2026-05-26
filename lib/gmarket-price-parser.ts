type BotStatus = "ok" | "bot_blocked";

export interface GmarketPriceData {
  couponPrice: number | null;
  sellPrice: number | null;
  originalPrice: number | null;
  isSoldOut: boolean;
  botStatus: BotStatus;
}

export interface GmarketPriceResult {
  price: number;
  botBlocked: boolean;
  failReason: "bot_blocked" | "sold_out" | "parse_failed" | "network_error" | null;
}

const RE_TITLE = /<title[^>]*>([^<]*)<\/title>/i;
const RE_COUPON_PRICE = /"couponAppliedPrice"\s*:\s*(\d+)/;
const RE_SELL_PRICE = /OrderSet\.SellPrice\s*=\s*(\d+)/;
const RE_SELL_PRICE_DECIMAL = /"SellPriceDecimal"\s*:\s*(\d+)/;
const RE_DC_PRICE = /OrderSet\.DcPrice\s*=\s*(\d+)/;
const RE_ORIGIN_PRICE = /OrderSet\.OriginPrice\s*=\s*(\d+)/;
const RE_ORIGIN_PRICE_DECIMAL = /"OriginPriceDecimal"\s*:\s*(\d+)/;
const RE_SOLDOUT = /box__soldout|item-soldout|class=['"][^'"]*soldout|class=['"][^'"]*sold_out/i;
const RE_SOLDOUT_TEXT = /품절.*?(이 상품은|판매종료)|판매종료.*?품절/;

function extractInt(html: string, ...patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0) return n;
    }
  }
  return null;
}

export function parseGmarketPrice(html: string): GmarketPriceData {
  const titleMatch = html.match(RE_TITLE);
  const title = titleMatch?.[1] ?? "";
  if (title.includes("잠시만 기다리십시오") || title.includes("Just a moment")) {
    return { couponPrice: null, sellPrice: null, originalPrice: null, isSoldOut: false, botStatus: "bot_blocked" };
  }

  const isSoldOut = RE_SOLDOUT.test(html) || RE_SOLDOUT_TEXT.test(html);

  const couponPrice = extractInt(html, RE_COUPON_PRICE);
  const sellPrice = extractInt(html, RE_SELL_PRICE, RE_SELL_PRICE_DECIMAL);
  const originalPrice = extractInt(html, RE_ORIGIN_PRICE, RE_ORIGIN_PRICE_DECIMAL, RE_DC_PRICE);

  return { couponPrice, sellPrice, originalPrice, isSoldOut, botStatus: "ok" };
}

export function toGmarketPriceResult(data: GmarketPriceData): GmarketPriceResult {
  if (data.botStatus === "bot_blocked") {
    return { price: 0, botBlocked: true, failReason: "bot_blocked" };
  }
  if (data.isSoldOut) {
    return { price: 0, botBlocked: false, failReason: "sold_out" };
  }

  const price = (data.couponPrice && data.couponPrice > 0)
    ? data.couponPrice
    : (data.sellPrice && data.sellPrice > 0)
      ? data.sellPrice
      : 0;

  if (price > 0) return { price, botBlocked: false, failReason: null };
  return { price: 0, botBlocked: false, failReason: "parse_failed" };
}
