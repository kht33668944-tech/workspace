"use client";

import { Package } from "lucide-react";

export default function ProductsPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-white/40">
      <Package className="w-16 h-16 mb-4" />
      <p className="text-lg font-medium">상품 소싱</p>
      <p className="text-sm mt-1">추후 구현 예정</p>
    </div>
  );
}
