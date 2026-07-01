from pydantic import BaseModel, Field
from typing import Any


class ScrapeItem(BaseModel):
    id: str
    url: str
    name: str | None = None
    previous_price: int | None = Field(default=None, ge=0)


class ScrapeRequest(BaseModel):
    items: list[ScrapeItem] = Field(default_factory=list, max_length=100)
    mode: str = "fetcher"
    cookies: list[dict[str, Any]] = Field(default_factory=list)
    user_agent: str | None = None


class ScrapeResult(BaseModel):
    id: str
    url: str
    price: int = 0
    bot_blocked: bool = False
    fail_reason: str | None = None
    status_code: int | None = None


class ScrapeResponse(BaseModel):
    results: list[ScrapeResult]
