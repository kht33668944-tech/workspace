# Scrapling price scraper service

Python/FastAPI service for workspace lowest-price update v3.

## Local run

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium
patchright install chromium
uvicorn app.main:app --reload --port 8000
```

Set `SCRAPER_API_KEY` in production. The Next.js app calls this service with `SCRAPER_V3_URL` and `SCRAPER_V3_API_KEY`.

## Endpoints

- `GET /health`
- `POST /scrape/gmarket`

The service returns prices only. The main Next.js app still controls product ownership, history, and final price application.
