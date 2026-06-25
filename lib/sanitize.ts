/**
 * HTML 태그 제거 — 예방적 입력 sanitize 유틸
 */
export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, "").trim();
}

export function sanitizeText(input: string, maxLength = 2000): string {
  return stripHtml(input).slice(0, maxLength);
}

/**
 * 서버에서 외부 이미지 URL을 fetch하기 전 SSRF 방어 검증.
 * - http/https만 허용
 * - localhost·내부망·링크로컬(클라우드 메타데이터 169.254.169.254 포함)·사설 IP 차단
 * 정상 공개 이미지 CDN은 통과시키되 내부 자원 접근만 막는 blocklist 방식.
 */
export function isSafeRemoteImageUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0") {
    return false;
  }

  // IPv4 리터럴이면 사설/루프백/링크로컬 대역 차단
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10) return false;                       // 10.0.0.0/8
    if (a === 127) return false;                      // 127.0.0.0/8 loopback
    if (a === 0) return false;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return false;         // 169.254.0.0/16 (메타데이터 169.254.169.254 포함)
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false;         // 192.168.0.0/16
    return true;
  }

  // IPv6 루프백/링크로컬/유니크로컬 차단
  if (host === "::1" || host === "[::1]") return false;
  if (host.startsWith("fe80:") || host.startsWith("[fe80:")) return false;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("[fc") || host.startsWith("[fd")) return false;

  return true;
}
