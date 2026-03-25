"use client";

import { useState, useEffect, useCallback } from "react";
import { Save, Loader2, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { PLATFORM_CONFIGS, type PlayAutoExportPlatform } from "@/lib/excel-export";
import { PLAYAUTO_SCHEMAS } from "@/lib/playauto-schema";
import type { PlayAutoExportConfig, PlayAutoNoticeConfig } from "@/types/database";

const PLATFORMS: { key: PlayAutoExportPlatform; label: string; color: string }[] = [
  { key: "smartstore", label: "스마트스토어", color: "green" },
  { key: "gmarket_auction", label: "지마켓·옥션", color: "yellow" },
  { key: "coupang", label: "쿠팡", color: "red" },
  { key: "myeolchi", label: "멸치쇼핑", color: "blue" },
];

type PlatformConfig = {
  shop_account: string;
  template_code: string;
  header_footer_template_code: string;
  sale_quantity: number;
};

type NoticeConfig = Record<string, string[]>; // schema_code → field_values

function getDefaultPlatformConfigs(): Record<string, PlatformConfig> {
  const result: Record<string, PlatformConfig> = {};
  for (const p of PLATFORMS) {
    const cfg = PLATFORM_CONFIGS[p.key];
    result[p.key] = {
      shop_account: cfg.shopAccount,
      template_code: cfg.templateCode,
      header_footer_template_code: cfg.headerFooterTemplateCode,
      sale_quantity: 2000,
    };
  }
  return result;
}

function getDefaultNoticeConfigs(): NoticeConfig {
  const result: NoticeConfig = {};
  for (const schema of PLAYAUTO_SCHEMAS) {
    result[schema.code] = schema.fields.map(() => "상세페이지 참조");
  }
  return result;
}

export default function ExportConfigTab() {
  const { session } = useAuth();
  const [platformConfigs, setPlatformConfigs] = useState(getDefaultPlatformConfigs);
  const [noticeConfigs, setNoticeConfigs] = useState<NoticeConfig>(getDefaultNoticeConfigs);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const [platformRes, noticeRes] = await Promise.all([
        fetch("/api/products/export-configs", { headers: { Authorization: `Bearer ${session.access_token}` } }),
        fetch("/api/products/notice-configs", { headers: { Authorization: `Bearer ${session.access_token}` } }),
      ]);

      if (platformRes.ok) {
        const data = (await platformRes.json()) as PlayAutoExportConfig[];
        if (data.length > 0) {
          setPlatformConfigs((prev) => {
            const next = { ...prev };
            for (const d of data) {
              if (next[d.platform]) {
                next[d.platform] = {
                  shop_account: d.shop_account,
                  template_code: d.template_code,
                  header_footer_template_code: d.header_footer_template_code,
                  sale_quantity: d.sale_quantity,
                };
              }
            }
            return next;
          });
        }
      }

      if (noticeRes.ok) {
        const data = (await noticeRes.json()) as PlayAutoNoticeConfig[];
        if (data.length > 0) {
          setNoticeConfigs((prev) => {
            const next = { ...prev };
            for (const d of data) {
              if (next[d.schema_code]) {
                next[d.schema_code] = d.field_values;
              }
            }
            return next;
          });
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handlePlatformChange = (platform: string, field: string, value: string | number) => {
    setPlatformConfigs((prev) => ({
      ...prev,
      [platform]: { ...prev[platform], [field]: value },
    }));
    setSaved(false);
  };

  const handleNoticeChange = (schemaCode: string, fieldIdx: number, value: string) => {
    setNoticeConfigs((prev) => {
      const next = { ...prev };
      next[schemaCode] = [...(next[schemaCode] || [])];
      next[schemaCode][fieldIdx] = value;
      return next;
    });
    setSaved(false);
  };

  const handleSave = async () => {
    if (!session?.access_token) return;
    setSaving(true);
    try {
      const platformArray = Object.entries(platformConfigs).map(([platform, cfg]) => ({
        platform,
        ...cfg,
        product_info_notice: "상세페이지 참조",
      }));
      const noticeArray = Object.entries(noticeConfigs).map(([schema_code, field_values]) => ({
        schema_code,
        field_values,
      }));

      const [r1, r2] = await Promise.all([
        fetch("/api/products/export-configs", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ configs: platformArray }),
        }),
        fetch("/api/products/notice-configs", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ configs: noticeArray }),
        }),
      ]);

      if (r1.ok && r2.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        alert("저장 실패");
      }
    } catch {
      alert("저장 실패");
    } finally {
      setSaving(false);
    }
  };

  const handleResetPlatform = (platform: string) => {
    const cfg = PLATFORM_CONFIGS[platform as PlayAutoExportPlatform];
    if (!cfg) return;
    setPlatformConfigs((prev) => ({
      ...prev,
      [platform]: {
        shop_account: cfg.shopAccount,
        template_code: cfg.templateCode,
        header_footer_template_code: cfg.headerFooterTemplateCode,
        sale_quantity: 2000,
      },
    }));
    setSaved(false);
  };

  const handleResetNotice = (schemaCode: string) => {
    const schema = PLAYAUTO_SCHEMAS.find((s) => s.code === schemaCode);
    if (!schema) return;
    setNoticeConfigs((prev) => ({
      ...prev,
      [schemaCode]: schema.fields.map(() => "상세페이지 참조"),
    }));
    setSaved(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 저장 버튼 */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          플레이오토 대량등록 엑셀의 고정값을 설정합니다. 저장 후 내보내기에 반영됩니다.
        </p>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg transition-colors ${
            saved ? "bg-green-600 text-white" : "bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          }`}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saved ? "저장 완료" : "저장"}
        </button>
      </div>

      {/* 플랫폼별 설정 */}
      <div>
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">플랫폼별 양식</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {PLATFORMS.map(({ key, label, color }) => (
            <div key={key} className="border border-[var(--border)] rounded-xl overflow-hidden">
              <div className={`flex items-center justify-between px-4 py-2.5 bg-${color}-500/10 border-b border-[var(--border)]`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full bg-${color}-400`} />
                  <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
                </div>
                <button
                  onClick={() => handleResetPlatform(key)}
                  className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <RotateCcw className="w-3 h-3" />
                  초기화
                </button>
              </div>
              <div className="p-4 space-y-3">
                <Field
                  label="쇼핑몰(계정)"
                  value={platformConfigs[key].shop_account}
                  onChange={(v) => handlePlatformChange(key, "shop_account", v)}
                  multiline={key === "gmarket_auction"}
                  placeholder="예: 스마트스토어=redgoom"
                />
                <Field
                  label="템플릿코드"
                  value={platformConfigs[key].template_code}
                  onChange={(v) => handlePlatformChange(key, "template_code", v)}
                  multiline={key === "gmarket_auction"}
                  placeholder="예: 2200901"
                />
                <Field
                  label="머리말/꼬리말 템플릿코드"
                  value={platformConfigs[key].header_footer_template_code}
                  onChange={(v) => handlePlatformChange(key, "header_footer_template_code", v)}
                  multiline={key === "gmarket_auction"}
                  placeholder="예: 14672"
                />
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">판매수량</label>
                  <input
                    type="number"
                    value={platformConfigs[key].sale_quantity}
                    onChange={(e) => handlePlatformChange(key, "sale_quantity", Number(e.target.value) || 0)}
                    className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 상품정보제공고시 설정 */}
      <div>
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">상품정보제공고시 (상품분류코드별)</h3>
        <div className="space-y-2">
          {PLAYAUTO_SCHEMAS.map((schema) => {
            const isExpanded = expandedSchema === schema.code;
            const values = noticeConfigs[schema.code] || [];
            const allDefault = values.every((v) => v === "상세페이지 참조");

            return (
              <div key={schema.code} className="border border-[var(--border)] rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedSchema(isExpanded ? null : schema.code)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />}
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {schema.code} — {schema.name}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">{schema.fields.length}개 항목</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {!allDefault && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">수정됨</span>}
                  </div>
                </button>
                {isExpanded && (
                  <div className="border-t border-[var(--border)] p-4 space-y-2">
                    <div className="flex justify-end mb-2">
                      <button
                        onClick={() => handleResetNotice(schema.code)}
                        className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        전체 초기화
                      </button>
                    </div>
                    {schema.fields.map((fieldName, idx) => (
                      <div key={idx} className="flex items-center gap-3">
                        <span className="w-5 text-xs text-[var(--text-disabled)] text-right shrink-0">{idx + 1}</span>
                        <span className="text-xs text-[var(--text-muted)] w-64 shrink-0 truncate" title={fieldName}>{fieldName}</span>
                        <input
                          type="text"
                          value={values[idx] ?? "상세페이지 참조"}
                          onChange={(e) => handleNoticeChange(schema.code, idx, e.target.value)}
                          className="flex-1 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, multiline, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-[var(--text-muted)] mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50 resize-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        />
      )}
    </div>
  );
}
