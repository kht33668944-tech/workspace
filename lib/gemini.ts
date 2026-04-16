/**
 * lib/gemini.ts
 * 프로젝트 전역 Gemini AI 엔진
 *
 * 모델 변경: GEMINI_MODEL 환경변수 또는 아래 DEFAULT_MODEL 상수만 수정
 * 현재: gemini-2.5-flash (안정)
 * 업그레이드: gemini-3-flash-preview / gemini-3-flash (출시 후)
 */

import { GoogleGenerativeAI, type GenerateContentResult, type Part } from "@google/generative-ai";
import { COUPANG_OPTION_IDS, getCoupangCategoryByCode, buildCategoryListForPrompt, type CoupangRequiredOption } from "./coupang-category-options";

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
    console.warn("[gemini] generateText 실패:", e instanceof Error ? e.message : String(e));
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
    console.warn("[gemini] generateContent 실패:", e instanceof Error ? e.message : String(e));
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
    console.warn("[gemini] analyzeImageFromUrl 실패:", e instanceof Error ? e.message : String(e));
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
    console.warn("[gemini] generateImageFromPrompt 실패:", e instanceof Error ? e.message : String(e));
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
    console.warn("[gemini] groundedSearch 실패:", e instanceof Error ? e.message : String(e));
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
 * 단위가격 표시제 정보 추출 (플레이오토 대량등록용)
 * 상품명에서 용량/단위 정보를 파싱하여 단위가격 표시 필드 생성
 * - display=Y: displayAmount(1~999), displayUnit(허용 단위), totalAmount(0.01~99999999)
 * - display=N: displayAmount=0, displayUnit=0, totalAmount=0
 */
export async function extractUnitPriceInfo(
  productNames: string[]
): Promise<Array<{ display: string; displayAmount: number; displayUnit: string | number; totalAmount: number }>> {
  const fallback = productNames.map(() => ({ display: "N", displayAmount: 0, displayUnit: 0 as string | number, totalAmount: 0 }));
  if (!process.env.GEMINI_API_KEY || productNames.length === 0) return fallback;

  const VALID_UNITS = ["g", "kg", "ml", "L", "cm", "m", "개", "개입", "매", "매입", "정", "캡슐", "구미", "포", "구"];

  const numbered = productNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const result = await generateText(
    `아래 상품명 목록을 분석해서 각 상품의 단위가격 표시 정보를 추출하세요.

상품명 목록:
${numbered}

규칙:
- 식품, 음료, 생활용품(세제, 샴푸, 바디워시, 치약, 물티슈, 화장지 등), 반려동물 사료 등 용량/중량이 있는 상품은 display: "Y"
- 전자기기, 의류, 가구, 잡화 등 단위가격 비대상 상품은 display: "N"
- 상품명에서 용량 정보를 파악할 수 없으면 display: "N"

display가 "Y"인 경우:
  - displayUnit: 허용 단위만 사용 → g, kg, ml, L, cm, m, 개, 개입, 매, 매입, 정, 캡슐, 구미, 포, 구
  - displayAmount: 단위가격 계산 기준 용량 (1~999 범위). 일반적으로 g→100, kg→1, ml→100, L→1, 개→1, 매→1 등
  - totalAmount: 상품 전체 용량 (숫자, 0.01~99999999 범위). 멀티팩이면 총량 계산
  - totalAmount와 displayUnit은 같은 단위 사용 (예: 2L → displayUnit: "ml", totalAmount: 2000, displayAmount: 100)
  - 예시: "삼다수 2L 6입" → display:"Y", displayUnit:"ml", displayAmount:100, totalAmount:12000
  - 예시: "비비고 왕교자 350g 4개" → display:"Y", displayUnit:"g", displayAmount:100, totalAmount:1400
  - 예시: "물티슈 100매 10팩" → display:"Y", displayUnit:"매", displayAmount:1, totalAmount:1000

display가 "N"인 경우: displayAmount:0, displayUnit:0, totalAmount:0

반드시 아래 JSON 배열 형식으로만 출력 (다른 설명 없이):
[
  {"display": "Y", "displayAmount": 100, "displayUnit": "ml", "totalAmount": 12000},
  {"display": "N", "displayAmount": 0, "displayUnit": 0, "totalAmount": 0}
]

상품 개수: ${productNames.length}개, JSON 배열 항목도 반드시 ${productNames.length}개`
  );

  if (!result) return fallback;

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      display?: string;
      displayAmount?: number;
      displayUnit?: string | number;
      totalAmount?: number;
    }>;
    if (!Array.isArray(parsed)) return fallback;
    return productNames.map((_, i) => {
      const item = parsed[i];
      if (!item || item.display !== "Y") {
        return { display: "N", displayAmount: 0, displayUnit: 0, totalAmount: 0 };
      }
      const unit = String(item.displayUnit ?? "");
      const amount = Number(item.displayAmount) || 0;
      const total = Number(item.totalAmount) || 0;
      // 유효성 검증: 허용 단위, 범위 체크
      if (!VALID_UNITS.includes(unit) || amount < 1 || amount > 999 || total < 0.01) {
        return { display: "N", displayAmount: 0, displayUnit: 0, totalAmount: 0 };
      }
      return {
        display: "Y",
        displayAmount: amount,
        displayUnit: unit,
        totalAmount: total,
      };
    });
  } catch {
    return fallback;
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
  // 용량 단위 보호 후 영문 제거
  const unitMap: string[] = [];
  cleaned = cleaned.replace(/(\d)\s*(ml|mL|ML|[Ll]|[Gg]|[Kk][Gg])\b/g, (_, num, unit) => {
    const idx = unitMap.length;
    unitMap.push(unit);
    return `${num}〈${idx}〉`;
  });
  cleaned = cleaned.replace(/[a-zA-Z]+/g, "");  // 영문 제거
  cleaned = cleaned.replace(/〈(\d+)〉/g, (_, idx) => unitMap[Number(idx)] ?? "");  // 용량 단위 복원
  cleaned = cleaned
    .replace(/[^\uAC00-\uD7A3\u3130-\u318Fa-zA-Z0-9\s]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return cleaned || null;
}

/**
 * 쿠팡 필수 구매옵션 추출 (카테고리 데이터 기반)
 *
 * 1단계: Gemini가 상품명을 쿠팡 카테고리로 분류 + 수량/단위 값 추출
 * 2단계: 카테고리 데이터에서 필수옵션 조회
 * 3단계: 코드가 정확한 옵션 형식 자동 생성
 */
export async function extractCoupangPurchaseOptions(
  productNames: string[]
): Promise<Array<{ hasOption: boolean; optionName: string; optionValue: string }>> {
  const fallback = productNames.map(() => ({ hasOption: false, optionName: "", optionValue: "" }));
  if (!process.env.GEMINI_API_KEY || productNames.length === 0) return fallback;

  // 1단계: Gemini에게 카테고리 분류 + 값 추출 요청
  const categoryList = buildCategoryListForPrompt();
  const numbered = productNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const result = await generateText(
    `아래 쿠팡 카테고리 목록을 참고하여, 각 상품명에 가장 적합한 쿠팡 카테고리를 분류하고 수량/단위 정보를 추출하세요.

[쿠팡 카테고리 목록] (코드:경로)
${categoryList}

[상품명 목록]
${numbered}

각 상품에 대해:
- categoryCode: 위 목록에서 가장 적합한 카테고리코드 (숫자)
- quantity: 총 수량 숫자 (예: 24). 상품명에서 파악 불가하면 1
- quantityUnit: 수량 단위 (개, 팩, 박스 등). 기본값 "개"
- unitValue: 개당 용량/중량/매수 등의 숫자값 (예: 86, 2, 100). 없으면 null
- unitType: 단위 (g, kg, ml, L, 매, 장, 정, 캡슐, 포 등). 없으면 null

예시:
- "육개장사발면 86g 24개" → {"categoryCode":58647,"quantity":24,"quantityUnit":"개","unitValue":86,"unitType":"g"}
- "삼다수 2L 6입" → {"categoryCode":해당코드,"quantity":6,"quantityUnit":"개","unitValue":2,"unitType":"L"}
- "물티슈 100매 10팩" → {"categoryCode":해당코드,"quantity":10,"quantityUnit":"개","unitValue":100,"unitType":"매"}
- "비타민C 180정" → {"categoryCode":해당코드,"quantity":1,"quantityUnit":"개","unitValue":180,"unitType":"정"}
- "무선이어폰" → {"categoryCode":해당코드,"quantity":1,"quantityUnit":"개","unitValue":null,"unitType":null}

반드시 JSON 배열로만 출력 (설명 없이). 상품 개수: ${productNames.length}개`
  );

  if (!result) return fallback;

  let parsed: Array<{
    categoryCode?: number;
    quantity?: number;
    quantityUnit?: string;
    unitValue?: number | null;
    unitType?: string | null;
  }>;

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return fallback;
    parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return fallback;
  } catch {
    return fallback;
  }

  // 2단계 + 3단계: 카테고리 데이터 기반 옵션 형식 생성
  return productNames.map((_, i) => {
    const item = parsed[i];
    if (!item?.categoryCode) return { hasOption: false, optionName: "", optionValue: "" };

    const category = getCoupangCategoryByCode(item.categoryCode);
    if (!category || category.options.length === 0) {
      return { hasOption: false, optionName: "", optionValue: "" };
    }

    const qty = item.quantity ?? 1;
    const qtyUnit = item.quantityUnit ?? "개";
    const unitVal = item.unitValue;
    const unitType = item.unitType;

    return buildCoupangOptionFromCategory(category.options, qty, qtyUnit, unitVal, unitType);
  });
}

/** 단위 타입 → 매칭되는 쿠팡 옵션 ID 후보군 (우선순위 순) */
const UNIT_TYPE_TO_OPTION_ID: Record<string, number[]> = {
  g: [COUPANG_OPTION_IDS.PER_UNIT_WEIGHT, COUPANG_OPTION_IDS.MIN_WEIGHT],
  kg: [COUPANG_OPTION_IDS.PER_UNIT_WEIGHT, COUPANG_OPTION_IDS.MIN_WEIGHT],
  ml: [COUPANG_OPTION_IDS.PER_UNIT_CAPACITY, COUPANG_OPTION_IDS.MIN_CAPACITY, COUPANG_OPTION_IDS.CAPACITY],
  L: [COUPANG_OPTION_IDS.PER_UNIT_CAPACITY, COUPANG_OPTION_IDS.MIN_CAPACITY, COUPANG_OPTION_IDS.CAPACITY],
  매: [COUPANG_OPTION_IDS.PER_UNIT_COUNT, COUPANG_OPTION_IDS.GRAMMAGE],
  장: [COUPANG_OPTION_IDS.PER_UNIT_COUNT],
  시트: [COUPANG_OPTION_IDS.PER_UNIT_COUNT],
  롤: [COUPANG_OPTION_IDS.PER_UNIT_COUNT],
  정: [COUPANG_OPTION_IDS.PER_UNIT_CAPSULE],
  캡슐: [COUPANG_OPTION_IDS.PER_UNIT_CAPSULE],
  포: [COUPANG_OPTION_IDS.PER_UNIT_CAPSULE],
  알: [COUPANG_OPTION_IDS.PER_UNIT_CAPSULE],
};

const QUANTITY_OPTION_IDS = new Set<number>([COUPANG_OPTION_IDS.QUANTITY, COUPANG_OPTION_IDS.TOTAL_QUANTITY]);

/** 카테고리 필수옵션 데이터를 기반으로 [옵션명]/값 형식 생성 */
function buildCoupangOptionFromCategory(
  options: CoupangRequiredOption[],
  qty: number,
  qtyUnit: string,
  unitVal: number | null | undefined,
  unitType: string | null | undefined
): { hasOption: boolean; optionName: string; optionValue: string } {
  const qtyOption = options.find(o => QUANTITY_OPTION_IDS.has(o.id));
  if (!qtyOption) return { hasOption: false, optionName: "", optionValue: "" };

  const matchingIds = unitType ? (UNIT_TYPE_TO_OPTION_ID[unitType] ?? []) : [];
  const matchedUnitOption = (unitVal && matchingIds.length > 0)
    ? options.find(o => !QUANTITY_OPTION_IDS.has(o.id) && matchingIds.includes(o.id))
    : undefined;

  if (!matchedUnitOption) {
    return {
      hasOption: true,
      optionName: `[${qtyOption.name}]`,
      optionValue: `${qty}${qtyUnit}`,
    };
  }

  return {
    hasOption: true,
    optionName: `[${qtyOption.name}=${matchedUnitOption.name}]`,
    optionValue: `${qty}${qtyUnit}=${unitVal}${unitType}`,
  };
}
