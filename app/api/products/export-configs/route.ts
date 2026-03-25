import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

// GET: 사용자의 플토 양식 설정 조회
export async function GET(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("playauto_export_configs")
    .select("*")
    .order("platform");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: 플토 양식 설정 저장 (upsert)
export async function POST(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await req.json();
  const { configs } = body as {
    configs: Array<{
      platform: string;
      shop_account: string;
      template_code: string;
      header_footer_template_code: string;
      sale_quantity: number;
      product_info_notice: string;
    }>;
  };

  if (!configs || configs.length === 0) {
    return NextResponse.json({ error: "설정 데이터 없음" }, { status: 400 });
  }

  const rows = configs.map((c) => ({
    user_id: user.id,
    platform: c.platform,
    shop_account: c.shop_account,
    template_code: c.template_code,
    header_footer_template_code: c.header_footer_template_code,
    sale_quantity: c.sale_quantity,
    product_info_notice: c.product_info_notice,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("playauto_export_configs")
    .upsert(rows, { onConflict: "user_id,platform" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
