import { FileText, FileSpreadsheet, FileType2, Folder, Globe, LayoutGrid, MessageSquare, PanelRight, Presentation, TerminalSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  ARTIFACT_LEGACY_NOTE,
  NEW_TAB_SHORTCUTS,
  type ArtifactPluginId,
  type ArtifactTile,
  type NewTabAction,
} from '../lib/newTab';

/**
 * 新标签页 —— 侧边栏里的入口页。
 *
 * 它不做任何自己的状态：每一项都直接落到 App 已有的能力上（文件树、浏览器
 * 面板、底部终端、源代码管理、侧聊），工件格则走插件注册表 + 系统选择框 +
 * 预览面板。所以这一页需要证明的不是「有按钮」，而是「按钮按下去真的发生
 * 了那件事」——本组件只负责把动作标识（`data-newtab-action` /
 * `data-newtab-artifact`）与禁用状态渲染对，动作到能力的映射在 App 里，
 * 由 `NewTabPage.test.tsx` 断言标记契约、`scripts/app-smoke.cjs` 跑真窗口。
 */

const SHORTCUT_ICONS: Record<NewTabAction, ReactNode> = {
  files: <Folder size={18} />,
  browser: <Globe size={18} />,
  terminal: <TerminalSquare size={18} />,
  review: <PanelRight size={18} />,
  sidechat: <MessageSquare size={18} />,
};

const ARTIFACT_ICONS: Record<ArtifactPluginId, ReactNode> = {
  pdf: <FileType2 size={20} />,
  presentations: <Presentation size={20} />,
  spreadsheets: <FileSpreadsheet size={20} />,
  documents: <FileText size={20} />,
};

/** 每个工件格的点缀色，和插件菜单里同 id 的图标色一致。 */
const ARTIFACT_TINT: Record<ArtifactPluginId, string> = {
  pdf: '#e05a4a',
  presentations: '#e8a13a',
  spreadsheets: '#3aa675',
  documents: '#4b83f0',
};

export type NewTabPageProps = {
  /** 工件格来自插件注册表，由 App 拉取；关闭的插件不出现。 */
  artifacts: ArtifactTile[];
  onShortcut: (action: NewTabAction) => void;
  onOpenArtifact: (id: ArtifactPluginId) => void;
  onOpenAllPlugins: () => void;
  /** 没有工作区时工件格无法打开（预览围栏按工作区解析）。 */
  workspaceReady: boolean;
};

export function NewTabPage({ artifacts, onShortcut, onOpenArtifact, onOpenAllPlugins, workspaceReady }: NewTabPageProps) {
  return (
    <div className="newtab-page" aria-labelledby="newtab-title">
      <h2 id="newtab-title" className="newtab-title">新标签页</h2>

      <section className="newtab-group" aria-label="打开">
        <div className="newtab-grid">
          {NEW_TAB_SHORTCUTS.map((item) => (
            <div key={item.action} className="newtab-cell">
              <span className="newtab-cell-icon" aria-hidden="true">{SHORTCUT_ICONS[item.action]}</span>
              <span className="newtab-cell-copy">
                <span className="newtab-cell-title">{item.title}</span>
                <span className="newtab-cell-desc">{item.desc}</span>
              </span>
              <button
                type="button"
                className="newtab-open"
                data-newtab-action={item.action}
                onClick={() => onShortcut(item.action)}
              >打开</button>
            </div>
          ))}
        </div>
      </section>

      <div className="newtab-divider" aria-hidden="true" />

      <section className="newtab-group" aria-label="应用插件">
        <div className="newtab-head">
          <h3 className="newtab-heading">应用插件</h3>
          <button type="button" className="newtab-more" onClick={onOpenAllPlugins}>
            查看所有插件<span aria-hidden="true"> ›</span>
          </button>
        </div>
        <div className="newtab-grid">
          {artifacts.map((tile) => {
            const blocked = !workspaceReady || !tile.available;
            const hint = !workspaceReady
              ? '先打开一个工作区，文档才能预览'
              : tile.available ? ARTIFACT_LEGACY_NOTE[tile.id] ?? tile.desc : tile.reason ?? '该插件在当前环境不可用';
            return (
              <div key={tile.id} className="newtab-cell newtab-cell-plugin">
                <span
                  className="newtab-plugin-icon"
                  style={{ color: ARTIFACT_TINT[tile.id], background: `color-mix(in srgb, ${ARTIFACT_TINT[tile.id]} 14%, transparent)` }}
                  aria-hidden="true"
                >{ARTIFACT_ICONS[tile.id]}</span>
                <span className="newtab-cell-copy">
                  <span className="newtab-cell-title">{tile.name}</span>
                  <span className="newtab-cell-desc" title={hint}>{tile.desc}</span>
                </span>
                <button
                  type="button"
                  className="newtab-open"
                  data-newtab-artifact={tile.id}
                  disabled={blocked}
                  title={hint}
                  onClick={() => onOpenArtifact(tile.id)}
                >打开</button>
              </div>
            );
          })}
          {artifacts.length === 0 && (
            <div className="newtab-empty">
              <span className="newtab-cell-icon" aria-hidden="true"><LayoutGrid size={18} /></span>
              <span className="newtab-cell-copy">
                <span className="newtab-cell-title">还没有启用的文档插件</span>
                <span className="newtab-cell-desc">在设置 → 插件里启用 PDF / 演示文稿 / 电子表格 / Word</span>
              </span>
              <button type="button" className="newtab-open" onClick={onOpenAllPlugins}>去设置</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
