import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const type = searchParams.get("type");

  const params = new URLSearchParams();
  if (code) params.set("code", code);
  if (type) params.set("type", type);

  return NextResponse.redirect(`${origin}/auth/handle?${params.toString()}`);
}
