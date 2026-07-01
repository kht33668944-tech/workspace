import re
import time
from typing import Any

from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher

from .models import ScrapeItem, ScrapeResult


RE_TITLE = re.compile(r"<title[^>]*>([^<]*)</title>", re.I)
RE_COUPON_PRICE = re.compile(r'"couponAppliedPrice"\s*:\s*(\d+)')
RE_SELL_PRICE = re.compile(r"OrderSet\.SellPrice\s*=\s*(\d+)")
RE_SELL_PRICE_DECIMAL = re.compile(r'"SellPriceDecimal"\s*:\s*(\d+)')
RE_DC_PRICE = re.compile(r"OrderSet\.DcPrice\s*=\s*(\d+)")
RE_ORIGIN_PRICE = re.compile(r"OrderSet\.OriginPrice\s*=\s*(\d+)")
RE_ORIGIN_PRICE_DECIMAL = re.compile(r'"OriginPriceDecimal"\s*:\s*(\d+)')
RE_SOLDOUT = re.compile(r"box__soldout|item-soldout|class=['\"][^'\"]*soldout|class=['\"][^'\"]*sold_out", re.I)
RE_SOLDOUT_TEXT = re.compile(r"품절.*?(이 상품은|판매종료)|판매종료.*?품절")


def _extract_int(html: str, *patterns: re.Pattern[str]) -> int | None:
    for pattern in patterns:
        match = pattern.search(html)
        if not match:
            continue
        value = int(match.group(1))
        if value > 0:
            return value
    return None


def _response_text(response: Any) -> str:
    for attr in ("body", "text", "content"):
        value = getattr(response, attr, None)
        if callable(value):
            value = value()
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="ignore")
        if isinstance(value, str):
            return value
    return str(response)


def _status_code(response: Any) -> int | None:
    for attr in ("status", "status_code"):
        value = getattr(response, attr, None)
        if isinstance(value, int):
            return value
    return None


def parse_gmarket_price(html: str) -> tuple[int, bool, str | None]:
    title_match = RE_TITLE.search(html)
    title = title_match.group(1) if title_match else ""
    if "잠시만 기다리십시오" in title or "Just a moment" in title:
        return 0, True, "bot_blocked"

    if "잠시만 기다리십시오" in html or "Just a moment" in html:
        return 0, True, "bot_blocked"

    is_sold_out = bool(RE_SOLDOUT.search(html) or RE_SOLDOUT_TEXT.search(html))
    if is_sold_out:
        return 0, False, "sold_out"

    coupon_price = _extract_int(html, RE_COUPON_PRICE)
    sell_price = _extract_int(html, RE_SELL_PRICE, RE_SELL_PRICE_DECIMAL)
    original_price = _extract_int(html, RE_ORIGIN_PRICE, RE_ORIGIN_PRICE_DECIMAL, RE_DC_PRICE)
    price = coupon_price or sell_price or original_price or 0
    if price > 0:
        return price, False, None
    return 0, False, "parse_failed"


def _cookie_header(cookies: list[dict[str, Any]]) -> str:
    pairs: list[str] = []
    for cookie in cookies:
        name = cookie.get("name")
        value = cookie.get("value")
        if isinstance(name, str) and isinstance(value, str):
            pairs.append(f"{name}={value}")
    return "; ".join(pairs)


def _base_headers(cookies: list[dict[str, Any]], user_agent: str | None) -> dict[str, str]:
    headers = {
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "referer": "https://www.gmarket.co.kr/",
    }
    if user_agent:
        headers["user-agent"] = user_agent
    cookie_header = _cookie_header(cookies)
    if cookie_header:
        headers["cookie"] = cookie_header
    return headers


def _fetch_html(
    url: str,
    mode: str,
    cookies: list[dict[str, Any]] | None = None,
    user_agent: str | None = None,
) -> tuple[str | None, int | None, bool]:
    request_cookies = cookies or []
    headers = _base_headers(request_cookies, user_agent)
    try:
        if mode == "stealth":
            response = StealthyFetcher.fetch(
                url,
                headless=True,
                disable_resources=True,
                timeout=30000,
                wait=500,
                cookies=request_cookies or None,
                useragent=user_agent,
                extra_headers=headers,
            )
        elif mode == "dynamic":
            response = DynamicFetcher.fetch(
                url,
                headless=True,
                disable_resources=True,
                timeout=30000,
                wait=500,
                network_idle=False,
                cookies=request_cookies or None,
                useragent=user_agent,
                extra_headers=headers,
            )
        else:
            response = Fetcher.get(
                url,
                timeout=30,
                impersonate="chrome",
                headers=headers,
            )
        status_code = _status_code(response)
        html = _response_text(response)
        blocked = status_code in (403, 429, 503)
        return html, status_code, blocked
    except Exception:
        return None, None, False


def scrape_gmarket_item(
    item: ScrapeItem,
    mode: str,
    cookies: list[dict[str, Any]] | None = None,
    user_agent: str | None = None,
) -> ScrapeResult:
    if "gmarket.co.kr" not in item.url:
        return ScrapeResult(id=item.id, url=item.url, fail_reason="unsupported")

    html, status_code, blocked = _fetch_html(item.url, mode, cookies, user_agent)
    if blocked:
        return ScrapeResult(id=item.id, url=item.url, bot_blocked=True, fail_reason="bot_blocked", status_code=status_code)
    if not html:
        return ScrapeResult(id=item.id, url=item.url, fail_reason="network_error", status_code=status_code)

    price, bot_blocked, fail_reason = parse_gmarket_price(html)
    return ScrapeResult(
        id=item.id,
        url=item.url,
        price=price,
        bot_blocked=bot_blocked,
        fail_reason=fail_reason,
        status_code=status_code,
    )


def scrape_gmarket_batch(
    items: list[ScrapeItem],
    mode: str,
    cookies: list[dict[str, Any]] | None = None,
    user_agent: str | None = None,
) -> list[ScrapeResult]:
    results: list[ScrapeResult] = []
    normalized_mode = mode if mode in {"fetcher", "dynamic", "stealth"} else "fetcher"
    for index, item in enumerate(items):
        results.append(scrape_gmarket_item(item, normalized_mode, cookies, user_agent))
        if index + 1 < len(items):
            time.sleep(0.25)
    return results
