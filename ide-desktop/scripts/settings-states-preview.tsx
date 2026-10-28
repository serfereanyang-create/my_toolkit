/*
 * Inner-state catalogue for the settings fixture (`scripts/settings-preview.tsx`).
 *
 * The a11y audit reaches the 15 settings pages only in their first paint. Every
 * state a page can be in *after* that paint — an inline editor opened, a
 * chip armed for rebinding, a confirm dialog, an error row, a toast — was
 * outside the sweep because `a11y-audit.cjs` has no drive step (and that file is
 * owned elsewhere). This module puts those states on the fixture's side of the
 * boundary: a state names its page, the settings shape it needs, the host
 * behaviour to inject, and a list of DOM steps to run.
 *
 * The probe is `scripts/settings-states-preview.cjs` (`npm run
 * test:settings-states`): it reads this catalogue from `window.__previewStates`,
 * loads one `?state=<id>` per state in a hidden window, waits for the drive, and
 * checks the selectors/text the state promised. Nothing here runs unless a state
 * is asked for: the fixture only imports the definitions, and the drive/patch
 * machinery is inert until `applyState` runs — the default (no `?state=`) render
 * is byte-for-byte the old fixture, which is what keeps the 120
 * `--page=settings` combinations at 6232 / 2092 / 3368.
 *
 * Two conventions the runner depends on:
 *   - `query` must be put in the *load URL* by the caller, not applied at
 *     runtime: the fixture mock reads `?scenario=` once, at module evaluation.
 *   - a state whose point is that some UI should NOT exist sets
 *     `expectMissingIsFinding`; the runner reports it as FINDING, not a failure.
 *
 * Browser-only: this file is loaded in the renderer, never in Node.
 */
import type { DesktopSettings } from '../src/types';
import type { SettingsNavId } from '../src/components/Settings/SettingsView';

export type PreviewSurface = 'settings' | 'memory';

/**
 * Replacements for one host method. `delay` keeps the real reply but stalls it
 * (so a busy/loading paint can be measured), `reject` throws, `resolve` answers
 * with `value` regardless of arguments. The API shape is the one the real main
 * process returns; these are not synthetic "missing field" cases.
 */
export type HostPatch = {
  /** Dotted path in `window.zcodeDesktop`, e.g. `sessions.listArchived`. */
  path: string;
  kind: 'delay' | 'reject' | 'resolve';
  ms?: number;
  value?: unknown;
  message?: string;
};

export type DriveStep =
  | { click: string; nth?: number }
  | { type: { selector: string; value: string } }
  | { key: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } }
  | { wait: number }
  | { eval: string }
  | { waitFor: string; timeout?: number };

export type PreviewStateDef = {
  id: string;
  /** Human title for the report. */
  title: string;
  /** Which settings page to open. */
  page?: SettingsNavId;
  /** Which fixture surface renders. Defaults to the settings shell. */
  surface?: PreviewSurface;
  /** Extra query string appended to the load URL (e.g. `scenario=empty`). */
  query?: string;
  /** Load workspace-shell.css (dialogs, toasts, the memory panel live there). */
  needsShellCss?: boolean;
  /** Mount the real ToastLayer beside the page. */
  toast?: boolean;
  /** Settings shape this state needs; receives the filled fixture base. */
  settings?: (base: DesktopSettings) => DesktopSettings;
  /** Host-call behaviour to inject before the drive runs. */
  patches?: HostPatch[];
  /** DOM steps, in order. */
  steps?: DriveStep[];
  /** Selectors that must exist once the drive settles. */
  expect?: string[];
  /** Selectors that must NOT exist once the drive settles. */
  forbid?: string[];
  /** Text that must be present in the element matched by the selector. */
  expectText?: Array<{ selector: string; text: string }>;
  /**
   * Reserved for a contrast pass: measure with whatever theme the drive applied
   * instead of overriding it. `settings-states-preview.cjs` only checks that the
   * state rendered and said what it promised — it takes its theme from `--theme`
   * and ignores this flag. Meaningful once these states are fed to the a11y
   * audit (which needs the theme held still, not switched mid-run).
   */
  respectTheme?: boolean;
  /** Why a state is absent, or what the state is meant to catch. */
  note?: string;
  /** When true the failure of `expect` is the point (a missing UI state). */
  expectMissingIsFinding?: boolean;
};

/* ── memory fixture shapes (same as scripts/memory-panel-preview.tsx) ─────── */

const MEMORY_PROJECT_FILES = [
  { name: 'MEMORY.md', path: 'C:/mem/MEMORY.md', kind: 'index' as const, size: 2848, updatedAt: Date.now() },
  { name: 'pcb-project-led-cct-lamp.md', path: 'C:/mem/pcb.md', kind: 'item' as const, size: 812, updatedAt: Date.now() },
];

const MEMORY_SNAPSHOT = {
  ok: true,
  root: 'C:/Users/preview/.zcode/cli/memories/global',
  indexPath: 'C:/Users/preview/.zcode/cli/memories/global/MEMORY.md',
  markdown: '# 全局记忆\n\n## zcode\n- ide-desktop/electron/git.cjs\n',
  updatedAt: Date.now(),
  totalEdits: 8,
  totalFiles: 42,
  projects: [
    {
      project: 'zcode',
      workspace: 'C:/work/zcode',
      edits: 6,
      lastAt: '2026-10-22T11:00:00.000Z',
      fileTotal: 41,
      files: [
        { path: 'ide-desktop/electron/git.cjs', at: '2026-10-22T11:00:00.000Z', count: 3, created: false },
        { path: 'cli/src/tools/git-write.ts', at: '2026-10-22T10:00:00.000Z', count: 1, created: false, renamed: true },
        { path: 'docs/plan.md', at: '2026-10-22T09:00:00.000Z', count: 1, created: true },
        { path: 'docs/old-notes.md', at: '2026-10-22T08:00:00.000Z', count: 1, created: false, deleted: true },
      ],
    },
    {
      project: 'cidai',
      workspace: 'C:/work/cidai',
      edits: 2,
      lastAt: '2026-10-21T20:00:00.000Z',
      fileTotal: 1,
      files: [{ path: 'app/src/main/java/Glass.kt', at: '2026-10-21T20:00:00.000Z', count: 2, created: false }],
    },
  ],
  records: [
    { at: '2026-10-21T20:00:00.000Z', project: 'cidai', workspace: 'C:/work/cidai', action: 'write', path: 'app/src/main/java/Glass.kt', created: false },
    { at: '2026-10-22T08:00:00.000Z', project: 'zcode', workspace: 'C:/work/zcode', action: 'delete', path: 'docs/old-notes.md', created: false },
    { at: '2026-10-22T10:00:00.000Z', project: 'zcode', workspace: 'C:/work/zcode', action: 'rename', path: 'cli/src/tools/git-write.ts', from: 'cli/src/git-write.ts', created: false },
    { at: '2026-10-22T11:00:00.000Z', project: 'zcode', workspace: 'C:/work/zcode', action: 'write', path: 'ide-desktop/electron/git.cjs', created: false },
  ],
};

const MEMORY_PROJECT_NOTES = [
  {
    id: 'zcode-b2c88be133bfd876',
    label: 'zcode',
    updatedAt: Date.now(),
    files: MEMORY_PROJECT_FILES,
  },
];

const EMPTY_MEMORY = { ok: true, root: MEMORY_SNAPSHOT.root, indexPath: MEMORY_SNAPSHOT.indexPath, markdown: '', updatedAt: 0, totalEdits: 0, projects: [], records: [] };

/* ── settings shapes ─────────────────────────────────────────────────────── */

const LONG_PROVIDER = {
  id: 'preview',
  type: 'custom' as const,
  label: '阿里巴巴云通义千问企业版华东二区专属推理加速网关（生产环境）',
  baseUrl: 'https://gateway.internal.example-company.cn/ai/v1/tenants/9f3c1a7e-4b2d-4e8a-9c1f/models/openai-compatible',
  model: 'qwen-max-2026-09-30-preview-extended-context-131072',
  keyHint: 'saved',
  apiFormat: 'openai-chat' as const,
  models: [
    {
      id: 'qwen-max-2026-09-30-preview-extended-context-131072-with-a-very-long-unbroken-suffix',
      contextWindow: 131072,
      inputPricePerM: 1.25,
      outputPricePerM: 10,
      cacheReadPricePerM: 0.125,
      cacheWritePricePerM: 1.25,
    },
    { id: 'gpt-5.4', contextWindow: 128000 },
  ],
};

const LONG_ARCHIVED_TITLE = '重构设置页面的探针并把整整二十个内部状态逐一渲染出来——这是一个刻意超长的会话标题，用来验证归档列表没有把行撑破，也没有把操作按钮挤到视口外面去';

/* ── the catalogue ───────────────────────────────────────────────────────── */

export const PREVIEW_STATES: PreviewStateDef[] = [
  /* 模型 — provider rail / detail / inline editors --------------------------- */
  {
    id: 'model-rail-empty',
    title: '模型：无自定义供应商（详情区空态）',
    page: 'model',
    settings: (base) => ({ ...base, providers: [], activeProviderId: '' }),
    expect: ['.settings-empty'],
    expectText: [{ selector: '.settings-empty', text: '尚无自定义供应商' }],
  },
  {
    id: 'provider-add',
    title: '模型：添加供应商后的空白编辑区',
    page: 'model',
    steps: [{ click: '.model-provider-add' }, { waitFor: '.provider-detail' }],
    expect: ['.provider-detail', '.settings-empty'],
    expectText: [{ selector: '.settings-empty', text: '尚无模型' }],
    note: '添加供应商不是弹层：新条目直接插入列表并选中，详情区以内联表单出现。',
  },
  {
    id: 'provider-remove-immediate',
    title: '模型：删除供应商（无确认，立即生效）',
    page: 'model',
    steps: [{ click: 'button[aria-label="删除供应商"]' }, { wait: 60 }],
    expect: ['.model-provider-item'],
    forbid: ['.model-provider-item:nth-of-type(2)'],
    note: '删除供应商没有确认框：一次点击即丢掉该供应商及其模型目录。',
  },
  {
    id: 'provider-longtext',
    title: '模型：超长供应商名 / Base URL / 模型 ID',
    page: 'model',
    settings: (base) => ({ ...base, providers: [LONG_PROVIDER, ...base.providers.slice(1)] }),
    expect: ['.model-provider-name', '.model-row-name'],
  },
  {
    id: 'model-add-form',
    title: '模型：添加模型的内联表单',
    page: 'model',
    steps: [{ click: '.model-add-btn' }, { waitFor: '.model-row.editing' }],
    expect: ['.model-row.editing', '.model-edit-grid-simple'],
  },
  {
    id: 'model-edit-form',
    title: '模型：编辑已有模型的内联表单',
    page: 'model',
    steps: [{ click: '.model-row button[aria-label="编辑"]' }, { waitFor: '.model-row.editing' }],
    expect: ['.model-row.editing'],
  },
  {
    id: 'model-delete-immediate',
    title: '模型：删除模型（无确认，立即生效）',
    page: 'model',
    steps: [{ click: '.model-row button[aria-label="删除"]' }, { wait: 60 }],
    expect: ['.model-row'],
    forbid: ['.model-list .model-row:nth-of-type(2)'],
    note: '删除模型同样没有确认；与“设为默认”相比，这一步不可撤销且没有提示。',
  },
  {
    id: 'model-set-default',
    title: '模型：切换默认模型',
    page: 'model',
    steps: [{ click: '.model-row:nth-of-type(2) button[aria-label="设为默认"]' }, { wait: 80 }],
    expect: ['.model-list .model-row:nth-of-type(2).is-default'],
    note: '“切换默认”没有确认；状态以行边框和按钮高亮表达，无 live 提示。',
  },
  {
    id: 'model-testing',
    title: '模型：测试连接进行中',
    page: 'model',
    patches: [{ path: 'connectivity.test', kind: 'delay', ms: 6000 }],
    steps: [{ click: '.model-conn-row .settings-action-btn' }, { wait: 120 }],
    expect: ['.model-conn-row .settings-action-btn'],
    expectText: [{ selector: '.model-conn-row .settings-action-btn', text: '测试中' }],
  },
  {
    id: 'model-test-ok',
    title: '模型：测试连接成功',
    page: 'model',
    steps: [{ click: '.model-conn-row .settings-action-btn' }, { waitFor: '.model-conn-result.ok' }],
    expect: ['.model-conn-result.ok'],
  },
  {
    id: 'model-test-fail',
    title: '模型：测试连接失败',
    page: 'model',
    patches: [{ path: 'connectivity.test', kind: 'resolve', value: { ok: false, status: 500, message: '连接超时（预览注入）' } }],
    steps: [{ click: '.model-conn-row .settings-action-btn' }, { waitFor: '.model-conn-result.fail' }],
    expect: ['.model-conn-result.fail'],
    note: '失败结果只是一个静态 span，没有 role=alert / aria-live，屏幕阅读器不会播报。',
  },
  {
    id: 'model-key-saved',
    title: '模型：API Key 保存后的“已保存”回执',
    page: 'model',
    steps: [
      { type: { selector: '.model-key-row input', value: 'sk-preview-0123456789' } },
      { click: '.model-key-row .settings-action-btn' },
      { wait: 100 },
    ],
    expect: ['.model-key-row .settings-action-btn'],
    expectText: [{ selector: '.model-key-row .settings-action-btn', text: '已保存' }],
    note: '回执只改按钮文案，没有 live region；两秒后自行消失。',
  },
  {
    id: 'model-key-save-fail',
    title: '模型：API Key 保存失败的 alert 行',
    page: 'model',
    patches: [],
    steps: [
      { type: { selector: '.model-key-row input', value: 'sk-preview-broken' } },
      { eval: 'window.__previewSaveKeyFail = true' },
      { click: '.model-key-row .settings-action-btn' },
      { waitFor: '.model-key-row ~ .settings-error[role="alert"]' },
    ],
    expect: ['.settings-error[role="alert"]'],
    expectText: [{ selector: '.settings-error[role="alert"]', text: 'API Key 保存失败' }],
    note: '此前 ProviderDetail.saveKey 没有 catch：onSaveKey 拒绝时输入保留、页面没有任何错误提示，只有一条未处理的 Promise 拒绝。已补 catch + disabled 态（见报告 §3）。',
  },
  {
    id: 'model-key-save-disabled',
    title: '模型：API Key 未输入时保存按钮禁用',
    page: 'model',
    expect: ['.model-key-row .settings-action-btn[disabled]'],
    expectText: [{ selector: '.model-key-row .settings-action-btn', text: '保存' }],
  },
  {
    id: 'model-test-throw',
    title: '模型：测试连接调用抛错（IPC 失败而非 5xx）',
    page: 'model',
    patches: [{ path: 'connectivity.test', kind: 'reject', message: '预览注入：连接被拒绝' }],
    steps: [{ click: '.model-conn-row .settings-action-btn' }, { waitFor: '.model-conn-result.fail' }],
    expect: ['.model-conn-result.fail'],
    expectText: [{ selector: '.model-conn-result.fail', text: '连接被拒绝' }],
    note: 'testConnection 的 catch 把异常也渲染成失败结果，这条路径和 5xx 走的是同一个 DOM。',
  },
  {
    id: 'model-edit-blank',
    title: '模型：编辑时清空 ID（确认按钮禁用）',
    page: 'model',
    steps: [
      { click: '.model-row button[aria-label="编辑"]' },
      { waitFor: '.model-row.editing' },
      { type: { selector: '.model-row.editing .settings-text-field', value: '' } },
      { wait: 60 },
    ],
    expect: ['.model-row.editing .settings-icon-btn[aria-label="确认"][disabled]'],
    note: '原实现只有 `if (!id.trim()) return`：点确认毫无反应，也没有任何提示。',
  },
  {
    id: 'model-add-duplicate',
    title: '模型：添加已存在的模型 ID（错误行 + 表单保留）',
    page: 'model',
    steps: [
      { click: '.model-add-btn' },
      { waitFor: '.model-row.editing' },
      { type: { selector: '.model-row.editing .settings-text-field', value: 'gpt-5.4' } },
      { click: '.model-row.editing .settings-icon-btn[aria-label="确认"]' },
      { wait: 80 },
    ],
    expect: ['.model-row.editing', '.settings-error[role="alert"]'],
    expectText: [{ selector: '.settings-error[role="alert"]', text: '该模型 ID 已存在' }],
    note: '原实现 commit 先 onAdd 再无条件清空并关表单：重复 ID 被静默吞掉，用户看到的是“填完就消失了”。',
  },

  /* 快捷键 — capture / conflict / reset error -------------------------------- */
  {
    id: 'shortcut-capturing',
    title: '快捷键：正在录制新组合键',
    page: 'shortcuts',
    steps: [{ click: '.sc-chip' }, { waitFor: '.sc-chip.capturing' }],
    expect: ['.sc-chip.capturing', '.sc-capture-text'],
    expectText: [{ selector: '.sc-capture-text', text: '按下' }],
  },
  {
    id: 'shortcut-invalid-key',
    title: '快捷键：录制冲突/非法键位的提示',
    page: 'shortcuts',
    steps: [{ click: '.sc-chip' }, { key: { key: 'a' } }, { wait: 80 }],
    expect: ['.sc-chip.capturing'],
    expectText: [{ selector: '.sc-capture-text', text: '必须包含 Ctrl 或 Alt' }],
  },
  {
    id: 'shortcut-conflict',
    title: '快捷键：两条命令占用同一组合键（冲突徽标）',
    page: 'shortcuts',
    patches: [{ path: 'keybindings.get', kind: 'resolve', value: { palette: 'Ctrl+Shift+X', 'quick-open': 'Ctrl+Shift+X' } }],
    steps: [{ waitFor: '.sc-conflict-badge' }],
    expect: ['.sc-conflict-badge', '.sc-chip.conflict'],
    expectText: [{ selector: '.sc-conflict-badge', text: '键位冲突' }],
    note: '冲突只靠徽标颜色表达，没有 aria-live；徽标本身是可读文本，可接受。',
  },
  {
    id: 'shortcut-reset-error',
    title: '快捷键：恢复默认失败的 alert 行',
    page: 'shortcuts',
    patches: [
      { path: 'keybindings.get', kind: 'resolve', value: { palette: 'Ctrl+Shift+K' } },
      { path: 'keybindings.set', kind: 'resolve', value: { ok: false, error: '键位存储不可用（预览注入）' } },
    ],
    steps: [{ waitFor: '.sc-reset' }, { click: '.sc-reset' }, { waitFor: '[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]', '.settings-error-row button'],
    expectText: [{ selector: '.settings-error-row', text: '恢复默认失败' }],
  },
  {
    id: 'shortcut-save-fail',
    title: '快捷键：改绑写入失败的提示（留在录制态）',
    page: 'shortcuts',
    patches: [{ path: 'keybindings.set', kind: 'resolve', value: { ok: false, error: '键位存储不可用（预览注入）' } }],
    steps: [{ click: '.sc-chip' }, { key: { key: 'j', ctrlKey: true, shiftKey: true } }, { wait: 120 }],
    expect: ['.sc-chip.capturing'],
    expectText: [{ selector: '.sc-capture-text', text: '键位存储不可用' }],
    note: '写入失败时 keybindings.set 返回 { ok: false, error }，错误只出现在 chip 内，chip 仍是录制态；没有 role=alert。',
  },
  {
    id: 'shortcut-search-empty',
    title: '快捷键：搜索无结果',
    page: 'shortcuts',
    steps: [{ type: { selector: '.settings-search-inline input', value: 'zzzz-no-such' } }, { wait: 80 }],
    expect: ['.settings-placeholder'],
    expectText: [{ selector: '.settings-placeholder', text: '没有匹配的快捷键' }],
  },

  /* 常规 — 禁用控件与非常规取值 ------------------------------------------- */
  {
    id: 'general-sound-off',
    title: '常规：提示音关闭后音量滑块与试听禁用',
    page: 'general',
    settings: (base) => ({ ...base, preferences: { ...base.preferences, 'gen.sounds': false } }),
    expect: ['[aria-label="提示音音量"][disabled]', '.sound-volume-row .settings-inline-edit[disabled]'],
    note: '两个控件禁用后只靠 CSS 降透明度，行内描述仍是“提示音音量，0 为静音”，没有说明是开关关掉导致的。',
  },
  {
    id: 'general-timeout-custom',
    title: '常规：自定义请求时限显示为 n 秒（自定义）',
    page: 'general',
    settings: (base) => ({ ...base, preferences: { ...base.preferences, requestTimeoutMs: 123000 } }),
    expect: ['.select-pill select'],
    steps: [
      { eval: '(() => { const el = document.querySelector(".select-pill select"); if (!el) throw new Error("请求时限 select 缺失"); const text = el.options[el.selectedIndex]?.textContent || ""; if (!text.includes("自定义")) throw new Error("自定义取值没有出现在选项里: " + text); })()' },
    ],
    note: '请求时限不在 5/15/30/60 分钟内时，选项里会补一条“123 秒（自定义）”；文字断言走 eval（select 的 textContent 不含选项文本）。',
  },

  /* 外观 — theme switch + background states -------------------------------- */
  {
    id: 'appearance-theme-dark',
    title: '外观：点击“深色”后的即时预览',
    page: 'appearance',
    needsShellCss: false,
    steps: [{ click: '.theme-tile:nth-of-type(3)' }, { wait: 100 }],
    expect: ['.theme-tile.active'],
    expectText: [{ selector: '.theme-tile.active', text: '深色' }],
    respectTheme: true,
    note: '主题切换通过 savePref 回写 preferences.theme；夹具按 App.tsx 的 applyTheme 同步 <html data-theme>，页面即时换色。',
  },
  {
    id: 'appearance-theme-system',
    title: '外观：切回“系统”主题',
    page: 'appearance',
    steps: [{ click: '.theme-tile:nth-of-type(1)' }, { wait: 100 }],
    expect: ['.theme-tile.active'],
    expectText: [{ selector: '.theme-tile.active', text: '系统' }],
    respectTheme: true,
  },
  {
    id: 'appearance-bg-empty-hint',
    title: '外观：背景开关已开但未选图（role=status 提示）',
    page: 'appearance',
    settings: (base) => ({ ...base, preferences: { ...base.preferences, backgroundImage: true } }),
    expect: ['.settings-error[role="status"]'],
    expectText: [{ selector: '.settings-error[role="status"]', text: '还没有选择图片' }],
  },
  {
    id: 'appearance-bg-read-error',
    title: '外观：读取背景状态失败的 alert 行',
    page: 'appearance',
    patches: [{ path: 'appearance.readBackground', kind: 'reject', message: '预览注入：读取背景失败' }],
    steps: [{ waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]', '.settings-error-row button'],
  },
  {
    id: 'appearance-bg-stored',
    title: '外观：已有背景图（更换 / 移除 可用）',
    page: 'appearance',
    patches: [{ path: 'appearance.readBackground', kind: 'resolve', value: { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', version: 2 } }],
    steps: [{ wait: 120 }],
    expect: ['.background-picker .settings-button.ghost'],
    expectText: [{ selector: '.background-picker .settings-button', text: '更换图片' }],
    note: '夹具原本只发 { ok: true, version }（无 dataUrl），所以“已存图”的按钮文案与移除按钮永远出不来。',
  },
  {
    id: 'appearance-bg-picking',
    title: '外观：选择图片进行中（两个按钮禁用）',
    page: 'appearance',
    patches: [{ path: 'appearance.pickBackground', kind: 'delay', ms: 5000 }],
    steps: [{ click: '.background-picker .settings-button' }, { wait: 150 }],
    expect: ['.background-picker .settings-button[disabled]'],
    expectText: [{ selector: '.background-picker .settings-button', text: '处理中' }],
  },
  {
    id: 'appearance-bg-pick-error',
    title: '外观：选择图片失败的 alert 行',
    page: 'appearance',
    patches: [{ path: 'appearance.pickBackground', kind: 'resolve', value: { ok: false, error: '预览注入：图片超过 16 MB' } }],
    steps: [{ click: '.background-picker .settings-button' }, { waitFor: '.settings-error[role="alert"]' }],
    expect: ['.settings-error[role="alert"]'],
    expectText: [{ selector: '.settings-error[role="alert"]', text: '图片超过 16 MB' }],
  },
  {
    id: 'appearance-bg-remove-error',
    title: '外观：移除背景图失败的 alert 行',
    page: 'appearance',
    patches: [
      { path: 'appearance.readBackground', kind: 'resolve', value: { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', version: 2 } },
      { path: 'appearance.clearBackground', kind: 'reject', message: '预览注入：删除失败' },
    ],
    steps: [
      { waitFor: '.background-picker .settings-button.ghost' },
      { click: '.background-picker .settings-button.ghost' },
      { waitFor: '.settings-error[role="alert"]' },
    ],
    expect: ['.settings-error[role="alert"]'],
    expectText: [{ selector: '.settings-error[role="alert"]', text: '删除失败' }],
    note: 'removeBackground 原来只有 try/finally：宿主拒绝时是未处理拒绝，开关和图片都留在原地，没有一个字的说明。已补 catch（见报告 §3）。',
  },
  {
    id: 'appearance-fontsize-midedit',
    title: '外观：UI 字号输入到一半（草稿不落库）',
    page: 'appearance',
    steps: [
      { type: { selector: '[aria-label="UI 字号"]', value: '1' } },
      { wait: 80 },
      // 输入框的值不是 text，expectText 读不到；用 eval 断言，抛错即计入 drive error。
      { eval: '(() => { const el = document.querySelector(\'[aria-label="UI 字号"]\'); if (!el) throw new Error("UI 字号 输入框缺失"); if (el.value !== "1") throw new Error("草稿被覆盖: " + el.value); if (window.settingsPreviewState && window.settingsPreviewState.preferences && window.settingsPreviewState.preferences.uiFontSize === 1) throw new Error("越界值被写库"); })()' },
    ],
    expect: ['[aria-label="UI 字号"]'],
    note: 'NumberField 在聚焦期间保留草稿、越界不写库（12–20px 之外只有 onCommit 才夹紧）。这是“输入到一半”的状态，值断言只能走 eval。',
  },

  /* Git — 说明文字的两步保存 ------------------------------------------------ */
  {
    id: 'git-guide-dirty',
    title: 'Git：提交说明改动后保存按钮解除禁用',
    page: 'git',
    expect: ['.settings-inline-save:not([disabled])'],
    steps: [
      { eval: '(() => { const el = document.querySelector(".settings-inline-save"); if (!el || !el.disabled) throw new Error("初始状态保存按钮应为禁用"); })()' },
      { type: { selector: '.settings-textarea', value: '请在提交信息里写清行为变化与验证方式。' } },
      { wait: 100 },
    ],
    note: '两个说明区都是本地草稿 + 显式保存：未改动时按钮禁用，改动后启用。夹具之前没有这个“脏”状态。',
  },

  /* 归档会话 — loading / empty / busy / error / cleanup confirm -------------- */
  {
    id: 'archived-loading',
    title: '归档：加载中的空态',
    page: 'archived',
    patches: [{ path: 'sessions.listArchived', kind: 'delay', ms: 6000 }],
    steps: [{ wait: 120 }],
    expect: ['.settings-empty'],
    expectText: [{ selector: '.settings-empty', text: '正在加载已归档的聊天' }],
    note: '加载态没有 role=status / aria-live，辅助技术读不到“正在加载”。归入组件负责人。',
  },
  {
    id: 'archived-empty',
    title: '归档：没有已归档的聊天',
    page: 'archived',
    query: 'scenario=empty',
    expect: ['.settings-empty'],
    expectText: [{ selector: '.settings-empty', text: '没有已归档的聊天' }],
  },
  {
    id: 'archived-restore-busy',
    title: '归档：恢复进行中（行内按钮禁用）',
    page: 'archived',
    patches: [{ path: 'sessions.archive', kind: 'delay', ms: 6000 }],
    // nth: 1 — the first `.app-row` on this page is the empty-session cleanup
    // card, whose own `.settings-action-btn` is 清理. The old step clicked that
    // and confirmed a cleanup instead of restoring a chat.
    steps: [{ waitFor: '.app-row' }, { click: '.app-row .settings-action-btn', nth: 1 }, { wait: 150 }],
    expect: ['.app-row .settings-action-btn[disabled]'],
    note: '恢复没有确认框，也没有 live 提示；进行中只把按钮禁用。',
  },
  {
    id: 'archived-delete-busy',
    title: '归档：永久删除进行中（无确认框）',
    page: 'archived',
    patches: [{ path: 'sessions.delete', kind: 'delay', ms: 6000 }],
    steps: [{ waitFor: '.app-row' }, { click: '.app-row button[aria-label="永久删除"]' }, { wait: 120 }],
    expect: ['.app-row button[aria-label="永久删除"][disabled]'],
    note: '永久删除一次点击即执行，没有确认；这是归档页最危险的缺口。归入组件负责人。',
  },
  {
    id: 'archived-action-error',
    title: '归档：恢复失败的 alert 行',
    page: 'archived',
    patches: [{ path: 'sessions.archive', kind: 'reject', message: '预览注入：恢复失败' }],
    steps: [{ waitFor: '.app-row' }, { click: '.app-row .settings-action-btn', nth: 1 }, { waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]'],
    expectText: [{ selector: '.settings-error-row', text: '恢复失败' }],
  },
  {
    id: 'archived-load-error',
    title: '归档：列表读取失败的 alert 行（可重试）',
    page: 'archived',
    patches: [{ path: 'sessions.listArchived', kind: 'reject', message: '预览注入：读取失败' }],
    steps: [{ waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]', '.settings-error-row button'],
    expectText: [{ selector: '.settings-error-row', text: '无法加载已归档的聊天' }],
    note: '夹具此前只覆盖了动作失败，没覆盖列表读取失败——而这条错误行正是把“读取失败”从“没有归档”里分出来的那次修复。',
  },
  {
    id: 'archived-delete-error',
    title: '归档：永久删除失败的 alert 行',
    page: 'archived',
    patches: [{ path: 'sessions.delete', kind: 'reject', message: '预览注入：删除失败' }],
    steps: [{ waitFor: '.app-row' }, { click: '.app-row button[aria-label="永久删除"]' }, { waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]'],
    expectText: [{ selector: '.settings-error-row', text: '删除失败' }],
  },
  {
    id: 'archived-cleanup-busy',
    title: '归档：空会话清理进行中',
    page: 'archived',
    patches: [{ path: 'sessionCleanup.deleteFiles', kind: 'delay', ms: 6000 }],
    steps: [
      { waitFor: '.settings-card .settings-action-btn' },
      { click: '.settings-card .settings-action-btn' },
      { waitFor: '.settings-action-btn.danger' },
      { click: '.settings-action-btn.danger' },
      { wait: 150 },
    ],
    expect: ['.settings-action-btn.danger[disabled]'],
    expectText: [{ selector: '.settings-action-btn.danger', text: '清理中' }],
  },
  {
    id: 'archived-cleanup-fail',
    title: '归档：空会话清理失败的 alert 行',
    page: 'archived',
    patches: [{ path: 'sessionCleanup.deleteFiles', kind: 'reject', message: '预览注入：无法删除文件' }],
    steps: [
      { waitFor: '.settings-card .settings-action-btn' },
      { click: '.settings-card .settings-action-btn' },
      { waitFor: '.settings-action-btn.danger' },
      { click: '.settings-action-btn.danger' },
      { waitFor: '.settings-error-row[role="alert"]' },
    ],
    expect: ['.settings-error-row[role="alert"]', '.settings-error-row button'],
    expectText: [{ selector: '.settings-error-row', text: '清理空会话失败' }],
    note: 'clean() 原来只有 try/finally：删除被拒时是未处理拒绝，确认按钮重新可用、没有一个字说明失败。已补 catch（见报告 §3）。',
  },
  {
    id: 'archived-cleanup-done',
    title: '归档：空会话清理完成后的结果说明',
    page: 'archived',
    patches: [{ path: 'sessionCleanup.deleteFiles', kind: 'resolve', value: { ok: true, deleted: ['session-empty-1', 'session-empty-2'], skipped: [], freedBytes: 48213, dir: 'C:\\\\Users\\\\preview\\\\.aicode\\\\sessions' } }],
    steps: [
      { waitFor: '.settings-card .settings-action-btn' },
      { click: '.settings-card .settings-action-btn' },
      { waitFor: '.settings-action-btn.danger' },
      { click: '.settings-action-btn.danger' },
      { wait: 200 },
    ],
    expect: ['.app-row-desc'],
    expectText: [{ selector: '.app-row-desc', text: '已删除 2 个空会话' }],
  },
  {
    id: 'archived-cleanup-confirm',
    title: '归档：空会话清理的两步确认',
    page: 'archived',
    steps: [{ waitFor: '.settings-card .settings-action-btn' }, { click: '.settings-card .settings-action-btn' }, { wait: 80 }],
    expect: ['.settings-action-btn.danger'],
    expectText: [{ selector: '.settings-action-btn.danger', text: '确认清理' }],
  },
  {
    id: 'archived-longtitle',
    title: '归档：超长会话标题的布局',
    page: 'archived',
    patches: [{ path: 'sessions.listArchived', kind: 'resolve', value: [
      { id: 'session-long-1', title: LONG_ARCHIVED_TITLE, baseTitle: LONG_ARCHIVED_TITLE, pinned: false, archived: true, updatedAt: new Date().toISOString(), messageCount: 14 },
    ] }],
    steps: [
      { wait: 120 },
      // 长标题的“有没有撑破行”只能量，不能只看存在：实测 .app-row-title 没有
      // ellipsis 规则，会折行而不是截断，行与列表都没有横向溢出（按钮没被挤出）。
      { eval: '(() => { const row = document.querySelector(".app-row"); if (!row) throw new Error("归档行缺失"); if (row.scrollWidth > row.clientWidth + 1) throw new Error(`归档行横向溢出 ${row.scrollWidth} > ${row.clientWidth}`); const card = row.parentElement; if (card && card.scrollWidth > card.clientWidth + 1) throw new Error("归档列表横向溢出"); })()' },
    ],
    expect: ['.app-row-title'],
  },

  /* 浏览器 — 只有禁用控件，没有数据源 -------------------------------------- */
  {
    id: 'browser-disabled-controls',
    title: '浏览器：尚未接入的控件（禁用，原因只在 title 里）',
    page: 'browser',
    expect: ['.app-row .settings-action-btn[disabled]', '.setting-row-control .settings-inline-edit[disabled]'],
    note: '扩展“安装”和“默认主页”都因没有数据源而禁用，原因写在 title（tooltip）里；键盘/触屏用户看不到为什么。',
  },

  /* 插件 — unavailable / disabled / loading / error / empty ----------------- */
  {
    id: 'plugins-unavailable',
    title: '插件：不可用条目（带原因徽标，开关禁用）',
    page: 'plugins',
    expect: ['.plugin-unavailable-badge', '.app-row-disabled .toggle[disabled]'],
    expectText: [{ selector: '.plugin-unavailable-badge', text: '需要 Git 仓库' }],
    note: '目录里没有“安装/更新”概念：插件是随应用内建的，只有可用/不可用与启用开关。',
  },
  {
    id: 'plugins-all-disabled',
    title: '插件：全部关闭（开关均为 off）',
    page: 'plugins',
    settings: (base) => ({ ...base, preferences: { ...base.preferences, pluginsEnabled: [] } }),
    expect: ['.toggle[aria-checked="false"]'],
  },
  {
    id: 'plugins-loading',
    title: '插件：目录加载中',
    page: 'plugins',
    patches: [
      { path: 'plugins.catalog', kind: 'delay', ms: 6000 },
      { path: 'plugins.status', kind: 'delay', ms: 6000 },
    ],
    steps: [{ wait: 120 }],
    expect: ['.settings-placeholder'],
    expectText: [{ selector: '.settings-placeholder', text: '插件目录加载中' }],
    note: '加载态同样是静态文本，没有 aria-live。',
  },
  {
    id: 'plugins-load-error',
    title: '插件：目录加载失败的 alert 行',
    page: 'plugins',
    patches: [{ path: 'plugins.catalog', kind: 'reject', message: '预览注入：目录读取失败' }],
    steps: [{ waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]'],
    expectText: [{ selector: '.settings-error-row', text: '插件目录加载失败' }],
  },
  {
    id: 'plugins-empty-catalog',
    title: '插件：目录为空',
    page: 'plugins',
    patches: [{ path: 'plugins.catalog', kind: 'resolve', value: [] }],
    steps: [{ wait: 120 }],
    expect: ['.settings-placeholder'],
    expectText: [{ selector: '.settings-placeholder', text: '插件目录为空' }],
  },

  /* 电脑操控 — the one real confirm dialog in settings ---------------------- */
  {
    id: 'computer-desktop-confirm',
    title: '电脑操控：切到桌面模式前的确认弹层',
    page: 'computer',
    needsShellCss: true,
    steps: [{ waitFor: '.toggle' }, { click: '.toggle' }, { waitFor: '.confirm-dialog' }],
    expect: ['.confirm-dialog[role="alertdialog"]', '.confirm-dialog-confirm'],
    expectText: [{ selector: '.confirm-dialog h2', text: '允许桌面操控' }],
    note: '设置页里唯一的 modal：aria-modal + aria-labelledby + aria-describedby 齐全，测量它的对比度与 1100×720 下的溢出。',
  },
  {
    id: 'computer-extension-checking',
    title: '电脑操控：浏览器扩展检测中',
    page: 'computer',
    patches: [{ path: 'computer.detectBrowserExtension', kind: 'delay', ms: 5000 }],
    steps: [{ wait: 150 }],
    expect: ['.settings-card > .app-row:nth-of-type(2) .app-row-status'],
    expectText: [{ selector: '.settings-card > .app-row:nth-of-type(2) .app-row-status', text: '检测中' }],
    note: 'extensionState=null 时行内是“检测中…”，没有 role=status；检测完成前后两态都是纯文本。',
  },

  /* 用量 — details view / empty / error ------------------------------------ */
  {
    id: 'usage-details',
    title: '用量：明细表',
    page: 'usage',
    steps: [{ eval: '[...document.querySelectorAll(".segmented-item")].find(b => b.textContent.trim() === "明细")?.click()' }, { waitFor: '.usage-records-table' }],
    expect: ['.usage-records-table', '.usage-export-csv'],
  },
  {
    id: 'usage-details-empty',
    title: '用量：时间窗口内没有明细（有别于整页空）',
    page: 'usage',
    // Was `?scenario=empty`, which zeroes the hourly summary too — with no
    // hourly data the 明细 branch never renders, so the old assertion matched
    // the "暂无小时粒度用量" block and measured nothing it claimed to.
    patches: [{ path: 'usage.records', kind: 'resolve', value: { records: [], total: 0 } }],
    steps: [{ eval: '[...document.querySelectorAll(".segmented-item")].find(b => b.textContent.trim() === "明细")?.click()' }, { waitFor: '.settings-empty' }],
    expect: ['.settings-empty'],
    expectText: [{ selector: '.settings-empty', text: '暂无详细记录' }],
  },
  {
    id: 'usage-details-error',
    title: '用量：明细加载失败的 alert 行',
    page: 'usage',
    patches: [{ path: 'usage.records', kind: 'reject', message: '预览注入：记录读取失败' }],
    steps: [{ eval: '[...document.querySelectorAll(".segmented-item")].find(b => b.textContent.trim() === "明细")?.click()' }, { waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]', '.settings-error-row button'],
  },
  {
    id: 'usage-records-loading',
    title: '用量：明细加载中',
    page: 'usage',
    patches: [{ path: 'usage.records', kind: 'delay', ms: 5000 }],
    steps: [{ eval: '[...document.querySelectorAll(".segmented-item")].find(b => b.textContent.trim() === "明细")?.click()' }, { waitFor: '.usage-loading' }],
    expect: ['.usage-loading'],
    expectText: [{ selector: '.usage-loading', text: '加载详细记录中' }],
    note: '这个加载态是一个裸 div，没有 role=status / aria-live（与 archived-loading 同一类缺口）。',
  },
  {
    id: 'usage-summary-error',
    title: '用量：汇总读取失败的 alert 行（此前渲染成“暂无数据”）',
    page: 'usage',
    patches: [{ path: 'usage.summary', kind: 'reject', message: '预览注入：账本读取失败' }],
    steps: [{ waitFor: '.settings-error-row[role="alert"]' }],
    expect: ['.settings-error-row[role="alert"]', '.settings-error-row button'],
    expectText: [{ selector: '.settings-error-row', text: '用量数据加载失败' }],
    note: 'summary / hourly 的 catch 原本只把数据置 null，页面于是显示“暂无真实用量数据”，与真的没用量无法区分。已补错误行（见报告 §3）。',
  },
  {
    id: 'usage-refresh-busy',
    title: '用量：手动刷新进行中',
    page: 'usage',
    patches: [{ path: 'usage.hourly', kind: 'delay', ms: 5000 }],
    steps: [{ waitFor: 'button[aria-label="刷新"]' }, { click: 'button[aria-label="刷新"]' }, { wait: 120 }],
    expect: ['button[aria-label="刷新"][disabled]'],
    note: '进行中只靠 disabled + 内联 opacity 0.5 表达，没有文案变化。',
  },
  {
    id: 'usage-export-busy',
    title: '用量：CSV 导出进行中',
    page: 'usage',
    patches: [{ path: 'usage.exportCsv', kind: 'delay', ms: 5000 }],
    steps: [
      { eval: '[...document.querySelectorAll(".segmented-item")].find(b => b.textContent.trim() === "明细")?.click()' },
      { waitFor: '.usage-export-csv' },
      { click: '.usage-export-csv' },
      { wait: 120 },
    ],
    expect: ['.usage-export-csv[disabled]'],
  },

  /* 记忆库 — separate surface (main view, not a settings nav page) ---------- */
  {
    id: 'memory-data',
    title: '记忆库：有数据',
    surface: 'memory',
    needsShellCss: true,
    patches: [
      { path: 'memory.global', kind: 'resolve', value: MEMORY_SNAPSHOT },
      { path: 'memory.listProjects', kind: 'resolve', value: { ok: true, projects: MEMORY_PROJECT_NOTES } },
    ],
    steps: [{ waitFor: '.mem-project-head' }],
    expect: ['.mem-project-head', '.mem-timeline', '.mem-note-group'],
  },
  {
    id: 'memory-empty',
    title: '记忆库：空',
    surface: 'memory',
    needsShellCss: true,
    patches: [
      { path: 'memory.global', kind: 'resolve', value: EMPTY_MEMORY },
      { path: 'memory.listProjects', kind: 'resolve', value: { ok: true, projects: [] } },
    ],
    steps: [{ waitFor: '.gtx-repo-empty' }],
    expect: ['.gtx-repo-empty'],
    expectText: [{ selector: '.gtx-repo-empty', text: '还没有任何编辑记录' }],
  },
  {
    id: 'memory-no-results',
    title: '记忆库：搜索无结果',
    surface: 'memory',
    needsShellCss: true,
    patches: [
      { path: 'memory.global', kind: 'resolve', value: MEMORY_SNAPSHOT },
      { path: 'memory.listProjects', kind: 'resolve', value: { ok: true, projects: MEMORY_PROJECT_NOTES } },
    ],
    steps: [{ waitFor: '.mem-search input' }, { type: { selector: '.mem-search input', value: 'zzzz-no-such' } }, { wait: 100 }],
    expect: ['.gtx-empty'],
    expectText: [{ selector: '.gtx-empty', text: '没有匹配' }],
  },
  {
    id: 'memory-note-dialog',
    title: '记忆库：项目笔记弹层',
    surface: 'memory',
    needsShellCss: true,
    patches: [
      { path: 'memory.global', kind: 'resolve', value: MEMORY_SNAPSHOT },
      { path: 'memory.listProjects', kind: 'resolve', value: { ok: true, projects: MEMORY_PROJECT_NOTES } },
      { path: 'memory.read', kind: 'resolve', value: { ok: true, content: '# MEMORY.md\n\n- 预览注入的笔记内容\n', updatedAt: Date.now() } },
    ],
    steps: [{ waitFor: '.mem-note-file' }, { click: '.mem-note-file' }, { waitFor: '.mem-note' }],
    expect: ['.mem-note[role="dialog"]', '.mem-note button'],
    note: '记忆笔记弹层是固定定位卡片：role=dialog 但没有 aria-modal，也没有焦点陷阱。归入焦点负责人。',
  },
  {
    id: 'memory-error',
    title: '记忆库：读取失败的 alert 行',
    surface: 'memory',
    needsShellCss: true,
    patches: [
      { path: 'memory.global', kind: 'resolve', value: { ok: false, error: '读取全局记忆失败（预览注入）' } },
      { path: 'memory.listProjects', kind: 'resolve', value: { ok: true, projects: [] } },
    ],
    steps: [{ waitFor: '.gtx-error[role="alert"]' }],
    expect: ['.gtx-error[role="alert"]', '.gtx-error button'],
  },
  {
    id: 'memory-loading',
    title: '记忆库：加载中',
    surface: 'memory',
    needsShellCss: true,
    patches: [
      { path: 'memory.global', kind: 'delay', ms: 6000 },
      { path: 'memory.listProjects', kind: 'delay', ms: 6000 },
    ],
    steps: [{ wait: 120 }],
    expect: ['.mem-loading[role="status"]'],
  },

  /* Toast — the app-wide live region, rendered in the settings shell --------- */
  {
    id: 'toast-success',
    title: 'Toast：成功提示（role=status, aria-live=polite）',
    page: 'usage',
    needsShellCss: true,
    toast: true,
    steps: [{ eval: 'window.dispatchEvent(new CustomEvent("zcode:notice", { detail: { kind: "success", title: "用量已导出", body: "43 条记录已保存到 .aicode/exports/usage-24h.csv。" } }))' }, { waitFor: '.toast' }],
    expect: ['.toast', '.toast-layer[role="status"]'],
  },
  {
    id: 'toast-error',
    title: 'Toast：错误提示（aria-live=assertive）',
    page: 'usage',
    needsShellCss: true,
    toast: true,
    steps: [{ eval: 'window.dispatchEvent(new CustomEvent("zcode:notice", { detail: { kind: "error", title: "导出失败", body: "无法写入文件或复制到剪贴板。" } }))' }, { waitFor: '.toast' }],
    expect: ['.toast', '.toast-layer[aria-live="assertive"]'],
  },
];

export const STATE_IDS = PREVIEW_STATES.map((state) => state.id);

export function findState(id: string | null): PreviewStateDef | null {
  if (!id) return null;
  return PREVIEW_STATES.find((state) => state.id === id) ?? null;
}

export function settingsForState(base: DesktopSettings, state: PreviewStateDef | null): DesktopSettings {
  return state?.settings ? state.settings(base) : base;
}

/**
 * The catalogue, published for the runner (`scripts/settings-states-preview.cjs`)
 * so the two can never drift: the runner asks the fixture which states exist
 * instead of keeping a second copy of the list. `query` travels with it because
 * a state that needs `?scenario=empty` has to put that in the *load URL* — the
 * fixture mock reads it once, at module evaluation, before any component (or
 * drive step) exists to change it.
 */
if (typeof window !== 'undefined') {
  (window as unknown as { __previewStates?: unknown }).__previewStates = PREVIEW_STATES.map((state) => ({
    id: state.id,
    query: state.query ?? '',
    page: state.page ?? '',
    surface: state.surface ?? 'settings',
    title: state.title,
  }));
  (window as unknown as { __previewStateIds?: unknown }).__previewStateIds = STATE_IDS;
}

/* ── host namespaces the fixture mock deliberately omits ──────────────────── */

/**
 * `settings-preview-mock.ts` installs only the namespaces settings pages use;
 * anything else is absent on purpose so a page that starts depending on a new
 * one fails loudly. The memory panel and ToastLayer are not settings pages, so
 * their namespaces are added here — only by this module, and only as real
 * shapes. A namespace that already exists is left untouched.
 */
export function ensureHostNamespaces(): void {
  const host = (window as unknown as { zcodeDesktop?: Record<string, unknown> }).zcodeDesktop;
  if (!host) return;
  if (!host.memory) {
    host.memory = {
      global: async () => MEMORY_SNAPSHOT,
      listProjects: async () => ({ ok: true, projects: MEMORY_PROJECT_NOTES }),
      read: async (_workspaceId: string, fileName: string) => ({ ok: true, content: `# ${fileName}\n`, updatedAt: Date.now() }),
    };
  }
  if (!host.agent) host.agent = { onEvent: () => () => undefined };
}

/* ── patch machinery ─────────────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Two frames when frames are available, but never more than a short timeout.
 *
 * A hidden Electron window throttles requestAnimationFrame hard (the probe
 * window is `show: false` so it never steals the user's focus). Waiting on two
 * frames unconditionally cost ~1s per drive step — a 46-state sweep spent 4 of
 * its 5 minutes doing nothing — and outlived short-lived UI: the API-key button
 * says 已保存 for 2s, which a slow settle walked past.
 */
const settle = () => new Promise<void>((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => requestAnimationFrame(finish));
  setTimeout(finish, 120);
});

type AnyRecord = Record<string, unknown>;
const originals = new Map<string, { owner: AnyRecord; key: string; fn: unknown }>();

function lookup(path: string): { owner: AnyRecord; key: string } | null {
  const host = (window as unknown as { zcodeDesktop?: AnyRecord }).zcodeDesktop;
  if (!host) return null;
  const parts = path.split('.');
  let owner: AnyRecord = host;
  for (const part of parts.slice(0, -1)) {
    const next = owner?.[part];
    if (!next || typeof next !== 'object') return null;
    owner = next as AnyRecord;
  }
  return { owner, key: parts[parts.length - 1] };
}

/** Put every patched host method back the way the mock installed it. */
export function restoreHost(): void {
  for (const [path, saved] of originals) {
    saved.owner[saved.key] = saved.fn;
    void path;
  }
  originals.clear();
}

export function applyHostPatches(patches: HostPatch[]): void {
  restoreHost();
  for (const patch of patches) {
    const target = lookup(patch.path);
    if (!target) continue;
    const previous = target.owner[target.key];
    if (!originals.has(patch.path)) originals.set(patch.path, { owner: target.owner, key: target.key, fn: previous });
    const original = previous as (...args: unknown[]) => Promise<unknown>;
    if (patch.kind === 'reject') {
      target.owner[target.key] = async () => { throw new Error(patch.message ?? '预览注入失败'); };
    } else if (patch.kind === 'resolve') {
      target.owner[target.key] = async () => patch.value;
    } else {
      target.owner[target.key] = async (...args: unknown[]) => {
        await sleep(patch.ms ?? 1000);
        return typeof original === 'function' ? original(...args) : undefined;
      };
    }
  }
}

/* ── drive machinery ─────────────────────────────────────────────────────── */

export async function waitForSelector(selector: string, timeout = 5000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (document.querySelector(selector)) return true;
    await settle();
    await sleep(40);
  }
  return false;
}

function typeInto(selector: string, value: string): void {
  const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function runDrive(steps: DriveStep[]): Promise<void> {
  for (const step of steps) {
    if ('click' in step) {
      const nodes = [...document.querySelectorAll(step.click)];
      const el = nodes[step.nth ?? 0] as HTMLElement | undefined;
      if (el) el.click();
      await settle();
      await sleep(40);
    } else if ('type' in step) {
      typeInto(step.type.selector, step.type.value);
      await settle();
      await sleep(30);
    } else if ('key' in step) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: step.key.key,
        ctrlKey: Boolean(step.key.ctrlKey),
        shiftKey: Boolean(step.key.shiftKey),
        altKey: Boolean(step.key.altKey),
        metaKey: Boolean(step.key.metaKey),
        bubbles: true,
        cancelable: true,
      }));
      await settle();
      await sleep(40);
    } else if ('wait' in step) {
      await sleep(step.wait);
      await settle();
    } else if ('waitFor' in step) {
      await waitForSelector(step.waitFor, step.timeout ?? 5000);
      await settle();
    } else if ('eval' in step) {
      // eslint-disable-next-line no-eval
      (0, eval)(step.eval);
      await settle();
      await sleep(40);
    }
  }
}

/** Load workspace-shell.css on demand: dialogs, toasts and the memory panel
 *  are styled there, and importing it for every settings page would change the
 *  120-combination baseline. Vite injects a <style> tag for a dynamically
 *  imported stylesheet, so this is a one-shot side effect. */
let shellCssPromise: Promise<unknown> | null = null;
export function ensureShellCss(): Promise<unknown> {
  if (!shellCssPromise) shellCssPromise = import('../src/workspace-shell.css');
  return shellCssPromise;
}

/** The subset of App.tsx's applyTheme the fixture mirrors for theme states. */
export function applyThemePreference(theme: string | undefined): void {
  if (theme !== 'dark' && theme !== 'light' && theme !== 'system') return;
  const resolved = theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
}
