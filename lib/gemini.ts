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
 * 상품 목록 → 플레이오토 카테고리코드 자동 매핑 (Gemini 2단계)
 * 0. 직접 매칭: product.category/source_category가 category_type과 정확/부분 일치
 * 1단계: 미매칭 상품에 대해 분류명(category_type) 선택 + 퍼지 매칭
 * 2단계: 해당 분류의 코드만 필터링 후 정확한 코드 매칭
 * 3. 미매칭 상품: 전체 코드에서 재검색
 */
export async function suggestSmartStoreCategoryCodes(
  products: Array<{ product_name: string; category: string; source_category: string }>,
  availableCodes: Array<{ category_code: string; category_type: string; category_name: string }>
): Promise<string[]> {
  const fallback = products.map(() => "");
  if (!process.env.GEMINI_API_KEY || products.length === 0 || availableCodes.length === 0) return fallback;

  // 분류별 코드 맵
  const codesByType = new Map<string, typeof availableCodes>();
  for (const c of availableCodes) {
    const arr = codesByType.get(c.category_type) ?? [];
    arr.push(c);
    codesByType.set(c.category_type, arr);
  }

  const uniqueTypes = [...codesByType.keys()].sort();
  const uniqueTypesLower = uniqueTypes.map((t) => t.toLowerCase());

  // ── 0단계: 직접 매칭 (product.category/source_category → category_type) ──
  const directType: (string | null)[] = products.map((p) => {
    const cat = (p.category || "").trim().toLowerCase();
    const src = (p.source_category || "").trim().toLowerCase();
    if (!cat && !src) return null;

    // 정확 일치
    const exactIdx = uniqueTypesLower.indexOf(cat);
    if (exactIdx >= 0) return uniqueTypes[exactIdx];

    // 포함 관계
    for (let i = 0; i < uniqueTypes.length; i++) {
      const tl = uniqueTypesLower[i];
      if ((cat && (tl.includes(cat) || cat.includes(tl))) ||
          (src && (tl.includes(src) || src.includes(tl)))) {
        return uniqueTypes[i];
      }
    }
    return null;
  });

  const directMatched = directType.filter((t) => t !== null).length;
  console.log(`[gemini] 0단계 직접매칭: ${directMatched}/${products.length}개`);

  // Gemini 1단계가 필요한 상품 인덱스
  const needStep1 = products.reduce<number[]>(
    (acc, _, i) => { if (directType[i] === null) acc.push(i); return acc; }, []
  );

  // ── 1단계: 미매칭 상품에 대해 Gemini로 분류명 선택 ──
  const selectedPrimaryType: (string | null)[] = [...directType];

  if (needStep1.length > 0 && uniqueTypes.length > 1) {
    const step1Products = needStep1.map((i) => products[i]);
    const productList = step1Products
      .map((p, gi) => `${gi + 1}. 상품명: ${p.product_name} | 내카테고리: ${p.category || "없음"} | 원본카테고리: ${p.source_category || "없음"}`)
      .join("\n");

    const step1Result = await generateText(
      `아래 상품 목록을 보고, 각 상품이 속할 수 있는 분류명을 선택하세요.

분류명 목록:
${uniqueTypes.map((t, i) => `${i + 1}. ${t}`).join("\n")}

상품 목록:
${productList}

규칙:
- 각 상품에 가장 적합한 분류명을 1~2개 선택
- 반드시 위 분류명 목록에 있는 이름 그대로 출력
- 반드시 아래 JSON 배열 형식으로만 출력 (다른 설명 없이):
[["분류명A"], ["분류명B", "분류명C"], ...]

상품 개수: ${step1Products.length}개, 배열 항목도 반드시 ${step1Products.length}개`
    );

    console.log("[gemini] 1단계 원본 응답:", step1Result?.slice(0, 500));

    if (step1Result) {
      try {
        const match = step1Result.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as string[][];
          if (Array.isArray(parsed) && parsed.length === step1Products.length) {
            parsed.forEach((types, gi) => {
              const productIdx = needStep1[gi];
              const validTypes = (Array.isArray(types) ? types : [types])
                .map((t) => {
                  const ts = String(t).trim();
                  if (uniqueTypes.includes(ts)) return ts;
                  // 퍼지 매칭: 포함 관계
                  const tl = ts.toLowerCase();
                  return uniqueTypes.find((ut) => {
                    const utl = ut.toLowerCase();
                    return utl.includes(tl) || tl.includes(utl);
                  }) ?? null;
                })
                .filter((t): t is string => t !== null);
              if (validTypes.length > 0) {
                selectedPrimaryType[productIdx] = validTypes[0];
              }
            });
            console.log("[gemini] 1단계 파싱 성공");
          } else {
            console.warn("[gemini] 1단계 배열 길이 불일치:", parsed.length, "vs", step1Products.length);
          }
        } else {
          console.warn("[gemini] 1단계 JSON 매칭 실패");
        }
      } catch (e) {
        console.warn("[gemini] 1단계 파싱 실패:", e);
      }
    } else {
      console.warn("[gemini] 1단계 응답 없음 (null)");
    }
  } else if (needStep1.length > 0 && uniqueTypes.length === 1) {
    needStep1.forEach((i) => { selectedPrimaryType[i] = uniqueTypes[0]; });
  }

  // ── 2단계: 분류별로 그룹화하여 각각 Gemini 호출 ──
  const typeGroups = new Map<string, number[]>();
  selectedPrimaryType.forEach((type, i) => {
    if (!type) return;
    const arr = typeGroups.get(type) ?? [];
    arr.push(i);
    typeGroups.set(type, arr);
  });

  const results: string[] = products.map(() => "");

  // 2단계 Gemini 호출 함수 (재사용)
  async function matchCodesForGroup(
    type: string,
    indices: number[],
    codes: typeof availableCodes
  ) {
    if (codes.length === 0 || indices.length === 0) return;

    const groupProducts = indices.map((i) => products[i]);
    const codeList = codes
      .map((c) => `${c.category_code}: ${c.category_name}`)
      .join("\n");
    const groupProductList = groupProducts
      .map((p, gi) => `${gi + 1}. 상품명: ${p.product_name} | 내카테고리: ${p.category || "없음"} | 원본카테고리: ${p.source_category || "없음"}`)
      .join("\n");

    console.log(`[gemini] 2단계 [${type}]: 상품 ${indices.length}개, 코드 ${codes.length}개`);

    const result = await generateText(
      `아래 상품 목록을 분석해서 각 상품에 가장 적합한 플레이오토 카테고리코드를 선택하세요.
분류: ${type}

카테고리코드 목록 (코드: 카테고리명):
${codeList}

상품 목록:
${groupProductList}

규칙:
- 반드시 위 카테고리코드 목록에 있는 코드 숫자만 선택
- 상품명을 분석하여 가장 구체적으로 일치하는 카테고리를 선택
- 예를 들어 "프라이팬"이면 프라이팬 관련 코드, "냄비"면 냄비 관련 코드 선택
- 정확히 맞는 카테고리가 없으면 가장 가까운 상위 카테고리 코드를 선택
- 절대 빈 문자열 출력 금지 — 반드시 가장 가까운 코드를 선택
- 반드시 아래 JSON 배열 형식으로만 출력 (다른 설명 없이):
["코드1", "코드2", ...]

상품 개수: ${groupProducts.length}개, 배열 항목도 반드시 ${groupProducts.length}개`
    );

    console.log(`[gemini] 2단계 [${type}] 응답:`, result?.slice(0, 300));

    if (!result) return;
    try {
      const jsonMatch = result.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return;
      const parsed = JSON.parse(jsonMatch[0]) as string[];
      if (!Array.isArray(parsed)) return;
      const validCodes = new Set(codes.map((c) => c.category_code));
      indices.forEach((productIdx, gi) => {
        const code = String(parsed[gi] ?? "").trim();
        if (validCodes.has(code)) results[productIdx] = code;
      });
    } catch { /* skip */ }
  }

  // 각 분류별로 Gemini 호출
  const step2Promises = [...typeGroups.entries()].map(([type, indices]) => {
    const typeCodes = codesByType.get(type) ?? [];
    return matchCodesForGroup(type, indices, typeCodes);
  });

  await Promise.all(step2Promises);

  // ── 3단계: 미매칭 상품 → 전체 코드에서 재검색 ──
  const unmatchedIndices = results.reduce<number[]>(
    (acc, r, i) => { if (r === "") acc.push(i); return acc; }, []
  );

  if (unmatchedIndices.length > 0) {
    console.log(`[gemini] 3단계 전체 검색: 미매칭 ${unmatchedIndices.length}개`);
    const allCodes = availableCodes.length <= 500
      ? availableCodes
      : availableCodes.filter((_, i) => i % Math.ceil(availableCodes.length / 500) === 0);
    await matchCodesForGroup("전체", unmatchedIndices, allCodes);
  }

  const matched = results.filter((r) => r !== "").length;
  console.log(`[gemini] 최종 결과: ${matched}/${products.length}개 매칭`);

  return results;
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
3. 허용 문자: 한글, 영문, 숫자, 공백만 사용
4. 총수량이 이미 있으면 분리 표현 제거 (예: "20입 5입 4개" → "20입")
5. 판매자 부가 설명 제거 (멀티팩, 이온음료, 쿠폰, 할인, HOT, NEW, 신제품 등)
6. 정리된 상품명 한 줄만 출력 (다른 설명 없이)

예시:
- "삼양 불닭볶음면 20입 5입 4개 멀티팩" → "삼양 불닭볶음면 20입"
- "(HOT신제품)오뚜기 진밀면 멀티팩(4개입x4팩) (총16개입)" → "오뚜기 진밀면 16개입"
- "테크 베이킹소다+구연산 액체세제 일반/드럼 겸용 1.8L 4개" → "테크 베이킹소다 구연산 액체세제 일반 드럼 겸용 1.8L 4개"
- "포카리스웨트 340ml 48캔 12캔 4팩 동아오츠카" → "포카리스웨트 340ml 48캔"

원본: ${rawName}`;

  return generateText(prompt);
}
