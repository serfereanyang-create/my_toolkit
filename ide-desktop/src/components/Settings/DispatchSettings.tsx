import { useEffect, useMemo, useState } from 'react';
import { Check, Coins, Search, TriangleAlert } from 'lucide-react';
import { desktop } from '../../lib/ipc';
import type { DispatchOption } from '../../lib/ipc';

/** Tier order matches the CLI router: capability descending. */
const TIERS = [
  { id: 'expensive', label: '贵档', hint: '出方案、做终审' },
  { id: 'standard', label: '中档', hint: '普通功能开发' },
  { id: 'cheap', label: '便宜档', hint: '写代码、跑排查' },
] as const;

type TierId = typeof TIERS[number]['id'];

/** tier -> ordered chain of option values; first entry is the primary. */
export type DispatchDraft = Partial<Record<TierId, string[]>>;

/** Accept the legacy single-string form and normalise to arrays. */
export function normalizeDraft(raw?: Record<string, unknown> | null): DispatchDraft {
  const out: DispatchDraft = {};
  for (const { id } of TIERS) {
    const value = raw?.[id];
    if (Array.isArray(value)) out[id] = value.filter((v): v is string => typeof v === 'string');
    else if (typeof value === 'string') out[id] = [value];
  }
  return out;
}

export function DispatchSettings({ options: optionsProp, dispatchDefault, onSaveDefault }: {
  /** Pre-loaded options; the panel fetches them itself when omitted. */
  options?: DispatchOption[];
  dispatchDefault?: DispatchDraft;
  onSaveDefault?: (next: DispatchDraft) => void;
}) {
  const [draft, setDraft] = useState<DispatchDraft>(() => normalizeDraft(dispatchDefault));
  const [filter, setFilter] = useState('');
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState<DispatchOption[]>([]);
  // The pickable models come from the CLI resolver over IPC: the desktop's own
  // provider list uses different vendor names and would offer pairs the router
  // cannot resolve.
  const options = optionsProp ?? loaded;
  useEffect(() => {
    if (optionsProp) return;
    let alive = true;
    void desktop.dispatch.options().then((next) => {
      if (alive && next.ok && next.options) setLoaded(next.options);
    });
    return () => { alive = false; };
  }, [optionsProp]);

  useEffect(() => { setDraft(normalizeDraft(dispatchDefault)); }, [dispatchDefault]);

  const toggle = (tier: TierId, value: string) => {
    setSaved(false);
    setDraft((current) => {
      const chain = current[tier] ?? [];
      const next = chain.includes(value) ? chain.filter((v) => v !== value) : [...chain, value];
      return { ...current, [tier]: next };
    });
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, filter]);

  const dirty = TIERS.some(({ id }) => (draft[id] ?? []).join('|') !== (dispatchDefault?.[id] ?? []).join('|'));
  const anyPicked = TIERS.some(({ id }) => (draft[id] ?? []).length > 0);

  return (
    <div className="dispatch-panel">
      <p className="dispatch-intro">
        把任务按难度分给三档模型。每个模型可同时勾进多档；同一档勾多个时，
        <strong>第一个是主选，其余在限流/失败时按顺序降级</strong>。
      </p>
      <div className="dispatch-toolbar">
        <span className="dispatch-search">
          <Search size={14} />
          <input
            value={filter}
            placeholder="筛选模型或提供商…"
            onChange={(event) => setFilter(event.target.value)}
          />
        </span>
        <button
          type="button"
          className="dispatch-save"
          disabled={!onSaveDefault || !dirty || !anyPicked}
          onClick={() => { onSaveDefault?.(draft); setSaved(true); }}
        >
          {saved && !dirty ? '已保存' : '保存为全局默认'}
        </button>
      </div>
      <div className="dispatch-matrix">
        <div className="dispatch-row dispatch-row-head">
          <span className="dispatch-col-model">模型</span>
          {TIERS.map((tier) => (
            <span key={tier.id} className={`dispatch-col-tier tone-${tier.id}`}>
              <b>{tier.label}</b>
              <i>{tier.hint}</i>
            </span>
          ))}
        </div>
        {visible.map((option) => (
          <div key={option.value} className="dispatch-row">
            <span className="dispatch-col-model">
              <span className="dispatch-model-vendor">{option.providerName}</span>
              <span className="dispatch-model-name">{option.model}</span>
              {!option.hasKey && (
                <span className="dispatch-tier-warn" title="该提供商没有 API key，派发会认证失败">
                  <TriangleAlert size={12} />
                </span>
              )}
            </span>
            {TIERS.map((tier) => {
              const chain = draft[tier.id] ?? [];
              const index = chain.indexOf(option.value);
              return (
                <span key={tier.id} className={`dispatch-col-tier tone-${tier.id}`}>
                  <button
                    type="button"
                    className={`dispatch-check ${index >= 0 ? 'on' : ''}`}
                    title={index >= 0 ? `已是${tier.label}第 ${index + 1} 位（点击取消）` : `加入${tier.label}`}
                    onClick={() => toggle(tier.id, option.value)}
                  >
                    {index >= 0 ? (chain.length > 1 ? index + 1 : <Check size={13} />) : null}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
        {visible.length === 0 && <div className="dispatch-empty">没有匹配的模型</div>}
      </div>
      <div className="dispatch-note">
        <Coins size={13} />
        保存后新会话默认用这套分级；当前会话可在对话里用 <code>/省钱分级</code> 覆盖。
        每次调用的模型与 token 记入 <code>~/.aicode/dispatch.jsonl</code>。
      </div>
    </div>
  );
}
