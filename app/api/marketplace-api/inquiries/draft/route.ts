import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { generateInquiryDraft, type InquiryOrderContext } from "@/lib/marketplace/inquiry-ai";
import type { MarketplaceInquiry } from "@/types/database";

export const maxDuration = 60;

/** AI 답변 초안 (재)생성: { id: marketplace_inquiries.id } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "id 가 필요합니다." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { data: row, error: rowErr } = await supabase
      .from("marketplace_inquiries").select("*").eq("id", body.id).single();
    if (rowErr || !row) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    const inquiry = row as MarketplaceInquiry;

    let orderCtx: InquiryOrderContext | null = null;
    if (inquiry.order_id) {
      const { data: order } = await supabase
        .from("orders")
        .select("delivery_status, tracking_no, courier, order_date, purchased_at, ship_by_date, recipient_name, product_name, quantity, marketplace")
        .eq("id", inquiry.order_id)
        .maybeSingle();
      orderCtx = (order as InquiryOrderContext | null) ?? null;
    }

    const draft = await generateInquiryDraft({
      inquiryType: inquiry.inquiry_type,
      content: inquiry.content,
      productName: inquiry.product_name,
      order: orderCtx,
      userId: userData.user.id,
    });
    if (!draft) return NextResponse.json({ error: "AI 초안 생성 실패 (GEMINI_API_KEY 확인)" }, { status: 503 });

    await supabase.from("marketplace_inquiries")
      .update({ ai_draft: draft.draft, ai_draft_at: new Date().toISOString() })
      .eq("id", inquiry.id);

    return NextResponse.json({ draft: draft.draft, autoSendable: draft.autoSendable, reason: draft.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inquiry-draft] 오류:", message);
    return NextResponse.json({ error: `초안 생성 실패: ${message}` }, { status: 500 });
  }
}
