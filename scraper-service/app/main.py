import os

from fastapi import Depends, FastAPI, Header, HTTPException

from .models import ScrapeRequest, ScrapeResponse
from .scraper import scrape_gmarket_batch


app = FastAPI(title="Workspace Scrapling Price Scraper", version="0.1.0")


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    expected = os.getenv("SCRAPER_API_KEY")
    if expected and x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/scrape/gmarket", response_model=ScrapeResponse, dependencies=[Depends(require_api_key)])
def scrape_gmarket(request: ScrapeRequest) -> ScrapeResponse:
    if not request.items:
        return ScrapeResponse(results=[])
    return ScrapeResponse(
        results=scrape_gmarket_batch(
            request.items,
            request.mode,
            request.cookies,
            request.user_agent,
        )
    )
