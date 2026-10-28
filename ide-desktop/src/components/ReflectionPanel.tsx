import { useEffect, useState } from 'react';
import { AlertTriangle, Brain, Clock, Lightbulb, Loader2, RefreshCw } from 'lucide-react';
import { desktop } from '../lib/ipc';
import { useQualityRevision } from '../lib/qualityRevision';

/*
 * ReflectionPanel — 失败教训（.aicode/reflections.json）浏览面板。
 * 数据通过质量网关只读调用 CLI 的 reflection_list；条目由智能体在
 * 任务终态失败时自动沉淀，相似任务开始前会被检索注入。
 */

interface ReflectionItem {
  id: string;
  topic: string;
  failure: string;
  lesson: string;
  kind: 'tool_failure' | 'max_steps' | 'exception' | 'cancelled' | 'manual';
  at: string;
  hits: number;
}

const KIND_LABEL: Record<ReflectionItem['kind'], string> = {
  tool_failure: '工具失败',
  max_steps: '步数耗尽',
  exception: '异常中断',
  cancelled: '用户取消',
  manual: '手动记录',
};

interface ReflectionListData {
  entries?: ReflectionItem[];
}

export function ReflectionPanel() {
  const { current } = useQualityRevision(true);
  const [entries, setEntries] = useState<ReflectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await desktop.quality.invoke('reflection_list', {}, current?.label);
      if (!result.ok) {
        setError(result.error ?? '教训读取失败');
        return;
      }
      const data = (result.data ?? {}) as ReflectionListData;
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="reflection-panel" aria-label="失败教训">
      <header className="reflection-panel-head">
        <span className="reflection-panel-icon"><Brain size={16} /></span>
        <div className="reflection-panel-titles">
          <strong>失败教训（Reflexions）</strong>
          <span>任务终态失败时自动沉淀；相似任务开始前会注入避坑</span>
        </div>
        <button type="button" className="reflection-panel-refresh" onClick={() => void refresh()} disabled={loading} title="重新加载">
          <RefreshCw size={14} className={loading ? 'reflection-panel-spin' : undefined} />
        </button>
      </header>

      {error && (
        <div className="reflection-panel-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" className="reflection-panel-retry" onClick={() => void refresh()} disabled={loading}>重试</button>
        </div>
      )}

      {loading && !error && entries.length === 0 && (
        <div className="reflection-panel-loading" role="status" aria-busy="true">
          <Loader2 size={15} className="reflection-panel-spin" />
          正在读取失败教训…
        </div>
      )}

      {!error && !loading && entries.length === 0 && (
        <div className="reflection-panel-empty">
          <Lightbulb size={22} />
          <p>还没有失败教训——这是好事。任务失败后这里会记录目标、现象与避坑建议。</p>
        </div>
      )}

      <ul className="reflection-panel-list">
        {entries.map((entry) => (
          <li key={entry.id} className="reflection-panel-item">
            <div className="reflection-panel-item-top">
              <span className={`reflection-chip kind-${entry.kind}`}>{KIND_LABEL[entry.kind]}</span>
              <span className="reflection-panel-item-topic" title={entry.topic}>{entry.topic}</span>
              <span className="reflection-panel-item-hits" title={`该教训被检索命中 ${entry.hits} 次`}>×{entry.hits}</span>
            </div>
            <p className="reflection-panel-item-failure">{entry.failure}</p>
            <p className="reflection-panel-item-lesson">
              <Lightbulb size={12} />
              {entry.lesson}
            </p>
            <div className="reflection-panel-item-foot">
              <Clock size={11} />
              <span>{entry.at.slice(0, 16).replace('T', ' ')}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
