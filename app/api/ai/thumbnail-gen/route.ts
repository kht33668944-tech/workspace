import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { generateImageFromPrompt } from "@/lib/gemini";

export const maxDuration = 120;

interface RequestBody {
  productId: string;
  productName: string;
  thumbnailUrl: string; // 참조용 현재 썸네일
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const { productId, productName, thumbnailUrl } = body;
  if (!productId || !productName) {
    return NextResponse.json({ error: "productId와 productName 필요" }, { status: 400 });
  }

  // 참조 이미지 base64 변환
  let referenceBase64: string | undefined;
  let referenceMime = "image/jpeg";
  if (thumbnailUrl) {
    try {
      const res = await fetch(thumbnailUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        referenceBase64 = Buffer.from(buf).toString("base64");
        referenceMime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
      }
    } catch {
      // 참조 이미지 없이도 진행
    }
  }

  const prompt = `제품 카탈로그 이미지를 생성해주세요.
제품명: ${productName}
요구사항:
- 완전한 흰색 배경
- 제품이 화면 중앙에 배치
- 사람, 로고, 워터마크 없음
- 전문적인 제품 사진 스타일
- 정방형 비율 (1:1)
- 고해상도, 선명한 이미지`;

  const generated = await generateImageFromPrompt(prompt, referenceBase64, referenceMime);
  if (!generated) {
    return NextResponse.json(
      { error: "이미지 생성 실패. Gemini 이미지 생성 모델 접근 권한을 확인하세요." },
      { status: 500 }
    );
  }

  // base64 → Buffer → Supabase Storage 업로드
  const imageBuffer = Buffer.from(generated.base64Data, "base64");
  const ext = generated.mimeType.includes("png") ? "png" : "jpg";
  const storagePath = `products/${user.id}/ai_thumb_${Date.now()}.${ext}`;

  const serviceClient = getServiceSupabaseClient();
  const { error: uploadError } = await serviceClient.storage
    .from("product-images")
    .upload(storagePath, imageBuffer, {
      contentType: generated.mimeType,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: "스토리지 업로드 실패" }, { status: 500 });
  }

  const { data: { publicUrl } } = serviceClient.storage
    .from("product-images")
    .getPublicUrl(storagePath);

  // DB 업데이트
  const { error: updateError } = await serviceClient
    .from("products")
    .update({ thumbnail_url: publicUrl })
    .eq("id", productId)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "DB 업데이트 실패" }, { status: 500 });
  }

  return NextResponse.json({ thumbnailUrl: publicUrl });
}
