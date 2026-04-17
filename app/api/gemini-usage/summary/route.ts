import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { calcCostUsd, usdToKrw, FALLBACK_MODEL } from "@/lib/gemini-pricing";

export const revalidate = 60;

interface UsageRow {
  call_source: string;
  model: string;
  prompt_tokens: number;
  candidate_tokens: number;
  is_image: boolean;
  image_count: number;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 이번 달 전체 행 조회 (사용자 ID는 RLS에서 자동 필터)
    const { data: rows, error } = await supabase
      .from("gemini_usage")
      .select("call_source, model, prompt_tokens, candidate_tokens, is_image, image_count, created_at")
      .gte("created_at", monthStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(50000);

    if (error) {
      console.error("[gemini-usage-summary]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const list: UsageRow[] = (rows ?? []) as UsageRow[];

    // 1) 월간 합계
    let totalPromptTokens = 0;
    let totalCandidateTokens = 0;
    let totalImageCount = 0;
    let monthCostUsd = 0;
    for (const r of list) {
      totalPromptTokens += r.prompt_tokens;
      totalCandidateTokens += r.candidate_tokens;
      totalImageCount += r.image_count;
      monthCostUsd += calcCostUsd({
        model: r.model || FALLBACK_MODEL,
        promptTokens: r.prompt_tokens,
        candidateTokens: r.candidate_tokens,
        imageCount: r.image_count,
      });
    }

    // 2) 기능별 집계
    const sourceMap = new Map<string, {
      promptTokens: number;
      candidateTokens: number;
      imageCount: number;
      costUsd: number;
    }>();
    for (const r of list) {
      const key = r.call_source || "unknown";
      const acc = sourceMap.get(key) ?? {
        promptTokens: 0,
        candidateTokens: 0,
        imageCount: 0,
        costUsd: 0,
      };
      acc.promptTokens += r.prompt_tokens;
      acc.candidateTokens += r.candidate_tokens;
      acc.imageCount += r.image_count;
      acc.costUsd += calcCostUsd({
        model: r.model || FALLBACK_MODEL,
        promptTokens: r.prompt_tokens,
        candidateTokens: r.candidate_tokens,
        imageCount: r.image_count,
      });
      sourceMap.set(key, acc);
    }
    const bySource = Array.from(sourceMap.entries())
      .map(([callSource, v]) => ({
        callSource,
        promptTokens: v.promptTokens,
        candidateTokens: v.candidateTokens,
        imageCount: v.imageCount,
        costUsd: Number(v.costUsd.toFixed(4)),
        costKrw: usdToKrw(v.costUsd),
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    // 3) 최근 7일 일별 (오늘 포함)
    const dayMap = new Map<string, number>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dayMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const r of list) {
      const created = new Date(r.created_at);
      if (created < sevenDaysAgo) continue;
      const key = created.toISOString().slice(0, 10);
      if (!dayMap.has(key)) continue;
      const cost = calcCostUsd({
        model: r.model || FALLBACK_MODEL,
        promptTokens: r.prompt_tokens,
        candidateTokens: r.candidate_tokens,
        imageCount: r.image_count,
      });
      dayMap.set(key, (dayMap.get(key) ?? 0) + cost);
    }
    const last7Days = Array.from(dayMap.entries())
      .map(([date, costUsd]) => ({ date, costKrw: usdToKrw(costUsd) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      month: {
        from: monthStart.toISOString().slice(0, 10),
        to: now.toISOString().slice(0, 10),
        totalPromptTokens,
        totalCandidateTokens,
        totalImageCount,
        estimatedCostUsd: Number(monthCostUsd.toFixed(4)),
        estimatedCostKrw: usdToKrw(monthCostUsd),
      },
      bySource,
      last7Days,
    });
  } catch (e) {
    console.error("[gemini-usage-summary]", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}
