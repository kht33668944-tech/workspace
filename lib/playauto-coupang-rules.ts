import type { Product } from "@/types/database";

export type CoupangExportOption = {
  hasOption: boolean;
  optionName: string;
  optionValue: string;
  missingRequired?: string[];
};

export type PlayAutoCategoryCode = {
  category_code: string;
  category_type: string;
  category_name: string;
};

export type CoupangRuleWarning = {
  productName: string;
  missing: string[];
};

type ParsedSpec = {
  quantity: number;
  quantityUnit: string;
  unitValue: string;
  unitType: string;
  rollCount: string;
  length: string;
  sheetCount: string;
};

const CATEGORY = {
  OAT_DRINK: "6372795",
  CORN_TEA: "6372760",
  INSTANT_RICE: "6373072",
  FRIED_RICE_CUPBAP: "6373069",
  BIBIM_COLD_NOODLE: "6372819",
  SPICY_NOODLE: "6372838",
  SOY_SAUCE: "6372999",
  SAUCE_DRESSING: "6373022",
  WET_TISSUE: "6372257",
  ROLL_TISSUE: "6372217",
  KITCHEN_TOWEL: "6372220",
  FACIAL_TISSUE: "6372216",
  COOKIE: "6372745",
  PIE_CAKE_SNACK: "6372743",
  CANDY: "6372902",
  YANGGAENG: "6372903",
  PEANUT_JAM: "6373145",
} as const;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesAny(text: string, keywords: string[]): boolean {
  const n = normalize(text);
  return keywords.some((keyword) => n.includes(keyword.toLowerCase()));
}

function parseProductSpec(productName: string): ParsedSpec {
  const text = productName
    .replace(/(\d+)\s+(?=\d\s*(?:kg|g|ml|mL|ML|L|m|M)\b)/g, "$1.")
    .replace(/(\d)\s*ML\b/g, "$1ml")
    .replace(/(\d)\s*mL\b/g, "$1ml")
    .replace(/(\d)\s*G\b/g, "$1g")
    .replace(/(\d)\s*KG\b/g, "$1kg");

  const countMatches = [...text.matchAll(/(\d+)\s*(개|봉|캔|병|팩|입|박스|롤|매|P|p|포|갑|곽|봉지|세트)/g)];
  const countMatch = countMatches.at(-1);
  let quantity = countMatch ? Number(countMatch[1]) : 1;
  let quantityUnit = countMatch?.[2] ?? "개";
  if (quantityUnit === "P" || quantityUnit === "p" || quantityUnit === "입") quantityUnit = "개";
  if (["봉", "캔", "병", "팩", "포", "갑", "곽", "봉지"].includes(quantityUnit)) quantityUnit = "개";

  const unitMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|L)\b/g)];
  const unitMatch = unitMatches.at(-1);
  const unitValue = unitMatch?.[1] ?? "";
  const unitType = unitMatch?.[2] ?? "";

  const rollMatch = text.match(/(\d+)\s*롤/);
  const lengthMatch = text.match(/(\d+(?:\.\d+)?)\s*m\b/i) ?? text.match(/(\d+)\s+(?=\d+\s*롤)/);
  const sheetMatch = text.match(/(\d+)\s*매/);

  // "30롤 2팩"이면 판매단위는 2개, 개당수량은 30롤이다.
  const packAfterRoll = text.match(/\d+\s*롤\s*(\d+)\s*(?:팩|개)/);
  if (packAfterRoll) {
    quantity = Number(packAfterRoll[1]);
    quantityUnit = "개";
  }

  return {
    quantity,
    quantityUnit,
    unitValue,
    unitType,
    rollCount: rollMatch ? `${rollMatch[1]}롤` : "",
    length: lengthMatch ? `${lengthMatch[1]}m` : "",
    sheetCount: sheetMatch ? `${sheetMatch[1]}매` : "",
  };
}

function canUseCategory(code: string, availableCodes?: PlayAutoCategoryCode[]): boolean {
  if (!availableCodes || availableCodes.length === 0) return true;
  return availableCodes.some((c) => c.category_code === code);
}

function setCategoryIfAvailable(
  categoryCodes: string[],
  index: number,
  code: string,
  availableCodes?: PlayAutoCategoryCode[]
) {
  if (canUseCategory(code, availableCodes)) categoryCodes[index] = code;
}

function option(optionName: string, optionValue: string): CoupangExportOption {
  return { hasOption: true, optionName, optionValue, missingRequired: [] };
}

function buildOptionForSiteCategory(productName: string, categoryCode: string): CoupangExportOption | null {
  const spec = parseProductSpec(productName);
  const qty = `${spec.quantity}${spec.quantityUnit}`;

  switch (categoryCode) {
    case CATEGORY.OAT_DRINK:
    case CATEGORY.CORN_TEA:
      if (spec.unitValue && (spec.unitType === "ml" || spec.unitType === "L")) {
        return option("[총 수량=개당 용량]", `${qty}=${spec.unitValue}${spec.unitType}`);
      }
      break;

    case CATEGORY.INSTANT_RICE:
      if (spec.unitValue && (spec.unitType === "g" || spec.unitType === "kg")) {
        return option("[총 수량=개당 중량]", `${qty}=${spec.unitValue}${spec.unitType}`);
      }
      break;

    case CATEGORY.FRIED_RICE_CUPBAP:
    case CATEGORY.SAUCE_DRESSING:
    case CATEGORY.COOKIE:
    case CATEGORY.PIE_CAKE_SNACK:
    case CATEGORY.CANDY:
    case CATEGORY.YANGGAENG:
    case CATEGORY.PEANUT_JAM:
      if (spec.unitValue && (spec.unitType === "g" || spec.unitType === "kg")) {
        return option("[수량=개당 중량]", `${qty}=${spec.unitValue}${spec.unitType}`);
      }
      break;

    case CATEGORY.BIBIM_COLD_NOODLE:
    case CATEGORY.SPICY_NOODLE:
      return option("[총 수량]", qty);

    case CATEGORY.SOY_SAUCE:
      if (spec.unitValue && (spec.unitType === "ml" || spec.unitType === "L")) {
        return option("[수량=개당 용량]", `${qty}=${spec.unitValue}${spec.unitType}`);
      }
      // 상품명 정규화 과정에서 "1.7L"이 "1.7"처럼 단위가 빠진 경우 보정한다.
      {
        const looseLiter = productName.match(/(\d+(?:\.\d+)?)\s+(?:\d+개|개)/);
        if (looseLiter) return option("[수량=개당 용량]", `${qty}=${looseLiter[1]}L`);
      }
      break;

    case CATEGORY.WET_TISSUE:
      if (spec.sheetCount) return option("[수량=평량=개당 수량]", `${qty}=${spec.sheetCount}=${spec.sheetCount}`);
      break;

    case CATEGORY.ROLL_TISSUE:
      if (spec.rollCount && spec.length) {
        return option("[수량=개당 수량=길이]", `${qty}=${spec.rollCount}=${spec.length}`);
      }
      if (spec.rollCount) {
        return option("[수량=개당 수량]", `${qty}=${spec.rollCount}`);
      }
      break;
  }

  return null;
}

function correctedCategoryByName(productName: string): string | null {
  if (includesAny(productName, ["어메이징오트", "아몬드브리즈 오리지널 950"])) return CATEGORY.OAT_DRINK;
  if (includesAny(productName, ["옥수수수염차"])) return CATEGORY.CORN_TEA;
  if (includesAny(productName, ["햇반", "오뚜기밥", "큰밥", "잡곡밥", "현미밥", "수향미 흰밥"])) return CATEGORY.INSTANT_RICE;
  if (includesAny(productName, ["솥반 불고기", "볶음밥", "컵밥"])) return CATEGORY.FRIED_RICE_CUPBAP;
  if (includesAny(productName, ["냉모밀", "진밀면", "비빔냉면", "비빔면"])) return CATEGORY.BIBIM_COLD_NOODLE;
  if (includesAny(productName, ["짬뽕왕뚜껑", "나가사끼짬뽕"])) return CATEGORY.SPICY_NOODLE;
  if (includesAny(productName, ["양조간장", "진간장", "장아찌 간장"])) return CATEGORY.SOY_SAUCE;
  if (includesAny(productName, ["불닭소스", "불닭마요", "까르보불닭소스", "드레싱", "요리소스"])) return CATEGORY.SAUCE_DRESSING;
  if (includesAny(productName, ["손소독티슈", "물티슈"])) return CATEGORY.WET_TISSUE;
  if (includesAny(productName, ["화장지", "휴지", "30롤", "90롤"])) return CATEGORY.ROLL_TISSUE;
  if (includesAny(productName, ["키친타올", "키친타월"])) return CATEGORY.KITCHEN_TOWEL;
  if (includesAny(productName, ["각티슈", "미용티슈"])) return CATEGORY.FACIAL_TISSUE;
  if (includesAny(productName, ["촉촉한 초코칩", "참크래커", "마가렛트", "비스킷", "쿠키"])) return CATEGORY.COOKIE;
  if (includesAny(productName, ["오예스", "몽쉘", "초코파이", "브라우니", "후레쉬베리"])) return CATEGORY.PIE_CAKE_SNACK;
  if (includesAny(productName, ["멘토스", "츄파춥스", "캔디"])) return CATEGORY.CANDY;
  if (includesAny(productName, ["양갱"])) return CATEGORY.YANGGAENG;
  if (includesAny(productName, ["땅콩버터", "초코잼", "누텔라"])) return CATEGORY.PEANUT_JAM;
  return null;
}

/**
 * 플레이오토 쿠팡 대량등록에서 실제 성공한 업로드 결과를 바탕으로 적용하는 보수적 보정.
 *
 * 핵심 원칙:
 * - 카테고리 빈칸은 계속 막는다.
 * - 같은 사이트 카테고리에서 성공한 옵션명 패턴이 있는 경우 Gemini 결과보다 우선한다.
 * - 상품명에서 값이 명확하지 않으면 억지로 채우지 않고 warning으로 남긴다.
 */
export function applyCoupangPlayAutoLearnedRules(
  products: Product[],
  siteCategoryCodes: string[],
  coupangOptions: CoupangExportOption[],
  availableCodes?: PlayAutoCategoryCode[]
): {
  siteCategoryCodes: string[];
  coupangOptions: CoupangExportOption[];
  warnings: CoupangRuleWarning[];
} {
  const adjustedCategoryCodes = [...siteCategoryCodes];
  const adjustedOptions: CoupangExportOption[] = coupangOptions.map((o) => ({
    ...o,
    missingRequired: [...(o.missingRequired ?? [])],
  }));
  const warnings: CoupangRuleWarning[] = [];

  products.forEach((product, index) => {
    const productName = product.product_name ?? "";
    const categoryByName = correctedCategoryByName(productName);
    if (categoryByName) {
      setCategoryIfAvailable(adjustedCategoryCodes, index, categoryByName, availableCodes);
    }

    const siteCategory = adjustedCategoryCodes[index] ?? "";
    const safeOption = buildOptionForSiteCategory(productName, siteCategory);
    if (safeOption) {
      adjustedOptions[index] = safeOption;
      return;
    }

    const optionMissing = !adjustedOptions[index]?.hasOption || !adjustedOptions[index]?.optionName || !adjustedOptions[index]?.optionValue;
    if (siteCategory && optionMissing) {
      warnings.push({
        productName,
        missing: ["쿠팡 옵션값을 확정하지 못했습니다. 업로드 시 필수 추천 옵션 오류 가능"],
      });
    }
  });

  return { siteCategoryCodes: adjustedCategoryCodes, coupangOptions: adjustedOptions, warnings };
}
