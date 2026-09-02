-- 구매 주문 목록 + 클레임 연락처/수량 (2026-09-03)
-- purchase_orders: 발주서 한 행에 딸린 구매처 주문 목록(수량 N개 자동구매 = N건, 수동 묶음구매 = 1건 quantity N).
--   비어 있으면 대표 컬럼(purchase_order_no/purchase_detail_url/courier/tracking_no) 1건으로 간주한다.
--   엔트리 형식은 types/database.ts PurchaseOrderEntry 참조.
-- claim_quantity: 마켓 반품/교환 요청 수량 (부분 반품 구분)
-- claim_contact_updated_at: 반품/교환 접수 시 마켓이 재발급한 안심번호로 연락처를 갱신한 시각
alter table orders add column if not exists purchase_orders jsonb not null default '[]'::jsonb;
alter table orders add column if not exists claim_quantity integer;
alter table orders add column if not exists claim_contact_updated_at timestamptz;
create index if not exists idx_orders_purchase_orders_gin on orders using gin (purchase_orders jsonb_path_ops);
