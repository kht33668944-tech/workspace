"use client";

import { useState } from "react";
import { X, Eraser, Loader2 } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import type { ResetFieldOptions } from "@/hooks/use-products";

interface Props {
  selectedCount: number;
  onClose: () => void;
  onReset: (fields: ResetFieldOptions) => Promise<{ error: string | null; deletedInventory: number }>;
}

const FIELD_ITEMS: { key: keyof ResetFieldOptions; label: string; desc: string }[] = [
  { key: "platformCodes", label: "판매처별 상품번호", desc: "플레이오토 임포트로 들어온 옥션/지마켓 등 쇼핑몰 상품번호" },
  { key: "sellerCode", label: "판매자관리코드", desc: "플레이오토 가격수정 양식에 쓰이는 관리코드" },
  { key: "registrationStatus", label: "등록상태", desc: "등록완료/판매중지 표시를 '등록전'으로 되돌림" },
  { key: "detailHtml", label: "상세페이지 HTML", desc: "플레이오토 대량등록용 상세페이지 (다시 생성 필요)" },
  { key: "detailImage", label: "AI 상세페이지 이미지", desc: "AI가 만든 상세 이미지 (저장소 파일도 함께 삭제)" },
  { key: "imageUrls", label: "상품 이미지 목록", desc: "수집/업로드된 상품 이미지들 (저장소 파일도 함께 삭제)" },
  { key: "thumbnail", label: "썸네일", desc: "목록에 보이는 대표 이미지 주소" },
  { key: "coupangOptions", label: "쿠팡 옵션 캐시", desc: "쿠팡 가격수정 양식용으로 추출해둔 옵션 정보" },
  { key: "fixedPrices", label: "고정 판매가", desc: "스마트스토어/ESM/쿠팡 고정가 → 자동계산으로 복귀" },
  { key: "priceInventory", label: "셀러센터 가격수정 캐시", desc: "쿠팡/스마트스토어/옥션·지마켓 셀러센터 엑셀 캐시 삭제" },
];

const makeSelection = (value: boolean) =>
  Object.fromEntries(FIELD_ITEMS.map((f) => [f.key, value])) as unknown as ResetFieldOptions;

export default function RegistrationResetModal({ selectedCount, onClose, onReset }: Props) {
  const { showToast } = useToast();
  const [fields, setFields] = useState<ResetFieldOptions>(() => makeSelection(false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkedCount = Object.values(fields).filter(Boolean).length;
  const allChecked = checkedCount === FIELD_ITEMS.length;

  const toggle = (key: keyof ResetFieldOptions) =>
    setFields((prev) => ({ ...prev, [key]: !prev[key] }));

  const toggleAll = () => setFields(makeSelection(!allChecked));

  const handleClose = () => {
    if (!busy) onClose();
  };

  const handleReset = async () => {
    if (busy || checkedCount === 0) return;
    const labels = FIELD_ITEMS.filter((f) => fields[f.key]).map((f) => f.label);
    const confirmed = window.confirm(
      [
        `선택한 ${selectedCount}개 상품의 ${checkedCount}개 항목을 초기화합니다.`,
        "",
        `초기화 항목: ${labels.join(", ")}`,
        "",
        "되돌릴 수 없습니다. 계속하시겠습니까?",
      ].join("\n")
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      const result = await onReset(fields);
      if (result.error) {
        setError(result.error);
        return;
      }
      showToast(
        `${selectedCount}개 상품 등록정보 초기화 완료${fields.priceInventory ? ` (가격캐시 ${result.deletedInventory}건 삭제)` : ""}`,
        "success"
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold text-white">등록정보 초기화</h2>
            <p className="text-xs text-zinc-400 mt-0.5">선택한 {selectedCount}개 상품에서 체크한 항목만 비웁니다</p>
          </div>
          <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-300">{checkedCount}개 항목 선택됨</span>
            <button onClick={toggleAll} className="text-xs text-orange-400 hover:text-orange-300">
              {allChecked ? "전체 해제" : "전체 선택"}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto border border-zinc-800 rounded-lg divide-y divide-zinc-800">
            {FIELD_ITEMS.map((item) => (
              <label
                key={item.key}
                className="flex items-start gap-3 px-4 py-2.5 cursor-pointer hover:bg-zinc-800/50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={fields[item.key]}
                  onChange={() => toggle(item.key)}
                  className="mt-0.5 w-4 h-4 accent-orange-500"
                />
                <span>
                  <span className="block text-sm text-white">{item.label}</span>
                  <span className="block text-xs text-zinc-500">{item.desc}</span>
                </span>
              </label>
            ))}
          </div>

          {error && (
            <div className="px-3 py-2 text-xs bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg">
              {error}
            </div>
          )}

          <p className="text-xs text-zinc-500">
            상품명·최저가·구매 URL·카테고리·마진율·메모는 유지됩니다.
          </p>

          <div className="flex justify-end gap-2">
            <button
              onClick={handleClose}
              disabled={busy}
              className="px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 rounded-lg disabled:opacity-50"
            >
              취소
            </button>
            <button
              onClick={handleReset}
              disabled={busy || checkedCount === 0}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 rounded-lg disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eraser className="w-4 h-4" />}
              {busy ? "초기화 중..." : "초기화"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
