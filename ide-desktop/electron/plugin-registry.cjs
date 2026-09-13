'use strict';
// Iteration 20 — plugin registry (main process).
//
// The single source of truth for which plugins exist and whether each one is
// usable in the current environment. The renderer owns presentation (icons,
// tints); this module owns capability metadata and availability detection so
// the settings page and the composer menu can never drift apart again.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Plugin catalog. `requires` gates availability:
 *   none      — always available
 *   workspace — needs an opened workspace root
 *   git       — needs a .git directory at the workspace root
 *   platform  — needs a specific OS (see `platforms`)
 */
const PLUGIN_CATALOG = [
  { id: 'documents', name: 'Documents', desc: '创建和编辑文档工件', category: 'artifacts', requires: 'none', route: null },
  { id: 'pdf', name: 'PDF', desc: '读取、创建和校验 PDF 文件', category: 'artifacts', requires: 'none', route: null },
  { id: 'spreadsheets', name: 'Spreadsheets', desc: '创建和编辑电子表格文件', category: 'artifacts', requires: 'none', route: null },
  { id: 'presentations', name: 'Presentations', desc: '创建和编辑演示文稿', category: 'artifacts', requires: 'none', route: null },
  { id: 'template', name: 'Template Creator', desc: '从参考内容创建或更新可复用模板', category: 'artifacts', requires: 'none', route: null },
  { id: 'browser', name: '浏览器', desc: '通过 YOYcode 控制应用内浏览器', category: 'tools', requires: 'none', route: 'browser' },
  { id: 'computer', name: '电脑', desc: '从 YOYcode 控制 Windows 应用', category: 'tools', requires: 'platform', platforms: ['win32'], route: null },
  { id: 'visualize', name: 'Visualize', desc: '将想法和数据转化为交互式可视化内容', category: 'artifacts', requires: 'none', route: null },
  { id: 'snippets', name: '片段库', desc: '可复用代码片段与 {{变量}} 模板', category: 'workflow', requires: 'none', route: 'snippets' },
  { id: 'bookmarks', name: '书签', desc: '行级书签、批注与跨文件跳转', category: 'workflow', requires: 'workspace', route: 'bookmarks' },
  { id: 'history', name: '保存历史', desc: '文件快照时间线与一键回滚', category: 'workflow', requires: 'workspace', route: 'history' },
  { id: 'census', name: '代码普查', desc: '语言占比、目录权重与 TODO 台账', category: 'insight', requires: 'workspace', route: 'stats' },
  { id: 'notes', name: '会话笔记', desc: '对话内速记，置顶与全文回看', category: 'workflow', requires: 'none', route: 'notes' },
  { id: 'session-search', name: '跨会话搜索', desc: '在所有历史对话转录中检索', category: 'insight', requires: 'workspace', route: 'search' },
  { id: 'automation', name: '自动化', desc: '定时任务与批量智能体工作流', category: 'workflow', requires: 'workspace', route: 'automation' },
  { id: 'git', name: 'Git 面板', desc: '分支、暂存、提交与差异审查', category: 'workflow', requires: 'git', route: 'git' },
  { id: 'quality', name: '质量工作台', desc: '评审、覆盖率、性能与重构建议', category: 'insight', requires: 'workspace', route: 'quality' },
  { id: 'terminal', name: '终端', desc: '内嵌 PTY 终端与输出引用', category: 'tools', requires: 'none', route: 'terminal' },
];

const VALID_REQUIRES = new Set(['none', 'workspace', 'git', 'platform']);

function catalog() {
  return PLUGIN_CATALOG.map((p) => ({ ...p, platforms: p.platforms ? [...p.platforms] : null }));
}

/**
 * Per-plugin availability in the current environment. Purely filesystem +
 * platform checks; never throws. `platform` is overridden for tests.
 */
function status(root, platform = process.platform) {
  const hasWorkspace = typeof root === 'string' && root.length > 0;
  const hasGit = hasWorkspace && fs.existsSync(path.join(root, '.git'));
  const out = [];
  for (const p of PLUGIN_CATALOG) {
    let available = true;
    let reason = null;
    if (p.requires === 'workspace' && !hasWorkspace) {
      available = false; reason = '需要打开工作区';
    } else if (p.requires === 'git' && !hasGit) {
      available = false; reason = '需要 Git 仓库';
    } else if (p.requires === 'platform') {
      if (!Array.isArray(p.platforms) || !p.platforms.includes(platform)) {
        available = false; reason = '当前系统不支持';
      }
    }
    out.push({ id: p.id, available, reason });
  }
  return { plugins: out, workspaceRoot: hasWorkspace ? root : null, hasGit, platform };
}

/** Validate a proposed catalog entry (used by tests and future user plugins). */
function validateDefinition(def) {
  if (!def || typeof def !== 'object') return '定义必须是对象';
  if (typeof def.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(def.id)) return 'id 必须是小写字母/数字/连字符';
  if (typeof def.name !== 'string' || !def.name.trim()) return 'name 不能为空';
  if (typeof def.desc !== 'string' || !def.desc.trim()) return 'desc 不能为空';
  if (!VALID_REQUIRES.has(def.requires)) return 'requires 非法';
  if (def.requires === 'platform' && (!Array.isArray(def.platforms) || def.platforms.length === 0)) {
    return 'platform 依赖必须声明 platforms 列表';
  }
  return null;
}

module.exports = { PLUGIN_CATALOG, catalog, status, validateDefinition };
