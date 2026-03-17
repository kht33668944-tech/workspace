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
  purchase_url: string;
  memo: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type ProductInsert = Omit<Product, "id" | "created_at" | "updated_at">;
export type ProductUpdate = Partial<Omit<Product, "id" | "user_id" | "created_at" | "updated_at">>;
