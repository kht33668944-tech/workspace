// 마켓 문의 동기화 (쿠팡 상품문의/고객센터, 스마트스토어 상품Q&A/1:1)
// 매시 크론과 문의 탭의 "동기화" 버튼이 호출. 새 미답변 문의는 AI가 초안 생성 후
// 단순 배송문의만 자동 답변하고, 애매한 문의는 초안만 저장(대기)한다.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CoupangOpenApiClient,
  type CoupangOnlineInquiry,
  type CoupangCallCenterInquiry,
  type CoupangCallCenterReply,
} from "@/lib/coupang-api";
import { NaverCommerceApiClient, type NaverQna, type NaverCustomerInquiry } from "@/lib/naver-commerce-api";
import { sleep, logMarketplaceApi } from "@/lib/marketplace/common";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";
import { toKstDateKey } from "@/lib/date-utils";
import { getAppSetting } from "@/lib/app-settings";
import { startSyncRun, finishSyncRun } from "@/lib/marketplace/sync-run";
import { generateInquiryDraft, type InquiryOrderContext } from "@/lib/marketplace/inquiry-ai";
import { INQUIRY_TYPE_LABEL, INQUIRY_REPLY_LIMITS, type MarketplaceInquiryType } from "@/types/database";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export { INQUIRY_TYPE_LABEL };

const MAX_PAGES = 30;          // 페이지네이션 안전 상한
const MAX_AUTO_REPLY = 5;      // 한 번의 동기화에서 AI 자동답변 최대 건수 (폭주 방지)

export interface InquirySyncItem {
  inquiryType: MarketplaceInquiryType;
  inquiryId: string;
  productName: string | null;
  contentPreview: string;
  reason?: string; // AI 판정 근거 (autoReplied/held 용)
}

export interface InquirySyncResult {
  platform: SyncPlatform;
  remoteCount: number;
  newInquiries: InquirySyncItem[];   // 이번에 새로 발견된 미답변 문의
  autoReplied: InquirySyncItem[];    // AI가 자동 답변한 건
  heldForReview: InquirySyncItem[];  // 초안만 저장하고 대기한 건
  updatedAnswered: number;           // 마켓에서 답변 완료로 바뀐 기존 행
  permissionDenied: MarketplaceInquiryType[];
  errors: string[];
  runId: string | null;              // marketplace_sync_runs 기록 id
}

/** 4종 문의를 upsert 전에 통일하는 중간 형태 */
interface NormalizedInquiry {
  inquiryType: MarketplaceInquiryType;
  inquiryId: string;
  content: string;
  productName: string | null;
  marketOrderIds: string[];
  inquiryAt: string | null;
  answered: boolean;
  answerContent: string | null;
  answeredAt: string | null;
  raw: Record<string, unknown>;
}

function preview(text: string, len = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > len ? `${clean.slice(0, len)}…` : clean;
}

// ───────── 플랫폼별 수집 ─────────

async function fetchCoupangProduct(client: CoupangOpenApiClient, from: string, to: string): Promise<NormalizedInquiry[]> {
  const out: NormalizedInquiry[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const res = await client.listOnlineInquiries({ inquiryStartAt: from, inquiryEndAt: to, pageNum });
    if (!res.ok) throw Object.assign(new Error(res.message), { status: res.status });
    const body = res.body as { data?: { content?: CoupangOnlineInquiry[]; pagination?: { totalPages?: number } } } | null;
    const rows = body?.data?.content ?? [];
    for (const r of rows) {
      const comments = r.commentDtoList ?? [];
      const last = comments[comments.length - 1];
      out.push({
        inquiryType: "coupang_product",
        inquiryId: String(r.inquiryId),
        content: r.content ?? "",
        productName: null, // 응답에 상품명 없음 — 주문 매칭으로 보강
        marketOrderIds: (r.orderIds ?? []).map(String),
        inquiryAt: r.inquiryAt ?? null,
        answered: comments.length > 0,
        answerContent: last?.content ?? null,
        answeredAt: last?.inquiryCommentAt ?? null,
        raw: r as unknown as Record<string, unknown>,
      });
    }
    const totalPages = body?.data?.pagination?.totalPages ?? 1;
    if (pageNum >= totalPages || rows.length === 0) break;
  }
  return out;
}

/** 고객센터 문의는 실제 질문이 replies(needAnswer=true) 안에 있는 경우가 많다 */
function csQuestionText(r: CoupangCallCenterInquiry): string {
  const needAnswer = (r.replies ?? []).filter((rep) => rep.needAnswer === true);
  const latest = needAnswer[needAnswer.length - 1];
  if (latest?.content) return latest.content;
  return r.content ?? "";
}

async function fetchCoupangCs(client: CoupangOpenApiClient, from: string, to: string): Promise<NormalizedInquiry[]> {
  const out: NormalizedInquiry[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const res = await client.listCallCenterInquiries({ inquiryStartAt: from, inquiryEndAt: to, pageNum });
    if (!res.ok) throw Object.assign(new Error(res.message), { status: res.status });
    const body = res.body as { data?: { content?: CoupangCallCenterInquiry[]; pagination?: { totalPages?: number } } } | null;
    const rows = body?.data?.content ?? [];
    for (const r of rows) {
      const answered = r.csPartnerCounselingStatus === "answered" || r.inquiryStatus === "complete";
      const vendorReplies = (r.replies ?? []).filter((rep) => rep.answerType !== "csAgent");
      const lastVendor = vendorReplies[vendorReplies.length - 1];
      out.push({
        inquiryType: "coupang_cs",
        inquiryId: String(r.inquiryId),
        content: csQuestionText(r),
        productName: r.itemName ?? null,
        marketOrderIds: r.orderId ? [String(r.orderId)] : [],
        inquiryAt: r.inquiryAt ?? r.answeredAt ?? null,
        answered,
        answerContent: lastVendor?.content ?? null,
        answeredAt: r.answeredAt ?? null,
        raw: r as unknown as Record<string, unknown>,
      });
    }
    const totalPages = body?.data?.pagination?.totalPages ?? 1;
    if (pageNum >= totalPages || rows.length === 0) break;
  }
  return out;
}

async function fetchNaverQna(client: NaverCommerceApiClient, from: string, to: string): Promise<NormalizedInquiry[]> {
  const out: NormalizedInquiry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.getProductQnas({ fromDate: from, toDate: to, page });
    if (!res.ok) throw Object.assign(new Error(res.message), { status: res.status });
    const body = res.body as { contents?: NaverQna[]; totalPages?: number } | null;
    const rows = body?.contents ?? [];
    for (const r of rows) {
      out.push({
        inquiryType: "naver_qna",
        inquiryId: String(r.questionId),
        content: r.question ?? "",
        productName: r.productName ?? null,
        marketOrderIds: [],
        inquiryAt: r.createDate ?? null,
        answered: r.answered === true,
        answerContent: typeof r.answer === "string" ? r.answer : null,
        answeredAt: null,
        raw: r as unknown as Record<string, unknown>,
      });
    }
    const totalPages = body?.totalPages ?? 1;
    if (page >= totalPages || rows.length === 0) break;
    await sleep(600);
  }
  return out;
}

async function fetchNaverInquiry(client: NaverCommerceApiClient, from: string, to: string): Promise<NormalizedInquiry[]> {
  const out: NormalizedInquiry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.getCustomerInquiries({ startSearchDate: from, endSearchDate: to, page });
    if (!res.ok) throw Object.assign(new Error(res.message), { status: res.status });
    const body = res.body as { content?: NaverCustomerInquiry[]; totalPages?: number } | null;
    const rows = body?.content ?? [];
    for (const r of rows) {
      const ids = [...(r.productOrderIdList ?? []), ...(r.orderId ? [r.orderId] : [])].map(String);
      out.push({
        inquiryType: "naver_inquiry",
        inquiryId: String(r.inquiryNo),
        content: [r.title, r.inquiryContent].filter(Boolean).join("\n") || "",
        productName: r.productName ?? null,
        marketOrderIds: ids,
        inquiryAt: r.inquiryRegistrationDateTime ?? null,
        answered: r.answered === true,
        answerContent: r.answerContent ?? null,
        answeredAt: r.answerRegistrationDateTime ?? null,
        raw: r as unknown as Record<string, unknown>,
      });
    }
    const totalPages = body?.totalPages ?? 1;
    if (page >= totalPages || rows.length === 0) break;
    await sleep(600);
  }
  return out;
}

// ───────── 답변 전송 (동기화 자동답변 + reply 라우트 공용) ─────────

export interface InquiryReplyOutcome {
  ok: boolean;
  dryRun: boolean;
  alreadyAnswered: boolean;
  message: string;
}

/** 마켓이 "이미 답변된 문의"라 거절한 응답인지 (order-ship 의 isAlreadyShippedMessage 와 같은 관용구) */
function isAlreadyAnsweredMessage(message: string): boolean {
  return /이미|중복|duplicate|already/i.test(message);
}

/** 고객센터 문의 답변에 필요한 parentAnswerId — needAnswer=true 인 최신 이관글의 answerId */
export function extractCsParentAnswerId(raw: Record<string, unknown>): number | null {
  const replies = (raw.replies as CoupangCallCenterReply[] | undefined) ?? [];
  const needAnswer = replies.filter((r) => r.needAnswer === true && typeof r.answerId === "number");
  const latest = needAnswer[needAnswer.length - 1];
  return latest?.answerId ?? null;
}

export async function sendInquiryReply(opts: {
  inquiryType: MarketplaceInquiryType;
  inquiryId: string;
  raw: Record<string, unknown>;
  content: string;
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
  wingUserId?: string | null;
}): Promise<InquiryReplyOutcome> {
  const { inquiryType, inquiryId, content } = opts;

  if (inquiryType === "coupang_product" || inquiryType === "coupang_cs") {
    if (!opts.coupang) return { ok: false, dryRun: false, alreadyAnswered: false, message: "쿠팡 API 클라이언트 없음" };
    if (!opts.wingUserId) {
      return { ok: false, dryRun: false, alreadyAnswered: false, message: "쿠팡윙 로그인 ID가 저장돼 있지 않습니다. 발주서 ▸ 마켓 API ▸ 취소 처리에서 윙ID를 한 번 입력하면 저장됩니다." };
    }
    if (inquiryType === "coupang_product") {
      const res = await opts.coupang.replyOnlineInquiry({ inquiryId, content, replyBy: opts.wingUserId });
      const alreadyAnswered = !res.ok && res.status === 400 && isAlreadyAnsweredMessage(res.message);
      return { ok: res.ok, dryRun: res.dryRun === true, alreadyAnswered, message: res.message };
    }
    // coupang_cs — 답변 조건: 글자수 제약 + 미답변 + parentAnswerId 확보
    const limits = INQUIRY_REPLY_LIMITS[inquiryType];
    if (limits && (content.trim().length < limits.min || content.length > limits.max)) {
      return { ok: false, dryRun: false, alreadyAnswered: false, message: `쿠팡 고객센터 답변은 ${limits.min}~${limits.max}자여야 합니다.` };
    }
    const parentAnswerId = extractCsParentAnswerId(opts.raw);
    if (parentAnswerId === null) {
      return { ok: false, dryRun: false, alreadyAnswered: false, message: "답변 대상 이관글(parentAnswerId)을 찾지 못했습니다. 동기화 후 다시 시도하세요." };
    }
    const res = await opts.coupang.replyCallCenterInquiry({ inquiryId, content, replyBy: opts.wingUserId, parentAnswerId });
    const alreadyAnswered = !res.ok && res.status === 400 && isAlreadyAnsweredMessage(res.message);
    return { ok: res.ok, dryRun: res.dryRun === true, alreadyAnswered, message: res.message };
  }

  if (!opts.smartstore) return { ok: false, dryRun: false, alreadyAnswered: false, message: "스마트스토어 API 클라이언트 없음" };
  const res = inquiryType === "naver_qna"
    ? await opts.smartstore.answerProductQna(opts.inquiryId, content)
    : await opts.smartstore.answerCustomerInquiry(opts.inquiryId, content);
  const alreadyAnswered = !res.ok && isAlreadyAnsweredMessage(res.message);
  return { ok: res.ok, dryRun: res.dryRun === true, alreadyAnswered, message: res.message };
}

// ───────── 동기화 본체 ─────────

export interface SyncInquiriesOptions {
  supabase: AnySupabase;
  userId: string;
  platform: SyncPlatform;
  credentialId: string | null;
  days?: number;
  trigger?: "manual" | "scheduler";
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
  /** 쿠팡 자동답변용 윙ID (credential.meta.wingUserId) */
  wingUserId?: string | null;
}

export async function syncInquiries(options: SyncInquiriesOptions): Promise<InquirySyncResult> {
  const { supabase, userId, platform } = options;
  const days = Math.min(Math.max(options.days ?? 7, 1), 7); // 쿠팡 최대 7일
  const to = toKstDateKey();
  const from = toKstDateKey(Date.now() - (days - 1) * 86400000);

  const result: InquirySyncResult = {
    platform, remoteCount: 0, newInquiries: [], autoReplied: [], heldForReview: [],
    updatedAnswered: 0, permissionDenied: [], errors: [], runId: null,
  };

  // 실행 기록 (자동화 페이지 타임라인용) — 기록 실패는 본작업을 막지 않는다
  result.runId = await startSyncRun(supabase, { userId, platform, kind: "inquiries", trigger: options.trigger ?? "manual" });

  try {
    await syncInquiriesBody(options, from, to, result);
  } finally {
    const hasWork = result.newInquiries.length + result.updatedAnswered + result.autoReplied.length > 0;
    await finishSyncRun(supabase, result.runId, {
      status: result.errors.length > 0 ? (hasWork ? "partial" : "failed") : "success",
      remote_count: result.remoteCount,
      confirmed: result.autoReplied.length,
      error: result.errors[0] ?? null,
      detail: {
        new: result.newInquiries.length,
        autoReplied: result.autoReplied.length,
        held: result.heldForReview.length,
        updatedAnswered: result.updatedAnswered,
        permissionDenied: result.permissionDenied,
        samples: result.newInquiries.slice(0, 20),
      },
    });
  }
  return result;
}

async function syncInquiriesBody(
  options: SyncInquiriesOptions,
  from: string,
  to: string,
  result: InquirySyncResult,
): Promise<void> {
  const { supabase, userId, platform } = options;

  // 1. 수집 (경로별 독립 실패)
  const collected: NormalizedInquiry[] = [];
  const paths: Array<[MarketplaceInquiryType, () => Promise<NormalizedInquiry[]>]> =
    platform === "coupang" && options.coupang
      ? [
          ["coupang_product", () => fetchCoupangProduct(options.coupang!, from, to)],
          ["coupang_cs", () => fetchCoupangCs(options.coupang!, from, to)],
        ]
      : platform === "smartstore" && options.smartstore
        ? [
            ["naver_qna", () => fetchNaverQna(options.smartstore!, from, to)],
            ["naver_inquiry", () => fetchNaverInquiry(options.smartstore!, from, to)],
          ]
        : [];

  for (const [type, fetcher] of paths) {
    try {
      collected.push(...await fetcher());
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 401 || status === 403) {
        result.permissionDenied.push(type);
        console.warn(`[inquiry-sync] ${type} 권한 없음(${status}): ${msg}`);
      } else {
        result.errors.push(`${INQUIRY_TYPE_LABEL[type]}: ${msg}`);
      }
    }
  }
  result.remoteCount = collected.length;
  if (collected.length === 0) return;

  // 2. 기존 행 대조 — 이번 수집분과 대응하는 행만 조회 (히스토리가 쌓여도 payload 고정)
  const types = [...new Set(collected.map((c) => c.inquiryType))];
  const existing = new Map<string, { id: string; status: string }>();
  const collectedIds = [...new Set(collected.map((c) => c.inquiryId))];
  for (let i = 0; i < collectedIds.length; i += 200) {
    const { data: existingRows, error: exErr } = await supabase
      .from("marketplace_inquiries")
      .select("id, inquiry_type, inquiry_id, status")
      .eq("user_id", userId)
      .in("inquiry_type", types)
      .in("inquiry_id", collectedIds.slice(i, i + 200));
    if (exErr) {
      result.errors.push(`기존 문의 조회 실패: ${exErr.message}`);
      return;
    }
    for (const r of existingRows ?? []) existing.set(`${r.inquiry_type}|${r.inquiry_id}`, { id: r.id, status: r.status });
  }

  // 3. 주문 매칭 (배치 1회) — AI 초안에 필요한 주문 컨텍스트까지 함께 조회 (5단계 개별 재조회 방지)
  //    쿠팡의 marketplace_product_order_no 는 `${shipmentBoxId}-${vendorItemId}` 형태라 문의 주문번호와 매칭 불가 → 제외
  const orderByMarketNo = new Map<string, { id: string } & InquiryOrderContext>();
  const allMarketNos = [...new Set(collected.flatMap((c) => c.marketOrderIds))];
  if (allMarketNos.length > 0) {
    const marketLabel = platform === "coupang" ? "쿠팡" : "스마트스토어";
    const cols = platform === "coupang"
      ? (["marketplace_order_no"] as const)
      : (["marketplace_order_no", "marketplace_product_order_no"] as const);
    const ctxCols = "id, product_name, delivery_status, tracking_no, courier, order_date, purchased_at, ship_by_date, recipient_name, quantity, marketplace";
    for (const col of cols) {
      for (let i = 0; i < allMarketNos.length; i += 200) {
        const chunk = allMarketNos.slice(i, i + 200);
        const { data: rows } = await supabase
          .from("orders")
          .select(`${ctxCols}, ${col}`)
          .eq("user_id", userId)
          .eq("marketplace", marketLabel)
          .in(col, chunk);
        for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
          const no = row[col];
          if (typeof no === "string" && no && !orderByMarketNo.has(no)) {
            orderByMarketNo.set(no, row as unknown as { id: string } & InquiryOrderContext);
          }
        }
      }
    }
  }

  // 4. upsert (answered → unanswered 다운그레이드 금지)
  const newlyInserted: Array<{ dbId: string; item: NormalizedInquiry; orderCtx: InquiryOrderContext | null }> = [];
  for (const item of collected) {
    const key = `${item.inquiryType}|${item.inquiryId}`;
    const matched = item.marketOrderIds.map((no) => orderByMarketNo.get(no)).find(Boolean) ?? null;
    const productName = item.productName ?? matched?.product_name ?? null;
    const prev = existing.get(key);

    if (!prev) {
      const { data: inserted, error: insErr } = await supabase
        .from("marketplace_inquiries")
        .insert({
          user_id: userId,
          platform,
          inquiry_type: item.inquiryType,
          inquiry_id: item.inquiryId,
          content: item.content,
          product_name: productName,
          market_order_ids: item.marketOrderIds,
          order_id: matched?.id ?? null,
          inquiry_at: item.inquiryAt,
          status: item.answered ? "answered" : "unanswered",
          answer_content: item.answered ? item.answerContent : null,
          answered_at: item.answered ? item.answeredAt : null,
          answer_source: item.answered ? "sync" : null,
          raw: item.raw,
        })
        .select("id")
        .single();
      if (insErr) {
        result.errors.push(`문의 저장 실패(${item.inquiryId}): ${insErr.message}`);
        continue;
      }
      if (!item.answered) {
        result.newInquiries.push({
          inquiryType: item.inquiryType,
          inquiryId: item.inquiryId,
          productName,
          contentPreview: preview(item.content),
        });
        newlyInserted.push({ dbId: inserted.id, item, orderCtx: matched });
      }
    } else if (prev.status === "unanswered") {
      // 답변 완료된 기존 행은 건드리지 않는다 (매시 no-op UPDATE 방지).
      // 미답변 행은 raw 를 최신화 — 쿠팡 CS 답변에 필요한 parentAnswerId 가 raw 에 있다
      const updates: Record<string, unknown> = { raw: item.raw };
      if (item.answered) {
        updates.status = "answered";
        updates.answer_content = item.answerContent;
        updates.answered_at = item.answeredAt;
        updates.answer_source = "sync";
        result.updatedAnswered++;
      }
      const { error: upErr } = await supabase.from("marketplace_inquiries").update(updates).eq("id", prev.id);
      if (upErr) result.errors.push(`문의 갱신 실패(${item.inquiryId}): ${upErr.message}`);
    }
  }

  // 5. AI 초안 + 단순 문의 자동 답변 (새 미답변 문의만)
  if (newlyInserted.length > 0) {
    const setting = await getAppSetting<{ enabled?: boolean }>(supabase, userId, "auto_reply_inquiry");
    const autoEnabled = setting?.enabled === true; // 기본 꺼짐 — AI는 초안만 준비, 전송은 사람이 확인 후
    let autoSent = 0;

    for (const { dbId, item, orderCtx } of newlyInserted) {
      const draft = await generateInquiryDraft({
        inquiryType: item.inquiryType,
        content: item.content,
        productName: item.productName,
        order: orderCtx,
        userId,
      });
      if (!draft) continue; // GEMINI 미설정·실패 → 대기 (초안 없음)

      await supabase.from("marketplace_inquiries")
        .update({ ai_draft: draft.draft, ai_draft_at: new Date().toISOString() })
        .eq("id", dbId);

      const summary: InquirySyncItem = {
        inquiryType: item.inquiryType,
        inquiryId: item.inquiryId,
        productName: item.productName,
        contentPreview: preview(item.content),
        reason: draft.reason,
      };

      const canAuto = autoEnabled && draft.autoSendable && orderCtx !== null && autoSent < MAX_AUTO_REPLY;
      if (!canAuto) {
        result.heldForReview.push(summary);
        continue;
      }

      const sent = await sendInquiryReply({
        inquiryType: item.inquiryType,
        inquiryId: item.inquiryId,
        raw: item.raw,
        content: draft.draft,
        coupang: options.coupang,
        smartstore: options.smartstore,
        wingUserId: options.wingUserId,
      });
      void logMarketplaceApi(supabase, {
        user_id: userId,
        platform,
        credential_id: options.credentialId ?? undefined,
        action: "inquiry_reply",
        status: sent.ok ? "success" : "failed",
        product_name: item.productName ?? undefined,
        target_id: item.inquiryId,
        new_value: draft.draft.slice(0, 200),
        error_message: sent.ok ? undefined : sent.message,
        response_payload: { auto: true, reason: draft.reason },
      });
      if (sent.ok) {
        await supabase.from("marketplace_inquiries").update({
          status: "answered",
          answer_content: draft.draft,
          answered_at: new Date().toISOString(),
          answer_source: "auto",
        }).eq("id", dbId);
        autoSent++;
        result.autoReplied.push(summary);
      } else {
        console.warn(`[inquiry-sync] 자동답변 실패(${item.inquiryId}): ${sent.message}`);
        result.heldForReview.push({ ...summary, reason: `자동답변 실패: ${sent.message}` });
      }
    }
  }

  void logMarketplaceApi(supabase, {
    user_id: userId,
    platform,
    credential_id: options.credentialId ?? undefined,
    action: "sync-inquiries",
    status: result.errors.length > 0 ? "failed" : "success",
    new_value: `remote=${result.remoteCount} new=${result.newInquiries.length} auto=${result.autoReplied.length} held=${result.heldForReview.length}`,
    error_message: result.errors.length > 0 ? result.errors.join(" / ").slice(0, 500) : undefined,
  });
}
