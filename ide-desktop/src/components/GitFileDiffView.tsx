import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, ExternalLink, FileDiff, Loader2, RefreshCw } from 'lucide-react';
import { desktop, type GitFileDiffResult } from '../lib/ipc';
import { countDiffRows, parseUnifiedDiff } from '../lib/gitDiffParse';

export function GitFileDiffView({ workspaceRoot, path, staged = false, commitRef, compact = false, onBack, onOpenFile, onStageChange }: {
  workspaceRoot: string;
  path: string;
  staged?: boolean;
  commitRef?: string;
  compact?: boolean;
  onBack?: () => void;
  onOpenFile?: (path: string, line?: number) => void;
  onStageChange?: (staged: boolean) => void;
}) {
  const [revision, setRevision] = useState(0);
  const requestKey = JSON.stringify([workspaceRoot, path, staged, commitRef, revision]);
  const [response, setResponse] = useState<{ key: string; data?: GitFileDiffResult; error?: string }>({ key: '' });
  const [shown, setShown] = useState({ key: '', limit: 400 });
  const [wrap, setWrap] = useState(true);
  const current = response.key === requestKey;
  const loading = !current;
  const data = current ? response.data : undefined;
  const error = current ? response.error : undefined;
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => cancelled ? null : desktop.git.fileDiff(path, staged, commitRef)).then((result) => {
      if (cancelled) return;
      if (!result) throw new Error('未收到文件差异结果');
      setResponse(result.ok ? { key: requestKey, data: result } : { key: requestKey, error: result.error || '无法读取文件差异' });
    }).catch((failure) => {
      if (!cancelled) setResponse({ key: requestKey, error: failure instanceof Error ? failure.message : String(failure) });
    });
    return () => { cancelled = true; };
  }, [requestKey, path, staged, commitRef, workspaceRoot]);

  const hunks = useMemo(() => parseUnifiedDiff(data?.diff ?? ''), [data?.diff]);
  const totals = useMemo(() => countDiffRows(hunks), [hunks]);
  const totalRows = hunks.reduce((count, hunk) => count + hunk.rows.length, 0);
  const limit = shown.key === requestKey ? shown.limit : 400;
  let remaining = limit;
  const visible = hunks.flatMap((hunk) => {
    if (remaining <= 0) return [];
    const rows = hunk.rows.slice(0, remaining);
    remaining -= rows.length;
    return [{ ...hunk, rows }];
  });
  const normalizedPath = path.replace(/\\/g, '/');
  const separator = normalizedPath.lastIndexOf('/');
  const fileName = normalizedPath.slice(separator + 1);
  const directory = separator < 0 ? '项目根目录' : normalizedPath.slice(0, separator);
  const deleted = data?.diff?.split(/\r?\n/).includes('+++ /dev/null') ?? false;
  const binary = data?.binary || /^(Binary files .* differ|GIT binary patch)$/m.test(data?.diff ?? '');
  const rawMetadata = !binary && hunks.length === 0 && Boolean(data?.diff?.trim());
  const openPath = data?.workspacePath ?? path;
  const retry = () => setRevision((value) => value + 1);

  return <section className={`git-file-diff${compact ? ' compact' : ''}${wrap ? ' wrap' : ''}`} aria-label={`${fileName} 文件差异`} aria-busy={loading}
    onKeyDown={(event) => {
      if (onBack && event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); onBack();
      }
    }}>
    <header className="git-file-diff-header">
      {onBack && <button type="button" autoFocus className="gtx-btn ghost git-diff-back" onClick={onBack}><ArrowLeft size={14} />返回更改</button>}
      <div className="git-file-diff-heading"><strong>{fileName}</strong><span title={path}>{directory}</span></div>
      <div className="git-file-diff-actions">
        <button type="button" className="icon-button" title="刷新文件差异" aria-label="刷新文件差异" disabled={loading} onClick={retry}><RefreshCw size={15} className={loading ? 'spin' : undefined} /></button>
        {onOpenFile && !deleted && !data?.outsideWorkspace && <button type="button" className="gtx-btn" disabled={loading || Boolean(error)} onClick={() => onOpenFile(openPath)}><ExternalLink size={14} />打开文件</button>}
      </div>
    </header>
    <div className="git-file-diff-toolbar">
      {!commitRef && onStageChange ? <div className="git-diff-source" role="group" aria-label="差异来源">
        <button type="button" aria-pressed={!staged} onClick={() => onStageChange(false)}>工作区</button>
        <button type="button" aria-pressed={staged} onClick={() => onStageChange(true)}>已暂存</button>
      </div> : <span className="git-diff-origin">{commitRef ? `提交 ${commitRef.slice(0, 7)}` : staged ? '已暂存' : '工作区'}</span>}
      {data?.untracked && <span className="git-diff-badge">新文件</span>}
      {deleted && <span className="git-diff-badge">文件已删除</span>}
      {data?.originalPath && <span className="git-diff-badge" title={`原路径：${data.originalPath}`}>重命名</span>}
      {!loading && !error && hunks.length > 0 && !binary && <span className="git-diff-stats"><span>+{totals.added}</span><span>−{totals.removed}</span></span>}
      <button type="button" className="git-diff-wrap" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>自动换行</button>
    </div>
    {loading && <div className="git-diff-empty" role="status"><Loader2 size={21} className="spin" /><strong>正在读取差异…</strong></div>}
    {error && <div className="git-diff-error" role="alert"><AlertCircle size={18} /><div><strong>差异读取失败</strong><p>{error}</p></div><button type="button" className="gtx-btn" onClick={retry}>重试</button></div>}
    {data?.truncated && <div className="git-diff-notice" role="status"><AlertCircle size={15} /><span>内容超过预览范围，当前仅显示部分差异。可打开文件查看完整内容。</span></div>}
    {data?.outsideWorkspace && <div className="git-diff-notice" role="status"><AlertCircle size={15} /><span>此文件位于当前工作区之外。可查看差异，请切换工作区后再打开文件。</span></div>}
    {!loading && !error && binary && <div className="git-diff-empty"><FileDiff size={26} /><strong>二进制文件已更改</strong><span>此文件不提供文本逐行差异。</span></div>}
    {!loading && !error && !binary && !rawMetadata && hunks.length === 0 && <div className="git-diff-empty"><FileDiff size={26} />
      <strong>{data?.truncated ? '文件过大，未加载文本差异' : data?.untracked ? '新文件为空' : '当前没有文本差异'}</strong>
      <span>{data?.truncated ? '文件内容保持不变，可单独打开查看。' : data?.untracked ? '该空文件尚未加入 Git。' : staged ? '此文件当前没有已暂存的文本更改。' : '工作区内容与暂存区一致，或更改已由其他操作处理。'}</span>
    </div>}
    {!loading && !error && rawMetadata && <div className="git-diff-metadata"><strong>文件属性或特殊差异</strong><pre>{data?.diff}</pre></div>}
    {!loading && !error && !binary && hunks.length > 0 && <div className="git-diff-scroll" tabIndex={0} aria-label="文件差异内容">
      <table className="git-diff-table"><colgroup><col className="git-diff-number-column" /><col className="git-diff-number-column" /><col className="git-diff-marker-column" /><col /></colgroup>
        <thead><tr><th scope="col">原行</th><th scope="col">现行</th><th scope="col">±</th><th scope="col">代码</th></tr></thead>
        {visible.map((hunk, hunkIndex) => <tbody key={hunkIndex}>
          <tr className="git-diff-hunk"><td colSpan={4}>{hunk.header}</td></tr>
          {hunk.rows.map((row, rowIndex) => <tr key={rowIndex} className={`git-diff-row ${row.kind}`}>
            <td className="git-diff-line-number">{row.oldLine ?? ''}</td>
            <td className="git-diff-line-number">{onOpenFile && row.newLine !== undefined && !deleted && !data?.outsideWorkspace
              ? <button type="button" className="git-diff-line-link" data-line={row.newLine} aria-label={`在第 ${row.newLine} 行打开 ${fileName}`} onClick={() => onOpenFile(openPath, row.newLine)}>{row.newLine}</button>
              : row.newLine ?? ''}</td>
            <td className="git-diff-marker" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</td>
            <td className="git-diff-code"><code>{row.text || ' '}</code></td>
          </tr>)}
        </tbody>)}
      </table>
    </div>}
    {!loading && !error && totalRows > limit && <div className="git-diff-more"><span>已显示 {limit} / {totalRows} 行</span><button type="button" className="gtx-btn" onClick={() => setShown({ key: requestKey, limit: limit + 400 })}>显示更多</button></div>}
  </section>;
}
