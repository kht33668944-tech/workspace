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
  purchase_order_no: string | null;
  courier: string | null;
  tracking_no: string | null;
  delivery_status: string;
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

export type OrderInsert = Omit<Order, "id" | "margin" | "order_month" | "created_at" | "updated_at">;

export type OrderUpdate = Partial<Omit<Order, "id" | "user_id" | "margin" | "order_month" | "created_at" | "updated_at">>;

export type PurchasePlatform = "gmarket" | "auction" | "ohouse" | "coupang" | "smartstore" | "11st";

export interface PurchaseCredential {
  id: string;
  user_id: string;
  platform: PurchasePlatform;
  login_id: string;
  label: string | null;
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

export const PLATFORM_LABELS: Record<PurchasePlatform, string> = {
  gmarket: "지마켓",
  auction: "옥션",
  ohouse: "오늘의집",
  coupang: "쿠팡",
  smartstore: "스마트스토어",
  "11st": "11번가",
};
