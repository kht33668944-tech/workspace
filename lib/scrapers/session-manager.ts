import type { SupabaseClient } from "@supabase/supabase-js";
import type { Cookie } from "playwright";
import crypto from "crypto";
import { encrypt, decrypt } from "../crypto";

const SESSION_TTL_HOURS = 24;

function hashLoginId(loginId: string): string {
  return crypto.createHash("md5").update(loginId).digest("hex").substring(0, 8);
}

/**
 * Supabase에서 저장된 세션 쿠키를 로드
 * 만료되었거나 없으면 null 반환
 */
export async function loadSession(
  supabase: SupabaseClient,
  platform: string,
  loginId: string
): Promise<Cookie[] | null> {
  try {
    const { data, error } = await supabase
      .from("scraper_sessions")
      .select("cookies_encrypted, expires_at")
      .eq("platform", platform)
      .eq("login_id_hash", hashLoginId(loginId))
      .single();

    if (error || !data) return null;

    // 만료 체크
    if (new Date(data.expires_at) < new Date()) return null;

    const cookiesJson = decrypt(data.cookies_encrypted);
    return JSON.parse(cookiesJson) as Cookie[];
  } catch {
    return null;
  }
}

/**
 * 세션 쿠키를 Supabase에 암호화하여 저장 (upsert)
 */
export async function saveSession(
  supabase: SupabaseClient,
  platform: string,
  loginId: string,
  cookies: Cookie[]
): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const cookiesEncrypted = encrypt(JSON.stringify(cookies));
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();

    await supabase
      .from("scraper_sessions")
      .upsert(
        {
          user_id: user.id,
          platform,
          login_id_hash: hashLoginId(loginId),
          cookies_encrypted: cookiesEncrypted,
          updated_at: new Date().toISOString(),
          expires_at: expiresAt,
        },
        { onConflict: "user_id,platform,login_id_hash" }
      );
  } catch {
    // 세션 저장 실패는 무시 (스크래핑 자체는 계속 진행)
  }
}
