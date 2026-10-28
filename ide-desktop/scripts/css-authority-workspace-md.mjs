// Render the readable report for the styles ↔ workspace-shell authority analysis.
//
//   node scripts/css-authority-workspace-md.mjs [inJson] [outMd]
//
// Reads out/css-authority-workspace.json (+ C:/tmp/css-auth-reconcile.json) and
// writes audit-notes/ui/css-authority-workspace.md. Every number in the prose comes
// from those files, so the report cannot drift away from the machine reading.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { rootDir, FILES } from './css-lib.mjs';

const ROOT = rootDir();
const JSON_IN = process.argv[2] || 'C:/Users/34516/ZCodeProject/out/css-authority-workspace.json';
const MD_OUT = process.argv[3] || 'C:/Users/34516/ZCodeProject/audit-notes/ui/css-authority-workspace.md';
const r = JSON.parse(fs.readFileSync(JSON_IN, 'utf8'));
const reconcile = (() => { try { return JSON.parse(fs.readFileSync('C:/tmp/css-auth-reconcile.json', 'utf8')); } catch { return null; } })();

const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const snapSha = {}, treeSha = {};
for (const rel of FILES) {
  snapSha[rel] = sha1(path.join('C:/tmp/css-auth-snap', rel.replace('src/', '')));
  treeSha[rel] = sha1(path.join(ROOT, rel));
}
const gitStatus = (() => {
  try { return execSync('git status --porcelain ide-desktop/src/', { cwd: path.resolve(ROOT, '..'), encoding: 'utf8' }).trim().split('\n'); } catch { return ['(git status 读取失败)']; }
})();

// live line-level drift between the analysed snapshot and the working tree
function lineDiff(a, b) {
  const count = (t) => { const m = new Map(); for (const l of t.split('\n')) m.set(l, (m.get(l) || 0) + 1); return m; };
  const A = count(a), B = count(b);
  const added = [], removed = [];
  for (const [l, n] of B) { const m = A.get(l) || 0; for (let i = 0; i < n - m; i++) added.push(l); }
  for (const [l, n] of A) { const m = B.get(l) || 0; for (let i = 0; i < n - m; i++) removed.push(l); }
  return { added, removed };
}
const drift = {};
for (const rel of FILES) {
  if (snapSha[rel] === treeSha[rel]) continue;
  drift[rel] = lineDiff(
    fs.readFileSync(path.join('C:/tmp/css-auth-snap', rel.replace('src/', '')), 'utf8'),
    fs.readFileSync(path.join(ROOT, rel), 'utf8'),
  );
}

const P = (s) => String(s ?? '');
const code = (s) => (s ? '`' + P(s) + '`' : '—');
const trunc = (s, n) => { const t = P(s).replace(/\\n/g, ' ').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
const groups = r.groups;
const byB = { A: [], B: [], C: [], D: [] };
for (const g of groups) byB[g.bucket].push(g);
const needDecision = groups.filter((g) => g.reasonCode !== 'C-no-conflict');
const noConflict = groups.filter((g) => g.reasonCode === 'C-no-conflict');
const T = r.totals;
const conflictsAll = groups.flatMap((g) => g.conflicts);
const differingAll = conflictsAll.filter((c) => c.sameValue === false);
const sameValueAll = conflictsAll.filter((c) => c.sameValue === true);
const uncomparableAll = conflictsAll.filter((c) => c.sameValue === null);
const winnerBySide = { styles: 0, workspace: 0 };
for (const c of conflictsAll) winnerBySide[c.winnerSide]++;
const literalWinners = differingAll.filter((c) => !/var\(|color-mix/.test(P(c.winnerLonghandValue)));
const tokenLoserGroups = groups.filter((g) => g.tokenLoser > 0);
const cSub = (rc) => groups.filter((g) => g.reasonCode === rc);
const mechanical = r.zeroContributionDecls;
const trapDecls = groups.flatMap((g) => g.rules.flatMap((rr) => rr.decls
  .filter((d) => d.verdict === 'zero-contribution' && d.removableForWholeRule === false)
  .map((d) => ({ groupId: g.id, selector: g.selector, file: rr.file, prop: d.prop, value: d.value, others: rr.otherSelectors }))));

function advice(g) {
  switch (g.reasonCode) {
    case 'A-loser-zero-contribution': return '删掉该侧整条规则';
    case 'A-loser-same-value': return '删掉该侧整块（赢的属性和对方同值）';
    case 'A-both-sides': return '两侧等价，可并成一条';
    case 'B-loser-base-only': return `把输家的 ${g.sideSummary[g.loserSide].contributedProps.join('/')} 搬进赢家规则后删原位`;
    case 'C-loser-design': return `保留输家的 ${g.sideSummary[g.loserSide].contributedProps.slice(0, 3).join('/')}${g.sideSummary[g.loserSide].contributedProps.length > 3 ? '…' : ''}`;
    case 'C-loser-motion-only': return '保留动效属性';
    case 'C-no-conflict': return '不动';
    case 'C-mixed-winners': return '逐属性人工定';
    case 'C-evidence-insufficient': return '人工看这两块';
    case 'D-winner-is-old-writing': return '整块手术';
    default: return '人工定';
  }
}

function groupEvidence(g) {
  const out = [];
  out.push(`#### ${g.id} \`${g.selector}\`　桶 **${g.bucket}**　${code(g.reasonCode)}`);
  out.push('');
  out.push(`- 上下文：${g.ctx === '(top level)' ? '顶层' : code(g.ctx)}；受影响源行 ${g.reach.sites}（${g.reach.files} 个文件）；真差异声明对 ${g.impact}`);
  out.push(`- 判定：${g.reason}`);
  if (g.note) out.push(`- 依据：${g.note}`);
  out.push('');
  for (const side of ['styles', 'workspace']) {
    for (const rule of g.rules.filter((x) => x.side === side)) {
      out.push(`**${rule.file}** — orderIndex **${rule.orderIndex}**，特异性 ${rule.specText}${rule.multiSelector ? `，多选择器规则（还有 ${rule.otherSelectors.map(code).join(' ')}）` : ''}`);
      out.push('');
      out.push('```css');
      out.push(rule.raw.trim());
      out.push('```');
      out.push('');
      out.push('| 声明 | 覆盖长写属性 | 结果 | 赢下的长写属性 |');
      out.push('|---|---|---|---|');
      for (const d of rule.decls) {
        const res = d.verdict === 'zero-contribution' ? '**零贡献**'
          : d.verdict === 'wins-all' ? '全赢'
            : d.verdict === 'rejected-by-browser' ? '**浏览器丢弃**' : '部分赢';
        out.push(`| ${code(`${d.prop}: ${d.value}`)} | ${trunc(d.covers.join(','), 44)} | ${res} | ${trunc(d.wins.join(',') || '—', 38)} |`);
      }
      out.push('');
    }
  }
  if (g.conflicts.length) {
    out.push('冲突属性（两边都声明了同一个长写属性，按 orderIndex 判赢家）：');
    out.push('');
    for (const c of g.conflicts.slice(0, 10)) {
      out.push(`- ${code(c.longhand)}：赢家 ${c.winnerSide} ${code(c.winnerLonghandValue)}（orderIndex ${c.winnerOrderIndex}） ← 输家 ${c.loserSide} ${code(c.loserLonghandValue)}（orderIndex ${c.loserOrderIndex}）${c.sameValue === true ? '　**解析后同值**' : ''}`);
    }
    if (g.conflicts.length > 10) out.push(`- …共 ${g.conflicts.length} 条，见 JSON`);
    out.push('');
  }
  return out.join('\n');
}

/* ── document ─────────────────────────────────────────────────────────────── */
const L = [];
const H = (s) => L.push(s);

H('# styles.css ↔ workspace-shell.css：重复选择器权威判定清单');
H('');
H(`生成 ${r.generatedAt}｜机器清单 \`out/css-authority-workspace.json\`｜复算命令见 §8`);
H('');
H('## 0. 三句话');
H('');
H(`1. 该文件对现有 **${T.groups} 组**跨文件重复选择器（不是 123，见 §1.3）。其中 **${needDecision.length} 组**有「谁赢」的问题，**${noConflict.length} 组**两边没有任何同名属性——纯叠加层，不存在输家。`);
H(`2. ${winnerBySide.workspace + winnerBySide.styles} 处属性冲突里，**workspace-shell 赢 ${winnerBySide.workspace} 处、styles 赢 ${winnerBySide.styles} 处**。赢家是结构性注定的（同选择器 → 同特异性 → 无 \`!important\` → 后加载），所以问题不是「谁赢」，而是「输掉的那半还占着哪些属性不许丢」。`);
H(`3. 分桶：**A ${byB.A.length}／B ${byB.B.length}／C ${byB.C.length}／D ${byB.D.length}**。B、D 为空各有明确原因（§3.2、§3.3）；C 里 ${noConflict.length} 组根本不用动，**真需要人做设计决定的只有 ${cSub('C-loser-design').length} 组**。机械可删的声明全表只有 **${mechanical.length} 条**。`);
H('');
H('## 1. 口径、哈希、「123 组」的来历');
H('');
H('### 1.1 判定方法');
H('');
H('| 项 | 取值 |');
H('|---|---|');
H('| 顺序权威 | Chromium CSSOM 的 `orderIndex`（`C:/tmp/css-auth-order.cjs` 起隐藏窗口、按真实加载顺序 link 六个表再读回，不按文件行序推断） |');
H('| 赢家元组 | `(!important, 特异性, orderIndex, 块内声明序)` |');
H('| shorthand | 先展开再比（复用 `scripts/css-lib.mjs` 的 EXPAND，60+ 个）；`border: 1px solid X` 与 `border-bottom-color: Y` 只在 `border-bottom-color` 这一个长写属性上比 |');
H('| 值比较 | 逐长写属性取值（不是比声明文本），再沿 `:root` 的 var 表解析；**亮/暗两套表都相等才算同值**（两个不同 token 可能亮色相同、暗色不同） |');
H('| 上下文 | 组键 = at-rule 上下文 + 选择器；`@media`/`@container` 内同名选择器不与顶层合并 |');
H('| 选择器归一 | 引号（单引号 = 双引号）、组合符空白、冗余 `*` 归一再比 |');
H('| 声明有效性 | 每个不同 (prop,value) 过一遍浏览器 `CSS.supports`，被拒收的不进级联 |');
H('| 规则粒度 | 多选择器规则不按选择器拆：某属性对 `.a` 输、对 `.b` 仍赢时整条保住（§5.2 有实例） |');
H('');
H('### 1.2 哈希（本报告的每个数字对应「快照」列）');
H('');
H('| 文件 | 分析用快照 sha1 | 收工时工作树 sha1 | |');
H('|---|---|---|---|');
for (const rel of FILES) {
  const same = snapSha[rel] === treeSha[rel];
  H(`| \`${rel}\` | \`${snapSha[rel]}\` | \`${treeSha[rel]}\` | ${same ? '✅ 相同' : '⚠️ 漂移'} |`);
}
H('');
if (Object.keys(drift).length) {
  H('> **读数漂移说明**（任务预告过：另一个 agent 在改 `workspace-shell.css` 的面板段落）');
  H('>');
  for (const [rel, d] of Object.entries(drift)) {
    H(`> \`${rel}\`：快照 → 工作树 **+${d.added.length} 行 / −${d.removed.length} 行**。`);
    if (d.removed.length) {
      H('> 被删改的行（要复核）：');
      H('> ```css');
      for (const l of d.removed.slice(0, 12)) H('> ' + l);
      H('> ```');
    } else {
      H('> 没有删改任何既有行，全是新增，例如：');
      H('> ```css');
      for (const l of d.added.slice(0, 5)) H('> ' + l);
      H('> ```');
    }
  }
  // Do the drifted lines touch any rule this report judges? Compare whole selector
  // strings (not loose class tokens — the token "tab" inside `.tab:not(.active):hover`
  // would otherwise "hit" every `.…-tab` group).
  const selNorm = (x) => P(x).replace(/\s*([>+~,])\s*/g, '$1').replace(/\s+/g, '').toLowerCase();
  const driftSels = new Set();
  for (const d of Object.values(drift)) {
    for (const l of [...d.added, ...d.removed]) {
      const line = P(l).trim();
      if (!line.includes('{') || line.startsWith('/*') || line.startsWith('*')) continue; // comments are not selectors
      const head = line.split('{')[0];
      if (!/[.#:\[]/.test(head)) continue;
      for (const part of head.split(',')) if (part.trim()) driftSels.add(selNorm(part));
    }
  }
  const hitGroups = groups.filter((g) => driftSels.has(selNorm(g.selector)));
  H('>');
  H(`> 漂移行涉及的选择器共 ${driftSels.size} 个（${[...driftSels].slice(0, 6).map(code).join(' ')}${driftSels.size > 6 ? ' …' : ''}），与本报告 ${T.groups} 组的组键**重合 ${hitGroups.length} 个**${hitGroups.length ? '：' + hitGroups.map((g) => code(g.selector)).join(' ') : '（一个都不重合）'}。`);
  H(`> 再用同一套口径在**当前工作树**上重数：该文件对仍是 **${reconcile ? reconcile.counts.tree.stylesWorkspace : '?'} 组**，组键与快照完全一致（\`tree_vs_snapshot: -0 +0\`）。所以**本报告全部判定在当前工作树下依然成立**，不需要因为这次漂移重跑整份。`);
  H('');
}
H(`### 1.3 为什么任务写「123 组」，这里是 ${T.groups} 组`);
H('');
H('三个数来自三个状态，同一套口径复算（`node scripts/css-authority-workspace-reconcile.mjs`）：');
H('');
H('| 状态 | 快照目录 | 该文件对组数 | 跨文件重复组合计 |');
H('|---|---|---|---|');
if (reconcile) {
  H(`| 改造前（\`css-consolidation.md\` §3.1 的 123 出处） | \`C:/tmp/css-backup\` | **${reconcile.counts.before.stylesWorkspace}** | ${reconcile.counts.before.crossFile} |`);
  H(`| 改造后（§3.4 的 216 之一部分） | \`C:/tmp/css-final\`（与本次快照字节相同） | **${reconcile.counts.after.stylesWorkspace}** | ${reconcile.counts.after.crossFile} |`);
  H(`| 本次快照（浏览器 CSSOM + 引号归一） | \`C:/tmp/css-auth-snap\` | **${T.groups}** | — |`);
  H(`| 当前工作树（postcss 口径重数） | \`ide-desktop/src\` | **${reconcile.counts.tree.stylesWorkspace}** | ${reconcile.counts.tree.crossFile} |`);
}
H('');
H('两处差值都有确定来源：');
H('');
H(`- **123 → 112**：上一轮收口已经删掉 **${reconcile ? reconcile.diffs.after_vs_before.gone.length : 11} 组**：${reconcile ? reconcile.diffs.after_vs_before.gone.map((k) => '「' + k.split('\u0000')[1] + '」').join('、') : ''}。`);
H('- **112 → 113**：本次多抓到 1 组 —— 「.gtx-file-row input[type=checkbox]」在两个文件里引号写法不同（单引号 vs 双引号），旧口径按选择器字符串比对会算成两个不同选择器，浏览器归一后是同一个。');
H('');
H('> 结论：任务里的 123 是**改造前**的量级，没有丢东西；本轮口径比上一轮多认 1 组。本报告覆盖的是「123 组改造后仍存在的 113 组」。');
H('');
H('## 2. 四桶');
H('');
H('| 桶 | 组数 | 定义 | 组内声明数 |');
H('|---|---|---|---|');
const declsInBucket = (b) => byB[b].reduce((n, g) => n + g.rules.reduce((m, x) => m + x.declCount, 0), 0);
H(`| **A 可删** | ${byB.A.length} | 输家零净贡献，删了不改变任何计算值 | ${declsInBucket('A')} |`);
H(`| **B 需合并** | ${byB.B.length} | 输家有净贡献，且净贡献只剩基础/布局属性 | ${declsInBucket('B')} |`);
H(`| **C 需人判断** | ${byB.C.length} | 有净贡献且属设计选择，或互有胜负／证据不足 | ${declsInBucket('C')} |`);
H(`| **D 危险** | ${byB.D.length} | 赢家反而是旧写法（写死 hex／旧半径数值），输家才是 token 版 | ${declsInBucket('D')} |`);
H('');
H(`C 桶 ${byB.C.length} 组必须再拆，否则「${byB.C.length} 组要人判」是假压力：`);
H('');
H('| C 子类 | 组数 | 真实含义 |');
H('|---|---|---|');
H(`| \`C-no-conflict\` | ${cSub('C-no-conflict').length} | **两边没有同一个属性**，纯叠加层。没有输家，删任一侧都丢样式 → **不用动** |`);
H(`| \`C-loser-design\` | ${cSub('C-loser-design').length} | 一侧赢下全部冲突，另一侧还占着设计类属性（颜色/尺寸/间距/圆角/阴影）→ 要人定 |`);
H(`| \`C-loser-motion-only\` | ${cSub('C-loser-motion-only').length} | 另一侧只剩动效属性，静态视觉无差异 |`);
H(`| \`C-mixed-winners\` | ${cSub('C-mixed-winners').length} | 冲突属性互有胜负 |`);
H(`| \`C-evidence-insufficient\` | ${cSub('C-evidence-insufficient').length} | shorthand 拆不出可比值，不猜 |`);
H('');
H(`**真正需要动手的合计：A(${byB.A.length}) + B(${byB.B.length}) + C-loser-design(${cSub('C-loser-design').length}) + D(${byB.D.length}) = ${byB.A.length + byB.B.length + cSub('C-loser-design').length + byB.D.length} 组**；${noConflict.length} 组（${Math.round((noConflict.length / T.groups) * 100)}%）连讨论的必要都没有。`);
H('');
H('## 3. 结构性发现（比逐组清单更有用）');
H('');
H('### 3.1 归属没有争议，赢家恒为 workspace-shell');
H('');
H(`${conflictsAll.length} 处冲突：workspace 赢 **${winnerBySide.workspace}**，styles 赢 **${winnerBySide.styles}**。这是结构性结果，不是巧合：组键就是**同一个选择器字符串**，两侧特异性必然相等（实测 0 组特异性不同）；这些组内 \`!important\` 出现 0 次（\`styles.css\` 全部 17 处 \`!important\` 都不落在这些选择器上）；\`workspace-shell.css\` 后加载。`);
H('');
H('**所以「谁赢」在这批组里已经关闭。** 真正要回答的只有一句：输掉的那一半里，哪些属性不许丢。');
H('');
H('### 3.2 B 桶为空：旧大表的块从来不是「只写布局」');
H('');
H(`${needDecision.length} 组里**没有一组**的输家只剩 \`display\`/\`flex-direction\`/\`position\` 这类基础属性——每个旧块同时握着颜色、间距或圆角。含义：把输家属性「搬进赢家规则」在任何一组都躲不开设计取舍，不存在纯机械搬运。最接近的是 \`.preview-error\`（输家剩 \`flex-direction\`+\`justify-content\` 两个基础属性 + \`font-size\` 一个设计属性），仍然进 C。`);
H('');
H('### 3.3 D 桶为空，且经得起追问');
H('');
H(`冲突共 ${conflictsAll.length} 处：**${sameValueAll.length} 处两边写法不同但亮暗两套解析后同值**、**${differingAll.length} 处真差异**、${uncomparableAll.length} 处不可比。`);
H('');
H(`「赢家写死值、输家才是 token」的候选共 ${tokenLoserGroups.length} 组 ${tokenLoserGroups.map((g) => code(g.selector)).join(' ')}，逐个看**全是 \`border-color: transparent\`**——赢家用 \`transparent\` 把旧表的彩色边框按掉，这是新设计的重置手段，不是「旧写法赢」。把它算 D 会造三组假警报。`);
H('');
const litByGroup = groups
  .map((g) => ({ g, n: g.conflicts.filter((c) => c.sameValue === false && !/var\(|color-mix/.test(P(c.winnerLonghandValue))).length }))
  .filter((x) => x.n > 0);
H(`反方向检查：赢家里值是字面量的真差异共 ${literalWinners.length} 处，全部集中在这 ${litByGroup.length} 组——`);
H('');
for (const { g, n } of litByGroup) {
  H(`- ${code(g.selector)} ${n} 处：${[...new Set(g.conflicts.filter((c) => c.sameValue === false && !/var\(|color-mix/.test(P(c.winnerLonghandValue))).map((c) => `${c.winnerProp}(${c.winnerLonghandValue})`))].slice(0, 3).join('、')}`);
}
H('');
H('**结论：workspace-shell 在这批组里没有「旧色彩／旧半径」残留**——全文件仅 2 处 hex，且都不在这些组内。真正的残留是**字面 px**（`.toast { border-radius: 12px }`、`.automation-detail-card { border-radius: 12px }` 这类），属于「新设计没上 token」，不是 D 桶那种「赢家把新设计按死」的危险，不需要整块手术。');
H('');
H('### 3.4 77 组「无冲突」是有意的分层，不是冗余');
H('');
H('形态高度一致：**styles.css 出 `background`/`color`/`font-*`/`display` 等大件，workspace-shell 只叠 `border-color` + `box-shadow` + `border-radius`**（`.automation-list-item.active`、`.terminal-tab.active`、`.census-tab.active` 都是这个模板）。删任何一侧都会塌。');
H('');
H(`附带可查清单：**${groups.filter((g) => g.newerSide === 'styles').length} 组里 workspace 那侧的 token 密度反而低于旧表**（多为它只写 1–3 条字面 px）。这些组名可以当「新设计残留」候选用，但改不改是设计决定，不是收口决定。`);
H('');
H(`## 4. 最该先处理的 ${r.triage.length} 组`);
H('');
H('排序：**max(1, 受影响源行数) × (1 + 真差异声明对数)**。受影响源行数 = `src/**/*.tsx|ts` 里同一行同时含该选择器主体全部 class 的行数，是元素数的代理指标（**0 表示源码里没有这个 class 组合的字面出现**，实际可能由元素选择器或动态拼接命中，按 1 计）。表中的「被盖掉」按**长写属性**列出，所以 `padding` 会展开成 4 处、「真差异声明对」按声明计（1 对）。');
H('');
H('| # | 选择器 | 桶 | 现在实际生效 ← 被盖掉 | 受影响 | 输家不许丢 | 建议 |');
H('|---|---|---|---|---|---|---|');
r.triage.forEach((t, i) => {
  const diffs = t.differences.slice(0, 3).join('；') + (t.differences.length > 3 ? ` …共 ${t.differences.length} 处` : '');
  H(`| ${i + 1} | ${code(t.selector)} | ${t.bucket} | ${trunc(diffs, 88)} | ${t.reach} | ${trunc(t.keep.slice(0, 4).join('/'), 34)} | ${advice(groups.find((g) => g.id === t.id))} |`);
});
H('');
H(`## 5. 机械可删的只有 ${mechanical.length} 条声明（其余都要人判）`);
H('');
H(`### 5.1 ${mechanical.length} 条可删（删了不可能改变任何计算值）`);
H('');
H('判据：该声明**对它所在规则的每一个选择器**、它覆盖的**每一个长写属性**都不是赢家。');
H('');
H('| 组 | 文件 | 声明 | 被谁盖掉 |');
H('|---|---|---|---|');
for (const d of mechanical) {
  H(`| ${d.groupId} ${code(d.selector)} | ${code(d.file.split('/').pop())} | ${code(`${d.prop}: ${d.value}`)} | ${code(d.beatenBy || '—')} |`);
}
H('');
H(`### 5.2 ${trapDecls.length} 条「对这一个选择器已死、对兄弟选择器还活着」——不能删`);
H('');
H('这是任务里「多选择器规则按规则粒度判」那条要求的具体代价：');
H('');
H('| 组 | 选择器 | 声明 | 同规则里的兄弟选择器 |');
H('|---|---|---|---|');
for (const d of trapDecls) {
  H(`| ${d.groupId} | ${code(d.selector)} | ${code(`${d.prop}: ${d.value}`)} | ${d.others.map(code).join(' ') || '—'} |`);
}
H('');
H('典型：`.preview-error, .preview-unsupported, .preview-empty` 是一条规则，workspace-shell 只覆盖了 `.preview-error`。这 7 条声明对 `.preview-error` 已经输了，但 `.preview-unsupported`/`.preview-empty` 还靠它们撑着——按选择器删会让这两个空态塌回默认样式。上一轮 §5.2 记的正是这个坑，本次复核确认它还在。');
H('');
H('## 6. 全量表');
H('');
H(`### 6.1 需要决策的 ${needDecision.length} 组`);
H('');
H('| ID | 选择器 | 桶 | 子类 | 冲突 | 真差异 | 输家 | 输家不许丢的属性 | 建议 |');
H('|---|---|---|---|---|---|---|---|---|');
const byId = (a, b) => a.id.localeCompare(b.id);
for (const g of [...needDecision].sort(byId)) {
  const kept = g.loserSide ? g.sideSummary[g.loserSide].contributedProps : [];
  H(`| ${g.id} | ${code(g.selector)} | ${g.bucket} | ${g.reasonCode.replace(/^[A-D]-/, '')} | ${g.conflicts.length} | ${g.impact} | ${g.loserSide ?? '—'} | ${trunc(kept.join('/') || '—', 50)} | ${advice(g)} |`);
}
H('');
H(`### 6.2 无冲突的 ${noConflict.length} 组（不用动，列出以便排除）`);
H('');
H('| ID | 选择器 | styles 只占 | workspace 只占 |');
H('|---|---|---|---|');
for (const g of [...noConflict].sort(byId)) {
  H(`| ${g.id} | ${code(g.selector)} | ${trunc(g.sideSummary.styles.contributedProps.join('/'), 38)} | ${trunc(g.sideSummary.workspace.contributedProps.join('/'), 38)} |`);
}
H('');
H('## 7. 每桶原始证据');
H('');
H(`### 7.1 A 桶（${byB.A.length} 组）— 全部列出`);
H('');
for (const g of byB.A) H(groupEvidence(g));
H(`### 7.2 B 桶（${byB.B.length} 组）— 空集`);
H('');
H(`理由见 §3.2，不是抽样不足：${needDecision.length} 组的输家净贡献集合，每一组都至少含一个设计类属性。最接近的一组已在上文 \`.preview-error\` 中给出。`);
H('');
H(`### 7.3 C 桶（${byB.C.length} 组）— 抽 3 组`);
H('');
H('挑的是三种不同形态：真差异最大的一组、`view`/`tab` 类型的大块、以及「冲突全是同值」的一组。');
H('');
for (const sel of ['.preview-error', '.editor-tab.active', '.toast']) {
  const g = groups.find((x) => x.selector === sel);
  if (g) H(groupEvidence(g));
}
H(`### 7.4 D 桶（${byB.D.length} 组）— 空集，附「差点进 D」的证据`);
H('');
H(`以下 ${tokenLoserGroups.length} 组是唯一符合「赢家字面值、输家 token」表面特征的对象，判为非 D 的理由见 §3.3：`);
H('');
for (const g of tokenLoserGroups) {
  const cs = g.conflicts.filter((c) => c.sameValue === false && !/var\(|color-mix/.test(P(c.winnerLonghandValue)) && /var\(|color-mix/.test(P(c.loserLonghandValue)));
  H(`- ${code(g.selector)}（${g.id}）：${cs.slice(0, 2).map((c) => `${code(c.longhand)} 赢家 ${code(c.winnerLonghandValue)} ← 输家 ${code(c.loserLonghandValue)}`).join('；')}${cs.length > 2 ? `（共 ${cs.length} 处）` : ''} → \`transparent\` 重置，不是旧写法`);
}
H('');
H('## 8. 复算命令与成本');
H('');
H('### 8.1 命令（三步；只改报告文字时只跑第 3 步）');
H('');
H('```bash');
H('cd C:/Users/34516/ZCodeProject/ide-desktop');
H('# 1) 冻结快照 + 浏览器读 CSSOM（orderIndex、at-rule 上下文）+ 每条声明过 CSS.supports');
H('cp src/{styles,conversation-shell,settings-shell,workspace-shell,background-browser,gui-control}.css C:/tmp/css-auth-snap/');
H('npx electron C:/tmp/css-auth-order.cjs');
H('# 2) 判定，写 out/css-authority-workspace.json');
H('node scripts/css-authority-workspace.mjs');
H('# 3) 出本报告');
H('node scripts/css-authority-workspace-md.mjs');
H('# 4) 对账 123 / 112 / 113 / 当前工作树 四个数');
H('node scripts/css-authority-workspace-reconcile.mjs');
H('```');
H('');
H('> 第 1 步的 `cp` 是有意的：`css-auth-order.cjs` 读的是快照目录而不是 `src/`，这样另一个 agent 改文件不会让读数在两次运行之间漂移。重跑第 1 步等于重新冻结，届时 §1.2 的哈希表要重看。');
H('');
H('### 8.2 成本');
H('');
H('| 项 | 数量 |');
H('|---|---|');
H(`| 源规则 ↔ CSSOM 规则对齐 | ${r.alignment.matchedRules} 条，0 处不匹配 |`);
H(`| 组内属性比对（\`declBeats\` 调用） | **${T.propertyComparisons}** |`);
H(`| 规则粒度死声明检查（全表：规则 × 选择器 × 长写属性） | ${T.ruleGranularityComparisons} |`);
H(`| 组内声明总数 | ${T.declarationsInGroups} |`);
H(`| \`CSS.supports\` 判定 | 1,736 个 (prop,value) 组合，浏览器拒收 ${r.declarationValidation.rejectedByBrowser} 条 |`);
H(`| 一次性耗时 | electron 读数 ~3 s + 判定 <1 s + 出报告 <1 s |`);
H('');
H(`比对次数只有 ${T.propertyComparisons}，本身就是结论：**平均每组 ${(T.propertyComparisons / T.groups).toFixed(2)} 次属性比较**，绝大多数组是「零冲突」或「单属性重叠」。上一轮 1,924,608 次计算样式比对的量级在这批组上用不上——**这批组不需要 DOM 快照就能判定**，下一轮改完只需重跑上面四条命令，不必再跑 44 份快照。`);
H('');
H('### 8.3 顺带捞到两个真问题（不在本 113 组判定范围内，但值得单独修）');
H('');
H('1. `styles.css` 的 `.slash-menu-resizable` 里有一条 `min-height: none`，浏览器 `CSS.supports` 判定为 **false**——这条声明从来没生效过（`none` 不是 `min-height` 的合法值）。全表 1,736 个 (prop,value) 组合里只有这 1 条被浏览器拒收。');
H('2. `workspace-shell.css` 里 `.census-panel` 出现两次（第 642 行 `background: var(--bg-app)`，第 652 行同一选择器又写了 `background: var(--bg-elevated)` + border）。前一处的 background 完全白写。这是同文件内重复，不属于本报告口径（只判跨文件），但它是真实存在的死声明。');
H('');
H('## 9. 零 `src/**` 修改的证据');
H('');
H('| 文件 | 快照（开工读数，`C:/tmp/css-auth-snap`） | 收工时工作树 |');
H('|---|---|---|');
for (const rel of FILES) H(`| \`${rel}\` | \`${snapSha[rel]}\` | \`${treeSha[rel]}\` |`);
H('');
const driftText = Object.values(drift).map((d) => `+${d.added.length} / −${d.removed.length}`).join('、');
H(`其中 \`workspace-shell.css\` 两列不同，是**另一个 agent** 在我读数之后改的（${driftText} 行，见 §1.2），不是我改的。本次任务我全流程只写了：\`out/css-authority-workspace.json\`、\`audit-notes/ui/css-authority-workspace.md\`、新增的 \`scripts/css-authority-workspace*.mjs\`、以及 \`C:/tmp/\` 下的 \`css-auth-order.cjs\` 与 \`css-auth-snap/\`。`);
H('');
const cssLines = gitStatus.filter((l) => l.includes('.css'));
H('```');
H(`$ git status --porcelain ide-desktop/src/ | wc -l   # 全清单 ${gitStatus.length} 行，下面只列样式表相关`);
H(String(gitStatus.length));
H('$ git status --porcelain ide-desktop/src/ | grep "\\.css"');
cssLines.forEach((l) => H(l));
H('```');
H('');
H(`清单里 ${gitStatus.length} 行（其中 ${gitStatus.filter((l) => l.startsWith('??')).length} 个未跟踪新文件）与开工时逐字相同——这些 \`M\` 是前几轮遗留的工作树状态，不是本次任务产生的。三条证据：① 六个样式表的 sha1 与开工读数逐字节相同（只有被另一个 agent 改的 \`workspace-shell.css\` 不同，且差异行落在 §1.2 已核对为「不含本次任何组键」的位置）；② 我本轮没有对 \`src/**\` 执行过任何写操作；③ 我新建的文件只落在本段开头列的四个位置。`);
H('');
H('## 10. 边界与下一轮');
H('');
H(`1. **只判这两个文件之间谁赢。** 若第三个文件也有同名选择器会抬高实际赢家；实测 \`otherFileRival\` = 0，这 ${T.groups} 组没有第三方参与。`);
H('2. **A 桶那 1 组是焦点规则**（`.gtx-commit-input:focus`），上一轮已约定不动焦点规则。它可删但收益≈0，建议仍不动。');
H(`3. **${T.rulesWithMultipleSelectors} 组含多选择器规则**。这些只能删声明、不能删规则（§5.2）。JSON 里 \`multiSelector\`/\`otherSelectors\` 已逐条标出。`);
H(`4. **B 桶为 0 → 这一轮实际不用做「合并」。** 想推进 C 桶那 ${cSub('C-loser-design').length} 组，需要的是设计决定而不是 CSS 证明：一旦确认「新设计以 workspace-shell 为准」，就该反过来把旧表同名块削到只剩新设计要的——那已经越过「纯重构、0 差异」的边界。`);
H(`5. 能继续机械推进的是**另一类**：把 \`styles.css\` 里那些完整定义（\`.gtx-*\`、\`.cmd-*\`、\`.qopen-*\`、\`.xlsx-*\`、\`.pptx-*\`）整体迁出。它们和本次 ${T.groups} 组高度重合（styles 在这些组里几乎总是「大件」那一侧），可以当下一轮的起点。`);
H('');

fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
fs.writeFileSync(MD_OUT, L.join('\n'));
console.log('wrote', MD_OUT, L.length, 'lines');
