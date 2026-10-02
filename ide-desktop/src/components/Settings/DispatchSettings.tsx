import { useEffect, useState } from 'react';
import { ArrowRight, Coins, TriangleAlert } from 'lucide-react';
import { desktop } from '../../lib/ipc';
import type { DispatchTierInfo } from '../../lib/ipc';

type Status = {
  ok: boolean;
  configured: boolean;
  tiers?: { expensive: DispatchTierInfo; cheap: DispatchTierInfo };
  error?: string;
};

/** One tier card: which provider/model the tier resolves to right now. */
function TierCard({ label, hint, tier }: { label: string; hint: string; tier: DispatchTierInfo }) {
  return (
    <div className="dispatch-tier">
      <div className="dispatch-tier-head">
        <span className="dispatch-tier-label">{label}</span>
        {!tier.hasKey ? (
          <span className="dispatch-tier-warn" title="该提供商没有 API key，派发会认证失败">
            <TriangleAlert size={13} /> 无密钥
          </span>
        ) : null}
      </div>
      <div className="dispatch-tier-model">{tier.model}</div>
      <div className="dispatch-tier-meta">
        {tier.provider}
        {tier.contextWindow ? ` · 上下文 ${Math.round(tier.contextWindow / 1000)}k` : ''}
      </div>
      <div className="dispatch-tier-hint">{hint}</div>
    </div>
  );
}

/**
 * 省钱分级 settings panel. Read-only over the CLI's session state: the
 * selection lives in the session record and is set with /省钱分级, so the
 * panel reports what the next dispatch will actually do rather than keeping a
 * second copy that could disagree.
 */
export function DispatchSettings({ sessionId, providers, dispatchDefault, onSaveDefault }: {
  sessionId?: string;
  /** Providers + their models, so the pickers offer what actually exists. */
  providers?: Array<{ id: string; label: string; models?: Array<{ id: string }>; model?: string }>;
  /** Current global default (settings.preferences.dispatchDefault). */
  dispatchDefault?: { expensive?: string; cheap?: string };
  /** Persist the global default; the parent owns settings writes. */
  onSaveDefault?: (next: { expensive?: string; cheap?: string }) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<{ expensive: string; cheap: string }>({
    expensive: dispatchDefault?.expensive ?? '',
    cheap: dispatchDefault?.cheap ?? '',
  });
  const [saved, setSaved] = useState(false);

  // Every model the configured providers expose, de-duplicated by name: the
  // same model can be listed under several providers, and the global default
  // stores names (credentials are resolved at dispatch time).
  const modelOptions = Array.from(new Set(
    (providers ?? []).flatMap((provider) => (
      provider.models?.length ? provider.models.map((m) => m.id) : (provider.model ? [provider.model] : [])
    )),
  )).sort();

  useEffect(() => {
    let alive = true;
    void desktop.dispatch.status(sessionId).then((next) => {
      if (alive) setStatus(next);
    });
    return () => { alive = false; };
  }, [sessionId]);

  if (!status) return <div className="dispatch-panel">正在读取分级配置…</div>;

  return (
    <div className="dispatch-panel">
      {/* Editable pickers: choosing two models here writes the GLOBAL default,
          which new sessions inherit. A session can still override with
          /省钱分级. */}
      <div className="dispatch-edit">
        <label className="dispatch-field">
          <span className="dispatch-field-label">贵档模型</span>
          <select
            className="dispatch-select"
            value={draft.expensive}
            onChange={(event) => setDraft((d) => ({ ...d, expensive: event.target.value }))}
          >
            <option value="">（未设置）</option>
            {modelOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <span className="dispatch-field-hint">只出方案与终审裁决</span>
        </label>
        <label className="dispatch-field">
          <span className="dispatch-field-label">便宜档模型</span>
          <select
            className="dispatch-select"
            value={draft.cheap}
            onChange={(event) => setDraft((d) => ({ ...d, cheap: event.target.value }))}
          >
            <option value="">（未设置）</option>
            {modelOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <span className="dispatch-field-hint">承担实现、写文档与找 bug</span>
        </label>
        <button
          type="button"
          className="dispatch-save"
          disabled={!onSaveDefault || (!draft.expensive && !draft.cheap)}
          onClick={() => onSaveDefault?.({ expensive: draft.expensive || undefined, cheap: draft.cheap || undefined })}
        >
          保存为全局默认
        </button>
      </div>

      {status?.configured && status.tiers ? (
        <>
          <div className="dispatch-flow">
            <TierCard label="贵档" tier={status.tiers.expensive} hint="只出方案与终审裁决" />
            <ArrowRight size={16} className="dispatch-arrow" />
            <TierCard label="便宜档" tier={status.tiers.cheap} hint="承担实现、写文档与找 bug" />
          </div>
          <div className="dispatch-note">
            子任务派发时由 <code>spawn_subagent</code> 的 <code>tier</code> 指定档位；
            每次调用的模型与 token 都记入 <code>~/.aicode/dispatch.jsonl</code>。
          </div>
        </>
      ) : (
        <div className="dispatch-note">
          选好两个档位并保存后，新会话默认按这套分级派发；也可以随时在对话里用
          <code> /省钱分级 贵=&lt;模型&gt; 便宜=&lt;模型&gt; </code> 覆盖当前会话。
        </div>
      )}
    </div>
  );
}
