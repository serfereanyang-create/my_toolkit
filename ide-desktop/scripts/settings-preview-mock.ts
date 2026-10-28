/**
 * Settings preview fixture — the `window.zcodeDesktop` contract the settings
 * pages actually consume, shaped like the real main-process replies
 * (electron/ipc.cjs + src/lib/ipc.ts). Measurement harness only: this file is
 * never bundled into the app.
 *
 * IMPORTANT — evaluation order. `src/lib/ipc.ts` captures
 * `const desktop = window.zcodeDesktop` at module scope. `settings-preview.tsx`
 * therefore imports this module *before* any component, so the assignment
 * below runs before `lib/ipc.ts` is evaluated. Reordering those imports (or
 * moving the assignment into the entry's module body) leaves `desktop`
 * undefined and every settings page that talks to the host unmounts.
 *
 * Two scenarios, selected by `?scenario=empty`; the default is `filled`:
 *   filled — one provider/day/model/archived session, a custom keybinding, a
 *            plugin catalog with an unavailable entry, one browser extension.
 *   empty  — the zero-data state every page has to survive: empty arrays,
 *            zero totals, no custom chords, no workspace.
 * Both are real shapes the main process can return; neither is a synthetic
 * "missing field" case.
 */
import type { DesktopSettings } from '../src/types';

export type PreviewScenario = 'filled' | 'empty';

const params = new URLSearchParams(window.location.search);
export const previewScenario: PreviewScenario = params.get('scenario') === 'empty' ? 'empty' : 'filled';
const FILLED = previewScenario === 'filled';

// Failure injection for the settings pages' error states: `?fail=key,key`
// makes only the named host calls reject, leaving every other namespace at the
// normal filled/empty shape. A probe can also push keys onto
// `window.__previewFail` at runtime to exhaust a retry and then clear it to
// watch the retry succeed. Keys are listed where they are used below.
const FAIL_FROM_URL = new Set((params.get('fail') ?? '').split(',').filter(Boolean));
export const previewFailures = [...FAIL_FROM_URL];

// Lets the probe assert which fixture it loaded (and catch a stale URL).
if (typeof document !== 'undefined') {
  document.documentElement.dataset.previewScenario = previewScenario;
  document.documentElement.dataset.previewFail = previewFailures.join(',');
}
// The probe mutates this set to make a retry succeed after a failure.
(window as unknown as { __previewFailSet?: Set<string> }).__previewFailSet = FAIL_FROM_URL;

function failing(key: string): boolean {
  const extra = (window as unknown as { __previewFail?: string[] }).__previewFail;
  return FAIL_FROM_URL.has(key) || (Array.isArray(extra) && extra.includes(key));
}

/** Reject the way the real IPC bridge does when the main process throws. */
function failIf(key: string): void {
  if (failing(key)) throw new Error(`预览夹具注入失败：${key}`);
}

const BASE_URL = 'https://api.preview.invalid/v1';
const BACKUP_URL = 'https://backup.preview.invalid/v1';

/* ── Settings ─────────────────────────────────────────────────────────────── */

export const PREVIEW_SETTINGS: DesktopSettings = {
  activeProviderId: 'preview',
  approval: 'ask',
  recentWorkspaces: [],
  providers: [
    {
      id: 'preview',
      type: 'custom',
      label: '工作模型',
      baseUrl: BASE_URL,
      model: 'gpt-5.4',
      keyHint: 'saved',
      models: [
        {
          id: 'gpt-5.4', contextWindow: 128000, callMode: 'streaming',
          inputPricePerM: 1.25, outputPricePerM: 10, cacheReadPricePerM: 0.125, cacheWritePricePerM: 1.25,
        },
        {
          id: 'claude-4.5', contextWindow: 200000, callMode: 'streaming',
          inputPricePerM: 3, outputPricePerM: 15, cacheReadPricePerM: 0.3, cacheWritePricePerM: 3.75,
        },
      ],
    },
    {
      id: 'backup',
      type: 'custom',
      label: '备用中转',
      baseUrl: BACKUP_URL,
      model: 'deepseek-v4.1',
      keyHint: 'missing',
      models: [{ id: 'deepseek-v4.1', contextWindow: 128000, inputPricePerM: 0.27, outputPricePerM: 1.1 }],
    },
  ],
  preferences: {
    theme: 'light',
    reasoningEffort: 'high',
    'gen.language': 'zh-CN',
    // Empty scenario: catalog loaded but nothing enabled (a real first-run state).
    pluginsEnabled: FILLED
      ? ['documents', 'pdf', 'spreadsheets', 'browser', 'visualize', 'snippets', 'notes', 'terminal']
      : [],
    // 电脑操控 → 始终允许的应用 has a removable row in the filled scenario.
    computerAllowedApps: FILLED ? ['node'] : [],
  },
};

/* ── Usage ledger ─────────────────────────────────────────────────────────── */

const MODEL_A = {
  key: `preview\u001f${BASE_URL}\u001fgpt-5.4`,
  model: 'gpt-5.4',
  provider: 'preview',
  baseUrl: BASE_URL,
};
const MODEL_B = {
  key: `preview\u001f${BASE_URL}\u001fclaude-4.5`,
  model: 'claude-4.5',
  provider: 'preview',
  baseUrl: BASE_URL,
};

type Spread = { input: number; output: number; cacheRead: number; cacheCreation: number; rounds: number };

function emptySpread(): Spread {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, rounds: 0 };
}

function addSpread(into: Spread, from: Spread): Spread {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreation += from.cacheCreation;
  into.rounds += from.rounds;
  return into;
}

function totalsOf(spread: Spread) {
  return {
    // `tokens` is input + output; cache fields are reported alongside, exactly
    // as the ledger IPC does (the UI adds cache back for the displayed total).
    tokens: spread.input + spread.output,
    rounds: spread.rounds,
    input: spread.input,
    output: spread.output,
    cacheRead: spread.cacheRead,
    cacheCreation: spread.cacheCreation,
    source: 'provider-reported' as const,
  };
}

function modelStats(model: typeof MODEL_A, spread: Spread, lastUsed: number) {
  return {
    ...model,
    total: spread.input + spread.output,
    input: spread.input,
    output: spread.output,
    cacheRead: spread.cacheRead,
    cacheCreation: spread.cacheCreation,
    rounds: spread.rounds,
    lastUsed,
    source: 'provider-reported' as const,
  };
}

function localDay(offsetDays: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function hourLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:00`;
}

function summaryFor(days: 7 | 30 | 90) {
  if (!FILLED) {
    return {
      days,
      daily: [],
      models: [],
      sessions: [],
      totals: { tokens: 0, rounds: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, source: 'local-estimate' as const },
      source: 'local-estimate' as const,
    };
  }
  const daily: Array<Record<string, unknown>> = [];
  const totalA = emptySpread();
  const totalB = emptySpread();
  for (let i = days - 1; i >= 0; i -= 1) {
    // A realistic ledger has idle days; every fourth one carries no traffic.
    const weight = i % 4 === 0 ? 0 : (i % 5) + 1;
    const a: Spread = { input: weight * 9400, output: weight * 2300, cacheRead: weight * 5200, cacheCreation: weight * 860, rounds: weight * 3 };
    const b: Spread = { input: weight * 3100, output: weight * 900, cacheRead: weight * 1800, cacheCreation: weight * 240, rounds: weight };
    addSpread(totalA, a);
    addSpread(totalB, b);
    const byModel = { [MODEL_A.key]: a.input + a.output, [MODEL_B.key]: b.input + b.output };
    daily.push({
      date: localDay(i),
      total: a.input + a.output + b.input + b.output,
      rounds: a.rounds + b.rounds,
      input: a.input + b.input,
      output: a.output + b.output,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheCreation: a.cacheCreation + b.cacheCreation,
      byModel,
      byIdentity: byModel,
      source: 'provider-reported',
    });
  }
  const totals = totalsOf(addSpread(addSpread(emptySpread(), totalA), totalB));
  return {
    days,
    daily,
    models: [
      modelStats(MODEL_A, totalA, Date.now() - 12 * 60_000),
      modelStats(MODEL_B, totalB, Date.now() - 3 * 3600_000),
    ],
    sessions: [
      {
        sessionId: 'session-preview-1', rounds: 18, tokens: 214000,
        input: 168000, output: 46000, cacheRead: 92000, toolCalls: 12,
        firstTs: Date.now() - 26 * 3600_000, lastTs: Date.now() - 11 * 60_000,
        toolsUsed: ['read_file', 'apply_patch'],
      },
    ],
    totals,
    source: 'provider-reported' as const,
  };
}

/** Ledger rows for the 24/36/48h window, newest first. */
function ledgerRecords(hours: 24 | 36 | 48) {
  const out: Array<Record<string, unknown>> = [];
  const count = 43;
  for (let i = 0; i < count; i += 1) {
    const isA = i % 3 !== 0;
    const input = isA ? 4200 + (i % 7) * 900 : 1800 + (i % 5) * 400;
    const output = isA ? 900 + (i % 4) * 260 : 320 + (i % 3) * 110;
    const cacheRead = isA ? 2100 + (i % 6) * 500 : 640 + (i % 4) * 300;
    const cacheCreation = 120 + (i % 5) * 60;
    out.push({
      id: `usage-${hours}-${String(i).padStart(3, '0')}`,
      timestamp: Date.now() - Math.round((i / count) * hours * 3600_000) - 60_000,
      model: isA ? MODEL_A.model : MODEL_B.model,
      provider: isA ? MODEL_A.provider : MODEL_B.provider,
      baseUrl: isA ? MODEL_A.baseUrl : MODEL_B.baseUrl,
      input, output, cacheRead, cacheCreation,
      total: input + output,
      reasoningEffort: isA ? 'high' : 'medium',
      source: 'provider-reported',
      sessionId: 'session-preview-1',
      turnId: `turn-${i}`,
      toolCalls: i % 4 === 0 ? 2 : 0,
      toolsUsed: i % 4 === 0 ? ['read_file'] : [],
      durationMs: 4200 + (i % 9) * 1100,
    });
  }
  return out;
}

function hourlyFor(hours: 24 | 36 | 48) {
  if (!FILLED) {
    return {
      hours,
      hourly: [],
      models: [],
      totals: { tokens: 0, rounds: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, source: 'local-estimate' as const },
      records: [],
      source: 'local-estimate' as const,
    };
  }
  const hourly: Array<Record<string, unknown>> = [];
  const totalA = emptySpread();
  const totalB = emptySpread();
  for (let i = hours - 1; i >= 0; i -= 1) {
    const active = i % 7 !== 3;
    const weight = active ? (i % 3) + 1 : 0;
    const startTs = Date.now() - i * 3600_000;
    const a: Spread = { input: weight * 720, output: weight * 180, cacheRead: weight * 410, cacheCreation: weight * 70, rounds: weight };
    const b: Spread = { input: weight * 240, output: weight * 70, cacheRead: weight * 130, cacheCreation: weight * 20, rounds: weight ? 1 : 0 };
    addSpread(totalA, a);
    addSpread(totalB, b);
    const byModel = { [MODEL_A.key]: a.input + a.output, [MODEL_B.key]: b.input + b.output };
    hourly.push({
      startTs,
      label: hourLabel(startTs),
      total: a.input + a.output + b.input + b.output,
      rounds: a.rounds + b.rounds,
      input: a.input + b.input,
      output: a.output + b.output,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheCreation: a.cacheCreation + b.cacheCreation,
      byModel,
      byIdentity: byModel,
      source: 'provider-reported',
    });
  }
  return {
    hours,
    hourly,
    models: [
      modelStats(MODEL_A, totalA, Date.now() - 12 * 60_000),
      modelStats(MODEL_B, totalB, Date.now() - 3 * 3600_000),
    ],
    totals: totalsOf(addSpread(addSpread(emptySpread(), totalA), totalB)),
    records: ledgerRecords(hours),
    source: 'provider-reported' as const,
  };
}

/* ── Plugin registry (mirrors electron/plugin-registry.cjs) ───────────────── */

const PLUGIN_CATALOG = [
  { id: 'documents', name: 'Documents', desc: '创建和编辑文档工件', category: 'artifacts', requires: 'none', platforms: null, route: null },
  { id: 'pdf', name: 'PDF', desc: '读取、创建和校验 PDF 文件', category: 'artifacts', requires: 'none', platforms: null, route: null },
  { id: 'spreadsheets', name: 'Spreadsheets', desc: '创建和编辑电子表格文件', category: 'artifacts', requires: 'none', platforms: null, route: null },
  { id: 'presentations', name: 'Presentations', desc: '创建和编辑演示文稿', category: 'artifacts', requires: 'none', platforms: null, route: null },
  { id: 'template', name: 'Template Creator', desc: '从参考内容创建或更新可复用模板', category: 'artifacts', requires: 'none', platforms: null, route: null },
  { id: 'browser', name: '浏览器', desc: '通过 YOYcode 控制应用内浏览器', category: 'tools', requires: 'none', platforms: null, route: 'browser' },
  { id: 'computer', name: '电脑', desc: '从 YOYcode 控制 Windows 应用', category: 'tools', requires: 'platform', platforms: ['win32'], route: null },
  { id: 'visualize', name: 'Visualize', desc: '将想法和数据转化为交互式可视化内容', category: 'artifacts', requires: 'none', platforms: null, route: null },
  { id: 'snippets', name: '片段库', desc: '可复用代码片段与 {{变量}} 模板', category: 'workflow', requires: 'none', platforms: null, route: 'snippets' },
  { id: 'bookmarks', name: '书签', desc: '行级书签、批注与跨文件跳转', category: 'workflow', requires: 'workspace', platforms: null, route: 'bookmarks' },
  { id: 'history', name: '保存历史', desc: '文件快照时间线与一键回滚', category: 'workflow', requires: 'workspace', platforms: null, route: 'history' },
  { id: 'census', name: '代码普查', desc: '语言占比、目录权重与 TODO 台账', category: 'insight', requires: 'workspace', platforms: null, route: 'stats' },
  { id: 'notes', name: '会话笔记', desc: '对话内速记，置顶与全文回看', category: 'workflow', requires: 'none', platforms: null, route: 'notes' },
  { id: 'session-search', name: '跨会话搜索', desc: '在所有历史对话转录中检索', category: 'insight', requires: 'workspace', platforms: null, route: 'search' },
  { id: 'automation', name: '自动化', desc: '定时任务与批量智能体工作流', category: 'workflow', requires: 'workspace', platforms: null, route: 'automation' },
  { id: 'git', name: 'Git 面板', desc: '分支、暂存、提交与差异审查', category: 'workflow', requires: 'git', platforms: null, route: 'git' },
  { id: 'quality', name: '质量工作台', desc: '评审、覆盖率、性能与重构建议', category: 'insight', requires: 'workspace', platforms: null, route: 'quality' },
  { id: 'terminal', name: '终端', desc: '内嵌 PTY 终端与输出引用', category: 'tools', requires: 'none', platforms: null, route: 'terminal' },
] as const;

function pluginStatus() {
  const workspaceRoot = FILLED ? 'C:\\Users\\preview\\project' : null;
  // A workspace without a git repo is a real state and exercises the
  // unavailable badge (see PluginStatusEntry.reason).
  const hasGit = false;
  const platform = 'win32';
  const plugins = PLUGIN_CATALOG.map((p) => {
    let available = true;
    let reason: string | null = null;
    if (p.requires === 'workspace' && !workspaceRoot) {
      available = false; reason = '需要打开工作区';
    } else if (p.requires === 'git' && !hasGit) {
      available = false; reason = '需要 Git 仓库';
    } else if (p.requires === 'platform') {
      if (!Array.isArray(p.platforms) || !p.platforms.includes(platform)) {
        available = false; reason = '当前系统不支持';
      }
    }
    return { id: p.id, available, reason };
  });
  return { plugins, workspaceRoot, hasGit, platform };
}

/* ── Archived chats / empty-session cleanup ───────────────────────────────── */

const ARCHIVED_SESSIONS = [
  {
    id: 'session-archived-1',
    title: '重构设置页面的探针',
    baseTitle: '重构设置页面的探针',
    pinned: false,
    archived: true,
    updatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
    messageCount: 14,
  },
  {
    id: 'session-archived-2',
    title: '整理 VPS 部署文档',
    baseTitle: '整理 VPS 部署文档',
    pinned: false,
    archived: true,
    updatedAt: new Date(Date.now() - 9 * 24 * 3600_000).toISOString(),
    messageCount: 3,
  },
];

const CLEANUP_ANALYSIS = {
  dir: 'C:\\Users\\preview\\.aicode\\sessions',
  total: 12,
  empty: 3,
  systemOnly: 1,
  withContent: 8,
  parseFailed: 0,
  pinnedEmpty: 0,
  overlayUnreadable: false,
  candidateBytes: 48213,
  candidates: [
    { id: 'session-empty-1', file: 'session-empty-1.json', title: null, createdAt: Date.now() - 3 * 24 * 3600_000, bytes: 20114, messageCount: 0 },
    { id: 'session-empty-2', file: 'session-empty-2.json', title: '未命名会话', createdAt: Date.now() - 11 * 3600_000, bytes: 28099, messageCount: 0 },
  ],
};

/* ── Host API ─────────────────────────────────────────────────────────────── */

const ok = { ok: true } as const;

/**
 * Every namespace/method below is read by at least one page under
 * src/components/Settings/ (or by a panel that page mounts):
 *   settings, usage, keybindings, plugins, computer, preview, sessions,
 *   sessionCleanup, backgroundApp, backgroundBrowser, workspace, appearance,
 *   fs, clipboard, connectivity, secrets.
 * Anything else is deliberately absent so a page that starts depending on a new
 * namespace fails loudly (React unmounts, the probe reports a blank page)
 * instead of silently rendering an empty shell.
 */
const previewHost = {
  settings: {
    get: async () => PREVIEW_SETTINGS,
    set: async () => PREVIEW_SETTINGS,
  },
  // 模型 page: the 测试连接 button (event handler, not on render).
  connectivity: {
    test: async () => ({ ok: true, status: 200, latencyMs: 42, message: '测试连接成功' }),
  },
  secrets: {
    setApiKey: async () => ({ configured: true, hint: 'saved' }),
    hasApiKey: async () => ({ configured: true, hint: 'saved' }),
  },
  usage: {
    summary: async (days: 7 | 30 | 90) => summaryFor(days),
    hourly: async (hours: 24 | 36 | 48) => hourlyFor(hours),
    cachePrediction: async (model?: string) => ({
      predicted: FILLED ? 0.42 : null,
      samples: FILLED ? 18 : 0,
      model: model ?? MODEL_A.model,
      windowDays: 7,
      source: 'provider-reported' as const,
    }),
    records: async (hours: 24 | 36 | 48, offset: number, limit: number) => {
      failIf('usage.records');
      const all = FILLED ? ledgerRecords(hours) : [];
      return { records: all.slice(offset, offset + limit), total: all.length };
    },
    exportCsv: async (hours: 24 | 36 | 48) => {
      const all = FILLED ? ledgerRecords(hours) : [];
      return { csv: 'timestamp,model,input,output\n', count: all.length };
    },
  },
  fs: {
    write: async (path: string) => ({ ok: true, path }),
  },
  clipboard: {
    write: async () => ok,
  },
  keybindings: {
    get: async () => {
      failIf('keybindings.get');
      return FILLED ? { palette: 'Ctrl+Alt+P', settings: 'Ctrl+Alt+,' } : {};
    },
    set: async (actionId: string, chord: string | null) => {
      // A reset (chord === null) can fail independently of a rebind.
      failIf(chord === null ? 'keybindings.reset' : 'keybindings.set');
      return { ok: true, actionId, chord };
    },
  },
  plugins: {
    catalog: async () => {
      failIf('plugins.catalog');
      return PLUGIN_CATALOG.map((p) => ({ ...p, platforms: p.platforms ? [...p.platforms] : null }));
    },
    status: async () => {
      failIf('plugins.status');
      return pluginStatus();
    },
  },
  computer: {
    detectBrowserExtension: async () => (FILLED
      ? {
        installed: true,
        extensions: [{
          browser: 'chrome',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          name: 'YOYcode 电脑操控',
        }],
      }
      : { installed: false, extensions: [] }),
  },
  preview: {
    openExternal: async () => ok,
  },
  sessions: {
    listArchived: async () => {
      failIf('sessions.listArchived');
      return FILLED ? ARCHIVED_SESSIONS : [];
    },
    archive: async (id: string, archived: boolean) => {
      failIf('sessions.archive');
      return { ok: true, id, archived };
    },
    delete: async (id: string) => {
      failIf('sessions.delete');
      return { ok: true, id };
    },
  },
  sessionCleanup: {
    analyze: async () => ({
      ok: true,
      analyses: FILLED
        ? [CLEANUP_ANALYSIS]
        : [{ ...CLEANUP_ANALYSIS, empty: 0, systemOnly: 0, candidateBytes: 0, candidates: [] }],
    }),
    deleteFiles: async (dir: string, ids: string[]) => ({
      ok: true,
      deleted: ids,
      skipped: [],
      freedBytes: 48213,
      dir,
    }),
  },
  backgroundApp: {
    execute: async (tool: string) => ({
      ok: true,
      output: `${tool} 预览夹具：无真实后台应用。`,
      data: {},
    }),
    close: async () => ok,
  },
  backgroundBrowser: {
    execute: async (tool: string) => ({
      ok: true,
      output: `${tool} 预览夹具：无真实后台浏览器。`,
      data: {},
    }),
    close: async () => ok,
    status: async () => ({ sessions: [] }),
  },
  workspace: {
    reveal: async () => ok,
  },
  // Read by AppearanceSettings via lib/background.ts. `readBackground` is
  // awaited without a catch on that page, so this must always resolve.
  appearance: {
    readBackground: async () => {
      failIf('appearance.readBackground');
      return FILLED ? { ok: true, version: 1 } : { ok: true, version: 0 };
    },
    pickBackground: async () => ({ ok: false, canceled: true }),
    clearBackground: async () => ok,
  },
};

(window as unknown as { zcodeDesktop: typeof previewHost }).zcodeDesktop = previewHost;
