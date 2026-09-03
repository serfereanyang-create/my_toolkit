# Stats Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global statistics drawer (reading status, evidence reliability, publication years, top tags, overview cards) backed by a pure stats function and ECharts, without changing account/paper/AI business logic.

**Architecture:** Extract `inspectCitation` into `src/lib/citationIssues.ts` so App and stats share ONE issue-counting implementation. Add pure `src/lib/paperStats.ts` (TDD, no ECharts). `StatsChart.tsx` owns ECharts lifecycle via dynamic `import()` (keeps echarts in an async chunk); `StatsDrawer.tsx` maps stats → options and renders cards + charts. `ActiveDrawer` widens to include `'stats'`.

**Tech Stack:** React 19, Ant Design 6, TypeScript, Vitest, ECharts (core + on-demand registration), Vite.

**Spec:** `docs/superpowers/specs/2026-09-01-stats-dashboard.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `src/lib/citationIssues.ts` | Extracted `inspectCitation` (single source of truth) |
| `src/lib/citationIssues.test.ts` | Tests pinning existing citation-issue rules |
| `src/lib/checklistItems.ts` | `DEFAULT_CHECKLIST_ITEMS` moved out of the component |
| `src/lib/paperStats.ts` | Pure `buildPaperStats(papers)` → `PaperStats` |
| `src/lib/paperStats.test.ts` | Stats unit tests |
| `src/components/paper/StatsChart.tsx` | ECharts lazy init, theme, resize, dispose |
| `src/components/paper/StatsDrawer.tsx` | Drawer shell, number cards, chart options, empty states |
| `src/lib/uiState.ts` | `ActiveDrawer` += `'stats'` |
| `src/App.tsx` | Use extracted citationIssues; stats menu entry; render StatsDrawer |
| `src/components/paper/QualityDrawer.tsx` | `统计概览` button + `onOpenStats` prop |
| `scripts/test-renderer-auth-wiring.cjs` | Markers for StatsDrawer / 统计概览 / 'stats' |
| `package.json` | Add `echarts` dependency |

---

### Task 1: Extract citationIssues (single source of truth)

**Files:**
- Create: `src/lib/citationIssues.ts`
- Create: `src/lib/citationIssues.test.ts`
- Modify: `src/App.tsx` (import instead of local definition)

- [ ] **Step 1: Write failing test `src/lib/citationIssues.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { inspectCitation } from './citationIssues';
import type { Paper } from '../types/paperApp';

const paper = (overrides: Partial<Paper> = {}): Paper => ({
  id: 'p1', title: 'T', authors: 'A', year: '2026', source: 'S', doi: '10.1/a', url: '',
  status: '未读', tags: [], question: '', method: '', dataset: '', findings: '',
  limitations: '', credibility: '', evidence: [], checklist: {},
  ...overrides,
});

describe('inspectCitation', () => {
  it('reports nothing when required fields are present', () => {
    expect(inspectCitation(paper(), [paper()])).toEqual([]);
  });

  it('reports missing author, year and source', () => {
    const issues = inspectCitation(paper({ authors: ' ', year: '', source: '' }), []);
    expect(issues.some((i) => i.includes('缺少作者'))).toBe(true);
    expect(issues.some((i) => i.includes('缺少年份'))).toBe(true);
    expect(issues.some((i) => i.includes('缺少来源'))).toBe(true);
  });

  it('requires at least one of DOI or URL', () => {
    const issues = inspectCitation(paper({ doi: '', url: '' }), []);
    expect(issues.some((i) => i.includes('DOI 和 URL 至少补一个'))).toBe(true);
    expect(inspectCitation(paper({ doi: '', url: 'https://x' }), []).length).toBe(0);
  });

  it('flags duplicate DOI across other papers (case-insensitive)', () => {
    const a = paper({ id: 'a', doi: '10.1/X' });
    const b = paper({ id: 'b', doi: '10.1/x' });
    expect(inspectCitation(a, [a, b]).some((i) => i.includes('DOI 与其他卡片重复'))).toBe(true);
  });

  it('uses 未命名论文 prefix when title empty', () => {
    const issues = inspectCitation(paper({ title: '', authors: '' }), []);
    expect(issues[0].startsWith('未命名论文:')).toBe(true);
  });
});
```

- [ ] **Step 2: Run → RED**

```bash
npm test -- src/lib/citationIssues.test.ts
```

Expected: cannot resolve `./citationIssues`.

- [ ] **Step 3: Create `src/lib/citationIssues.ts` by MOVING the existing function**

Copy the current body from `src/App.tsx` (search `function inspectCitation`) verbatim, add the import and export:

```ts
import type { Paper } from '../types/paperApp';

export function inspectCitation(paper: Paper, papers: Paper[]): string[] {
  // ...exact existing body, unchanged...
}
```

Do NOT change any rule. Behavior must stay identical.

- [ ] **Step 4: Update `src/App.tsx`**

- Delete the local `function inspectCitation(...)` definition
- Add `import { inspectCitation } from './lib/citationIssues';` with the other lib imports
- Leave both call sites (`citationIssues` useMemo and `selectedIssues`) unchanged

- [ ] **Step 5: Verify**

```bash
npm test -- src/lib/citationIssues.test.ts
npm test
npm run build
```

All green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/citationIssues.ts src/lib/citationIssues.test.ts src/App.tsx
git commit -m "refactor: extract citation issue rules into shared lib"
```

If a hook blocks the commit, do NOT use `--no-verify`; skip and report. Never stage `ide-desktop/*`.

---

### Task 2: paperStats pure function (TDD)

**Files:**
- Create: `src/lib/paperStats.ts`
- Create: `src/lib/paperStats.test.ts`

- [ ] **Step 1: Write failing tests `src/lib/paperStats.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildPaperStats, STATUS_ORDER, RELIABILITY_ORDER } from './paperStats';
import type { Paper, Evidence } from '../types/paperApp';

const ev = (reliability: Evidence['reliability']): Evidence => ({
  id: `e-${Math.random()}`, claim: 'c', support: '', locator: '', reliability, tags: [],
});

const paper = (overrides: Partial<Paper> = {}): Paper => ({
  id: 'p1', title: 'T', authors: 'A', year: '2026', source: 'S', doi: '', url: 'https://x',
  status: '未读', tags: [], question: '', method: '', dataset: '', findings: '',
  limitations: '', credibility: '', evidence: [], checklist: {},
  ...overrides,
});

describe('buildPaperStats', () => {
  it('returns zeroed structure for empty library', () => {
    const stats = buildPaperStats([]);
    expect(stats.total).toBe(0);
    expect(stats.evidenceTotal).toBe(0);
    expect(stats.issueTotal).toBe(0);
    expect(stats.checklistCompletion).toBe(0);
    expect(stats.byStatus.map((s) => s.status)).toEqual([...STATUS_ORDER]);
    expect(stats.byStatus.every((s) => s.count === 0)).toBe(true);
    expect(stats.byReliability.map((r) => r.level)).toEqual([...RELIABILITY_ORDER]);
    expect(stats.byYear).toEqual([]);
    expect(stats.topTags).toEqual([]);
  });

  it('counts status distribution in fixed order', () => {
    const stats = buildPaperStats([
      paper({ id: '1', status: '精读' }),
      paper({ id: '2', status: '精读' }),
      paper({ id: '3', status: '未读' }),
    ]);
    expect(stats.byStatus.find((s) => s.status === '精读')?.count).toBe(2);
    expect(stats.byStatus.find((s) => s.status === '未读')?.count).toBe(1);
    expect(stats.byStatus.map((s) => s.status)).toEqual([...STATUS_ORDER]);
  });

  it('aggregates evidence reliability across papers', () => {
    const stats = buildPaperStats([
      paper({ id: '1', evidence: [ev('高'), ev('中')] }),
      paper({ id: '2', evidence: [ev('高')] }),
    ]);
    expect(stats.evidenceTotal).toBe(3);
    expect(stats.byReliability.find((r) => r.level === '高')?.count).toBe(2);
    expect(stats.byReliability.find((r) => r.level === '中')?.count).toBe(1);
    expect(stats.byReliability.find((r) => r.level === '低')?.count).toBe(0);
  });

  it('sorts years ascending and puts invalid years under 未标注 last', () => {
    const stats = buildPaperStats([
      paper({ id: '1', year: '2024' }),
      paper({ id: '2', year: '2020' }),
      paper({ id: '3', year: '' }),
      paper({ id: '4', year: 'n/a' }),
    ]);
    expect(stats.byYear.map((y) => y.year)).toEqual(['2020', '2024', '未标注']);
    expect(stats.byYear.find((y) => y.year === '未标注')?.count).toBe(2);
  });

  it('ranks tags by frequency then zh name, dedupes within a paper, caps at 10', () => {
    const stats = buildPaperStats([
      paper({ id: '1', tags: ['nlp', 'nlp', '机器学习'] }),
      paper({ id: '2', tags: ['nlp'] }),
      paper({ id: '3', tags: ['  '] }),
      ...Array.from({ length: 12 }, (_, i) => paper({ id: `x${i}`, tags: [`t${i}`] })),
    ]);
    expect(stats.topTags[0]).toEqual({ tag: 'nlp', count: 2 });
    expect(stats.topTags.length).toBeLessThanOrEqual(10);
    expect(stats.topTags.some((t) => t.tag.trim() === '')).toBe(false);
  });

  it('averages checklist completion across papers', () => {
    const stats = buildPaperStats([
      paper({ id: '1', checklist: { 研究问题明确: true, 方法可复现: true } }),
      paper({ id: '2', checklist: {} }),
    ]);
    expect(stats.checklistCompletion).toBeGreaterThan(0);
    expect(stats.checklistCompletion).toBeLessThan(1);
  });

  it('counts citation issues using shared inspectCitation', () => {
    const stats = buildPaperStats([paper({ id: '1', authors: '', doi: '', url: '' })]);
    expect(stats.issueTotal).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run → RED**

```bash
npm test -- src/lib/paperStats.test.ts
```

- [ ] **Step 3: Implement `src/lib/paperStats.ts`**

**First, move the checklist constant out of the component** so the pure stats module (and its unit test) never pulls antd in:

1. Create `src/lib/checklistItems.ts`:

```ts
export const DEFAULT_CHECKLIST_ITEMS = [
  '研究问题明确',
  '方法可复现',
  '样本/数据说明完整',
  '统计或评估指标清楚',
  '图表来源可追踪',
  '局限性已记录',
  '引用字段完整',
] as const;
```

2. In `src/components/paper/QualityDrawer.tsx`, delete the local definition and re-export for backward compatibility so existing importers keep working:

```ts
import { DEFAULT_CHECKLIST_ITEMS } from '../../lib/checklistItems';

export { DEFAULT_CHECKLIST_ITEMS };
```

(Verify existing importers still resolve: `rg -n "DEFAULT_CHECKLIST_ITEMS" src/` before and after.)

3. Then implement the stats module:

```ts
import type { Paper, PaperStatus, Reliability } from '../types/paperApp';
import { inspectCitation } from './citationIssues';
import { DEFAULT_CHECKLIST_ITEMS } from './checklistItems';

export const STATUS_ORDER: PaperStatus[] = ['未读', '粗读', '精读', '已摘录', '待复核'];
export const RELIABILITY_ORDER: Reliability[] = ['高', '中', '低'];
export const UNSPECIFIED_YEAR = '未标注';
export const MAX_TOP_TAGS = 10;

export type PaperStats = {
  total: number;
  evidenceTotal: number;
  issueTotal: number;
  checklistCompletion: number;
  byStatus: { status: PaperStatus; count: number }[];
  byReliability: { level: Reliability; count: number }[];
  byYear: { year: string; count: number }[];
  topTags: { tag: string; count: number }[];
};

export function buildPaperStats(papers: Paper[]): PaperStats {
  const list = Array.isArray(papers) ? papers : [];

  const statusCounts = new Map<PaperStatus, number>(STATUS_ORDER.map((s) => [s, 0]));
  const reliabilityCounts = new Map<Reliability, number>(RELIABILITY_ORDER.map((r) => [r, 0]));
  const yearCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  let evidenceTotal = 0;
  let issueTotal = 0;
  let checklistSum = 0;

  for (const paper of list) {
    if (statusCounts.has(paper.status)) {
      statusCounts.set(paper.status, (statusCounts.get(paper.status) ?? 0) + 1);
    }

    const evidence = Array.isArray(paper.evidence) ? paper.evidence : [];
    evidenceTotal += evidence.length;
    for (const item of evidence) {
      if (reliabilityCounts.has(item.reliability)) {
        reliabilityCounts.set(item.reliability, (reliabilityCounts.get(item.reliability) ?? 0) + 1);
      }
    }

    issueTotal += inspectCitation(paper, list).length;

    const year = String(paper.year ?? '').trim();
    const key = /^\d{4}$/.test(year) ? year : UNSPECIFIED_YEAR;
    yearCounts.set(key, (yearCounts.get(key) ?? 0) + 1);

    const seen = new Set<string>();
    for (const raw of Array.isArray(paper.tags) ? paper.tags : []) {
      const tag = String(raw ?? '').trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    const checked = DEFAULT_CHECKLIST_ITEMS.filter((item) => Boolean(paper.checklist?.[item])).length;
    checklistSum += DEFAULT_CHECKLIST_ITEMS.length ? checked / DEFAULT_CHECKLIST_ITEMS.length : 0;
  }

  const byYear = Array.from(yearCounts.entries())
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => {
      if (a.year === UNSPECIFIED_YEAR) return 1;
      if (b.year === UNSPECIFIED_YEAR) return -1;
      return a.year.localeCompare(b.year);
    });

  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'zh'))
    .slice(0, MAX_TOP_TAGS);

  return {
    total: list.length,
    evidenceTotal,
    issueTotal,
    checklistCompletion: list.length ? checklistSum / list.length : 0,
    byStatus: STATUS_ORDER.map((status) => ({ status, count: statusCounts.get(status) ?? 0 })),
    byReliability: RELIABILITY_ORDER.map((level) => ({ level, count: reliabilityCounts.get(level) ?? 0 })),
    byYear,
    topTags,
  };
}
```

**Import-cycle note:** the checklist constant now lives in `src/lib/checklistItems.ts` (Step 3.1) precisely so this pure module never imports a component. Do not import anything from `src/components/**` here.

- [ ] **Step 4: Run → GREEN**

```bash
npm test -- src/lib/paperStats.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/paperStats.ts src/lib/paperStats.test.ts src/lib/checklistItems.ts src/components/paper/QualityDrawer.tsx
git commit -m "feat: add paper statistics pure function"
```

---

### Task 3: Install echarts + StatsChart component

**Files:**
- Modify: `package.json` (dependency)
- Create: `src/components/paper/StatsChart.tsx`

- [ ] **Step 1: Install**

```bash
npm install echarts
```

- [ ] **Step 2: Implement `src/components/paper/StatsChart.tsx`**

Requirements:
- Props: `{ option: unknown; height?: number; ariaLabel?: string }`
- Lazy-load echarts inside `useEffect` via dynamic import so it lands in an async chunk:

```tsx
import { useEffect, useRef, useState } from 'react';

type EChartsInstance = { setOption: (o: unknown, notMerge?: boolean) => void; resize: () => void; dispose: () => void };

type StatsChartProps = {
  option: unknown;
  height?: number;
  ariaLabel?: string;
};

export function StatsChart({ option, height = 220, ariaLabel }: StatsChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;

    const boot = async () => {
      try {
        const [core, charts, components, renderers] = await Promise.all([
          import('echarts/core'),
          import('echarts/charts'),
          import('echarts/components'),
          import('echarts/renderers'),
        ]);
        core.use([
          charts.PieChart,
          charts.BarChart,
          components.GridComponent,
          components.TooltipComponent,
          components.LegendComponent,
          renderers.CanvasRenderer,
        ]);
        if (disposed || !containerRef.current) return;
        const instance = core.init(containerRef.current) as unknown as EChartsInstance;
        chartRef.current = instance;
        instance.setOption(option, true);
        observer = new ResizeObserver(() => instance.resize());
        observer.observe(containerRef.current);
      } catch {
        if (!disposed) setFailed(true);
      }
    };

    void boot();
    return () => {
      disposed = true;
      observer?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  if (failed) {
    return <div className="quiet-note">图表加载失败</div>;
  }
  return <div ref={containerRef} style={{ width: '100%', height }} aria-label={ariaLabel} />;
}
```

Keep the failure text exactly `图表加载失败` (spec §7.3).

- [ ] **Step 3: Build check**

```bash
npm run build
```

Confirm build succeeds. Note in the report whether an echarts async chunk appears in the output listing (spec §8 requires echarts NOT in the main entry chunk).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/components/paper/StatsChart.tsx
git commit -m "feat: add lazy echarts chart wrapper"
```

---

### Task 4: StatsDrawer

**Files:**
- Create: `src/components/paper/StatsDrawer.tsx`

- [ ] **Step 1: Implement**

Props:

```ts
type StatsDrawerProps = {
  open: boolean;
  onClose: () => void;
  papers: Paper[];              // FULL library, not filtered
  accentColor: string;          // themeTokens.accent
  textColor: string;            // themeTokens.textSecondary
  borderColor: string;          // themeTokens.border
};
```

Behavior:
- `const stats = useMemo(() => buildPaperStats(papers), [papers]);`
- Ant `Drawer` width 480, `destroyOnClose={false}`, className `drawer-shell`, title 统计概览
- `stats.total === 0` → `<Empty description="还没有论文，先新建或导入" />` only
- Otherwise render:
  1. Number cards: 论文 `stats.total`, 证据 `stats.evidenceTotal`, 待修 `stats.issueTotal`, 自查 `${Math.round(stats.checklistCompletion * 100)}%` (reuse `stat-chip` / `stats-inline` classes already in styles.css)
  2. 阅读状态分布 — doughnut: `series[0].type='pie'`, `radius:['45%','70%']`
  3. 证据可靠性 — bar; if `stats.evidenceTotal === 0` render `暂无证据数据` placeholder instead
  4. 发表年份分布 — bar over `stats.byYear`
  5. 标签 Top 10 — horizontal bar (`yAxis type 'category'`), highest on top; if `stats.topTags.length === 0` render `暂无标签数据`
- Build each option with `useMemo` keyed on stats + colors; all options must set:
  - `backgroundColor: 'transparent'`
  - text color `textColor` (`textStyle.color`)
  - axis line/split line color `borderColor`
  - series color `accentColor` (pie may derive a shade list from accent; keep it simple and readable)
  - `tooltip: { trigger: ... }`
- Each chart wrapped in a titled block reusing existing `inspector-block` / `inspector-title` classes for visual consistency.

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/paper/StatsDrawer.tsx
git commit -m "feat: add statistics drawer with charts"
```

---

### Task 5: App integration + wiring test

**Files:**
- Modify: `src/lib/uiState.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/paper/QualityDrawer.tsx`
- Modify: `scripts/test-renderer-auth-wiring.cjs`

- [ ] **Step 1: Update wiring markers first (RED)**

Add to the markers array in `scripts/test-renderer-auth-wiring.cjs`:

```js
  'StatsDrawer',
  "label: '统计概览'",
```

And add a uiState assertion next to the existing ActiveDrawer check:

```js
const uiState = fs.readFileSync(path.join(root, 'src', 'lib', 'uiState.ts'), 'utf8');
assert.ok(
  uiState.includes("'quality' | 'account' | 'review' | 'stats' | null"),
  'ActiveDrawer missing stats',
);
```

Run → RED.

- [ ] **Step 2: Widen `ActiveDrawer`**

```ts
export type ActiveDrawer = 'quality' | 'account' | 'review' | 'stats' | null;
```

- [ ] **Step 3: Wire `src/App.tsx`**

- `import { StatsDrawer } from './components/paper/StatsDrawer';`
- Add opener mirroring the existing ones:

```ts
function openStatsDrawer() {
  setSettingsOpen(false);
  setActiveDrawer((prev) => nextActiveDrawer(prev, 'stats'));
}
```

(match the exact shape of `openQualityDrawer` in the file)

- More menu: add `{ key: 'stats', label: '统计概览', onClick: openStatsDrawer }` next to 生成综述 / 导出文献矩阵
- Render alongside other drawers, passing FULL `papers` (not `filteredPapers`) and theme colors:

```tsx
<StatsDrawer
  open={activeDrawer === 'stats'}
  onClose={closeDrawer}
  papers={papers}
  accentColor={themeTokens.accent}
  textColor={themeTokens.textSecondary}
  borderColor={themeTokens.border}
/>
```

- Pass `onOpenStats={openStatsDrawer}` to `QualityDrawer`

- [ ] **Step 4: QualityDrawer button**

- Extend Props with `onOpenStats: () => void;`
- Add above the 导入/导出 actions (use an already-imported or newly imported distinct icon, e.g. `PieChartOutlined`):

```tsx
<Button block icon={<PieChartOutlined />} onClick={onOpenStats}>
  统计概览
</Button>
```

- [ ] **Step 5: Verify**

```bash
node scripts/test-renderer-auth-wiring.cjs
node scripts/test-ai-wiring.cjs
node scripts/test-electron-wiring.cjs
npm test
npm run build
```

All green.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/lib/uiState.ts src/components/paper/QualityDrawer.tsx scripts/test-renderer-auth-wiring.cjs
git commit -m "feat: integrate statistics drawer into app shell"
```

---

### Task 6: Desktop verification + spec status

- [ ] **Step 1: Full automated suite**

```bash
node scripts/test-paper-digest.cjs
node scripts/test-ai-service.cjs
node scripts/test-ai-wiring.cjs
node scripts/test-electron-wiring.cjs
node scripts/test-renderer-auth-wiring.cjs
npm test
npm run build
```

If `test-auth-core.cjs` / `test-library-store.cjs` are needed: `npm rebuild better-sqlite3` first, run them, then `npx @electron/rebuild -f -w better-sqlite3` to restore the Electron ABI before launching the app.

- [ ] **Step 2: Desktop smoke (single bash call — the sandbox kills processes across calls)**

```bash
tmpdir=$(mktemp -d)
./node_modules/.bin/electron . --user-data-dir="$tmpdir" --remote-debugging-port=9466 &
# curl-wait for /json/version, then CDP Runtime.evaluate:
```

Assert via CDP:
1. `!!document.querySelector('.desktop-workbench')` is true
2. No console errors captured (Runtime.consoleAPICalled / exceptionThrown)
3. DevTools still disabled (menu has no toggle; `devTools:false` in main)

Then `Browser.close`, remove tmpdir.

- [ ] **Step 3: Report bundle impact**

From `npm run build` output, record whether echarts is in a separate async chunk and the main entry chunk size delta versus before this feature.

- [ ] **Step 4: Spec status**

Only after the above pass, set in `docs/superpowers/specs/2026-09-01-stats-dashboard.md`:

```md
状态：已实现
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-stats-dashboard.md
git commit -m "docs: mark stats dashboard implemented"
```

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| Shared citation issue implementation | 1 |
| PaperStats model + all 8 fields | 2 |
| Status fixed order, reliability aggregation | 2 |
| Year ascending + 未标注 last | 2 |
| Tag ranking, dedupe, cap 10 | 2 |
| checklistCompletion average | 2 |
| echarts on-demand + dynamic import | 3 |
| Chart failure fallback 图表加载失败 | 3 |
| dispose + resize lifecycle | 3 |
| Drawer 480, number cards, 4 charts | 4 |
| Empty library placeholder | 4 |
| Per-dimension empty placeholders | 4 |
| Theme colors from tokens, transparent bg | 4 |
| ActiveDrawer 'stats' + exclusivity | 5 |
| Menu + QualityDrawer entries | 5 |
| Global scope (papers not filteredPapers) | 5 |
| Wiring markers | 5 |
| Desktop smoke + DevTools guard + bundle note | 6 |

## Placeholder scan

No TBD. No deferred execution-time branches: the checklist constant is moved to `src/lib/checklistItems.ts` up front (Task 2 Step 3.1) so the pure stats module never imports a component.

## Type consistency

- `ActiveDrawer`: `'quality' | 'account' | 'review' | 'stats' | null`
- `PaperStats` fields exactly as in spec §6
- `StatsChart` props: `{ option, height?, ariaLabel? }`
- `StatsDrawer` props: `{ open, onClose, papers, accentColor, textColor, borderColor }`

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-01-stats-dashboard.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review
2. **Inline Execution** — this session, task by task

Which approach?
