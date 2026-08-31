-- 구매처 주문상세 페이지 링크 (자동구매 완료 시 자동 입력 — 반품/문의 시 바로 진입용)
alter table orders add column if not exists purchase_detail_url text;
