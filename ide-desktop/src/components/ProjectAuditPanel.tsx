import { useEffect, useState } from 'react';
import { AlertTriangle, FolderTree, Play } from 'lucide-react';
import { desktop } from '../lib/ipc';
import { useQualityRevision } from '../lib/qualityRevision';

/*
 * ProjectAuditPanel — 项目结构健康审计（structure_audit）。
 * 只读扫描：超大文件/目录过深/命名混用/测试镜像断裂/空目录，
 * 经质量网关调用 CLI 的 structure_audit（read-only allowlist 内）。
 */

interface AuditIssue {
  kind: string;
  path: string;
  detail: string;
  severity: 1 | 2 | 3;
}

interface AuditReport {
  scannedFiles: number;
  scannedDirs: number;
  issues: AuditIssue[];
  byKind: Record<string, number>;
}

const KIND_LABEL: Record<string, string> = {
  'huge-file': '超大文件',
  'deep-dir': '目录过深',
  'crowded-dir': '目录过挤',
  'mixed-naming': '命名混用',
  'orphan-test': '测试镜像断裂',
  'empty-dir': '空目录',
};

export function ProjectAuditPanel() {
  const { current } = useQualityRevision(true);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await desktop.quality.invoke('structure_audit', {}, current?.label);
      if (!result.ok) {
        setError(result.error ?? '审计失败');
        return;
      }
      setReport((result.data ?? null) as AuditReport | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byKindEntries = report
    ? Object.entries(report.byKind).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <section className="audit-panel" aria-label="项目结构审计">
      <header className="audit-panel-head">
        <span className="audit-panel-icon"><FolderTree size={16} /></span>
        <div className="audit-panel-titles">
          <strong>结构健康</strong>
          <span>静态扫描目录结构、文件规模与测试镜像</span>
        </div>
        <button type="button" className="audit-panel-run" onClick={() => void run()} disabled={loading}>
          <Play size={13} />
          <span>{loading ? '扫描中…' : '重新审计'}</span>
        </button>
      </header>

      {error && (
        <div className="audit-panel-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {loading && !report && <p className="audit-panel-loading">正在扫描工作区结构…</p>}

      {report && !loading && !error && (
        <>
          <div className="audit-panel-stats">
            <div><strong>{report.scannedFiles}</strong><span>代码文件</span></div>
            <div><strong>{report.scannedDirs}</strong><span>目录</span></div>
            <div><strong>{report.issues.length}</strong><span>问题</span></div>
          </div>
          {report.issues.length === 0 ? (
            <div className="audit-panel-clean">✓ 结构健康，没有发现问题。</div>
          ) : (
            <ul className="audit-panel-groups">
              {byKindEntries.map(([kind, count]) => {
                const issues = report.issues.filter((i) => i.kind === kind);
                return (
                  <li key={kind} className="audit-panel-group">
                    <div className="audit-panel-group-head">
                      <span>{KIND_LABEL[kind] ?? kind}</span>
                      <em>{count}</em>
                    </div>
                    {issues.slice(0, 8).map((issue) => (
                      <div key={`${issue.kind}:${issue.path}:${issue.detail}`} className="audit-panel-row">
                        <span className={`audit-sev sev-${issue.severity}`}>{'★'.repeat(issue.severity)}</span>
                        <code title={issue.path}>{issue.path}</code>
                        <span className="audit-panel-row-detail">{issue.detail}</span>
                      </div>
                    ))}
                    {issues.length > 8 && (
                      <div className="audit-panel-more">…另有 {issues.length - 8} 条同类</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
