// 마켓 문의 AI 답변 초안 생성 + 자동전송 가능 여부 분류 (Gemini)
// 크론(자동 답변)과 문의 탭의 "AI 초안" 버튼이 같이 사용한다.

import { generateText } from "@/lib/gemini";

/** 문의에 연결된 발주서 주문 컨텍스트 (없으면 일반 답변 모드) */
export interface InquiryOrderContext {
  delivery_status: string | null;
  tracking_no: string | null;
  courier: string | null;
  order_date: string | null;
  purchased_at: string | null;
  ship_by_date: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number | null;
  marketplace: string | null;
}

export interface InquiryDraftInput {
  inquiryType: string;
  content: string;
  productName: string | null;
  order: InquiryOrderContext | null;
  userId?: string;
}

export interface InquiryDraftResult {
  draft: string;
  /** true = 주문 데이터로 확답 가능한 단순 문의 → 자동 전송해도 안전 */
  autoSendable: boolean;
  reason: string;
}

function orderContextText(order: InquiryOrderContext | null): string {
  if (!order) return "연결된 주문 정보 없음 (일반 문의로 답변)";
  const lines = [
    `- 주문일: ${order.order_date ?? "미상"}`,
    `- 현재 상태: ${order.delivery_status ?? "미상"}`,
    `- 운송장: ${order.tracking_no ? `${order.courier ?? "택배사 미상"} ${order.tracking_no}` : "아직 없음"}`,
    `- 발주(구매) 처리일: ${order.purchased_at ? order.purchased_at.slice(0, 10) : "아직 처리 전"}`,
    `- 발송기한: ${order.ship_by_date ?? "미상"}`,
    `- 상품/수량: ${order.product_name ?? "미상"} / ${order.quantity ?? 1}개`,
  ];
  return lines.join("\n");
}

/**
 * 문의 내용 + 주문 정보로 답변 초안과 자동전송 가능 여부를 생성.
 * GEMINI_API_KEY 미설정·파싱 실패 시 null (호출부는 대기 처리).
 */
export async function generateInquiryDraft(input: InquiryDraftInput): Promise<InquiryDraftResult | null> {
  const prompt = `당신은 한국 오픈마켓(쿠팡/스마트스토어) 판매자의 CS 담당자다. 아래 고객 문의에 대한 답변을 작성하라.

## 고객 문의
상품: ${input.productName ?? "미상"}
내용: ${input.content}

## 이 문의에 연결된 주문의 실제 데이터 (사실만 사용, 지어내기 금지)
${orderContextText(input.order)}

## 답변 작성 규칙
- 존댓말, 정중하고 간결하게 2~5문장. "안녕하세요 고객님" 인사로 시작, "감사합니다"로 마무리.
- 주문 데이터에 있는 사실(배송 상태, 운송장 번호, 발송 시점)만 답하라. 데이터에 없는 것(정확한 도착일, 제조일자, 재고 상황 등)은 단정하지 말고 확인 후 안내하겠다고 답하라.
- 절대 금지: 사입/위탁/리셀/도매처/구매처/원가/마진 등 내부 사정 언급, 다른 쇼핑몰 이름 언급, 개인정보 노출.
- 운송장이 있으면 택배사와 번호를 답변에 포함하라.

## 자동전송 판정 (autoSendable)
true 조건 (전부 충족할 때만): 문의가 배송 진행 상황·발송 시점·운송장 확인 같은 단순 확인성 질문이고, 연결된 주문 데이터로 확답이 가능하다.
false 조건 (하나라도 해당하면): 취소·반품·교환·환불·보상 요구, 오배송·파손·누락 등 클레임, 상품 스펙·제조일자·유통기한·재고 질문, 불만·화난 어조, 주문 데이터가 없거나 문의와 매칭이 불확실, 판매자의 판단이 필요한 모든 경우.
애매하면 무조건 false.

## 출력 형식 (JSON만, 다른 텍스트 금지)
{"draft": "답변 내용", "autoSendable": true/false, "reason": "판정 근거 한 문장"}`;

  const raw = await generateText(prompt, { callSource: "inquiry_draft", userId: input.userId });
  if (!raw) return null;

  try {
    const match = raw.match(/\{[\s\S]*\}/); // 코드펜스 등 JSON 밖 텍스트 제거

    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { draft?: unknown; autoSendable?: unknown; reason?: unknown };
    const draft = typeof parsed.draft === "string" ? parsed.draft.trim() : "";
    if (!draft) return null;
    return {
      draft,
      autoSendable: parsed.autoSendable === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (e) {
    console.warn("[inquiry-ai] 초안 JSON 파싱 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
