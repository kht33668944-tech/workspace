"use client";

/**
 * 백그라운드 유지 대상 모달들의 컨트롤러 인스턴스.
 * 각 컨트롤러는 WorkspaceLayout에 Provider로 마운트되어 페이지 이동에도 유지된다.
 */

import type { Order, ProductInsert } from "@/types/database";
import { createModalController } from "./modal-controller";

// 자동구매: 선택된 주문 스냅샷
export interface AutoPurchaseInput {
  orders: Order[];
}
const autoPurchase = createModalController<AutoPurchaseInput>("AutoPurchase");
export const AutoPurchaseProvider = autoPurchase.Provider;
export const useAutoPurchaseController = autoPurchase.useController;

// 운송장 수집: 전체 주문 + 택배사 코드 맵 스냅샷
export interface TrackingCollectInput {
  orders: Order[];
  courierCodeMap: Record<string, number>;
}
const trackingCollect = createModalController<TrackingCollectInput>("TrackingCollect");
export const TrackingCollectProvider = trackingCollect.Provider;
export const useTrackingCollectController = trackingCollect.useController;

// 지마켓 가져오기: 카테고리 + 기존 URL 집합 스냅샷
export interface GmarketImportInput {
  categories: string[];
  existingUrls: Set<string>;
}
// import 핸들러: products 페이지가 마운트 중일 때 등록 (DB insert + 로컬 캐시)
export type GmarketImportHandler = (
  rows: Omit<ProductInsert, "user_id">[]
) => Promise<{ error: string | null }>;
const gmarketImport = createModalController<GmarketImportInput, GmarketImportHandler>("GmarketImport");
export const GmarketImportProvider = gmarketImport.Provider;
export const useGmarketImportController = gmarketImport.useController;
