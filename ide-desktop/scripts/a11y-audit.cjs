/*
 * Accessibility audit for the renderer: text contrast, UI border contrast,
 * accessible names, and text below 10px.
 *
 * Why this reads pixels at all: this app paints several surfaces with
 * background-image gradients (approval cards, failed tool cards). For those,
 * getComputedStyle().backgroundColor is rgba(0,0,0,0), so a colour-only walk up
 * the DOM silently falls through to --bg-app and reports a ratio for a surface
 * nobody is looking at — the old throwaway probe graded the risk badge at 5.90:1
 * against the token stack while the painted card tint measures 5.16:1. Both pass
 * AA, which is exactly the problem: no regression on that path was visible.
 *
 * So: resolve the backdrop from computed backgroundColor when that is honest
 * (opaque layers, no painting tricks in the chain), and only when the chain
 * contains a gradient / image / filter / blend / non-opaque ancestor / alpha
 * backdrop, hide the glyphs, capture the page and take the per-row pixel mode as
 * the real surface. Solid token surfaces never pay the screenshot cost.
 *
 * Results: out/a11y-audit/report.json (machine readable), summary.md (human) and
 * the same summary on stdout. Exit code is 1 when anything violates a threshold,
 * so this can sit in CI: `npm run a11y`.
 *
 * Usage:
 *   electron scripts/a11y-audit.cjs
 *   electron scripts/a11y-audit.cjs --verbose
 *   electron scripts/a11y-audit.cjs --theme=dark --scenario=approval
 *   electron scripts/a11y-audit.cjs --out=out/a11y-audit
 *   electron scripts/a11y-audit.cjs --self-test   (proves every rule can fire)
 *   electron scripts/a11y-audit.cjs --page=panels
 *   electron scripts/a11y-audit.cjs --page=settings --theme=dark --viewport=1100x720
 *
 * Surfaces (`--page`). Until this round the audit only reached what
 * scripts/ui-preview.tsx renders — the conversation shell, rail and composer —
 * because that was the only fixture wired to a window. Settings and the
 * workspace quality panels had no entry at all, so a whole new card design
 * (--border-subtle, ~1.13:1) shipped with no gate on it. `--page` selects the
 * fixture *and* the set of render states:
 *
 *   chat     (default) scripts/ui-preview.tsx · 9 scenarios, the original sweep
 *   panels   scripts/states-preview.tsx · the 5 quality panels (CodeReview,
 *            Coverage, Performance, QualityDashboard, Refactor) in their result
 *            and placeholder states — the cards whose borders this round is for
 *   settings scripts/settings-preview.tsx · the 15 settings pages, `filled` and
 *            `?scenario=empty` (zero data)
 *   workspace scripts/workspace-shell-preview.tsx · the workspace shell: file
 *            tree, Git panel, editor tabs, bottom terminal, pending diff review
 *   bg-browser scripts/bg-browser-workbench-preview.tsx · the background browser
 *            workbench panel (address bar, actions, page links, capture)
 *   gui-control scripts/gui-control-preview.tsx · 电脑操控: window map, control
 *            list, window capture, the confirm bar for foreground actions
 *   subagent scripts/subagent-directory-preview.tsx · 子智能体目录 (running /
 *            finished split, status badges, expanded answer)
 *   tasks    scripts/task-board-preview.tsx · the task-board card (plan, stages,
 *            acceptance, verification badges, actions)
 *
 * The four surfaces after `settings` share one property: every state is reachable
 * offline. Their fixtures stub `window.zcodeDesktop` and answer like the CLI does
 * — no PTY, no hidden browser, no desktop capture, no network. That is the bar for
 * a new page here; a fixture that needs a live CLI process or a socket does not
 * get one (see audit-notes/ui/a11y-coverage.md §3).
 *
 * Two things change with the page, and only with the page:
 *   - the border pass grades every element with a visible border
 *     (`--border-subtle` card edges are not controls; the control-only set
 *     would have skipped exactly the new design), and
 *   - an element that is neither a control nor a status graphic is reported as
 *     `review` rather than `fail` when its edge is its only boundary — a card
 *     edge is decoration, a chip with no label is not.
 * The chat page keeps the control-only set, so its numbers are comparable with
 * every earlier run.
 *
 * Border note: a control's border is compared against the surface just outside
 * it (its parent's resolved backdrop), because that is the edge it delimits. When
 * that surface is only knowable from pixels, the sample comes from inside the
 * control's own box — under a card gradient that is the same tint at that height.
 */

require('./lib/probe-guard.cjs');

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = argv.find((argument) => argument.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const verbose = flag('verbose');
// Which surface family this run covers — see PAGES below. `chat` is the default
// so `npm run a11y` keeps auditing exactly the surface it audited before.
const pageName = option('page', 'chat');
const PAGE_NAMES = ['chat', 'panels', 'settings', 'workspace', 'bg-browser', 'gui-control', 'subagent', 'tasks'];
if (!PAGE_NAMES.includes(pageName)) { console.error(`unknown --page=${pageName}; known: ${PAGE_NAMES.join(', ')}`); process.exit(2); }
const outDir = path.resolve(root, option('out', path.join('out', 'a11y-audit', pageName === 'chat' ? '' : pageName)));
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'report.json');
const summaryPath = path.join(outDir, 'summary.md');

const VIEWPORT = { width: 1440, height: 960 };
const FONT_BASE = '14px';
const THRESHOLDS = { text: 4.5, largeText: 3, uiBorder: 3, minFontSize: 10 };

// The preview exposes one scenario per surface and per approval risk tint.
const ALL_SCENARIOS = ['empty', 'conversation', 'running', 'approval', 'approval-shell', 'approval-network', 'failure', 'tool-failure', 'changes'];
const onlyScenario = option('scenario', null);
const onlyTheme = option('theme', null);
const scenarios = onlyScenario ? ALL_SCENARIOS.filter((name) => name === onlyScenario) : ALL_SCENARIOS;
const themes = onlyTheme ? ['light', 'dark'].filter((name) => name === onlyTheme) : ['light', 'dark'];
if (!scenarios.length) { console.error(`unknown --scenario=${onlyScenario}; known: ${ALL_SCENARIOS.join(', ')}`); process.exit(2); }
if (!themes.length) { console.error(`unknown --theme=${onlyTheme}; known: light, dark`); process.exit(2); }

const logPath = path.join(outDir, 'audit.log');
fs.writeFileSync(logPath, '');
const log = (message) => { fs.appendFileSync(logPath, `${message}\n`); if (verbose) console.log(message); };

app.setPath('userData', path.join(outDir, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

let server;
let window;

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── pages ──────────────────────────────────────────────────────────────────
 * Each entry names a fixture, the render states it can reach, the viewports to
 * measure and how to bring one state on screen. `prepare` receives the case and
 * runs inside the renderer; the theme is applied by the runner afterwards, so a
 * fixture that reloads (settings, for ?scenario=empty) still gets its theme.
 *
 * `borderSelectors` is what the border pass grades on top of controls and badge
 * chips. Empty for the chat shell, whose baseline is the control set; services
 * that paint their own cards pass ['body *'] so card edges are graded too. */
const PANEL_NAMES = ['coverage', 'quality', 'code-review', 'performance', 'refactor'];
const PANEL_CASES = [
  ...PANEL_NAMES.map((name) => ({ name: `${name}/data`, panel: name, mode: 'data', scroll: true })),
  ...PANEL_NAMES.map((name) => ({ name: `${name}/empty`, panel: name, mode: 'empty', scroll: true })),
];
// Refactor only paints its preview after a click: the panel renders a form with
// a single "预览重构" button, so the result state needs one drive step.
for (const item of PANEL_CASES) if (item.panel === 'refactor' && item.mode === 'data') item.drive = 'document.querySelector(".refactor-form .preview-btn")?.click()';

const SETTINGS_PAGES = ['general', 'appearance', 'model', 'usage', 'personalize', 'shortcuts', 'plugins', 'browser', 'computer', 'hooks', 'connections', 'git', 'environment', 'worktrees', 'archived'];
// Scenario-major: `?scenario=` is read once at module load, so keeping the two
// scenarios in two blocks turns 30 page switches into 2 reloads per pass.
const SETTINGS_CASES = [
  ...SETTINGS_PAGES.map((name) => ({ name: `${name}/filled`, page: name, query: '' })),
  ...SETTINGS_PAGES.map((name) => ({ name: `${name}/empty`, page: name, query: '?scenario=empty' })),
];

/* ── workspace shell ───────────────────────────────────────────────────────
 * One case per view the shell can show, because the shell shows one at a time
 * (App.tsx switches mainView between 文件树 / 编辑器 / Git, and the terminal
 * docks at the bottom regardless). `editor/open` really mounts monaco-editor:
 * monacoRuntime.ts points @monaco-editor/react at the local package, so no CDN
 * request is involved. */
const WORKSPACE_CASES = [
  { name: 'files/mixed', view: 'files', variant: 'mixed', drive: 'expand-tree' },
  { name: 'git/mixed', view: 'git', variant: 'mixed' },
  { name: 'editor/empty', view: 'editor', variant: 'empty' },
  { name: 'editor/open', view: 'editor', variant: 'open' },
  { name: 'terminal/tabs', view: 'terminal', variant: 'mixed' },
  { name: 'diff/pending', view: 'diff', variant: 'mixed' },
];

// The background browser workbench: nothing open, a page inspected (its links +
// capture), a download that landed on disk. `failed` shows the refused-policy
// output line, which is the panel's only error surface.
const BG_BROWSER_CASES = [
  { name: 'idle', stage: 'idle' },
  { name: 'inspected', stage: 'inspected' },
  { name: 'saved', stage: 'saved' },
  { name: 'failed', stage: 'failed' },
];

// 电脑操控: the window list on its own, a selected window with its control list,
// a window capture, and the confirmation bar in front of a foreground action.
const GUI_CONTROL_CASES = [
  { name: 'windows', stage: 'windows' },
  { name: 'detail', stage: 'detail' },
  { name: 'shot', stage: 'shot' },
  { name: 'confirm', stage: 'confirm' },
];

const SUBAGENT_CASES = [
  { name: 'mixed', stage: 'mixed' },
  { name: 'expanded', stage: 'expanded' },
  { name: 'empty', stage: 'empty' },
  { name: 'error', stage: 'error' },
];

const TASK_BOARD_CASES = [
  { name: 'active', stage: 'active' },
  { name: 'detail', stage: 'detail' },
  { name: 'waiting', stage: 'waiting' },
  { name: 'invalid', stage: 'invalid' },
];

const HIDE_FIXTURE_CHROME = `(() => {
  // The panel fixture's own toolbar and motion probes are harness, not product:
  // hiding them keeps their buttons out of the border and control counts.
  const tab = document.querySelector('[data-panel]');
  if (tab && tab.parentElement) tab.parentElement.style.display = 'none';
  const motion = document.querySelector('[data-motion-fixture]');
  if (motion) motion.style.display = 'none';
})()`;

const RESET_SCROLL = `(() => {
  window.scrollTo(0, 0);
  for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
})()`;

// Expand one directory node in the file tree by its visible name. Two of these
// (src, then auth) put a nested file row on screen, which is where the tree's
// indentation row, disclosure and file rows all get graded at once.
const expandTreeNode = (name) => `(() => {
  const row = [...document.querySelectorAll('.tree-row.directory')].find((node) => (node.querySelector('.tree-node-name')?.textContent || '') === ${JSON.stringify(name)});
  if (row) row.click();
})()`;

const PAGES = {
  chat: {
    title: '对话壳：侧栏 / 会话流 / composer',
    route: '/__a11y-audit',
    entry: '/scripts/ui-preview.tsx',
    cases: scenarios.map((name) => ({ name })),
    viewports: [{ width: VIEWPORT.width, height: VIEWPORT.height }],
    borderSelectors: [],
    reload: false,
    // Which state the self test injects its fixtures over: the rules are proved
    // on whichever surface the page brought up, never on an empty body.
    selfTest: 'window.uiPreview.scenario("conversation")',
    prepare: async (item) => {
      await evaluate(`window.uiPreview.scenario(${JSON.stringify(item.name)}); document.querySelector('.chat-shell').style.setProperty('--panel-w', '0px'); document.documentElement.style.setProperty('--fs-base', ${JSON.stringify(FONT_BASE)});`);
    },
  },
  panels: {
    title: '工作区质量面板：CodeReview / Coverage / Performance / QualityDashboard / Refactor',
    route: '/__a11y-audit/panels',
    entry: '/scripts/states-preview.tsx',
    cases: PANEL_CASES,
    viewports: [{ width: 1440, height: 960 }, { width: 1100, height: 720 }],
    borderSelectors: ['body *'],
    reload: false,
    selfTest: 'window.statesPreview.reset("coverage", "data")',
    prepare: async (item) => {
      await evaluate(`window.statesPreview.reset(${JSON.stringify(item.panel)}, ${JSON.stringify(item.mode)})`);
      await settle();
      await sleep(60);
      await evaluate(HIDE_FIXTURE_CHROME);
      if (item.drive) { await evaluate(item.drive); await settle(); await sleep(120); }
      await evaluate(RESET_SCROLL);
    },
  },
  settings: {
    title: '设置页：15 页 × filled / empty',
    route: '/__a11y-audit/settings',
    entry: '/scripts/settings-preview.tsx',
    cases: SETTINGS_CASES,
    viewports: [{ width: 1440, height: 960 }, { width: 1100, height: 720 }],
    borderSelectors: ['body *'],
    reload: true,
    selfTest: 'window.settingsPreview.open("general")',
    prepare: async (item) => {
      await evaluate(`window.settingsPreview.open(${JSON.stringify(item.page)})`);
      await settle();
      await sleep(80);
      await evaluate(RESET_SCROLL);
    },
  },
  /* The five pages below share one contract: the fixture stubs the desktop
   * bridge, so the surface renders offline and every state is reachable by
   * clicking what a user would click. They also share the grading rule the
   * panels and settings pages already use — every visible border is graded, and
   * an edge that is neither a control nor a status graphic is `review` rather
   * than `fail`, because a shell's container edges are decoration. */
  workspace: {
    title: '工作区外壳：文件树 / 编辑器 / Git / 终端 / 待确认差异',
    route: '/__a11y-audit/workspace',
    entry: '/scripts/workspace-shell-preview.tsx',
    cases: WORKSPACE_CASES,
    viewports: [{ width: 1440, height: 960 }],
    borderSelectors: ['body *'],
    reload: false,
    selfTest: `window.workspaceShellPreview.reset("git", "mixed")`,
    prepare: async (item) => {
      await evaluate(`window.workspaceShellPreview.reset(${JSON.stringify(item.view)}, ${JSON.stringify(item.variant)})`);
      await settle();
      await sleep(120);
      if (item.drive === 'expand-tree') {
        await evaluate(expandTreeNode('src'));
        await settle();
        await sleep(120);
        await evaluate(expandTreeNode('auth'));
        await settle();
        await sleep(120);
      }
      await evaluate(RESET_SCROLL);
    },
  },
  'bg-browser': {
    title: '后台浏览器工作台：地址栏 / 动作 / 页面链接 / 截图',
    route: '/__a11y-audit/bg-browser',
    entry: '/scripts/bg-browser-workbench-preview.tsx',
    cases: BG_BROWSER_CASES,
    viewports: [{ width: 1440, height: 960 }],
    borderSelectors: ['body *'],
    reload: false,
    selfTest: `window.bgBrowserPreview.stage("idle")`,
    prepare: async (item) => {
      await evaluate(`window.bgBrowserPreview.stage(${JSON.stringify(item.stage)})`);
      await settle();
      await sleep(120);
      await evaluate(RESET_SCROLL);
    },
  },
  'gui-control': {
    title: '电脑操控：窗口地图 / 控件列表 / 窗口截图 / 前台操作确认',
    route: '/__a11y-audit/gui-control',
    entry: '/scripts/gui-control-preview.tsx',
    cases: GUI_CONTROL_CASES,
    viewports: [{ width: 1440, height: 960 }],
    borderSelectors: ['body *'],
    reload: false,
    selfTest: `window.guiControlPreview.stage("windows")`,
    prepare: async (item) => {
      await evaluate(`window.guiControlPreview.stage(${JSON.stringify(item.stage)})`);
      await settle();
      await sleep(120);
      await evaluate(RESET_SCROLL);
    },
  },
  subagent: {
    title: '子智能体目录：运行中 / 已结束 / 展开结果 / 空态与错误',
    route: '/__a11y-audit/subagent',
    entry: '/scripts/subagent-directory-preview.tsx',
    cases: SUBAGENT_CASES,
    viewports: [{ width: 1440, height: 960 }],
    borderSelectors: ['body *'],
    reload: false,
    selfTest: `window.subagentDirectoryPreview.stage("mixed")`,
    prepare: async (item) => {
      await evaluate(`window.subagentDirectoryPreview.stage(${JSON.stringify(item.stage)})`);
      await settle();
      await sleep(120);
      await evaluate(RESET_SCROLL);
    },
  },
  tasks: {
    title: '任务计划卡：计划 / 阶段 / 验收 / 验证徽标 / 动作',
    route: '/__a11y-audit/tasks',
    entry: '/scripts/task-board-preview.tsx',
    cases: TASK_BOARD_CASES,
    viewports: [{ width: 1440, height: 960 }],
    borderSelectors: ['body *'],
    reload: false,
    selfTest: `window.taskBoardPreview.stage("active")`,
    prepare: async (item) => {
      await evaluate(`window.taskBoardPreview.stage(${JSON.stringify(item.stage)})`);
      await settle();
      await sleep(120);
      await evaluate(RESET_SCROLL);
    },
  },
};

const page = PAGES[pageName];

const onlyCase = option('case', null);
const cases = onlyCase ? page.cases.filter((item) => item.name === onlyCase) : page.cases;
if (!cases.length) { console.error(`unknown --case=${onlyCase} for --page=${pageName}; known: ${page.cases.map((item) => item.name).join(', ')}`); process.exit(2); }

const requestedViewports = option('viewport', null);
const viewports = requestedViewports
  ? requestedViewports.split(',').map((token) => {
    const [width, height] = token.split('x').map(Number);
    if (!width || !height) { console.error(`bad --viewport=${token}; want WIDTHxHEIGHT, e.g. 1440x960`); process.exit(2); }
    return { width, height };
  })
  : page.viewports;

/* Negative control. Proves that the widened border pass on a new surface really
 * grades what it claims to: the fixture is injected after the surface is up, so
 * whatever it reports is measured on this page, against this stylesheet.
 * `--inject=` takes a file of renderer JavaScript. */
const injectPath = option('inject', null);
const injectSource = injectPath ? fs.readFileSync(path.resolve(injectPath), 'utf8') : null;

// Text is made invisible, not removed: hiding it with visibility/display would
// relayout the page and move the very surfaces being measured.
const HIDE_TEXT_CSS = `html[data-audit-hide-text="1"] *,
html[data-audit-hide-text="1"] *::before,
html[data-audit-hide-text="1"] *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }
html[data-audit-hide-text="1"] svg,
html[data-audit-hide-text="1"] img,
html[data-audit-hide-text="1"] canvas,
html[data-audit-hide-text="1"] video { visibility: hidden !important; }`;

/* Runs inside the renderer. Returns measurements; contrast against a pixel
 * sample is applied afterwards in Node for the elements flagged needsPixel.
 * `borderSelectors` widens the border pass beyond controls and badge chips —
 * empty on the chat page, ['body *'] where the card edges themselves are what
 * this run is about. */
const scanScript = (borderSelectors) => String.raw`(() => {
  const BORDER_SELECTORS = ${JSON.stringify(borderSelectors)};
  // With a widened pass most bordered things are containers, and a container's
  // edge is decoration unless a status graphic leans on it — that split is the
  // severity rule below.
  const CONTAINER_EDGES = BORDER_SELECTORS.length > 0;
  const parse = (value) => {
    if (!value) return null;
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (match) {
      const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    // Chromium serialises color-mix() results as color(srgb r g b / a) with 0..1
    // channels. Reading only rgb() silently skipped those elements.
    const wide = value.match(/color\(\s*srgb\s+([^)]+)\)/);
    if (wide) {
      const parts = wide[1].split(/[\s/]+/).filter(Boolean).map((token) => (token.endsWith('%') ? parseFloat(token) / 100 : Number(token)));
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
    }
    return null;
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const channel = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const text = (c) => 'rgb(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ')';
  const round = (n) => Math.round(n * 100) / 100;

  // Walk up until an opaque background-color, tracking anything that makes the
  // computed colour a lie about what is actually painted.
  const backdrop = (start) => {
    const layers = [];
    const flags = { gradient: false, image: false, filter: false, blend: false, transparency: false };
    let opaque = false;
    for (let node = start; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const image = style.backgroundImage;
      if (image && image !== 'none') { if (/gradient/i.test(image)) flags.gradient = true; else flags.image = true; break; }
      if (style.backdropFilter && style.backdropFilter !== 'none') { flags.filter = true; break; }
      if (style.filter && style.filter !== 'none') { flags.filter = true; break; }
      if (style.mixBlendMode && style.mixBlendMode !== 'normal') { flags.blend = true; break; }
      if (node !== start && Number(style.opacity) < 1) flags.transparency = true;
      const color = parse(style.backgroundColor);
      if (color && color.a > 0) { layers.push(color); if (color.a === 1) { opaque = true; break; } }
    }
    let color = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) color = over(layers[index], color);
    const reasons = Object.keys(flags).filter((key) => flags[key]);
    if (!opaque) reasons.push('no-opaque-layer');
    return { color, reliable: reasons.length === 0, reasons, flags };
  };

  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    return true;
  };

  const labelOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 4) {
      const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      let part = node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + classes.map((name) => '.' + name).join('');
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ').replace(/^body > /, '') || el.tagName.toLowerCase();
  };

  // One id per element, not per measurement: a badge is both a text surface and
  // a bordered graphic, and two ids on the same node would send the second
  // assignment to a selector that no longer resolves.
  const ids = new WeakMap();
  let counter = 0;
  // A colour the parser cannot read (color(srgb ...) from color-mix, or oklch)
  // would otherwise be skipped in silence and look like a pass.
  let unparsedColors = 0;
  const nextId = (el) => {
    const known = ids.get(el);
    if (known) return known;
    const id = 'a11y-' + (counter += 1);
    ids.set(el, id);
    el.setAttribute('data-audit-id', id);
    return id;
  };

  const texts = [];
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((node) => node.nodeType === 3 && node.nodeValue.trim())) continue;
    if (!shown(el)) continue;
    const style = getComputedStyle(el);
    const ink = parse(style.color);
    if (!ink) { unparsedColors += 1; continue; }
    if (ink.a === 0) continue;
    const back = backdrop(el);
    const composed = ink.a < 1 ? over(ink, back.color) : ink;
    const size = parseFloat(style.fontSize) || 0;
    const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? ${THRESHOLDS.largeText} : ${THRESHOLDS.text};
    const disabled = !!el.closest('[disabled], [aria-disabled="true"], fieldset[disabled]');
    const badge = typeof el.className === 'string' && /approval-risk-badge/.test(el.className);
    const box = el.getBoundingClientRect();
    const entry = {
      id: nextId(el), selector: labelOf(el), kind: 'text', text: (el.textContent || '').trim().slice(0, 40),
      ink: style.color, alpha: ink.a, fontSize: round(size), weight, large, required: need,
      disabled, riskBadge: badge,
      ratio: round(contrast(composed, back.color)),
      estimatedBg: text(back.color), reliable: back.reliable, reasons: back.reasons,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    };
    texts.push(entry);
  }

  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"]';
  const borders = [];
  const decorative = [];
  const borderTargets = new Set([...document.querySelectorAll(INTERACTIVE), ...document.querySelectorAll('[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"]')]);
  for (const selector of BORDER_SELECTORS) for (const el of document.querySelectorAll(selector)) borderTargets.add(el);
  for (const el of borderTargets) {
    if (!shown(el)) continue;
    const style = getComputedStyle(el);
    const width = parseFloat(style.borderTopWidth) || 0;
    if (style.borderTopStyle === 'none' || width <= 0) continue;
    const color = parse(style.borderTopColor);
    if (!color) { unparsedColors += 1; continue; }
    if (color.a === 0) continue;
    const behind = backdrop(el.parentElement || el);
    const own = backdrop(el);
    const composited = color.a < 1 ? over(color, behind.color) : color;
    const className = typeof el.className === 'string' ? el.className : '';
    // Visible text only: an aria-label gives an icon-only control an accessible
    // name, but nothing on screen that identifies it.
    const label = (el.textContent || '').trim();
    // "Badge" is a piece of state drawn as a shape; a chip is a labelled
    // control. Only the former leans on its edge to be understood — and only
    // while the shape is all there is. The class name is a weak hint on its own:
    // div.gui-status is a banner that says what happened in words, so its edge is
    // decoration exactly like a card's, and matching the name alone failed it.
    const statusGraphic = /badge|status|indicator/.test(className) && !label;
    // A control with a text label is identified by the label, not by its edge,
    // so a low-contrast edge is reported for review rather than failed. An
    // icon-only control or a status graphic has nothing else to lean on.
    // On the widened pass a container edge is decoration unless it IS the
    // status graphic (a card border identifies nothing by itself).
    const interactive = el.matches(INTERACTIVE);
    const severity = statusGraphic || (!label && (interactive || !CONTAINER_EDGES)) ? 'fail' : 'review';
    // A border is only *required* to hit 3:1 when it is the boundary. When the
    // surrounding surface is knowable from tokens, a fill that already
    // separates the element makes the border redundant paint; under a gradient
    // that call is deferred to the pixel pass, which measures the surface
    // outside the element.
    const fillRatio = behind.reliable ? contrast(own.color, behind.color) : null;
    const box = el.getBoundingClientRect();
    const entry = {
      id: nextId(el), selector: labelOf(el), kind: 'border', border: style.borderTopColor, borderWidth: round(width),
      ratio: round(contrast(composited, behind.color)),
      ownRatio: round(contrast(composited, own.color)),
      ownBg: text(own.color), ownReliable: own.reliable,
      fillRatio: fillRatio === null ? null : round(fillRatio), severity, statusGraphic, label: label.slice(0, 32),
      estimatedBg: text(behind.color), reliable: behind.reliable, reasons: behind.reasons,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    };
    if (fillRatio !== null && fillRatio >= ${THRESHOLDS.uiBorder}) decorative.push({ selector: entry.selector, border: entry.border, fillRatio: entry.fillRatio, ratio: entry.ratio });
    else borders.push(entry);
  }

  const NAME_TARGETS = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';
  // An element the page puts behind aria-hidden="true" is not in the
  // accessibility tree at all, so it cannot be a control whose name a screen
  // reader fails to announce. Monaco ships exactly one of these — a helper
  // textarea for IME composition — and grading it reported a "nameless control"
  // that no assistive tech can ever reach. Names only: aria-hidden text and
  // borders are still painted, so contrast still grades them.
  const hiddenFromAT = (el) => Boolean(el.closest('[aria-hidden="true"]'));
  const controls = [];
  for (const el of document.querySelectorAll(NAME_TARGETS)) {
    if (!shown(el) || hiddenFromAT(el)) continue;
    const labelledBy = el.getAttribute('aria-labelledby');
    const labelledText = labelledBy
      ? labelledBy.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ')
      : '';
    const labels = el.labels && el.labels.length ? [...el.labels].map((label) => label.textContent || '').join(' ') : '';
    const svgTitle = [...el.querySelectorAll('svg title')].map((title) => title.textContent || '').join(' ');
    const candidates = [el.getAttribute('aria-label'), labelledText, el.getAttribute('title'), el.getAttribute('alt'), labels, el.textContent, svgTitle];
    const name = candidates.map((value) => (value || '').trim()).find(Boolean) || '';
    controls.push({
      selector: labelOf(el), tag: el.tagName.toLowerCase(), name: name.slice(0, 48),
      placeholder: (el.getAttribute('placeholder') || '').trim().slice(0, 48),
      missing: !name,
    });
  }

  const meta = { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, unparsedColors };
  return { meta, texts, borders, decorative, controls };
})()`;

const SCAN_JS = scanScript(page.borderSelectors);

const channel = (value) => { const x = value / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
const contrast = (a, b) => {
  const x = luminance(a); const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const parseColor = (value) => {
  const match = String(value || '').match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  const wide = String(value || '').match(/color\(\s*srgb\s+([^)]+)\)/);
  if (!wide) return null;
  const parts = wide[1].split(/[\s/]+/).filter(Boolean).map((token) => (token.endsWith('%') ? parseFloat(token) / 100 : Number(token)));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
};
const rgbText = (color) => `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const round = (n) => Math.round(n * 100) / 100;

/* Mode of one horizontal pixel run. The mode, not the mean: a row that clips an
 * icon or a 1px rule still has a dominant surface colour, and averaging would
 * invent a colour that is painted nowhere. */
function sampleRow(bitmap, size, scale, row) {
  const y = Math.round(row.y * scale);
  if (y < 0 || y >= size.height) return null;
  const counts = new Map();
  for (let x = row.x1; x <= row.x2; x += 1) {
    const sx = Math.round(x * scale);
    if (sx < 0 || sx >= size.width) continue;
    const index = (y * size.width + sx) * 4;
    const key = `${bitmap[index + 2]},${bitmap[index + 1]},${bitmap[index]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null; let bestCount = 0; let total = 0;
  for (const [key, count] of counts) { total += count; if (count > bestCount) { bestCount = count; best = key; } }
  if (!best) return null;
  const [r, g, b] = best.split(',').map(Number);
  return { color: { r, g, b, a: 1 }, share: round(bestCount / total), y: row.y };
}

/* Rows to sample. Text reads the surface inside its own box; a border reads the
 * surface just outside the element, left and right of it at the same height —
 * inside a filled control would be the fill, which is what the border is already
 * painted against. Built from a live rect, because the scroll pass moves
 * elements between captures. */
function rowsOf(box, kind) {
  if (!box || box.width < 2 || box.height < 2) return [];
  const heights = box.height < 8 ? [box.y + box.height / 2] : [0.25, 0.5, 0.75].map((fraction) => box.y + box.height * fraction);
  if (kind === 'border') {
    const gap = 3;
    const run = 6;
    const leftX2 = Math.floor(box.x - gap);
    const leftX1 = leftX2 - run;
    const rightX1 = Math.ceil(box.x + box.width + gap);
    const rightX2 = rightX1 + run;
    if (leftX1 < 0 && rightX2 < 0) return [];
    return heights.flatMap((y) => [{ y: Math.round(y), x1: leftX1, x2: leftX2 }, { y: Math.round(y), x1: rightX1, x2: rightX2 }]);
  }
  // A glyph box narrower than the inset still has to be sampled: its own ink is
  // hidden during the capture, so the whole box is background.
  const narrow = box.width < 6 || box.height < 6;
  const inset = narrow ? 0 : Math.min(3, Math.floor(box.width / 3), Math.floor(box.height / 3));
  const x1 = Math.ceil(box.x + inset);
  const x2 = Math.ceil(box.x + box.width - inset) - 1;
  if (x2 - x1 < 1) return [];
  return heights.map((y) => ({ y: Math.round(y), x1, x2 }));
}

/* Live viewport rects for the given element ids. */
async function boxesOf(ids) {
  if (!ids.length) return {};
  return evaluate(`(() => {
    const out = {};
    for (const id of ${JSON.stringify(ids)}) {
      const el = document.querySelector('[data-audit-id="' + id + '"]');
      if (!el) continue;
      const box = el.getBoundingClientRect();
      out[id] = { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    return out;
  })()`);
}

/* Sample every candidate that needs real pixels. One capture serves every
 * candidate currently inside the viewport; anything scrolled away is brought
 * into view and the page re-captured. Text is hidden for the whole pass. */
async function sampleSurfaces(candidates) {
  const sampled = new Map();
  if (!candidates.length) return sampled;
  await evaluate('document.documentElement.dataset.auditHideText = "1"');
  await settle();
  await sleep(80);
  try {
    let pending = candidates.slice();
    for (let pass = 0; pass < 12 && pending.length; pass += 1) {
      const boxes = await boxesOf(pending.map((candidate) => candidate.id));
      const image = await window.webContents.capturePage();
      const size = image.getSize();
      const bitmap = image.getBitmap();
      const innerWidth = await evaluate('innerWidth');
      const innerHeight = await evaluate('innerHeight');
      const scale = size.width / innerWidth;
      const inView = (row) => row.y >= 0 && row.y < innerHeight && row.x1 >= 0 && row.x2 < innerWidth;
      const remaining = [];
      for (const candidate of pending) {
        const rows = rowsOf(boxes[candidate.id], candidate.kind).filter(inView);
        const pixels = rows.map((row) => sampleRow(bitmap, size, scale, row)).filter(Boolean);
        if (pixels.length) sampled.set(candidate.id, pixels);
        else remaining.push(candidate);
      }
      if (!remaining.length) break;
      pending = remaining;
      await evaluate(`(() => { const el = document.querySelector('[data-audit-id="${pending[0].id}"]'); if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' }); })()`);
      await settle();
      await sleep(60);
    }
  } finally {
    await evaluate('delete document.documentElement.dataset.auditHideText');
    await settle();
  }
  return sampled;
}

function judge(entry, rows, kind) {
  const ink = parseColor(entry.ink || entry.border);
  if (!rows || !rows.length || !ink) return null;
  let chosen = null;
  if (kind === 'border') {
    // The most common surrounding colour is the surface the border sits on;
    // a stray dark row next to a label must not become the grade.
    for (const row of rows) if (!chosen || row.share > chosen.share) chosen = row;
    if (!chosen || chosen.share < 0.4) return null;
  } else {
    // Worst sampled row wins: a gradient varies across the element and the
    // glyphs are only as readable as their worst line.
    let worst = Infinity;
    for (const row of rows) {
      const ratio = contrast(ink.a < 1 ? over(ink, row.color) : ink, row.color);
      if (ratio < worst) { worst = ratio; chosen = row; }
    }
  }
  if (!chosen) return null;
  const ratio = contrast(ink.a < 1 ? over(ink, chosen.color) : ink, chosen.color);
  return {
    ratio: round(ratio),
    color: chosen.color,
    sampledBg: rgbText(chosen.color),
    sampledAt: { y: chosen.y, modeShare: chosen.share },
    delta: round(entry.ratio - ratio),
    kind,
  };
}

/* Turn one scan (plus its pixel samples) into findings. Shared with the self
 * test, so the rules the audit relies on are the same rules the self test
 * proves can fire. */
function evaluateScan(scan, sampled, theme, scenario) {
  const violations = [];
  const textureNotes = [];
  const unmeasured = [];
  const decorativeBorders = [];
  const riskBadges = [];
  // Closest-to-the-line measurements, kept even when they pass: a ratio that is
  // one style tweak away from failing is what a trend needs to see.
  const tightestText = [];
  const tightestBorder = [];

  for (const entry of scan.texts) {
    let measured = entry.ratio;
    let backdrop = entry.estimatedBg;
    let sampledInfo = null;
    if (!entry.reliable) {
      const judged = judge(entry, sampled.get(entry.id), 'text');
      if (judged) {
        measured = judged.ratio;
        backdrop = judged.sampledBg;
        sampledInfo = judged;
        textureNotes.push({ selector: entry.selector, text: entry.text, estimate: entry.ratio, sampled: judged.ratio, delta: judged.delta, bg: judged.sampledBg, estimatedBg: entry.estimatedBg, reason: entry.reasons.join('+') });
      } else {
        // The token estimate here is known to be wrong (that is why the element
        // needed pixels), so reporting it as a ratio would be a fabricated
        // number. Record it as unmeasured instead.
        unmeasured.push({ rule: 'contrast-text', selector: entry.selector, text: entry.text, reason: entry.reasons.join('+') });
      }
    }
    const record = {
      theme, scenario, rule: 'contrast-text', selector: entry.selector, text: entry.text,
      measured, required: entry.required, fontSize: entry.fontSize, weight: entry.weight,
      ink: entry.ink, bg: backdrop, estimatedBg: entry.estimatedBg, sampled: !!sampledInfo,
      pixelOnly: !entry.reliable, excepted: entry.disabled, severity: 'fail',
    };
    if (entry.riskBadge) {
      riskBadges.push({
        theme, scenario, label: entry.text, ink: entry.ink, fontSize: entry.fontSize,
        tokenEstimate: entry.estimatedBg, tokenRatio: entry.ratio,
        sampledBg: sampledInfo ? sampledInfo.sampledBg : null,
        measured: sampledInfo ? measured : null, delta: sampledInfo ? sampledInfo.delta : null,
        required: entry.required, pass: sampledInfo ? measured >= entry.required : null,
      });
    }
    if ((sampledInfo || entry.reliable) && measured < entry.required) violations.push(record);
    if (sampledInfo || entry.reliable) tightestText.push({ selector: entry.selector, text: entry.text, measured, required: entry.required, sampled: !!sampledInfo });
    if (entry.fontSize < THRESHOLDS.minFontSize) {
      violations.push({ theme, scenario, rule: 'font-size', selector: entry.selector, text: entry.text, measured: entry.fontSize, required: THRESHOLDS.minFontSize, excepted: entry.disabled, severity: 'fail' });
    }
  }

  for (const entry of scan.borders) {
    let measured = entry.ratio;
    let backdrop = entry.estimatedBg;
    let sampledInfo = null;
    let fillRatio = entry.fillRatio;
    if (!entry.reliable) {
      const judged = judge(entry, sampled.get(entry.id), 'border');
      if (judged) {
        measured = judged.ratio;
        backdrop = judged.sampledBg;
        sampledInfo = judged;
        const ownBg = parseColor(entry.ownBg);
        if (entry.ownReliable && ownBg) fillRatio = round(contrast(ownBg, judged.color));
        textureNotes.push({ selector: entry.selector, text: '(border)', estimate: entry.ratio, sampled: judged.ratio, delta: judged.delta, bg: judged.sampledBg, estimatedBg: entry.estimatedBg, reason: entry.reasons.join('+') });
      } else {
        unmeasured.push({ rule: 'contrast-ui-border', selector: entry.selector, text: '(border)', reason: entry.reasons.join('+') });
      }
    }
    if (fillRatio !== null && fillRatio >= THRESHOLDS.uiBorder) {
      decorativeBorders.push({ theme, scenario, selector: entry.selector, border: entry.border, fillRatio, ratio: sampledInfo ? measured : entry.ratio, sampled: !!sampledInfo });
      continue;
    }
    if (sampledInfo || entry.reliable) tightestBorder.push({ selector: entry.selector, measured, required: THRESHOLDS.uiBorder, severity: entry.severity, sampled: !!sampledInfo });
    if ((sampledInfo || entry.reliable) && measured < THRESHOLDS.uiBorder) {
      violations.push({
        theme, scenario, rule: 'contrast-ui-border', selector: entry.selector,
        measured, required: THRESHOLDS.uiBorder, ink: entry.border, bg: backdrop,
        estimatedBg: entry.estimatedBg, sampled: !!sampledInfo, pixelOnly: !entry.reliable,
        severity: entry.severity, label: entry.label, excepted: false,
      });
    }
  }

  for (const control of scan.controls) {
    if (control.missing) {
      violations.push({ theme, scenario, rule: 'name-missing', selector: control.selector, tag: control.tag, measured: null, required: 1, placeholder: control.placeholder, excepted: false, severity: 'fail' });
    }
  }

  return {
    violations, textureNotes, unmeasured, decorativeBorders, riskBadges,
    tightestText: tightestText.sort((a, b) => a.measured - b.measured).slice(0, 5),
    tightestBorder: tightestBorder.sort((a, b) => a.measured - b.measured).slice(0, 5),
  };
}

/* Fixtures that must fail, injected into the live preview. A rule that cannot
 * fail is not a check — this is what the old ui-smoke focusVisible assertion got
 * wrong: it collected a value nothing ever graded. */
async function selfTest() {
  // Start from a rendered surface on whichever page is loaded: the injected
  // fixtures are position:fixed above it, and the pixel rule needs a real page
  // underneath rather than an empty body. Each page names its own surface.
  await evaluate(page.selfTest);
  await evaluate('document.documentElement.dataset.theme = "light"');
  await settle();
  await evaluate(`(() => {
    const host = document.createElement('div');
    host.id = 'a11y-self-test';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;width:240px;padding:12px;';
    host.innerHTML = [
      '<div id="st-gradient" style="background:linear-gradient(180deg,#f4f4f4 0%,#f6f6f6 100%);padding:10px;color:#8a8a8a;font-size:14px">渐变底上的灰字</div>',
      '<button id="st-nameless" style="width:40px;height:24px;border:1px solid #dcdcdc;background:#fff"></button>',
      '<span id="st-tiny" style="font-size:9px">小字</span>',
      '<button id="st-icon" aria-label="自测图标按钮" style="width:32px;height:24px;border:1px solid #fafafa;background:transparent"></button>'
    ].join('');
    document.body.appendChild(host);
  })()`);
  await settle();
  const scan = await evaluate(SCAN_JS);
  const pending = [...scan.texts.filter((entry) => !entry.reliable), ...scan.borders.filter((entry) => !entry.reliable)];
  const sampled = await sampleSurfaces(pending);
  const { violations } = evaluateScan(scan, sampled, 'light', 'self-test');
  await evaluate('document.getElementById("a11y-self-test").remove()');

  const has = (predicate) => violations.some(predicate);
  const checks = [
    ['contrast on a gradient surface is measured from pixels', has((v) => v.rule === 'contrast-text' && /st-gradient/.test(v.selector) && v.pixelOnly && v.sampled)],
    ['a nameless control is reported', has((v) => v.rule === 'name-missing' && /st-nameless/.test(v.selector))],
    ['text below 10px is reported', has((v) => v.rule === 'font-size' && /st-tiny/.test(v.selector))],
    ['an icon-only low-contrast border is reported as fail', has((v) => v.rule === 'contrast-ui-border' && /st-icon/.test(v.selector) && v.severity === 'fail')],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test: ${label}`);
  }
  const gradient = violations.find((v) => v.rule === 'contrast-text' && /st-gradient/.test(v.selector));
  if (gradient) console.log(`       gradient fixture: token estimate ${gradient.estimatedBg}, painted ${gradient.bg}, measured ${gradient.measured}:1 (needs ${gradient.required})`);
  return failed;
}

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  // One route per fixture: which preview renders is fixed at document load,
  // and the settings page re-navigates with ?scenario=empty for its zero
  // data pass, so the query string has to survive to the module.
  // Built from PAGES so adding a page cannot leave its route pointing at the
  // wrong fixture (the default arm falls back to the active page's entry).
  const ENTRIES = {};
  for (const definition of Object.values(PAGES)) {
    ENTRIES[definition.route.replace('/__a11y-audit', '') || '/'] = definition.entry;
  }
  const previewPlugin = {
    name: 'a11y-audit-page',
    configureServer(vite) {
      // One route per fixture: which preview renders is fixed at document load,
      // and the settings page re-navigates with ?scenario=empty for its zero
      // data pass, so the query string has to survive to the module.
      // Sub-paths on purpose — connect matches a mounted path at a segment
      // boundary, so `/__a11y-audit-panels` falls through to vite's SPA
      // fallback and measures the real app (which throws without a host bridge)
      // instead of the fixture.
      vite.middlewares.use('/__a11y-audit', async (request, response, next) => {
        try {
          const suffix = (request.url || '/').split('?')[0];
          const entry = ENTRIES[suffix] ?? page.entry;
          const html = await vite.transformIndexHtml(`/__a11y-audit${suffix}`, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
  server = await createServer({ root, plugins: [previewPlugin], server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const port = server.httpServer.address().port;
  log('preview server listening');

  window = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'a11y-audit' },
  });
  const rendererErrors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });

  const loadSurface = async (query = '') => {
    await window.loadURL(`http://127.0.0.1:${port}${page.route}${query}`);
    // insertCSS is per-document, so it has to be re-applied after every
    // navigation or the next page is measured with transitions running and its
    // glyphs painted.
    await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
    await window.webContents.insertCSS(HIDE_TEXT_CSS);
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await evaluate('document.documentElement.dataset.previewReady === "true"')) { ready = true; break; }
      await sleep(100);
    }
    if (!ready) throw new Error(`preview never rendered (${pageName} ${query}): ${rendererErrors.slice(0, 3).join(' | ')}`);
  };
  await loadSurface('');

  if (flag('self-test')) {
    const failedChecks = await selfTest();
    console.log(failedChecks ? `self-test FAILED (${failedChecks} rule${failedChecks === 1 ? '' : 's'} did not fire)` : 'self-test PASSED (all rules fire)');
    process.exitCode = failedChecks ? 1 : 0;
    return;
  }

  const combos = [];
  const riskBadges = [];
  const allViolations = [];
  let pixelSampledTotal = 0;
  let textsChecked = 0;
  let bordersChecked = 0;
  let controlsChecked = 0;
  let unparsedTotal = 0;

  let loadedQuery = '';
  for (const viewport of viewports) {
    // Content size, not window size. The chat page's single viewport is the one
    // the window was created with, so it is never resized — its numbers stay
    // comparable with every earlier run of this script.
    if (viewport.width !== VIEWPORT.width || viewport.height !== VIEWPORT.height) {
      window.setContentSize(viewport.width, viewport.height);
      await settle();
      await sleep(150);
    }
    const requestedLabel = `${viewport.width}x${viewport.height}`;
    for (const theme of themes) {
      for (const item of cases) {
        // A page whose fixture state lives in the URL (settings: ?scenario=)
        // needs a navigation; the panel fixture switches state in place.
        if (page.reload && item.query !== loadedQuery) {
          await loadSurface(item.query);
          loadedQuery = item.query;
        }
        await page.prepare(item);
        if (injectSource) { await evaluate(injectSource); await settle(); }
        await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        await settle();
        await sleep(pageName === 'chat' ? 180 : 220);

        const scan = await evaluate(SCAN_JS);
        // Label a combination by the size the page actually got, not by the size
        // that was asked for: a window's 960 includes the frame, so the content
        // is 894 — and the sidebar can eat a scrollbar's width off `innerWidth`.
        const viewportLabel = `${scan.meta.viewport.width}x${scan.meta.viewport.height}`;
        unparsedTotal += scan.meta.unparsedColors;
        const texturePending = [
          ...scan.texts.filter((entry) => !entry.reliable),
          ...scan.borders.filter((entry) => !entry.reliable),
        ];
        const sampled = await sampleSurfaces(texturePending);
        pixelSampledTotal += sampled.size;

        const analyzed = evaluateScan(scan, sampled, theme, item.name);
        const { violations, textureNotes, unmeasured, decorativeBorders } = analyzed;
        riskBadges.push(...analyzed.riskBadges);
        textsChecked += scan.texts.length;
        bordersChecked += scan.borders.length;
        controlsChecked += scan.controls.length;
        allViolations.push(...violations);
        // Split the two severities per combination too: a bare "violations" count
        // that also swallowed review-level findings summed to 41 while the totals
        // said 1, which reads as a bug in the report rather than a policy choice.
        const failingHere = violations.filter((violation) => violation.severity !== 'review' && !violation.excepted).length;
        const reviewHere = violations.filter((violation) => violation.severity === 'review').length;
        combos.push({
          theme, surface: item.name, scenario: item.name, viewportLabel, requestedViewport: requestedLabel,
          counts: {
            textElements: scan.texts.length, borderedElements: scan.borders.length, controls: scan.controls.length,
            decorativeBorders: scan.decorative.length + decorativeBorders.length,
            pixelSampled: sampled.size, unmeasured: unmeasured.length,
            violations: failingHere, review: reviewHere,
          },
          viewport: scan.meta.viewport,
          decorativeBorders: [...scan.decorative, ...decorativeBorders],
          tightest: { text: analyzed.tightestText, border: analyzed.tightestBorder },
          unmeasured,
          texture: textureNotes,
          violations,
        });
      console.log(`${failingHere ? 'FAIL' : 'ok  '} ${theme}/${viewportLabel} ${item.name}: text ${scan.texts.length} border ${scan.borders.length} (${scan.decorative.length + decorativeBorders.length} decorative) controls ${scan.controls.length} | pixel ${sampled.size} | unmeasured ${unmeasured.length} | violations ${failingHere}${reviewHere ? ` +${reviewHere} review` : ''}`);
      if (violations.length) {
        for (const violation of violations.slice(0, verbose ? 60 : 6)) {
          console.log(`       [${violation.severity}] ${violation.rule} ${violation.selector} ${violation.measured}${violation.rule === 'name-missing' || violation.rule === 'font-size' ? '' : ':1'} (needs ${violation.required}) ${violation.text ? `"${violation.text}"` : ''}${violation.excepted ? ' [disabled: exempt]' : ''}`);
        }
      }
      if (verbose) {
        for (const note of textureNotes) console.log(`       pixel ${note.selector} ${note.text} est ${note.estimate}:1 → real ${note.sampled}:1 (${note.bg}, ${note.reason})`);
        for (const note of unmeasured) console.log(`       unmeasured ${note.rule} ${note.selector} (${note.reason})`);
      }
      // Reset the injected ids so they never leak into the next surface's selectors.
      await evaluate('document.querySelectorAll("[data-audit-inject]").forEach((el) => el.remove()); document.querySelectorAll("[data-audit-id]").forEach((el) => el.removeAttribute("data-audit-id"))');
      }
    }
  }

  const failing = allViolations.filter((violation) => violation.severity !== 'review' && !violation.excepted);
  const review = allViolations.filter((violation) => violation.severity === 'review');
  const byRule = {};
  for (const violation of failing) byRule[violation.rule] = (byRule[violation.rule] || 0) + 1;
  // The stylesheets this run measured. Another agent rewrites the panel rules in
  // workspace-shell.css while this is developed, so every number below is only
  // meaningful against the hash it was taken with.
  const styleHashes = Object.fromEntries(['styles.css', 'conversation-shell.css', 'workspace-shell.css', 'settings-shell.css'].map((file) => {
    const full = path.join(root, 'src', file);
    const hash = fs.existsSync(full) ? require('node:crypto').createHash('md5').update(fs.readFileSync(full)).digest('hex').slice(0, 12) : 'missing';
    return [file, hash];
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    page: pageName,
    pageTitle: page.title,
    borderScope: page.borderSelectors.length ? 'all-bordered-elements' : 'controls-and-badges',
    rendererEntry: page.entry,
    styleHashes,
    // A filtered run (--theme / --scenario / --case / --viewport) writes a
    // report that covers only the selection; say so, so the artifact is never
    // mistaken for the full sweep.
    partial: !!(onlyTheme || onlyScenario || onlyCase || requestedViewports || injectSource),
    injectedFixture: injectSource ? injectPath : null,
    viewport: VIEWPORT,
    viewports: viewports.map((item) => `${item.width}x${item.height}`),
    fontBase: FONT_BASE,
    thresholds: THRESHOLDS,
    scenarios: cases.map((item) => item.name),
    themes,
    totals: {
      combos: combos.length,
      textElements: textsChecked,
      borderedElements: bordersChecked,
      controls: controlsChecked,
      pixelSampled: pixelSampledTotal,
      decorativeBorders: combos.reduce((sum, combo) => sum + combo.counts.decorativeBorders, 0),
      violations: failing.length,
      review: review.length,
      disabledExempt: allViolations.filter((violation) => violation.excepted).length,
      unmeasured: combos.reduce((sum, combo) => sum + combo.unmeasured.length, 0),
      unparsedColors: unparsedTotal,
      byRule,
    },
    riskBadges,
    combos,
    rendererErrors,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // One row per distinct element (its worst combination): the same card edge
  // repeating once per surface and viewport tells a reader nothing. The panel
  // and settings passes grade every bordered element, so the raw list is
  // hundreds of rows per surface — aggregate or nobody reads it.
  const aggregate = (list) => {
    const seen = new Map();
    for (const item of list) {
      const key = `${item.rule}|${item.selector}`;
      const known = seen.get(key);
      if (!known) {
        seen.set(key, { ...item, occurrences: 1, surfaces: new Set([`${item.theme} ${item.scenario}`]) });
        continue;
      }
      known.occurrences += 1;
      known.surfaces.add(`${item.theme} ${item.scenario}`);
      if (typeof item.measured === 'number' && (typeof known.measured !== 'number' || item.measured < known.measured)) {
        known.measured = item.measured; known.theme = item.theme; known.scenario = item.scenario; known.bg = item.bg; known.sampled = item.sampled;
      }
    }
    return [...seen.values()].sort((a, b) => (a.measured ?? 0) / (b.required || 1) - (b.measured ?? 0) / (b.required || 1));
  };
  const failingBySelector = aggregate(failing);
  const reviewBySelector = aggregate(review);
  const tightestSeen = new Set();
  const tightest = combos.flatMap((combo) => [
    ...combo.tightest.text.map((item) => ({ ...item, kind: 'text', theme: combo.theme, scenario: combo.scenario, viewport: combo.viewportLabel })),
    ...combo.tightest.border.map((item) => ({ ...item, kind: 'border', theme: combo.theme, scenario: combo.scenario, viewport: combo.viewportLabel })),
  ]).sort((a, b) => a.measured / a.required - b.measured / b.required)
    .filter((item) => (tightestSeen.has(item.selector) ? false : tightestSeen.add(item.selector)))
    .slice(0, 12);
  const unmeasuredAll = combos.flatMap((combo) => combo.unmeasured.map((note) => ({ ...note, theme: combo.theme, surface: combo.surface, viewport: combo.viewportLabel })));
  const aggregatedRow = (item) => `| ${item.theme} | ${item.surface ?? item.scenario} | ${item.rule} | \`${item.selector}\` | ${item.measured ?? '—'}${item.rule === 'name-missing' || item.rule === 'font-size' ? '' : ':1'} | ${item.required} | ${item.occurrences} |`;
  const lines = [
    '# Renderer accessibility audit',
    '',
    `Generated ${report.generatedAt} · Electron ${report.electron} · Chromium ${report.chrome} · --fs-base ${FONT_BASE}`,
    `Page: **${pageName}** — ${page.title} · border pass ${report.borderScope}`,
    `Viewports requested ${report.viewports.join(', ')} · measured content size ${[...new Set(combos.map((combo) => combo.viewportLabel))].join(', ')} (a 1440×960 window leaves 894px of height for content, which is why the chat baseline is labelled 1427×894)`,
    `Stylesheets: ${Object.entries(styleHashes).map(([file, hash]) => `\`${file}\` ${hash}`).join(' · ')}`,
    '',
    `Surfaces: ${cases.map((item) => item.name).join(', ')} × ${themes.join(' / ')} × ${report.viewports.length} viewport(s) = ${combos.length} combinations.`,
    '',
    '## Totals',
    '',
    `- text elements checked: **${textsChecked}**`,
    `- bordered UI elements checked for 3:1: **${bordersChecked}**`,
    `- interactive controls checked for names: **${controlsChecked}**`,
    `- elements that needed pixel sampling: **${pixelSampledTotal}**`,
    `- borders skipped as decorative (the fill already provides the boundary): **${report.totals.decorativeBorders}**`,
    `- violations: **${failing.length}** (+${review.length} review, ${report.totals.disabledExempt} on disabled controls, ${report.totals.unmeasured} unmeasured)`,
    `- colours the parser could not read (skipped, would otherwise look like a pass): **${report.totals.unparsedColors}**`,
    '',
    '## Per combination',
    '',
    '| viewport | theme | surface | text | border | decorative | controls | pixel | violations | review |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...combos.map((combo) => `| ${combo.viewportLabel} | ${combo.theme} | ${combo.surface} | ${combo.counts.textElements} | ${combo.counts.borderedElements} | ${combo.counts.decorativeBorders} | ${combo.counts.controls} | ${combo.counts.pixelSampled} | ${combo.counts.violations} | ${combo.counts.review} |`),
    '',
    '## Approval risk badges (painted surface)',
    '',
    '| theme | scenario | label | ink | token estimate | pixel measured | delta | threshold |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...riskBadges.map((badge) => `| ${badge.theme} | ${badge.scenario} | ${badge.label} | \`${badge.ink}\` | ${badge.tokenRatio}:1 (${badge.tokenEstimate}) | **${badge.measured ?? 'unmeasured'}:1** (${badge.sampledBg ?? '—'}) | ${badge.delta ?? '—'} | ${badge.required}:1 ${badge.pass ? 'pass' : 'FAIL'} |`),
    '',
    '## Tightest measurements (closest to the line, pass or fail)',
    '',
    '| viewport | theme | surface | kind | selector | measured | required |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...tightest.map((item) => `| ${item.viewport} | ${item.theme} | ${item.scenario} | ${item.kind} | \`${item.selector}\` | ${item.measured}:1 | ${item.required} |`),
    '',
    failing.length
      ? '## Violations (one row per element, worst combination)\n\n| theme | surface | rule | selector | measured | required | combinations |\n| --- | --- | --- | --- | --- | --- | --- |\n' + failingBySelector.map(aggregatedRow).join('\n')
      : '## Violations\n\nNone.',
    '',
    review.length
      ? '## Review (edge of a labelled control or a container: the label or the fill identifies it)\n\n| theme | surface | rule | selector | measured | required | combinations |\n| --- | --- | --- | --- | --- | --- | --- |\n' + reviewBySelector.map(aggregatedRow).join('\n')
      : '',
    '',
    unmeasuredAll.length
      ? '## Unmeasured (backdrop not knowable and not samplable — no token fallback, so no number)\n\n| viewport | theme | surface | rule | selector | reason |\n| --- | --- | --- | --- | --- | --- |\n' + unmeasuredAll.map((note) => `| ${note.viewport} | ${note.theme} | ${note.surface} | ${note.rule} | \`${note.selector}\` | ${note.reason} |`).join('\n')
      : '## Unmeasured\n\nNone.',
    '',
  ];
  fs.writeFileSync(summaryPath, lines.join('\n'));

  console.log('');
  console.log(`page ${pageName} · viewports ${report.viewports.join(', ')} · combinations ${combos.length} · text ${textsChecked} · borders ${bordersChecked} · controls ${controlsChecked} · pixel ${pixelSampledTotal}`);
  if (report.partial) console.log('NOTE: filtered run (--theme/--scenario/--case/--viewport) — report.json covers only this selection');
  console.log(`violations ${failing.length} · review ${review.length} · disabled-exempt ${report.totals.disabledExempt} · unmeasured ${report.totals.unmeasured} · unparsed-colors ${unparsedTotal} ${JSON.stringify(byRule)}`);
  for (const badge of riskBadges) console.log(`  risk ${badge.theme}/${badge.scenario} ${badge.label}: token ${badge.tokenRatio}:1 → painted ${badge.measured ?? 'unmeasured'}:1 ${badge.pass === null ? '' : badge.pass ? 'pass' : 'FAIL'}`);
  console.log(`report ${reportPath}`);
  console.log(`summary ${summaryPath}`);
  if (failing.length) process.exitCode = 1;
}).catch((error) => {
  log(error.stack || String(error));
  console.error(error.stack || String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await server.close();
  app.exit(process.exitCode || 0);
});
