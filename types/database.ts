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
  file_type: "order_export" | "playauto_tracking";
  file_data: string; // base64 encoded xlsx
  order_count: number;
  created_at: string;
  expires_at: string;
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
export type CommissionPlatform = "smartstore" | "esm" | "coupang" | "esm_5pct" | "myeolchi";

export const COMMISSION_PLATFORM_LABELS: Record<CommissionPlatform, string> = {
  smartstore: "스마트스토어",
  esm: "오픈마켓(ESM)",
  coupang: "쿠팡",
  esm_5pct: "지마켓/옥션(5%)",
  myeolchi: "멸치쇼핑",
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
  detail_html: string | null; // 플레이오토 대량등록용 상세페이지 HTML
  detail_image_url: string | null; // AI 생성 상세페이지 이미지 URL
  registration_status: string; // 상품 등록 상태
  created_at: string;
  updated_at: string;
}

export type ProductInsert = Omit<Product, "id" | "created_at" | "updated_at">;
export type ProductUpdate = Partial<Omit<Product, "id" | "user_id" | "created_at" | "updated_at">>;

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
