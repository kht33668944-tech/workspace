-- 구매처 반품신청 자동화용 컬럼 (2026-09-02)
-- claim_reason: 마켓에서 수집한 고객 반품/교환 사유 원문 (지마켓 반품신청 시 사유 분기·인용에 사용)
-- purchase_return_requested_at: 구매처(지마켓 등) 반품신청 완료 시각 — 중복 신청 방지 기준
alter table orders add column if not exists claim_reason text;
alter table orders add column if not exists purchase_return_requested_at timestamptz;
