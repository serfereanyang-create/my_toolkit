import { useEffect, useState } from 'react';
import { Check, Coins, TriangleAlert } from 'lucide-react';
import { desktop } from '../../lib/ipc';
import type { DispatchOption, DispatchTierInfo } from '../../lib/ipc';

type Status = {
  ok: boolean;
  configured: boolean;
  tiers?: { expensive: DispatchTierInfo; cheap: DispatchTierInfo };
  error?: string;
};

type Draft = { expensive: string; cheap: string };

/**
 * One tier row: what the tier is for, which model fills it, and whether that
 * choice is actually usable. The role text sits next to the picker instead of
 * below it — "贵档" alone says nothing about what the model will be asked to do.
 */
function TierField({ tone, role, hint, value, options, onChange }: {
  tone: 'expensive' | 'cheap';
  role: string;
  hint: string;
  value: string;
  /** "provider/model" pairs — the provider is shown so the same model served
      by two vendors is distinguishable. */
  options: Array<{ value: string; label: string }>;
  onChange: (next: string) => void;
}) {
  return (
    <div className={`dispatch-field tone-${tone}`}>
      <div className="dispatch-field-head">
        <span className="dispatch-field-badge">{role}</span>
        <span className="dispatch-field-hint">{hint}</span>
      </div>
      <select
        className="dispatch-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">（未设置 — 该档会回落到当前模型）</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

/** One-line summary of what a tier currently resolves to. */
function TierStatusLine({ label, tier }: { label: string; tier?: DispatchTierInfo }) {
  if (!tier) return null;
  return (
    <div className="dispatch-status-line">
      <span className={`dispatch-status-dot ${tier.hasKey ? 'ok' : 'warn'}`} />
      <span className="dispatch-status-label">{label}</span>
      <span className="dispatch-status-model">{tier.model}</span>
      <span className="dispatch-status-provider">{tier.provider}</span>
      {!tier.hasKey && (
        <span className="dispatch-tier-warn" title="该提供商没有 API key，派发会认证失败">
          <TriangleAlert size={12} /> 无密钥
        </span>
      )}
    </div>
  );
}

/**
 * 省钱分级 settings panel.
 *
 * Layout answers three questions in order, because the previous version left
 * users staring at two bare dropdowns: WHAT this feature does, WHICH two
 * models it uses, and WHETHER the current session is already running on it.
 */
export function DispatchSettings({ sessionId, providers, dispatchDefault, onSaveDefault }: {
  sessionId?: string;
  providers?: Array<{ id: string; label: string; models?: Array<{ id: string }>; model?: string }>;
  dispatchDefault?: { expensive?: string; cheap?: string };
  onSaveDefault?: (next: { expensive?: string; cheap?: string }) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState({ expensive: dispatchDefault?.expensive ?? '', cheap: dispatchDefault?.cheap ?? '' });
  const [saved, setSaved] = useState(false);

  const [options, setOptions] = useState<DispatchOption[]>([]);

  useEffect(() => {
    let alive = true;
    void desktop.dispatch.status(sessionId).then((next) => { if (alive) setStatus(next); });
    return () => { alive = false; };
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    void desktop.dispatch.options().then((next) => {
      if (alive && next.ok && next.options) setOptions(next.options);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setDraft({ expensive: dispatchDefault?.expensive ?? '', cheap: dispatchDefault?.cheap ?? '' });
  }, [dispatchDefault?.expensive, dispatchDefault?.cheap]);

  // Options come from the CLI resolver, not the desktop provider list: the
  // two are separate stores (desktop labels like 新供应商 do not match the v2
  // config names the dispatch resolves against), and only the v2 side knows
  // which entries actually carry credentials.
  const modelOptions = options.map((o) => ({ value: o.value, label: o.hasKey ? o.label : `${o.label}（无密钥）` }));
  const dirty = draft.expensive !== (dispatchDefault?.expensive ?? '')
    || draft.cheap !== (dispatchDefault?.cheap ?? '');
  const bothPicked = Boolean(draft.expensive && draft.cheap);
  const sameModel = Boolean(draft.expensive && draft.expensive === draft.cheap);
  return (
    <div className="dispatch-panel">
      <p className="dispatch-intro">
        把任务按难度分给两个模型：<strong>贵档</strong>只做方案与终审裁决，
        <strong>便宜档</strong>承担实现、写文档和排查。机械活不再烧贵模型的额度。
      </p>

      <div className="dispatch-tiers">
        <TierField
          role="贵档" tone="expensive" value={draft.expensive} options={modelOptions}
          hint="出方案、做终审。用量少但要求判断力。" onChange={(v) => { setDraft((d) => ({ ...d, expensive: v })); setSaved(false); }}
        />
        <TierField
          role="便宜档" tone="cheap" value={draft.cheap} options={modelOptions}
          hint="写代码、跑排查。用量大但要求低。" onChange={(v) => { setDraft((d) => ({ ...d, cheap: v })); setSaved(false); }}
        />
      </div>

      {sameModel && (
        <div className="dispatch-error">两档选了同一个模型，分级就没有意义了 —— 请换一个。</div>
      )}

      <div className="dispatch-actions">
        <button
          type="button"
          className="dispatch-save"
          disabled={!onSaveDefault || !dirty || !bothPicked || sameModel}
          onClick={() => { onSaveDefault?.({ expensive: draft.expensive || undefined, cheap: draft.cheap || undefined }); setSaved(true); }}
        >
          {saved && !dirty ? '已保存' : '保存为全局默认'}
        </button>
        <span className="dispatch-actions-hint">
          {bothPicked
            ? '保存后，新会话默认用这套分级；当前会话可用 /省钱分级 覆盖。'
            : '两个档位都选好才能保存。'}
        </span>
      </div>

      <div className="dispatch-live">
        <div className="dispatch-live-title">
          {status?.configured ? (
            <><Check size={13} /> 当前会话生效中</>
          ) : (
            <><Coins size={13} /> 当前会话还没启用分级</>
          )}
        </div>
        {status?.configured && status.tiers ? (
          <div className="dispatch-live-rows">
            <TierStatusLine label="贵档" tier={status.tiers.expensive} />
            <TierStatusLine label="便宜档" tier={status.tiers.cheap} />
          </div>
        ) : (
          <div className="dispatch-live-hint">
            在对话里发一条任务，并用 <code>/省钱分级</code> 指定档位即可启用；
            或直接保存上面的全局默认，新会话自动生效。
          </div>
        )}
      </div>
    </div>
  );
}

