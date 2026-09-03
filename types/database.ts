export interface Order {
  id: string;
  user_id: string;
  bundle_no: string | null;
  order_date: string | null;
  marketplace: string | null;
  marketplace_order_no: string | null;
  marketplace_product_order_no: string | null;
  marketplace_account?: string | null;
  marketplace_orderer_name: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number;
  recipient_phone: string | null;
  orderer_phone: string | null;
  postal_code: string | null;
  address: string | null;
  address_detail: string | null;
  delivery_memo: string | null;
  revenue: number;
  settlement: number;
  cost: number;
  margin: number; // generated: settlement - cost
  payment_method: string | null;
  purchase_id: string | null;
  purchase_source: string | null;
  purchase_url: string | null;
  purchase_order_no: string | null;
  courier: string | null;
  tracking_no: string | null;
  delivery_status: string;
  purchased_at: string | null;
  delivered_at: string | null;
  returned_at: string | null;
  is_duplicate: boolean;
  consultation_logs: ConsultationLog[];
  order_month: string | null; // generated: YYYY-MM
  memo: string | null;
  // 마켓 API 동기화 (20260831 마이그레이션)
  source?: string | null;
  marketplace_status?: string | null;
  claim_type?: string | null;
  claim_status?: string | null;
  confirmed_at?: string | null;
  ship_by_date?: string | null;
  marketplace_synced_at?: string | null;
  canceled_at?: string | null;
  // 송장 전송·정산 (20260901 마이그레이션)
  shipped_to_marketplace_at?: string | null;
  ship_error?: string | null;
  tracking_exported_at?: string | null;
  settlement_actual?: number | null;
  settlement_source?: "estimate" | "api" | "excel" | string | null;
  settlement_confirmed_at?: string | null;
  claim_receipt_id?: string | null;
  // 구매처 주문상세 링크 (add_purchase_detail_url 마이그레이션, 자동구매 시 자동 입력)
  purchase_detail_url?: string | null;
  // 구매처 반품신청 자동화 (20260902 마이그레이션)
  claim_reason?: string | null;
  purchase_return_requested_at?: string | null;
  // 구매 주문 목록 + 클레임 연락처/수량 (20260903 마이그레이션)
  // 비어 있으면 대표 컬럼(purchase_order_no 등) 1건으로 간주 — lib/purchase-orders.ts getPurchaseOrders 사용
  purchase_orders?: PurchaseOrderEntry[];
  claim_quantity?: number | null;
  claim_contact_updated_at?: string | null;
  created_at: string;
  updated_at: string;
  purchase_log_order_nos?: string[];
  purchase_duplicate_level?: "danger" | "warning" | null;
  purchase_duplicate_message?: string | null;
}

/** 발주서 한 행에 딸린 구매처 주문 1건 (orders.purchase_orders 엔트리) */
export interface PurchaseOrderEntry {
  order_no: string;                    // 구매처 주문번호 (지마켓 orderNo / 오늘의집 orderNo)
  pay_no?: string | null;              // 지마켓 결제번호 (상세링크 키)
  detail_url?: string | null;          // purchaseDetailUrl() 결과
  quantity: number;                    // 이 주문에 담긴 수량 (수동 묶음구매는 2 이상)
  courier?: string | null;
  tracking_no?: string | null;
  purchased_at?: string | null;
  return_requested_at?: string | null; // 지마켓 반품신청 완료 시각 (엔트리 단위)
  return_status?: "접수" | "완료" | null; // 반품 진행상태 추적 결과
  source: "auto" | "manual";
}

export interface ConsultationLog {
  date: string;
  author: string;
  content: string;
}

export type OrderInsert = Omit<Order, "id" | "margin" | "order_month" | "is_duplicate" | "created_at" | "updated_at" | "purchased_at" | "delivered_at" | "returned_at"> & {
  is_duplicate?: boolean;
  purchased_at?: string | null;
  delivered_at?: string | null;
  returned_at?: string | null;
};

export type OrderUpdate = Partial<Omit<Order, "id" | "user_id" | "margin" | "order_month" | "created_at" | "updated_at">>;

export type PurchasePlatform = "gmarket" | "auction" | "ohouse" | "coupang" | "smartstore" | "11st";

export interface PurchaseCredential {
  id: string;
  user_id: string;
  platform: PurchasePlatform;
  login_id: string;
  label: string | null;
  group_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExcelArchive {
  id: string;
  user_id: string;
  file_name: string;
  file_type: "order_export" | "playauto_tracking" | "playauto_product" | "price_update" | "esm_tracking";
  file_data: string; // base64 encoded xlsx
  order_count: number;
  created_at: string;
  expires_at: string;
}

export interface PlayAutoExportConfig {
  id: string;
  user_id: string;
  platform: string;
  shop_account: string;
  template_code: string;
  header_footer_template_code: string;
  sale_quantity: number;
  product_info_notice: string;
  created_at: string;
  updated_at: string;
}

export interface PlayAutoNoticeConfig {
  id: string;
  user_id: string;
  schema_code: string;
  field_values: string[];  // 항목별 값 배열 (스키마 fields와 인덱스 매칭)
  created_at: string;
  updated_at: string;
}

export interface PurchaseLog {
  id: string;
  user_id: string;
  batch_id: string;
  order_id: string | null;
  platform: string;
  login_id: string;
  status: "success" | "failed" | "cancelled";
  purchase_order_no: string | null;
  cost: number | null;
  payment_method: string | null;
  error_message: string | null;
  product_name: string | null;
  recipient_name: string | null;
  created_at: string;
}

export interface TrackingLog {
  id: string;
  user_id: string;
  batch_id: string;
  order_id: string | null;
  platform: string;
  login_id: string;
  status: "success" | "failed" | "not_found";
  purchase_order_no: string | null;
  courier: string | null;
  tracking_no: string | null;
  error_message: string | null;
  product_name: string | null;
  recipient_name: string | null;
  created_at: string;
}

export const PLATFORM_LABELS: Record<PurchasePlatform, string> = {
  gmarket: "지마켓",
  auction: "옥션",
  ohouse: "오늘의집",
  coupang: "쿠팡",
  smartstore: "스마트스토어",
  "11st": "11번가",
};

// ─── 수수료 ───
export type CommissionPlatform = "smartstore" | "esm" | "coupang" | "esm_5pct";

export const COMMISSION_PLATFORM_LABELS: Record<CommissionPlatform, string> = {
  smartstore: "스마트스토어",
  esm: "오픈마켓(ESM)",
  coupang: "쿠팡",
  esm_5pct: "지마켓/옥션(5%)",
};

export interface CommissionRate {
  id: string;
  user_id: string;
  category: string;
  platform: CommissionPlatform;
  rate_details: Record<string, number>;
  total_rate: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ─── 상품 ───
export interface Product {
  id: string;
  user_id: string;
  product_name: string;
  lowest_price: number;
  margin_rate: number; // 퍼센트 (8.00 = 8%)
  category: string;
  source_category: string; // 크롤링된 원본 카테고리 (예: '음료/생수')
  purchase_url: string;
  memo: string;
  sort_order: number;
  thumbnail_url: string | null;
  image_urls: string[];
  source_platform: string | null; // 'gmarket' | 'auction' 등
  detail_html: string | null; // 플레이오토 대량등록용 상세페이지 HTML (목록 조회 시 제외, 필요 시 단건 조회)
  has_detail_html: boolean; // 클라이언트 계산값: detail_html이 존재하는지 여부
  detail_image_url: string | null; // AI 생성 상세페이지 이미지 URL
  registration_status: string; // 상품 등록 상태
  platform_codes: Record<string, string> | null; // 플랫폼별 쇼핑몰 상품번호 {"옥션=redgoom00": "F445675075", ...}
  seller_code: Record<string, string> | null; // 플레이오토 판매자관리코드 (가격수정 시 필수)
  // 플랫폼별 고정 판매가 — null이면 자동계산, 값이 있으면 해당 값 우선 사용 (최저가 갱신에 영향받지 않음)
  fixed_price_smartstore: number | null;
  fixed_price_esm: number | null;
  fixed_price_coupang: number | null;
  // 쿠팡 가격수정 양식용 옵션 캐시 (한 번 추출 후 재사용)
  coupang_options: { hasOption: boolean; optionName: string; optionValue: string } | null;
  // 상품정보제공고시 실제 값 (식약처 품목제조보고 조사 결과) — null이면 "상세페이지 참조"로 내보냄
  item_info: Record<string, string> | null;
  // 재정비 진행상태: 대기 | 조사완료 | 이미지완료 | 재등록완료
  rebuild_status: string;
  created_at: string;
  updated_at: string;
}

export type ProductInsert = Omit<Product, "id" | "created_at" | "updated_at" | "platform_codes" | "seller_code" | "has_detail_html" | "fixed_price_smartstore" | "fixed_price_esm" | "fixed_price_coupang" | "coupang_options" | "item_info" | "rebuild_status">;
export type ProductUpdate = Partial<Omit<Product, "id" | "user_id" | "created_at" | "updated_at" | "has_detail_html">>;

// ─── 플레이오토 카테고리 매핑 ───
export interface PlayautoCategoryMapping {
  id: string;
  user_id: string;
  user_category: string;    // 내 수수료 카테고리명
  playauto_code: string;    // 플레이오토 상품분류코드 (예: "21")
  created_at: string;
  updated_at: string;
}

export type PlayautoCategoryMappingUpsert = Pick<PlayautoCategoryMapping, "user_category" | "playauto_code">;

// ─── 스마트스토어 카테고리코드 ───
export interface SmartStoreCategoryCode {
  id: string;
  user_id: string;
  category_code: string;  // 스마트스토어 카테고리코드 (예: "6219426")
  category_type: string;  // 분류 (예: "가공식품")
  category_name: string;  // 카테고리명 (예: "생수")
  created_at: string;
}

export type SmartStoreCategoryCodeInsert = Pick<SmartStoreCategoryCode, "category_code" | "category_type" | "category_name">;

// ─── 쿠팡 가격수정 v2: 셀러센터 양식 행 캐시 ───
export interface CoupangPriceInventory {
  id: string;
  user_id: string;
  product_id: string | null;
  vendor_item_id: string | null;
  coupang_product_id: string | null;
  option_id: string;
  product_status: string | null;
  barcode: string | null;
  vendor_item_code: string | null;
  coupang_display_name: string | null;
  registered_name: string | null;
  option_name: string | null;
  sale_price: number | null;
  discount_base_price: number | null;
  sale_status: string | null;
  stock: number | null;
  sales_count: number | null;
  approval_status: string | null;
  created_at: string;
  updated_at: string;
}

export type CoupangPriceInventoryInsert = Omit<CoupangPriceInventory, "id" | "created_at" | "updated_at">;

// ─── 공식 판매처 API 연동 ───
export type MarketplaceApiPlatform = "coupang" | "smartstore" | "esm";
export type MarketplaceApiTestStatus = "success" | "failed";
export type MarketplaceApiLogStatus = "success" | "failed";
export type MarketplaceApiAction =
  | "test" | "price" | "stock" | "stop" | "resume" | "sync" | "cancel"
  | "sync-orders" | "confirm" | "claim" | "approve-cancel" | "reject-cancel" | "auto-approve-cancel"
  | "ship" | "ship-fix"
  | "return-approve" | "return-receive" | "return-complete" | "return-reject"
  | "exchange-collect" | "exchange-ship" | "exchange-reject"
  | "settlement"
  | "sync-inquiries" | "inquiry_reply";

export interface MarketplaceApiCredential {
  id: string;
  user_id: string;
  platform: MarketplaceApiPlatform;
  label: string | null;
  account_id: string;
  meta: Record<string, unknown>;
  last_tested_at: string | null;
  last_test_status: MarketplaceApiTestStatus | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceApiLog {
  id: string;
  user_id: string;
  credential_id: string | null;
  platform: MarketplaceApiPlatform | string;
  action: MarketplaceApiAction | string;
  status: MarketplaceApiLogStatus;
  product_id: string | null;
  product_name: string | null;
  vendor_item_id: string | null;
  target_id: string | null;
  previous_value: string | null;
  new_value: string | null;
  error_message: string | null;
  response_payload: Record<string, unknown> | null;
  created_at: string;
}

// ─── 마켓 문의 (쿠팡 상품문의/고객센터, 스토어 상품Q&A/1:1) ───
export type MarketplaceInquiryType = "coupang_product" | "coupang_cs" | "naver_qna" | "naver_inquiry";
export type MarketplaceInquiryStatus = "unanswered" | "answered";
export type MarketplaceInquiryAnswerSource = "sync" | "app" | "auto";

/** 문의 유형 라벨 — 화면(문의 탭)·디스코드 알림·동기화 로그가 공유하는 정본 */
export const INQUIRY_TYPE_LABEL: Record<MarketplaceInquiryType, string> = {
  coupang_product: "쿠팡·상품문의",
  coupang_cs: "쿠팡·고객센터",
  naver_qna: "스토어·상품Q&A",
  naver_inquiry: "스토어·1:1",
};

/** 마켓 API 답변 글자수 제약 (없으면 제약 없음) — 화면 검증·전송 전 검증 공용 */
export const INQUIRY_REPLY_LIMITS: Partial<Record<MarketplaceInquiryType, { min: number; max: number }>> = {
  coupang_cs: { min: 2, max: 1000 },
};

export interface MarketplaceInquiry {
  id: string;
  user_id: string;
  platform: "coupang" | "smartstore";
  inquiry_type: MarketplaceInquiryType;
  inquiry_id: string;
  content: string;
  product_name: string | null;
  market_order_ids: string[];
  order_id: string | null;
  inquiry_at: string | null;
  status: MarketplaceInquiryStatus;
  answer_content: string | null;
  answered_at: string | null;
  answer_source: MarketplaceInquiryAnswerSource | null;
  ai_draft: string | null;
  ai_draft_at: string | null;
  raw: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── 옥션·지마켓(ESM) 가격 인벤토리 ───
export interface EsmPriceInventory {
  id: string;
  user_id: string;
  product_id: string | null;
  master_product_id: string | null;  // 마스터상품번호 (옥션+지마켓 공통 키)
  site_product_id: string;            // 사이트 상품번호 (양식에 들어가는 값)
  site: string | null;                // "옥션" | "지마켓"
  product_name: string | null;
  seller_code: string | null;
  seller_id: string | null;
  sale_status: string | null;
  sale_price: number | null;
  stock: number | null;
  category: string | null;
  site_category: string | null;
  created_at: string;
  updated_at: string;
}

export type EsmPriceInventoryInsert = Omit<EsmPriceInventory, "id" | "created_at" | "updated_at">;

// ─── 스마트스토어 가격 인벤토리 ───
export interface SmartstorePriceInventory {
  id: string;
  user_id: string;
  product_id: string | null;
  smartstore_product_id: string;
  seller_product_code: string | null;
  category_code: string | null;
  product_name: string | null;
  product_status: string | null;
  sale_price: number | null;
  option_type: string | null;
  // 커머스API 직접 연동용 (20260830 마이그레이션)
  origin_product_no: string | null;
  channel_product_no: string | null;
  stock: number | null;
  api_synced_at: string | null;
  // 94컬럼 전체 raw 값을 보존: { "0": "값A", "1": "값B", ..., "93": "값CP" }
  // 내보내기 시 F열만 우리 시스템 가격으로 교체하고 나머지는 그대로 복원.
  raw_row: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export type SmartstorePriceInventoryInsert = Omit<
  SmartstorePriceInventory,
  "id" | "created_at" | "updated_at" | "origin_product_no" | "channel_product_no" | "stock" | "api_synced_at"
> & Partial<Pick<SmartstorePriceInventory, "origin_product_no" | "channel_product_no" | "stock" | "api_synced_at">>;

// ─── 가격 이력 ───
export interface PriceHistory {
  id: string;
  product_id: string;
  previous_price: number;
  new_price: number;
  change_amount: number;  // new_price - previous_price
  change_rate: number;    // 변동률 (%)
  source: "scrape" | "impit_scrape" | "scrapling_scrape" | "manual" | "soldout";
  scraped_at: string;
}

// ─── 입출금 스냅샷 ───
export interface CardEntry {
  name: string;
  accumulated: number;
  daily_payment: number;
  installment: number;
  total: number;
  personal_excluded?: number; // 사업비에서 제외할 개인 사용분
  payments?: CardPaymentRecord[]; // 해당 날짜에 실제 납부한 금액 기록
  payment_day?: number; // legacy: 예전 카드 결제일
  payment_made?: number; // legacy: 예전 납부액
}

export interface CardPaymentRecord {
  date: string;
  amount: number;
  memo?: string;
}

export interface PlatformEntry {
  name: string;
  delivered: number;
  shipping: number;
  cs: number;
  total: number;
  settled_amount?: number; // 실제 정산 입금된 금액
}

export interface CashEntry {
  name: string;
  amount: number;
}

export interface DailySnapshot {
  id: string;
  user_id: string;
  date: string;
  cards: CardEntry[];
  platforms: PlatformEntry[];
  cash: CashEntry[];
  pending_purchase: number;
  total_cards: number;
  total_platforms: number;
  total_cash: number;
  net_balance: number;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export type DailySnapshotInsert = Omit<DailySnapshot, "id" | "created_at" | "updated_at">;
export type DailySnapshotUpdate = Partial<Omit<DailySnapshot, "id" | "user_id" | "created_at" | "updated_at">>;

// ─── SMS ───
export interface SmsTemplate {
  id: string;
  user_id: string;
  name: string;
  content: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export type SmsTemplateInsert = Omit<SmsTemplate, "id" | "created_at" | "updated_at">;
export type SmsTemplateUpdate = Partial<Omit<SmsTemplate, "id" | "user_id" | "created_at" | "updated_at">>;

export interface SmsLog {
  id: string;
  user_id: string;
  batch_id: string;
  order_id: string | null;
  phone: string;
  message: string;
  status: "success" | "failed";
  error_message: string | null;
  message_id: string | null;
  provider: "solapi" | "phone" | null;
  created_at: string;
}

export interface MarketplaceSyncRun {
  id: string;
  user_id: string;
  platform: string;
  trigger: string;
  dry_run: boolean;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "partial" | "failed";
  remote_count: number;
  new_orders: number;
  confirmed: number;
  confirm_failed: number;
  claims: Record<string, number>;
  error: string | null;
  detail: Record<string, unknown> | null;
  kind?: "orders" | "shipping" | "settlement" | "daily-summary" | "inquiries" | "tracking-collect" | "esm-export" | "price" | "health-alert" | string;
}
