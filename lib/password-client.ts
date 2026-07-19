export async function checkPasswordSecurity(password: string) {
  try {
    const response = await fetch("/api/auth/check-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const json = (await response.json()) as { ok?: boolean; error?: string };

    if (!response.ok || !json.ok) {
      return json.error ?? "비밀번호를 확인할 수 없습니다.";
    }
    return null;
  } catch {
    return "비밀번호를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.";
  }
}
