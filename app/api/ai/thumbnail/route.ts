import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { analyzeImageFromUrl } from "@/lib/gemini";
import sharp from "sharp";

export const maxDuration = 120;

interface RequestBody {
  productId: string;
  imageUrls: string[];
}

interface ImageScore {
  url: string;
  score: number;
  reason: string;
}

const ANALYSIS_PROMPT = `이 제품 이미지를 분석하여 썸네일 품질을 평가해주세요.

평가 기준 (각 항목 점수 부여):
- 흰색/단색 배경: 3점 (있으면 +3, 없으면 0)
- 제품이 중앙에 배치: 2점
- 사람 없음: 2점 (사람이 있으면 0점)
- 로고/워터마크 없음: 1점

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{"score": <0-8>, "issues": ["사람 있음", "복잡한 배경"] }`;

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

  const { productId, imageUrls } = body;
  if (!productId || !imageUrls?.length) {
    return NextResponse.json({ error: "productId와 imageUrls 필요" }, { status: 400 });
  }

  // 최대 10장 분석 (비용 절감)
  const urlsToAnalyze = imageUrls.slice(0, 10);
  const scores: ImageScore[] = [];

  // 병렬로 모든 이미지 분석
  const results = await Promise.allSettled(
    urlsToAnalyze.map((url) => analyzeImageFromUrl(url, ANALYSIS_PROMPT))
  );

  for (let i = 0; i < urlsToAnalyze.length; i++) {
    const result = results[i];
    let score = 0;
    let reason = "분석 실패";

    if (result.status === "fulfilled" && result.value) {
      try {
        // JSON 파싱 시도 (마크다운 코드블록 제거)
        const cleaned = result.value.replace(/```json\n?|\n?```/g, "").trim();
        const parsed = JSON.parse(cleaned) as { score: number; issues: string[] };
        score = parsed.score ?? 0;
        reason = parsed.issues?.join(", ") || "문제 없음";
      } catch {
        reason = "파싱 실패";
      }
    }

    scores.push({ url: urlsToAnalyze[i], score, reason });
  }

  // 최고 점수 이미지 선택
  const best = scores.reduce((a, b) => (a.score >= b.score ? a : b));

  // 이미지 다운로드 → 1000x1000 리사이즈 → Storage 업로드
  const serviceClient = getServiceSupabaseClient();
  let finalUrl = best.url;
  try {
    const imgRes = await fetch(best.url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (imgRes.ok) {
      const imgBuf = Buffer.from(await imgRes.arrayBuffer());
      const resized = await sharp(imgBuf)
        .resize(1000, 1000, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .jpeg({ quality: 90 })
        .toBuffer();

      const storagePath = `products/${user.id}/thumb_${productId}_${Date.now()}.jpg`;
      const { error: uploadError } = await serviceClient.storage
        .from("product-images")
        .upload(storagePath, resized, { contentType: "image/jpeg", upsert: true });

      if (!uploadError) {
        const { data: { publicUrl } } = serviceClient.storage
          .from("product-images")
          .getPublicUrl(storagePath);
        finalUrl = publicUrl;
      }
    }
  } catch (e) {
    console.error("[thumbnail]", e instanceof Error ? e.message : String(e));
    // 리사이즈 실패 시 원본 URL 사용
  }

  // DB 업데이트
  const { error: updateError } = await serviceClient
    .from("products")
    .update({ thumbnail_url: finalUrl })
    .eq("id", productId)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "DB 업데이트 실패" }, { status: 500 });
  }

  return NextResponse.json({
    thumbnailUrl: finalUrl,
    score: best.score,
    reason: best.reason,
    allScores: scores,
    summary: `${urlsToAnalyze.length}장 중 점수 ${best.score}/8 이미지로 썸네일 변경 (1000x1000)`,
  });
}
