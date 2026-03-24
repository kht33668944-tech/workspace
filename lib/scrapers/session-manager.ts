import type { SupabaseClient } from "@supabase/supabase-js";
import type { Cookie } from "playwright";
import crypto from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { encrypt, decrypt } from "../crypto";

const SESSION_TTL_HOURS = 24;
const SESSION_DIR = path.join(process.cwd(), ".sessions");

function hashLoginId(loginId: string): string {
  return crypto.createHash("md5").update(loginId).digest("hex").substring(0, 8);
}

// ═══════════════════════════════════
// 파일 기반 세션 (암호화 저장)
// ═══════════════════════════════════

interface SavedSession {
  loginId: string;
  data: string; // encrypt된 쿠키 JSON
  savedAt: number;
}

function getCookiePath(platform: string, loginId: string): string {
  const hash = hashLoginId(loginId);
  return path.join(SESSION_DIR, `${platform}-${hash}.json`);
}

export async function loadFileSession(
  platform: string,
  loginId: string
): Promise<Cookie[] | null> {
  try {
    const raw = await readFile(getCookiePath(platform, loginId), "utf-8");
    const session: SavedSession = JSON.parse(raw);
    if (session.loginId !== loginId) return null;
    const hoursSaved = (Date.now() - session.savedAt) / (1000 * 60 * 60);
    if (hoursSaved > SESSION_TTL_HOURS) return null;
    const cookiesJson = decrypt(session.data);
    return JSON.parse(cookiesJson) as Cookie[];
  } catch {
    return null;
  }
}

export async function saveFileSession(
  platform: string,
  loginId: string,
  cookies: Cookie[]
): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { recursive: true });
    const session: SavedSession = {
      loginId,
      data: encrypt(JSON.stringify(cookies)),
      savedAt: Date.now(),
    };
    await writeFile(getCookiePath(platform, loginId), JSON.stringify(session), "utf-8");
  } catch {
    // 세션 저장 실패는 무시
  }
}

// ═══════════════════════════════════
// Supabase 기반 세션 (암호화 저장)
// ═══════════════════════════════════

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
