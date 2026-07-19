import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

const MIN_PASSWORD_LENGTH = 8;
const HIBP_RANGE_ENDPOINT = "https://api.pwnedpasswords.com/range";

function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return "비밀번호는 8자 이상이어야 합니다.";
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return "비밀번호에는 영문과 숫자를 모두 포함해주세요.";
  }
  return null;
}

async function getPwnedPasswordCount(password: string) {
  const hash = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${HIBP_RANGE_ENDPOINT}/${prefix}`, {
      cache: "no-store",
      headers: {
        "Add-Padding": "true",
        "User-Agent": "workspace-password-safety-check",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HIBP request failed: ${response.status}`);
    }

    const lines = (await response.text()).split(/\r?\n/);
    for (const line of lines) {
      const [returnedSuffix, countText] = line.trim().split(":");
      if (returnedSuffix?.toUpperCase() === suffix) {
        return Number.parseInt(countText ?? "0", 10) || 0;
      }
    }

    return 0;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function POST(request: NextRequest) {
  let password: unknown;

  try {
    ({ password } = (await request.json()) as { password?: unknown });
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  if (typeof password !== "string") {
    return NextResponse.json({ error: "비밀번호가 필요합니다." }, { status: 400 });
  }

  const validationError = validatePassword(password);
  if (validationError) {
    return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
  }

  try {
    const pwnedCount = await getPwnedPasswordCount(password);
    if (pwnedCount > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "이미 유출 이력이 있는 비밀번호입니다. 다른 비밀번호를 사용해주세요.",
        },
        { status: 400 }
      );
    }
  } catch (error) {
    console.warn(
      "[auth/check-password] 유출 비밀번호 검사 실패:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({
      ok: true,
      warning: "유출 비밀번호 검사 서비스에 일시적으로 연결할 수 없습니다.",
    });
  }

  return NextResponse.json({ ok: true });
}
