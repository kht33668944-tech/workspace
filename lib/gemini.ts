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
 * 사용자 카테고리 목록 → 플레이오토 상품분류코드 자동 매핑 (Gemini)
 * @param userCategories 사용자 카테고리명 배열
 * @param playautoSchemas 플레이오토 분류 목록 (code + name)
 * @returns 각 카테고리에 대응하는 플레이오토 코드 배열
 */
export async function suggestPlayautoCategories(
  userCategories: string[],
  playautoSchemas: Array<{ code: string; name: string }>
): Promise<string[]> {
  const fallback = userCategories.map(() => "35");
  if (!process.env.GEMINI_API_KEY || userCategories.length === 0) return fallback;

  const schemaList = playautoSchemas.map((s) => `${s.code}: ${s.name}`).join("\n");
  const categoryList = userCategories.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const result = await generateText(
    `아래 "내 카테고리 목록"을 "플레이오토 분류 목록" 중 가장 적합한 것으로 매핑하세요.

플레이오토 분류 목록:
${schemaList}

내 카테고리 목록:
${categoryList}

규칙:
- 반드시 플레이오토 분류 코드(숫자)만 출력
- 적합한 분류가 없으면 35(기타재화) 출력
- 반드시 아래 JSON 배열 형식으로만 출력 (다른 설명 없이):
["코드1", "코드2", ...]

카테고리 개수: ${userCategories.length}개, 배열 항목도 반드시 ${userCategories.length}개`
  );

  if (!result) return fallback;

  try {
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as string[];
    if (!Array.isArray(parsed)) return fallback;
    const validCodes = new Set(playautoSchemas.map((s) => s.code));
    return userCategories.map((_, i) => {
      const code = String(parsed[i] ?? "35").trim();
      return validCodes.has(code) ? code : "35";
    });
  } catch {
    return fallback;
  }
}

/**
 * 상품 목록 → 스마트스토어 카테고리코드 자동 매핑 (Gemini)
 * @param products 상품 목록 (product_name, category, source_category)
 * @param availableCodes 사용자가 등록한 스마트스토어 카테고리코드 목록
 * @returns 각 상품에 대응하는 카테고리코드 (없으면 "" 반환)
 */
export async function suggestSmartStoreCategoryCodes(
  products: Array<{ product_name: string; category: string; source_category: string }>,
  availableCodes: Array<{ category_code: string; category_type: string; category_name: string }>
): Promise<string[]> {
  const fallback = products.map(() => "");
  if (!process.env.GEMINI_API_KEY || products.length === 0 || availableCodes.length === 0) return fallback;

  const codeList = availableCodes
    .map((c) => `${c.category_code}: [${c.category_type}] ${c.category_name}`)
    .join("\n");

  const productList = products
    .map((p, i) => `${i + 1}. 상품명: ${p.product_name} | 내카테고리: ${p.category || "없음"} | 원본카테고리: ${p.source_category || "없음"}`)
    .join("\n");

  const result = await generateText(
    `아래 상품 목록을 분석해서 각 상품에 가장 적합한 스마트스토어 카테고리코드를 선택하세요.

스마트스토어 카테고리코드 목록 (코드: [분류] 카테고리명):
${codeList}

상품 목록:
${productList}

규칙:
- 반드시 위 카테고리코드 목록에 있는 코드 숫자만 선택
- 적합한 카테고리가 없으면 빈 문자열("") 출력
- 반드시 아래 JSON 배열 형식으로만 출력 (다른 설명 없이):
["코드1", "코드2", ...]

상품 개수: ${products.length}개, 배열 항목도 반드시 ${products.length}개`
  );

  if (!result) return fallback;

  try {
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as string[];
    if (!Array.isArray(parsed)) return fallback;
    const validCodes = new Set(availableCodes.map((c) => c.category_code));
    return products.map((_, i) => {
      const code = String(parsed[i] ?? "").trim();
      return validCodes.has(code) ? code : "";
    });
  } catch {
    return fallback;
  }
}

/**
 * 상품명 배열에서 브랜드/모델명/제조사를 일괄 추출
 * 플레이오토 대량등록 양식 생성 시 사용
 * 한 번의 Gemini 호출로 N개 상품 메타데이터 추출
 */
export async function extractProductMetadataBatch(
  productNames: string[]
): Promise<Array<{ model: string; brand: string; manufacturer: string }>> {
  const empty = productNames.map(() => ({ model: "", brand: "", manufacturer: "" }));
  if (!process.env.GEMINI_API_KEY || productNames.length === 0) return empty;

  const numbered = productNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const result = await generateText(
    `아래 상품명 목록에서 각 상품의 브랜드(brand), 모델명(model), 제조사(manufacturer)를 추출하세요.

상품명 목록:
${numbered}

규칙:
- 브랜드: 제품을 판매하는 브랜드명 (예: 삼양, 코카콜라, CJ제일제당)
- 모델명: 제품 고유 모델명/제품명 (예: 불닭볶음면, 제로, 햇반)
- 제조사: 실제 제조하는 회사. 브랜드와 같으면 브랜드명 그대로 출력. OEM이면 실제 제조사 출력. 절대 빈 문자열 금지 — 모르면 브랜드명을 그대로 사용
- 특수문자(&, /, (, ), %, + 등) 절대 사용 금지 — 한글, 영문, 숫자, 공백만 허용 (예: 동원 F&B → 동원 FB, CJ제일제당 → CJ제일제당)
- 반드시 아래 JSON 배열 형식으로만 출력 (다른 설명 없이):

[
  {"model": "모델명1", "brand": "브랜드1", "manufacturer": "제조사1"},
  {"model": "모델명2", "brand": "브랜드2", "manufacturer": "제조사2"}
]

상품 개수: ${productNames.length}개, JSON 배열 항목도 반드시 ${productNames.length}개`
  );

  if (!result) return empty;

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return empty;
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      model?: string;
      brand?: string;
      manufacturer?: string;
    }>;
    if (!Array.isArray(parsed)) return empty;
    const stripSpecial = (s: string) => s.replace(/[^가-힣a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
    return productNames.map((_, i) => {
      const brand = stripSpecial(parsed[i]?.brand ?? "");
      const model = stripSpecial(parsed[i]?.model ?? "");
      const manufacturer = stripSpecial(parsed[i]?.manufacturer ?? "") || brand;
      return { model, brand, manufacturer };
    });
  } catch {
    return empty;
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
2. 특수문자 완전 제거 — +, %, /, ., &, ~, ★, !, @, #, $, ^, *, 괄호() 등 모든 특수문자 사용 금지
3. 허용 문자: 한글, 숫자, 공백만 사용 (영문 금지)
4. 영어 단어는 반드시 한글로 변환 — pet→펫, pack→팩, box→박스, set→세트, can→캔, mini→미니, slim→슬림, soft→소프트, clean→클린, fresh→프레시, light→라이트, plus→플러스, pro→프로, gold→골드, silver→실버, zero→제로, free→프리, ice→아이스, cool→쿨, hot→핫 등. 고유 브랜드명도 한글로 변환 (예: Downy→다우니, Tide→타이드). 단, 용량 단위(ml, L, g, kg)는 그대로 유지
5. 총수량이 이미 있으면 분리 표현 제거 (예: "20입 5입 4개" → "20개")
6. 수량 단위는 특별한 이유가 없으면 "개"로 통일 (입→개, EA→개, PCS→개). 캔/병/봉/포/매 등 해당 제품에 맞는 단위는 유지
7. 판매자 부가 설명 제거 (멀티팩, 이온음료, 쿠폰, 할인, HOT, NEW, 신제품, 무료배송, 특가 등)
8. 정리된 상품명 한 줄만 출력 (다른 설명 없이)

예시:
- "삼양 불닭볶음면 20입 5입 4개 멀티팩" → "삼양 불닭볶음면 20개"
- "(HOT신제품)오뚜기 진밀면 멀티팩(4개입x4팩) (총16개입)" → "오뚜기 진밀면 16개"
- "테크 베이킹소다+구연산 액체세제 일반/드럼 겸용 1.8L 4개" → "테크 베이킹소다 구연산 액체세제 일반 드럼 겸용 1.8L 4개"
- "포카리스웨트 340ml 48캔 12캔 4팩 동아오츠카" → "포카리스웨트 340ml 48캔"
- "Downy Premium pet clean 1L 4개" → "다우니 프리미엄 펫 클린 1L 4개"

원본: ${rawName}`;

  const result = await generateText(prompt);
  if (!result) return null;

  // LLM이 설명까지 포함해서 응답하는 경우 정리된 상품명만 추출
  let cleaned = result.trim();
  // "정리된 상품명:" 패턴이 있으면 그 뒤의 값만 추출
  const nameMatch = cleaned.match(/정리된\s*상품명[:\s]*(.+?)(?:\s*[-—]+|$)/m);
  if (nameMatch) {
    cleaned = nameMatch[1].trim();
  }
  // 여러 줄이면 첫 줄만 사용 (설명이 이어질 수 있음)
  cleaned = cleaned.split("\n")[0].trim();
  // 마크다운 볼드(**) 제거
  cleaned = cleaned.replace(/\*\*/g, "").trim();
  // 특수문자 최종 정리 (허용: 한글, 숫자, 공백, 용량 단위 ml/L/g/kg)
  cleaned = cleaned
    .replace(/(\d)\s*(ml|mL|ML|[Ll]|[Gg]|[Kk][Gg])\b/g, "$1__UNIT_$2__")  // 용량 단위 보호
    .replace(/[a-zA-Z]+/g, "")  // 영문 제거
    .replace(/__UNIT_(.+?)__/g, "$1")  // 용량 단위 복원
    .replace(/[^\uAC00-\uD7A3\u3130-\u318Fa-zA-Z0-9\s]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return cleaned || null;
}
