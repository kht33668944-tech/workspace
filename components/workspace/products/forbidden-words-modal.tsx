"use client";

import { useEffect, useState, useCallback } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface ForbiddenWord {
  id: string;
  word: string;
  created_at: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ForbiddenWordsModal({ open, onClose }: Props) {
  const { session } = useAuth();
  const [words, setWords] = useState<ForbiddenWord[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = session?.access_token;

  const fetchWords = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/forbidden-words", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "조회 실패");
      setWords(json.words ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) fetchWords();
  }, [open, fetchWords]);

  const handleAdd = async () => {
    const trimmed = input.trim();
    if (!trimmed || !token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/forbidden-words", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ word: trimmed }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "추가 실패");
      setWords((prev) => [json.word, ...prev]);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/forbidden-words", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "삭제 실패");
      setWords((prev) => prev.filter((w) => w.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold text-white">금지어 관리</h2>
            <p className="text-xs text-zinc-400 mt-0.5">상세페이지 생성 시 이 단어가 포함된 문구는 제외됩니다</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder="금지어 입력 (예: 알레르기)"
              maxLength={50}
              className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500"
            />
            <button
              onClick={handleAdd}
              disabled={busy || !input.trim()}
              className="flex items-center gap-1 px-3 py-2 text-sm bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-lg disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              추가
            </button>
          </div>

          {error && (
            <div className="px-3 py-2 text-xs bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg">
              {error}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto border border-zinc-800 rounded-lg">
            {loading ? (
              <div className="p-6 text-center text-sm text-zinc-500">불러오는 중...</div>
            ) : words.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">등록된 금지어가 없습니다</div>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {words.map((w) => (
                  <li key={w.id} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-sm text-white">{w.word}</span>
                    <button
                      onClick={() => handleDelete(w.id)}
                      disabled={busy}
                      className="p-1 rounded text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-zinc-500">총 {words.length}개 등록됨</p>
        </div>
      </div>
    </div>
  );
}
