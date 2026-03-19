/**
 * HTML 태그 제거 — 예방적 입력 sanitize 유틸
 */
export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, "").trim();
}

export function sanitizeText(input: string, maxLength = 2000): string {
  return stripHtml(input).slice(0, maxLength);
}
