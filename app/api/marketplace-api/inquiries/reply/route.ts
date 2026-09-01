import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getInquiryClients } from "@/lib/marketplace-api-helpers";
import { sendInquiryReply } from "@/lib/marketplace/inquiry-sync";
import { logMarketplaceApi } from "@/lib/marketplace/common";
import type { MarketplaceInquiry } from "@/types/database";

export const maxDuration = 60;

/** 문의 답변 전송: { id: marketplace_inquiries.id, content } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string; content?: string };
    const content = (body.content ?? "").trim();
    if (!body.id || !content) return NextResponse.json({ error: "id 와 content 가 필요합니다." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const { data: row, error: rowErr } = await supabase
      .from("marketplace_inquiries").select("*").eq("id", body.id).single();
    if (rowErr || !row) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    const inquiry = row as MarketplaceInquiry;
    if (inquiry.status === "answered") {
      return NextResponse.json({ error: "이미 답변된 문의입니다." }, { status: 409 });
    }

    const { data: cred } = await supabase
      .from("marketplace_api_credentials").select("id,platform,meta")
      .eq("platform", inquiry.platform).limit(1).maybeSingle();
    if (!cred) return NextResponse.json({ error: `${inquiry.platform} API 계정이 등록되지 않았습니다.` }, { status: 400 });

    const clients = await getInquiryClients(supabase, cred);

    const sent = await sendInquiryReply({
      inquiryType: inquiry.inquiry_type,
      inquiryId: inquiry.inquiry_id,
      raw: inquiry.raw ?? {},
      content,
      ...clients,
    });

    void logMarketplaceApi(supabase, {
      user_id: userId,
      platform: inquiry.platform,
      credential_id: cred.id,
      action: "inquiry_reply",
      status: sent.ok || sent.alreadyAnswered ? "success" : "failed",
      product_name: inquiry.product_name ?? undefined,
      target_id: inquiry.inquiry_id,
      new_value: content.slice(0, 200),
      error_message: sent.ok || sent.alreadyAnswered ? undefined : sent.message,
    });

    if (sent.alreadyAnswered) {
      // 마켓에서 이미 답변된 문의 — 로컬도 답변완료로 맞춘다
      await supabase.from("marketplace_inquiries")
        .update({ status: "answered", answer_source: "sync", answered_at: new Date().toISOString() })
        .eq("id", inquiry.id);
      return NextResponse.json({ ok: true, alreadyAnswered: true, message: "마켓에서 이미 답변된 문의라 답변완료로 반영했습니다." });
    }
    if (!sent.ok) {
      return NextResponse.json({ error: sent.message }, { status: 502 });
    }

    const { data: updated } = await supabase.from("marketplace_inquiries")
      .update({ status: "answered", answer_content: content, answered_at: new Date().toISOString(), answer_source: "app" })
      .eq("id", inquiry.id)
      .select("*")
      .single();

    return NextResponse.json({ ok: true, dryRun: sent.dryRun, inquiry: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inquiry-reply] 오류:", message);
    return NextResponse.json({ error: `답변 전송 실패: ${message}` }, { status: 500 });
  }
}
