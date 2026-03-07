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
  order_month: string | null; // generated: YYYY-MM
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export type OrderInsert = Omit<Order, "id" | "margin" | "order_month" | "created_at" | "updated_at">;

export type OrderUpdate = Partial<Omit<Order, "id" | "user_id" | "margin" | "order_month" | "created_at" | "updated_at">>;
