/**
 * Gemini API 공식 단가 (2026년 4월 기준)
 * 출처: https://ai.google.dev/gemini-api/docs/pricing
 *
 * 단가 변경 시 이 파일만 수정하면 됨 (DB에는 토큰 수만 저장).
 */

export interface ModelPrice {
  inputPerMillion: number;   // USD per 1M input tokens
  outputPerMillion: number;  // USD per 1M output tokens
  perImage?: number;         // USD per generated image (optional)
}

export const GEMINI_PRICING: Record<string, ModelPrice> = {
  "gemini-2.5-flash": {
    inputPerMillion: 0.30,
    outputPerMillion: 2.50,
  },
  "gemini-2.5-flash-lite": {
    inputPerMillion: 0.10,
    outputPerMillion: 0.40,
  },
  "gemini-2.5-pro": {
    inputPerMillion: 1.25,
    outputPerMillion: 10.00,
  },
  "gemini-2.5-flash-image": {
    inputPerMillion: 0.30,
    outputPerMillion: 2.50,
    perImage: 0.039,
  },
};

export const FALLBACK_MODEL = "gemini-2.5-flash";
export const USD_TO_KRW = 1380;

export function getModelPrice(model: string): ModelPrice {
  return GEMINI_PRICING[model] ?? GEMINI_PRICING[FALLBACK_MODEL];
}

export function calcCostUsd(params: {
  model: string;
  promptTokens: number;
  candidateTokens: number;
  imageCount?: number;
}): number {
  const p = getModelPrice(params.model);
  const text =
    (params.promptTokens * p.inputPerMillion +
      params.candidateTokens * p.outputPerMillion) /
    1_000_000;
  const image = (params.imageCount ?? 0) * (p.perImage ?? 0);
  return text + image;
}

export function usdToKrw(usd: number): number {
  return Math.round(usd * USD_TO_KRW);
}
