/**
 * lib/gemini.ts
 * 프로젝트 전역 Gemini AI 엔진
 *
 * 모델 변경: GEMINI_MODEL 환경변수 또는 아래 DEFAULT_MODEL 상수만 수정
 * 현재: gemini-2.5-flash (안정)
 * 업그레이드: gemini-3-flash-preview / gemini-3-flash (출시 후)
 */

import { GoogleGenerativeAI, type GenerateContentResult, type Part } from "@google/generative-ai";

// ── 모델 설정 ─────────────────────────────────────────────────────────────────
const DEFAULT_MODEL = "gemini-2.5-flash";

function getModel(modelOverride?: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = modelOverride ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  return genAI.getGenerativeModel({ model: modelName });
}

// ── 응답 파싱 ─────────────────────────────────────────────────────────────────
export interface GeminiTextResult {
  type: "text";
  text: string;
}

export interface GeminiImageResult {
  type: "image";
  mimeType: string;
  base64Data: string;
  /** data: URI 형태로 바로 사용 가능 */
  dataUrl: string;
}

export type GeminiPart = GeminiTextResult | GeminiImageResult;

export interface GeminiResponse {
  parts: GeminiPart[];
  /** 텍스트만 필요할 때 편의용 */
  text: string;
  /** 이미지만 필요할 때 편의용 */
  images: GeminiImageResult[];
}

/**
 * Gemini 응답에서 텍스트 / 이미지(inlineData) 파트를 모두 파싱
 * - 현재(gemini-2.5-flash): 텍스트만 반환
 * - 미래(gemini-3-flash 이미지 모델): 텍스트 + 이미지 동시 반환
 */
function parseResponse(result: GenerateContentResult): GeminiResponse {
  const parts: GeminiPart[] = [];

  for (const candidate of result.response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        parts.push({ type: "text", text: part.text.trim() });
      } else if (part.inlineData) {
        const { mimeType, data } = part.inlineData;
        parts.push({
          type: "image",
          mimeType,
          base64Data: data,
          dataUrl: `data:${mimeType};base64,${data}`,
        });
      }
    }
  }

  // fallback: response.text() 사용 (parts가 비어있을 때)
  if (parts.length === 0) {
    const fallbackText = result.response.text?.() ?? "";
    if (fallbackText) parts.push({ type: "text", text: fallbackText.trim() });
  }

  return {
    parts,
    text: parts
      .filter((p): p is GeminiTextResult => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim(),
    images: parts.filter((p): p is GeminiImageResult => p.type === "image"),
  };
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 텍스트 생성 (기본 사용)
 * GEMINI_API_KEY 없으면 null 반환 → 호출부에서 fallback 처리
 */
export async function generateText(
  prompt: string,
  modelOverride?: string
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const model = getModel(modelOverride);
    const result = await model.generateContent(prompt);
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] generateText 실패:", e);
    return null;
  }
}

/**
 * 멀티파트 생성 — 텍스트 + 이미지 동시 처리 (gemini-3 이미지 모델용)
 * 현재는 텍스트만 반환되지만 구조는 완성되어 있음
 */
export async function generateContent(
  prompt: string,
  modelOverride?: string
): Promise<GeminiResponse | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const model = getModel(modelOverride);
    const result = await model.generateContent(prompt);
    return parseResponse(result);
  } catch (e) {
    console.warn("[gemini] generateContent 실패:", e);
    return null;
  }
}

/**
 * 상품 카테고리 자동 분류
 * G마켓 원본 카테고리 + 상품명을 보고 등록된 카테고리 중 가장 적합한 것 선택
 * 해당 없으면 fallbackCategory(기본: "가공식품") 반환
 */
export async function classifyCategory(
  productName: string,
  sourceCategory: string,
  categories: string[],
  fallbackCategory = "가공식품"
): Promise<string> {
  if (categories.length === 0) return fallbackCategory;

  const result = await generateText(
    `아래 상품을 분석해서 카테고리 목록 중 가장 적합한 하나를 선택해주세요.

상품명: ${productName}
G마켓 카테고리: ${sourceCategory || "없음"}

선택 가능한 카테고리 목록:
${categories.map((c, i) => `${i + 1}. ${c}`).join("\n")}

규칙:
- 반드시 위 목록에 있는 카테고리 이름 그대로만 출력
- 적합한 것이 없으면 "${fallbackCategory}" 출력
- 다른 설명 없이 카테고리 이름만 한 줄 출력`
  );

  const matched = result?.trim() ?? "";
  return categories.includes(matched) ? matched : fallbackCategory;
}

// ── 이미지 분석 (Vision) ───────────────────────────────────────────────────────

/**
 * 이미지 URL을 base64로 변환 후 Gemini vision으로 분석
 * 썸네일 품질 판단, 상세페이지 OCR 등에 사용
 */
export async function analyzeImageFromUrl(
  imageUrl: string,
  prompt: string,
  modelOverride?: string
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];

    const model = getModel(modelOverride);
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      { text: prompt },
    ]);
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] analyzeImageFromUrl 실패:", e);
    return null;
  }
}

/**
 * 이미지 생성 출력 (gemini-2.0-flash-preview-image-generation)
 * referenceImageBase64: 참조 이미지 base64 (optional)
 */
export async function generateImageFromPrompt(
  prompt: string,
  referenceImageBase64?: string,
  mimeType = "image/jpeg"
): Promise<GeminiImageResult | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const IMAGE_GEN_MODEL =
    process.env.GEMINI_IMAGE_GEN_MODEL ?? "gemini-2.5-flash-image";
  try {
    const genAI = new (await import("@google/generative-ai")).GoogleGenerativeAI(
      process.env.GEMINI_API_KEY
    );
    const model = genAI.getGenerativeModel({
      model: IMAGE_GEN_MODEL,
      // @ts-expect-error: responseModalities is supported by this model
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    });

    const parts: Part[] = [{ text: prompt }];
    if (referenceImageBase64) {
      parts.unshift({ inlineData: { data: referenceImageBase64, mimeType } });
    }

    const result = await model.generateContent(parts);
    const parsed = parseResponse(result);
    return parsed.images[0] ?? null;
  } catch (e) {
    console.warn("[gemini] generateImageFromPrompt 실패:", e);
    return null;
  }
}

/**
 * Google Search Grounding — 웹 검색으로 제품 정보 보완
 * gemini-2.5-flash + googleSearch tool 사용
 */
export async function groundedSearch(prompt: string): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const genAI = new (await import("@google/generative-ai")).GoogleGenerativeAI(
      process.env.GEMINI_API_KEY
    );
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? DEFAULT_MODEL,
      // @ts-expect-error: googleSearch tool supported
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(prompt);
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] groundedSearch 실패:", e);
    return null;
  }
}

/**
 * 상품명 정규화 전용 헬퍼
 * 구조: 브랜드 + 제품명 + 옵션(용량/무게) + 수량
 */
export async function normalizeProductName(rawName: string): Promise<string | null> {
  const prompt = `지마켓에서 크롤링한 상품명을 아래 규칙으로 정리해주세요.

규칙:
1. 구조: 브랜드명 + 제품명 + 옵션(용량/무게 등) + 수량
2. 특수문자 완전 제거 (괄호 포함)
3. 총수량이 이미 있으면 분리 표현 제거 (예: "20입 5입 4개" → "20입")
4. 판매자 부가 설명 제거 (멀티팩, 이온음료, 쿠폰, 할인 등)
5. 정리된 상품명 한 줄만 출력 (다른 설명 없이)

예시:
- "삼양 불닭볶음면 20입 5입 4개 멀티팩" → "삼양 불닭볶음면 20입"
- "홈런볼 4번들 4팩 41g 16개" → "홈런볼 4번들 4팩 41g 16개"
- "포카리스웨트 340ml 48캔 12캔 4팩 동아오츠카" → "포카리스웨트 340ml 48캔"

원본: ${rawName}`;

  return generateText(prompt);
}
