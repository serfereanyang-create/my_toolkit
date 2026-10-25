import { AlertTriangle, FolderOpen, LoaderCircle, Minimize2 } from 'lucide-react';
import {
  formatTokens,
  workspaceLabel,
  type ContextPanelModel,
  type OutputFile,
} from '../lib/contextSidebar';

/**
 * 侧栏底部的常驻面板：环境 / 上下文 / 输出。
 *
 * 「常驻」是刻意的：它没有折叠箭头、没有关闭按钮、不参与右栏那几个面板的
 * 开合互斥——那几块是「用的时候打开」，这一块是「一直看得见」。任何一项都
 * 不自己造数，全部由 `buildContextPanel` / `sessionOutputs` 从真实数据算好传进来。
 */
export type ContextSidebarProps = {
  panel: ContextPanelModel;
  outputs: OutputFile[];
  workspaceRoot: string;
  recentWorkspaces: string[];
  compacting: boolean;
  onCompact: () => void;
  onOpenFile: (path: string) => void;
  onOpenWorkspace: () => void;
  onSwitchWorkspace: (root: string) => void;
};

function percentLabel(percent: number | null): string {
  return percent === null ? '—' : `${percent}%`;
}

export function ContextSidebar({
  panel,
  outputs,
  workspaceRoot,
  recentWorkspaces,
  compacting,
  onCompact,
  onOpenFile,
  onOpenWorkspace,
  onSwitchWorkspace,
}: ContextSidebarProps) {
  const others = recentWorkspaces.filter((root) => root !== workspaceRoot).slice(0, 3);
  const hasContext = panel.used > 0;

  return (
    <aside className="context-sidebar" aria-label="环境与上下文">
      <section className="context-sec" aria-label="环境">
        <div className="context-sec-head"><span>环境</span></div>
        <ul className="context-env">
          <li>
            <button
              type="button"
              className="context-env-row"
              data-env-current={workspaceRoot}
              title={workspaceRoot || '还没有打开工作区'}
              onClick={onOpenWorkspace}
            >
              <FolderOpen size={14} />
              <span className="context-env-name">{workspaceRoot ? workspaceLabel(workspaceRoot) : '未打开工作区'}</span>
            </button>
          </li>
          {others.map((root) => (
            <li key={root}>
              <button
                type="button"
                className="context-env-row context-env-recent"
                data-env-recent={root}
                title={root}
                onClick={() => onSwitchWorkspace(root)}
              >
                <FolderOpen size={14} />
                <span className="context-env-name">{workspaceLabel(root)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="context-sec" aria-label="上下文">
        <div className="context-sec-head">
          <span>上下文</span>
          <span className="context-used" data-context-percent={panel.percent ?? ''}>{percentLabel(panel.percent)}</span>
        </div>

        <div className="context-meter" role="img" aria-label={hasContext ? '上下文占用分布' : '暂无上下文数据'}>
          {panel.segments.map((segment) => (
            <span
              key={segment.key}
              className="context-meter-seg"
              data-context-segment={segment.key}
              style={{ width: `${panel.window ? (segment.tokens / panel.window) * 100 : 0}%`, background: segment.color }}
              title={`${segment.label} ${formatTokens(segment.tokens)}`}
            />
          ))}
        </div>

        <div className="context-figures">
          <span data-context-used={panel.used}>{formatTokens(panel.used)}</span>
          <span className="context-figures-sep">/</span>
          <span data-context-window={panel.window ?? ''}>{panel.window === null ? '窗口未知' : formatTokens(panel.window)}</span>
        </div>

        {panel.segments.length > 0 ? (
          <ul className="context-legend">
            {panel.segments.map((segment) => (
              <li key={segment.key} data-context-legend={segment.key}>
                <span className="context-swatch" style={{ background: segment.color }} aria-hidden="true" />
                <span className="context-legend-label">{segment.label}</span>
                <span className="context-legend-tokens">{formatTokens(segment.tokens)}</span>
                <span className="context-legend-pct">{percentLabel(segment.percent)}</span>
              </li>
            ))}
            {panel.buffer !== null && (
              <li data-context-legend="buffer">
                <span className="context-swatch context-swatch-muted" aria-hidden="true" />
                <span className="context-legend-label">自动压缩余量</span>
                <span className="context-legend-tokens">{formatTokens(panel.buffer)}</span>
                <span className="context-legend-pct">
                  {percentLabel(panel.window ? Math.round((panel.buffer / panel.window) * 1000) / 10 : null)}
                </span>
              </li>
            )}
            {panel.free !== null && (
              <li data-context-legend="free">
                <span className="context-swatch context-swatch-empty" aria-hidden="true" />
                <span className="context-legend-label">剩余空间</span>
                <span className="context-legend-tokens">{formatTokens(panel.free)}</span>
                <span className="context-legend-pct">
                  {percentLabel(panel.window ? Math.round((panel.free / panel.window) * 1000) / 10 : null)}
                </span>
              </li>
            )}
          </ul>
        ) : (
          <p className="context-empty">这个会话还没有跑过模型调用，暂时没有可显示的占用。</p>
        )}

        <div className="context-actions">
          {/* 压缩阈值是 CLI 报的；没报就说明拿不到，不编一个「还剩 84k」。 */}
          <span className="context-until" data-context-until={panel.untilCompact ?? ''}>
            {panel.untilCompact === null ? '—' : `${formatTokens(panel.untilCompact)} 后自动压缩`}
          </span>
          <button
            type="button"
            className="context-compact"
            data-context-compact
            onClick={onCompact}
            disabled={compacting || !hasContext}
            title={hasContext ? '把较早的对话压成一份摘要（真实执行 /compact）' : '还没有可压缩的内容'}
          >
            {compacting ? <LoaderCircle size={13} className="spin" /> : <Minimize2 size={13} />}
            压缩
          </button>
        </div>
      </section>

      <section className="context-sec" aria-label="输出">
        <div className="context-sec-head">
          <span>输出</span>
          <span className="context-count" data-context-output-count={outputs.length}>{outputs.length || ''}</span>
        </div>
        {outputs.length > 0 ? (
          <ul className="context-outputs">
            {outputs.slice(0, 8).map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="context-output-row"
                  data-output-path={file.path}
                  title={file.path}
                  onClick={() => onOpenFile(file.path)}
                >
                  <span className="context-output-name">{workspaceLabel(file.path)}</span>
                  <span className="context-output-dir">{file.path.slice(0, Math.max(0, file.path.length - workspaceLabel(file.path).length - 1))}</span>
                  <span className="context-output-diff">
                    <span className="context-add">+{file.added}</span>
                    <span className="context-del">-{file.removed}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="context-empty">本会话还没有改动过文件。</p>
        )}
        {outputs.length > 8 && (
          <p className="context-more" data-context-output-more>另有 {outputs.length - 8} 个文件</p>
        )}
      </section>

      {panel.percent !== null && panel.percent >= 90 && (
        <p className="context-warn" data-context-warn>
          <AlertTriangle size={13} /> 已超过自动压缩阈值
        </p>
      )}
    </aside>
  );
}
