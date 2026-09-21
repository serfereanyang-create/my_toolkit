import { AlertTriangle, ChevronRight, ShieldAlert } from 'lucide-react';
import type { ReviewFinding } from '../types';

/*
 * Findings from an AI code review, grouped P0-P3.
 *
 * Shared by the transcript row and the 审查 tab so the two cannot disagree
 * about what a review said. The severity badge comes from the reviewer's own
 * numeric priority — a finding with none shows 未分级 rather than being
 * silently promoted or demoted into a bucket.
 */

const PRIORITY_ORDER = [0, 1, 2, 3] as const;

const PRIORITY_META: Record<number, { label: string; className: string; hint: string }> = {
  0: { label: 'P0', className: 'p0', hint: '阻断性问题，需立即处理' },
  1: { label: 'P1', className: 'p1', hint: '紧急，应在下个周期处理' },
  2: { label: 'P2', className: 'p2', hint: '普通，最终需要修复' },
  3: { label: 'P3', className: 'p3', hint: '低优先，锦上添花' },
};

/** The badge for one finding: its priority, or 未分级 when it has none. */
export function PriorityBadge({ priority }: { priority: number | undefined }) {
  if (priority === undefined || !Number.isFinite(priority)) {
    return <span className="review-finding-priority unrated" title="审查者没有给出优先级">未分级</span>;
  }
  const clamped = Math.max(0, Math.min(3, Math.trunc(priority)));
  const meta = PRIORITY_META[clamped]!;
  return <span className={`review-finding-priority ${meta.className}`} title={meta.hint}>{meta.label}</span>;
}

/** Group findings by priority, worst first, with unrated last. */
export function groupByPriority(findings: ReviewFinding[]): Array<{ key: string; priority: number | undefined; findings: ReviewFinding[] }> {
  const groups = PRIORITY_ORDER
    .map((priority) => ({ key: `p${priority}`, priority: priority as number | undefined, findings: findings.filter((f) => f.priority !== undefined && Math.trunc(f.priority) === priority) }))
    .filter((group) => group.findings.length > 0);
  const unrated = findings.filter((f) => f.priority === undefined);
  if (unrated.length > 0) groups.push({ key: 'unrated', priority: undefined, findings: unrated });
  return groups;
}

/** Where a finding points, as a display string. */
export function findingLocation(finding: ReviewFinding): string | undefined {
  if (!finding.filePath) return undefined;
  const file = finding.filePath.replace(/\\/g, '/');
  if (!finding.lineStart) return file;
  const end = finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : '';
  return `${file}:${finding.lineStart}${end}`;
}

export function FindingsList({
  findings,
  onOpenFile,
}: {
  findings: ReviewFinding[];
  onOpenFile?: (path: string, line?: number) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="review-findings">
      {groupByPriority(findings).map((group) => (
        <div key={group.key} className="review-finding-group">
          {group.findings.map((finding, index) => {
            const location = findingLocation(finding);
            const clickable = Boolean(location && finding.filePath && onOpenFile);
            return (
              <div key={`${group.key}-${index}`} className="review-finding">
                <div className="review-finding-head">
                  <PriorityBadge priority={finding.priority} />
                  <span className="review-finding-title">{finding.title}</span>
                  {finding.confidenceScore !== undefined && (
                    <span className="review-finding-confidence" title="审查者自评的置信度">
                      {Math.round(finding.confidenceScore * 100)}%
                    </span>
                  )}
                </div>
                {finding.body && <p className="review-finding-body">{finding.body}</p>}
                {location && (
                  clickable ? (
                    <button
                      type="button"
                      className="review-finding-location"
                      onClick={() => onOpenFile?.(finding.filePath!, finding.lineStart)}
                      title="在编辑器中打开"
                    >
                      <ChevronRight size={12} />
                      {location}
                    </button>
                  ) : (
                    <code className="review-finding-location static">{location}</code>
                  )
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * The whole review: verdict, findings, or the reason it could not be read.
 *
 * The three states are deliberately distinct. "未发现问题" is a claim about the
 * code; "审查未返回结构化结果" is a claim about the reviewer; "审查失败" is a
 * claim about the run. Collapsing them would let a broken review read as a
 * clean bill of health.
 */
export function ReviewReport({
  review,
  onOpenFile,
}: {
  review: { label: string; ok: boolean; error?: string; unparsed?: boolean; findings: ReviewFinding[]; outcome?: 'correct' | 'incorrect' | 'unknown'; explanation?: string; durationMs?: number };
  onOpenFile?: (path: string, line?: number) => void;
}) {
  if (!review.ok) {
    return (
      <div className="review-report failed" role="alert">
        <div className="review-report-head">
          <AlertTriangle size={14} />
          <strong>代码审查失败</strong>
          <span className="review-report-label">{review.label}</span>
        </div>
        <p className="review-report-error">{review.error ?? '没有返回原因。'}</p>
      </div>
    );
  }

  if (review.unparsed) {
    return (
      <div className="review-report unparsed">
        <div className="review-report-head">
          <ShieldAlert size={14} />
          <strong>审查未返回结构化结果</strong>
          <span className="review-report-label">{review.label}</span>
        </div>
        {/* Explicitly NOT "no findings": the reviewer ran and said something we
            could not read, which is a different fact about the change. */}
        <p className="review-report-note">审查已完成，但返回的内容不符合规定的输出格式，无法逐条呈现。完整回复已记入会话历史。</p>
      </div>
    );
  }

  const verdict = review.outcome === 'correct'
    ? { text: '补丁正确', className: 'correct' }
    : review.outcome === 'incorrect'
      ? { text: '补丁不正确', className: 'incorrect' }
      : { text: '未给出总体结论', className: 'unknown' };

  return (
    <div className="review-report">
      <div className="review-report-head">
        <strong>代码审查</strong>
        <span className="review-report-label">{review.label}</span>
        <span className={`review-verdict ${verdict.className}`}>{verdict.text}</span>
        {review.durationMs !== undefined && (
          <span className="review-report-duration">{(review.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      {review.explanation && <p className="review-report-explanation">{review.explanation}</p>}
      {review.findings.length === 0
        ? <p className="review-report-note">未发现问题。</p>
        : <FindingsList findings={review.findings} onOpenFile={onOpenFile} />}
    </div>
  );
}
