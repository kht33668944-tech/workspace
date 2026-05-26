export interface Order {
  id: string;
  user_id: string;
  bundle_no: string | null;
  order_date: string | null;
  marketplace: string | null;
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
  is_duplicate: boolean;
  consultation_logs: ConsultationLog[];
  order_month: string | null; // generated: YYYY-MM
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsultationLog {
  date: string;
  author: string;
  content: string;
}

export type OrderInsert = Omit<Order, "id" | "margin" | "order_month" | "is_duplicate" | "created_at" | "updated_at"> & { is_duplicate?: boolean };

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
  file_type: "order_export" | "playauto_tracking" | "playauto_product";
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
  created_at: string;
  updated_at: string;
}

export type ProductInsert = Omit<Product, "id" | "created_at" | "updated_at" | "platform_codes" | "seller_code" | "has_detail_html" | "fixed_price_smartstore" | "fixed_price_esm" | "fixed_price_coupang" | "coupang_options">;
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
  // 94컬럼 전체 raw 값을 보존: { "0": "값A", "1": "값B", ..., "93": "값CP" }
  // 내보내기 시 F열만 우리 시스템 가격으로 교체하고 나머지는 그대로 복원.
  raw_row: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export type SmartstorePriceInventoryInsert = Omit<SmartstorePriceInventory, "id" | "created_at" | "updated_at">;

// ─── 가격 이력 ───
export interface PriceHistory {
  id: string;
  product_id: string;
  previous_price: number;
  new_price: number;
  change_amount: number;  // new_price - previous_price
  change_rate: number;    // 변동률 (%)
  source: "scrape" | "manual";
  scraped_at: string;
}

// ─── 입출금 스냅샷 ───
export interface CardEntry {
  name: string;
  accumulated: number;
  daily_payment: number;
  installment: number;
  total: number;
  payment_day?: number; // 1-31, 카드 결제일
  payment_made?: number; // 결제일에 실제 납부한 금액
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
  created_at: string;
}
