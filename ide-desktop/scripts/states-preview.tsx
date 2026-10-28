/*
 * states-preview — 面板四态（空 / 加载 / 错误 / 禁用）与减动效的探针场景。
 *
 * 每个面板都在同一套 mock 下按 mode 返回不同结果：
 *   empty   —— 接口成功但没有任何数据
 *   loading —— 接口永远不 resolve（停在加载态）
 *   error   —— 接口返回 { ok: false, error } 或抛错（带真实错误串）
 *   data    —— 正常数据
 *
 * 探针（C:/tmp/states-probe.cjs）通过 window.statesPreview 切 mode / 面板，
 * 断言渲染出的是哪一个状态块，再用 CDP 模拟 prefers-reduced-motion: reduce
 * 量动画时长。
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initialState } from '../src/lib/state';
import type { AppState } from '../src/types';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/workspace-shell.css';

type Mode = 'empty' | 'loading' | 'error' | 'data';
let mode: Mode = 'data';

/** 展开在探针里被断言的真实错误串。 */
const ERR = "无法读取 .aicode/skills：EACCES: permission denied, open 'C:/workspace/YOYcode/.aicode/skills'";

const never = <T,>() => new Promise<T>(() => {});

function revisionOf() {
  return { branch: 'main', head: 'abc1234', dirtyCount: 0, label: 'main@abc1234@0' };
}

const gitMock = {
  status: () => {
    if (mode === 'loading') return never();
    if (mode === 'error') return Promise.resolve({ ok: false, error: ERR });
    if (mode === 'empty') return Promise.resolve({ ok: true, branch: 'main', staged: [], unstaged: [], untracked: [] });
    return Promise.resolve({
      ok: true, branch: 'feat/states', upstream: 'origin/feat/states', ahead: 1, behind: 0,
      staged: [{ path: 'src/components/SkillPanel.tsx', index: 'M', working: ' ' }],
      unstaged: [{ path: 'src/components/MemoryPanel.tsx', index: ' ', working: 'M' }],
      untracked: ['src/components/Terminal.tsx'],
    });
  },
  log: () => Promise.resolve({ ok: true, commits: [{ shortHash: 'abc1234' }] }),
  branches: () => Promise.resolve({ ok: true, current: 'main', local: ['main'], remote: [] }),
  diffStats: () => Promise.resolve({ ok: true, added: 3, removed: 1, fileCount: 1 }),
  fileStats: () => {
    if (mode === 'loading') return never();
    if (mode === 'error') return Promise.resolve({ ok: false, error: ERR });
    if (mode === 'empty') return Promise.resolve({ ok: true, files: [] });
    return Promise.resolve({ ok: true, files: [{ path: 'src/components/Terminal.tsx', added: 3, removed: 1, status: 'unstaged' }] });
  },
  graph: () => Promise.resolve({ ok: true, commits: [] }),
  fileDiff: () => Promise.resolve({ ok: true, file: '', staged: false, diff: '' }),
  stage: () => Promise.resolve({ ok: true }),
  unstage: () => Promise.resolve({ ok: true }),
  discard: () => Promise.resolve({ ok: true }),
  commit: () => Promise.resolve({ ok: true, shortHash: 'abc1234', message: '' }),
  push: () => Promise.resolve({ ok: true }),
  pull: () => Promise.resolve({ ok: true }),
  checkout: () => Promise.resolve({ ok: true }),
  createBranch: () => Promise.resolve({ ok: true }),
  init: () => Promise.resolve({ ok: true }),
  prReadiness: () => Promise.resolve({ ok: true }),
  createPr: () => Promise.resolve({ ok: true, url: '' }),
};

const skillData = { skills: [{ name: 'review-checklist', description: '按目录结构复审改动', triggers: ['review'], instructions: '1. 读改动\n2. 列风险' }], errors: [] };
const reflectionData = { entries: [{ id: 'r1', topic: '会话恢复', failure: '令牌刷新并发时集火', lesson: '刷新前先取一次共享 Promise', kind: 'tool_failure', at: '2026-10-20T10:00:00Z', hits: 3 }] };
const auditData = { scannedFiles: 412, scannedDirs: 58, issues: [], byKind: {} };
const memoryData = {
  ok: true, root: 'C:/Users/preview/.zcode/cli/memories/global', markdown: '# MEMORY',
  updatedAt: Date.now(), totalEdits: 2, totalFiles: 2,
  projects: [{ id: 'p1', project: 'YOYcode', workspace: 'C:/workspace/YOYcode', label: 'YOYcode', edits: 2, fileTotal: 2, lastAt: '2026-10-20T10:00:00Z', files: [{ path: 'src/App.tsx', at: '2026-10-20T10:00:00Z', count: 1, created: true }] }],
  records: [{ at: '2026-10-20T10:00:00Z', project: 'YOYcode', workspace: 'C:/workspace/YOYcode', action: 'write' as const, path: 'src/App.tsx', created: true }],
};

const qualityMock = {
  latest: async () => ({ result: { data: null } }),
  invoke: async (name: string) => {
    if (mode === 'loading') return never();
    if (mode === 'error') return { ok: false, error: ERR };
    return { ok: true, data: qualityData(name, mode === 'empty') };
  },
};

/* ── 质量五面板（CodeReview / Performance / Refactor / Coverage / Dashboard）──
 * 这五块的卡片边框来自 workspace-shell.css 的新设计，a11y 审计要先把结果态
 * 渲染出来才量得到，所以夹具按 CLI 网关的真实回包形状给数据（空态返回
 * null，让面板自己出 empty 块）。 */
const reviewData = {
  score: 78,
  summary: '会话恢复与并发刷新两条路径的边界处理基本到位，但过期令牌分支缺少测试。',
  comments: [
    { category: 'security', severity: 'critical', line: 41, message: '过期令牌仍然写入本地存储，刷新失败后会带着失效令牌重试。', suggestion: '写入前先校验 exp，失败路径清空存储。', example: 'if (Date.now() >= expiresAt) return null;' },
    { category: 'correctness', severity: 'warning', line: 96, message: '并发刷新没有共享 Promise，多个请求会各自发起一次刷新。', suggestion: '把首次刷新的 Promise 存到模块变量，其余请求复用它。' },
    { category: 'style', severity: 'info', line: 12, message: '会话恢复函数超过 60 行，建议拆出令牌校验。', suggestion: '提取 validateSession()。' },
  ],
  strengths: ['令牌过期判定集中在单一入口', '恢复流程不阻塞首屏渲染'],
  improvements: ['为刷新失败补一条集成测试', '并发刷新的共享 Promise 需要显式清理'],
  staticAnalysis: { errors: 0, warnings: 2 },
};
const performanceData = {
  issues: [
    { category: 'algorithm', severity: 'major', line: 41, column: 5, message: '每个请求里重复做一次全量扫描', explanation: '刷新路径对全部会话记录重排了一次，随会话数线性增长。', suggestion: '只对当前会话的令牌做校验。', estimatedImpact: '单次调用 O(n)，1000 个会话时约 40ms', example: 'const target = sessions.find((item) => item.id === id);' },
    { category: 'memory', severity: 'minor', line: 96, column: 12, message: '事件订阅没有在卸载时释放', explanation: '多次进入恢复流程会叠加订阅。', suggestion: 'useEffect 返回清理函数。' },
  ],
  algorithmComplexities: { refreshToken: { timeComplexity: 'O(n log n)', spaceComplexity: 'O(n)', reasoning: '对会话列表排序后再线性查找。' } },
  memoryLeakRisks: [{ line: 96, type: 'event-listener', description: 'sessionEvents 的订阅在面板关闭后仍然存在。' }],
  optimizationSuggestions: ['把令牌校验结果放进缓存', '复用同一个刷新 Promise'],
  estimatedScore: 72,
};
const refactorData = {
  result: {
    variableAnalysis: { inputs: ['token', 'options'], outputs: ['session'], internal: ['now', 'expiresAt'] },
    isSafe: true,
    warnings: ['调用点还有 2 处，需要人工复核'],
    extractedMethod: 'function validateSession(token: Token, options: RefreshOptions) {\n  const now = Date.now();\n  if (token.expiresAt <= now) return null;\n  return { ...token, now, refreshed: options.refresh };\n}',
    callSite: 'const session = validateSession(token, options);\nif (!session) return restoreFromDisk();',
  },
};
const coverageData = {
  files: [
    { path: 'src/components/SessionRecoveryPanel.tsx', totalLines: 210, coveredLines: 120, lineCoverage: 57.1, totalBranches: 26, coveredBranches: 12, branchCoverage: 46.2, totalFunctions: 14, coveredFunctions: 9, functionCoverage: 64.3, uncoveredLines: [24, 25, 41, 58, 77, 96, 128], uncoveredFunctions: [{ name: 'restoreSession', line: 24 }, { name: 'refreshToken', line: 96 }] },
    { path: 'src/auth/refresh-token-boundary.ts', totalLines: 152, coveredLines: 96, lineCoverage: 63.2, totalBranches: 22, coveredBranches: 13, branchCoverage: 59.1, totalFunctions: 11, coveredFunctions: 7, functionCoverage: 63.6, uncoveredLines: [18, 19, 40], uncoveredFunctions: [{ name: 'shouldRefresh', line: 18 }] },
    { path: 'src/auth/session.ts', totalLines: 250, coveredLines: 186, lineCoverage: 74.4, totalBranches: 40, coveredBranches: 26, branchCoverage: 65, totalFunctions: 16, coveredFunctions: 12, functionCoverage: 75, uncoveredLines: [52, 53, 90], uncoveredFunctions: [{ name: 'revoke', line: 90 }] },
  ],
  summary: { totalFiles: 3, totalLines: 612, coveredLines: 402, lineCoverage: 65.7, totalBranches: 88, coveredBranches: 51, branchCoverage: 58, totalFunctions: 41, coveredFunctions: 28, functionCoverage: 68.3 },
  worstFiles: [
    { path: 'src/components/SessionRecoveryPanel.tsx', coverage: 57.1 },
    { path: 'src/auth/refresh-token-boundary.ts', coverage: 63.2 },
    { path: 'src/auth/session.ts', coverage: 74.4 },
  ],
  uncoveredFiles: ['src/lib/sessionEvents.ts'],
};
const complexityData = {
  totalFiles: 42, totalFunctions: 388, averageCyclomatic: 3.8, averageCognitive: 4.2,
  distribution: { low: 300, moderate: 61, high: 20, critical: 7 },
  hotspots: [{ name: 'restoreSession', kind: 'function', line: 41, metrics: { cyclomatic: 24, cognitive: 31, maxNesting: 6, parameters: 5, loc: 96 }, risk: 'critical' as const }],
  files: [{ path: 'src/auth/session.ts', highRiskCount: 2, functions: [] }],
};
const smellData = {
  totalSmells: 14,
  byType: { 'long-function': 5, 'deep-nesting': 4, 'duplicate-code': 3, 'god-class': 2 },
  bySeverity: { info: 1, minor: 6, major: 5, critical: 2 },
  topSmells: [{ type: 'long-function', severity: 'major', message: 'restoreSession 有 96 行', file: 'src/auth/session.ts', line: 41, symbol: 'restoreSession' }],
};
const dependencyData = {
  totalModules: 42, externalDependencies: 16,
  circularDependencies: [{ cycle: ['src/auth/session.ts', 'src/lib/sessionEvents.ts', 'src/auth/session.ts'], severity: 'major' }],
  godModules: [{ module: 'src/App.tsx', dependentCount: 23 }],
  isolatedModules: ['src/lib/legacy.ts'],
};

/** 质量网关各工具的夹具。空态一律 null，让面板走自己的 empty 块。 */
function qualityData(name: string, empty: boolean): unknown {
  if (empty) {
    if (name === 'skill_list') return { skills: [], errors: [] };
    if (name === 'reflection_list') return { entries: [] };
    if (name === 'structure_audit') return { scannedFiles: 0, scannedDirs: 0, issues: [], byKind: {} };
    return null;
  }
  switch (name) {
    case 'skill_list': return skillData;
    case 'reflection_list': return reflectionData;
    case 'structure_audit': return auditData;
    case 'review_code': return reviewData;
    case 'analyze_performance': return performanceData;
    case 'refactor_preview': return refactorData;
    case 'analyze_coverage': return coverageData;
    case 'analyze_complexity': return complexityData;
    case 'detect_code_smells': return smellData;
    case 'analyze_dependencies': return dependencyData;
    default: return null;
  }
}

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  git: gitMock,
  quality: qualityMock,
  subagents: {
    list: async () => {
      if (mode === 'loading') return never();
      if (mode === 'error') throw new Error(ERR);
      if (mode === 'empty') return { running: [], finished: [] };
      return {
        running: [{ id: 'sub-1', goal: '复审认证边界', expert: 'reviewer', status: 'running' as const, startedAt: Date.now() - 40000 }],
        finished: [{ id: 'sub-2', goal: '整理模块依赖', expert: 'explorer', status: 'done' as const, startedAt: Date.now() - 900000, finishedAt: Date.now() - 600000, durationMs: 300000, steps: 12, answer: '完成。' }],
      };
    },
    remove: async () => ({ ok: true }),
  },
  memory: {
    global: async () => {
      if (mode === 'loading') return never();
      if (mode === 'error') return { ok: false, error: ERR };
      if (mode === 'empty') return { ok: true, records: [], projects: [], totalEdits: 0, totalFiles: 0 };
      return memoryData;
    },
    listProjects: async () => ({ ok: true, projects: [] }),
    read: async () => ({ ok: true, content: '', updatedAt: Date.now() }),
  },
  terminal: {
    create: async () => {
      if (mode === 'loading') return never<{ id: string; cwd: string }>();
      if (mode === 'error') throw new Error(ERR);
      return { id: `term-${Date.now()}`, cwd: 'C:/workspace/YOYcode' };
    },
    write: async () => ({ ok: true }),
    resize: async () => ({ ok: true }),
    kill: async () => ({ ok: true }),
    onEvent: () => () => {},
  },
  preview: { openExternal: async () => ({ ok: true }), reload: async () => ({ ok: true }) },
};

const [{ SkillPanel }, { ReflectionPanel }, { ProjectAuditPanel }, { SubagentDirectory }, { ReviewPanel },
  { MemoryPanel }, { Terminal }, { GitPanel }, { CoveragePanel }, { QualityDashboard },
  { CodeReviewPanel }, { PerformancePanel }, { RefactorPanel }] = await Promise.all([
  import('../src/components/SkillPanel'),
  import('../src/components/ReflectionPanel'),
  import('../src/components/ProjectAuditPanel'),
  import('../src/components/SubagentDirectory'),
  import('../src/components/ReviewPanel'),
  import('../src/components/MemoryPanel'),
  import('../src/components/Terminal'),
  import('../src/components/GitPanel'),
  import('../src/components/CoveragePanel'),
  import('../src/components/QualityDashboard'),
  import('../src/components/CodeReviewPanel'),
  import('../src/components/PerformancePanel'),
  import('../src/components/RefactorPanel'),
]);

const PANELS = ['skill', 'reflection', 'audit', 'subagents', 'review', 'memory', 'terminal', 'git', 'coverage', 'quality', 'code-review', 'performance', 'refactor'] as const;
type PanelName = (typeof PANELS)[number];

const state: AppState = { ...initialState, workspaceRoot: 'C:/workspace/YOYcode', agentStatus: 'ready' };

function Panel({ name }: { name: PanelName }) {
  // The five quality panels only paint their cards once an analysis result is
  // in: `empty` keeps their own placeholder block, everything else gets the
  // file/selection that makes them run against the fixture reply.
  const target = mode === 'empty' ? undefined : 'src/auth/session.ts';
  switch (name) {
    case 'skill': return <SkillPanel />;
    case 'reflection': return <ReflectionPanel />;
    case 'audit': return <ProjectAuditPanel />;
    case 'subagents': return <SubagentDirectory sessionId="preview-session" />;
    case 'review': return <ReviewPanel workspaceRoot="C:/workspace/YOYcode" chat={[]} onRunReview={() => {}} />;
    case 'memory': return <MemoryPanel />;
    case 'terminal': return <Terminal cwd="C:/workspace/YOYcode" onClose={() => {}} />;
    case 'git': return <GitPanel state={state} onOpenFile={() => {}} />;
    case 'coverage': return <CoveragePanel visible onClose={() => {}} />;
    case 'quality': return <QualityDashboard visible onClose={() => {}} onOpenFile={() => {}} />;
    case 'code-review': return <CodeReviewPanel visible onClose={() => {}} file={target} onOpenFile={() => {}} />;
    case 'performance': return <PerformancePanel visible onClose={() => {}} file={target} />;
    case 'refactor': return <RefactorPanel visible onClose={() => {}} selectedCode={target ? { file: target, startLine: 41, endLine: 58, startColumn: 3, content: 'const now = Date.now();' } : undefined} />;
    default: return null;
  }
}

function Preview() {
  const [panel, setPanel] = useState<PanelName>('skill');
  const [nonce, setNonce] = useState(0);
  // 只用来制造一次父级重渲染，不参与 key —— 探针据此验证加载动画不会重启。
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (window as unknown as { statesPreview: unknown }).statesPreview = {
      panels: PANELS,
      panel: (name: PanelName) => setPanel(name),
      /** 只换 mock 行为，不重新挂载——用来验“点了重试就恢复”。 */
      setMode: (next: Mode) => { mode = next; },
      reset: (name: PanelName, next: Mode) => { mode = next; setPanel(name); setNonce((value) => value + 1); },
      bump: () => setTick((value) => value + 1),
      mode: () => mode,
    };
    document.documentElement.dataset.previewReady = 'true';
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', gap: 8, padding: 8 }} data-tick={tick}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {PANELS.map((name) => (
          <button key={name} type="button" data-panel={name} onClick={() => setPanel(name)}>{name}</button>
        ))}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <Panel key={`${panel}:${nonce}`} name={panel} />
      </div>
      {/*
        动效样本：这些类名在真实界面里各自跑一条 @keyframes。探针在
        reduce 下量它们的 animation-duration，用来看全局兜底是否真的生效。
      */}
      <div data-motion-fixture style={{ display: 'flex', gap: 4, height: 2, overflow: 'hidden' }} aria-hidden="true">
        <span className="spin" data-motion="spin" />
        <span className="skill-panel-spin" data-motion="skill-panel-rotate" />
        <span className="reflection-panel-spin" data-motion="reflection-panel-rotate" />
        <span className="review-spin" data-motion="review-spin" />
        <span className="tool-spin" data-motion="tool-spin" />
        <span className="subagent-spin" data-motion="subagent-spin" />
        <span className="sup-spin" data-motion="sup-spin" />
        <span className="insp-spin" data-motion="insp-spin" />
        <span className="turn-spin" data-motion="turn-spin" />
        <span className="work-spin" data-motion="work-spin" />
        <span className="task-board-spin" data-motion="task-board-spin" />
        <span className="preview-loading-dot" data-motion="preview-pulse" />
        <span className="toast-pulse" data-motion="toast-pulse" />
        <span className="codex-bullet blink" data-motion="codex-bullet-blink" />
        <span className="compaction-divider running"><span className="compaction-divider-label" data-motion="compaction-pulse" /></span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
