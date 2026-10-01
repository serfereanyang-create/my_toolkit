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
export function DispatchSettings({ sessionId }: { sessionId?: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    void desktop.dispatch.status(sessionId).then((next) => {
      if (alive) setStatus(next);
    });
    return () => { alive = false; };
  }, [sessionId]);

  if (!status) return <div className="dispatch-panel">正在读取分级配置…</div>;

  if (!status.configured || !status.tiers) {    return (
      <div className="dispatch-panel">
        <div className="dispatch-empty">
          <Coins size={16} />
          <div>
            <div className="dispatch-empty-title">本会话尚未配置分级调度</div>
            <div className="dispatch-empty-hint">
              在对话里输入 <code>/省钱分级 贵=&lt;模型&gt; 便宜=&lt;模型&gt;</code> 即可启用。
              贵档只做方案与裁决，便宜档承担实现与排查。
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dispatch-panel">
      <div className="dispatch-flow">
        <TierCard label="贵档" tier={status.tiers.expensive} hint="只出方案与终审裁决" />
        <ArrowRight size={16} className="dispatch-arrow" />
        <TierCard label="便宜档" tier={status.tiers.cheap} hint="承担实现、写文档与找 bug" />
      </div>
      <div className="dispatch-note">
        子任务派发时由 <code>spawn_subagent</code> 的 <code>tier</code> 指定档位；
        每次调用的模型与 token 都记入 <code>~/.aicode/dispatch.jsonl</code>。
      </div>
    </div>
  );
}
