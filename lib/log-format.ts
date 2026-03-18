import { PLATFORM_LABELS } from "@/types/database";
import type { PurchasePlatform } from "@/types/database";

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

export function formatLogDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dayName = DAY_NAMES[d.getDay()];
  return `${y}년 ${m}월 ${day}일 (${dayName})`;
}

export function formatLogTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function getPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as PurchasePlatform] || platform;
}
