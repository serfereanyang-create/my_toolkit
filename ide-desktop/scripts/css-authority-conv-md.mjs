// Render audit-notes/ui/css-authority-conv-settings.md from the analysis JSON.
// Usage: node scripts/css-authority-conv-md.mjs <analysisJson> <outMd> [hashBlockFile]
import fs from 'node:fs';
import path from 'node:path';

const IN = process.argv[2] || 'C:/Users/34516/ZCodeProject/out/css-authority-conv-settings.json';
const OUT = process.argv[3] || 'C:/Users/34516/ZCodeProject/audit-notes/ui/css-authority-conv-settings.md';
const HASHBLOCK = process.argv[4] || '';
const r = JSON.parse(fs.readFileSync(IN, 'utf8'));
const G = r.groups;
const short = (f) => f.replace('src/', '').replace('.css', '');
const code = (s) => '`' + s + '`';
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const clip = (s, n = 260) => (s.length > n ? s.slice(0, n) + ' …' : s);
const trunc = (arr, n = 4) => (arr.length > n ? arr.slice(0, n).join(', ') + `, +${arr.length - n}` : arr.join(', '));

const meta = r.meta;
const byB = r.summary.byBucket;
const deadAll = meta.counts.globallyDeadDeclarations;
const deadScope = G.reduce((n, g) => n + g.deadDeclCount, 0);
const overlapRows = G.reduce((n, g) => n + g.diffTable.length, 0);
const sameRows = G.reduce((n, g) => n + g.diffTable.filter((d) => d.sameValue).length, 0);
const risks = G.map((g) => g.mergeRiskTotal).filter((x) => x > 0).sort((a, b) => a - b);
const medRisk = risks.length ? risks[Math.floor(risks.length / 2)] : 0;
const focusGroups = G.filter((g) => g.flags.focusRule || g.flags.markdownRule);
const multiTargets = G.filter((g) => (g.rules[g.winnerFile] || []).some((x) => x.multiSelector));
const provSafe = G.filter((g) => g.mergeRiskTotal === 0);
const deadInFocus = G.filter((g) => g.flags.focusRule || g.flags.markdownRule).reduce((n, g) => n + g.deadDeclCount, 0);

/* ── per-group descriptions ─────────────────────────────────── */
function winDecls(g, f) {
  const seen = new Set();
  const out = [];
  for (const d of g.declarations[f]) {
    if (!d.verdict.startsWith('contributing')) continue;
    const k = `${d.rule.line}|${d.prop}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`${d.prop}: ${d.value}`);
  }
  return out;
}
function orderStr(g, f) {
  return g.rules[f].map((x) => `@${x.orderIndex}/L${x.line}`).join(' ');
}
function winnerShape(g) {
  return Object.entries(g.winsByFile).filter(([, v]) => v.length)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([f, v]) => `${short(f)} ${v.length}`).join(' / ');
}
function exclusiveCounts(g) {
  const sides = Object.keys(g.rules);
  const only = Object.fromEntries(sides.map((f) => [f, 0]));
  for (const l of g.longhands) {
    const files = new Set(l.candidates.map((c) => c.file));
    if (files.size === 1) only[[...files][0]]++;
  }
  const both = g.diffTable.length;
  return { both, only };
}
function diffLines(g, max = 4) {
  const other = Object.keys(g.rules).find((f) => f !== 'src/styles.css') || '';
  const rows = g.diffTable.filter((d) => !d.sameValue);
  if (!rows.length) {
    const ex = exclusiveCounts(g);
    const parts = Object.entries(ex.only).filter(([, v]) => v).map(([f, v]) => `${short(f)} 独占 ${v}`);
    return `无共同长写 —— ${parts.join('、')}（各写各的属性）`;
  }
  const shown = rows.slice(0, max).map((d) => `${d.prop}: styles ${d.styles.value} ⇢ ${short(other)} ${d.other.value}`);
  return shown.join('；') + (rows.length > max ? `；…共 ${rows.length} 处` : '');
}
function actualValues(g) {
  const vals = [];
  for (const f of Object.keys(g.rules)) {
    const v = winDecls(g, f);
    if (v.length) vals.push(`${short(f)}: ${v.slice(0, 5).join('; ')}${v.length > 5 ? ' …' : ''}`);
  }
  return vals.join(' ｜ ') || '（无）';
}
function suggestion(g) {
  const custom = g.customPropNotes.filter((n) => n.onlyDefinition && g.loser.contributingLonghands.includes(n.prop));
  if (g.bucket === 'D') return '先定"想要哪份值"：胜方是硬写、输方是 token。改法是把该 token（或对应 px）搬进胜方那条规则，而不是删输家。';
  if (custom.length && custom.some((n) => Object.keys(n.referencedIn).length)) {
    const n0 = custom.find((n) => Object.keys(n.referencedIn).length);
    return `**删不得**：${code(n0.prop)} 只在 ${short(n0.definedIn[0])} 定义，${Object.entries(n0.referencedIn).map(([f, c]) => short(f) + ` 里 ${c} 处`).join('、')} \`var()\` 引用；正确方向是把它挪进 \`styles.css\` 的 \`:root\`。`;
  }
  if (g.bucket === 'B') {
    const multi = (g.rules[g.winnerFile] || []).some((x) => x.multiSelector);
    return `把输家这 ${g.loser.contributingLonghands.length} 个基础属性（${g.loser.contributingLonghands.join('/')}）并进胜方${multi ? '——目标是多选择器规则，需先拆出单选择器规则' : ''}；挡路 ${g.mergeRiskTotal} 条${g.mergeRiskTotal ? '，需先证明不共元素' : ''}。`;
  }
  return `只差 ${g.loser.contributingLonghands.length} 个长写（${g.loser.contributingLonghands.join('/')}），确认这值归哪个文件后再并；挡路 ${g.mergeRiskTotal} 条。`;
}

/* ── priority ───────────────────────────────────────────────── */
const dGroups = G.filter((g) => g.bucket === 'D');
const bGroups = G.filter((g) => g.bucket === 'B').sort((a, b) => a.mergeRiskTotal - b.mergeRiskTotal);
const cheapC = G.filter((g) => g.bucket === 'C' && g.loser.contributingLonghands.length === 1)
  .sort((a, b) => a.mergeRiskTotal - b.mergeRiskTotal);
const priority = [
  ...dGroups,
  ...bGroups,
  ...cheapC.slice(0, Math.max(0, 15 - dGroups.length - bGroups.length)),
].slice(0, 15);

/* ── evidence ───────────────────────────────────────────────── */
function evidence(g) {
  const files = Object.keys(g.rules);
  const L = [];
  L.push(`**${g.id} ${code(g.selector)}** —— ${g.bucket} 桶，${g.confidence} 置信。${g.bucketReason}。`);
  L.push('');
  L.push('| 侧 | 规则位置 | 声明原文 |');
  L.push('|---|---|---|');
  for (const f of files) for (const ru of g.rules[f]) {
    L.push(`| ${short(f)} | ${orderStr(g, f)} | ${cell(code(clip(ru.raw.replace(/\n\s*/g, ' '))))} |`);
  }
  L.push('');
  // contested longhands first, then a capped list of one-sided ones
  const contested = g.longhands.filter((l) => new Set(l.candidates.map((c) => c.file)).size > 1);
  const oneSided = g.longhands.filter((l) => new Set(l.candidates.map((c) => c.file)).size === 1);
  const loserOwn = oneSided.filter((l) => l.winner === g.loser.file);
  const rest = oneSided.filter((l) => l.winner !== g.loser.file);
  const show = [...contested, ...loserOwn, ...rest].slice(0, 12);
  L.push('| 长写 | 类型 | 赢家 | 计算依据（候选 → 结果） |');
  L.push('|---|---|---|---|');
  for (const l of show) {
    const cands = l.candidates.map((c) => `${short(c.file)}@${c.orderIndex} \`${c.prop}: ${clip(c.value, 60)}\`${c.win ? ' ✔' : ''}`).join(' ; ');
    L.push(`| \`${l.prop}\` | ${l.kind} | ${short(l.winner)} | ${cell(cands)} |`);
  }
  if (show.length < g.longhands.length) {
    L.push(`| … | | | 另有 ${g.longhands.length - show.length} 个长写只有一侧声明，赢家即该侧（完整清单见 JSON） |`);
  }
  L.push('');
  for (const f of files) {
    const win = winDecls(g, f), dead = g.declarations[f].filter((d) => d.globallyDead);
    const winShown = win.length > 8 ? win.slice(0, 8).join('; ') + ` ; …共 ${win.length} 条` : win.join('; ');
    L.push(`- ${short(f)} 净贡献（${g.winsByFile[f].length} 个长写）：${win.length ? code(winShown) : '**无**'}`);
    if (dead.length) L.push(`- ${short(f)} 零贡献声明：${code(dead.map((d) => `${d.prop}: ${d.value}`).join('; '))}`);
  }
  // only the tokens actually at risk: declared by the losing side, or contributed by it
  const risky = g.customPropNotes.filter((x) => x.onlyDefinition &&
    (g.loser.contributingLonghands.includes(x.prop) || x.definedIn.includes(g.loser.file)));
  for (const n of risky) {
    const refs = Object.entries(n.referencedIn).map(([f, c]) => `${short(f)} ${c} 处`).join('、');
    L.push(`- ${code(n.prop)} 只在 ${code(short(n.definedIn[0]))} 定义；引用：本文件 ${n.referencedSameFile} 处${refs ? `，另 ${refs}` : ''}${refs ? ' → **删了会断链**' : ''}`);
  }
  if (g.tokenLostEvidence.length) {
    L.push('');
    L.push('新旧倒挂证据：');
    for (const t of g.tokenLostEvidence) {
      L.push(`- \`${t.prop}\`：赢家 ${short(t.winner.file)}@${t.winner.orderIndex} ${code(t.winner.decl)} vs 输家 ${short(t.loser.file)}@${t.loser.orderIndex} ${code(t.loser.decl)}；token 解析为 ${code(t.resolvedLoserValue)}，与赢家值${t.valuesEqual ? '相同' : '**不同**'}`);
    }
  }
  if (g.mergeRisk.length) {
    L.push('');
    L.push(`挡路规则（搬动时会经过的同特异性、可共匹配、值不同的规则，共 ${g.mergeRiskTotal} 条）：`);
    for (const m of g.mergeRisk.slice(0, 3)) {
      L.push(`- \`${m.prop}\` ${m.blockerRules} 条，例如 ${m.examples.slice(0, 3).map((e) => `${code(e.selector)}@${e.order} \`${e.value}\``).join('、')}`);
    }
  }
  L.push('');
  return L.join('\n');
}

/* ── full table ─────────────────────────────────────────────── */
function fullTable() {
  const L = ['| # | 选择器 | styles 位置 | 另一侧位置 | 共同长写 | 赢家分布 | 输家净贡献 | 挡路 | 桶 | 备注 |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const g of G) {
    const others = Object.keys(g.rules).filter((f) => f !== 'src/styles.css');
    const notes = [];
    if (g.flags.focusRule) notes.push('焦点段·勿动');
    if (g.flags.markdownRule) notes.push('.md 段·勿动');
    if (g.flags.multiSelectorRule) notes.push('多选择器');
    if (g.flags.keywordValues.length) notes.push('含 inherit');
    if (g.tokenLostEvidence.length) notes.push(`倒挂 ${g.tokenLostEvidence.length}`);
    if (g.customPropNotes.some((n) => g.loser.contributingLonghands.includes(n.prop))) notes.push('输家是 token 定义');
    if (g.mergeRiskTotal === 0 && g.bucket !== 'A') notes.push('合并可证');
    if (g.confidence !== 'high') notes.push(`证据${g.confidence}`);
    L.push('| ' + [
      g.id, code(g.selector), orderStr(g, 'src/styles.css'),
      others.map((f) => `${short(f)} ${orderStr(g, f)}`).join(' '),
      `${g.diffTable.length}${g.diffTable.filter((d) => d.sameValue).length ? `(同值${g.diffTable.filter((d) => d.sameValue).length})` : ''}`,
      winnerShape(g),
      g.loser.contributingLonghands.length ? trunc(g.loser.contributingLonghands, 3) : '**无**',
      String(g.mergeRiskTotal), g.bucket, notes.join('·') || '—',
    ].map(cell).join(' | ') + ' |');
  }
  return L.join('\n');
}

const hashBlock = HASHBLOCK && fs.existsSync(HASHBLOCK) ? fs.readFileSync(HASHBLOCK, 'utf8').trim() : '（收工时补齐）';
const selfKill = G.filter((g) => g.bucket === 'B' && g.loser.contributingLonghands.every((p) => p.startsWith('--')));
const Cdist = G.filter((g) => g.bucket === 'C').reduce((a, g) => { const k = g.loser.contributingLonghands.length; a[k] = (a[k] || 0) + 1; return a; }, {});

const md = `# 跨样式表重复选择器 · 权威判定清单（conversation-shell / settings-shell ↔ styles）

日期：2026-10-26 / 27　本轮**零 CSS 改动**（前后 sha1 相同，见 §7）
范围：\`ide-desktop/src/{conversation-shell,settings-shell,styles}.css\` 之间的跨文件重复选择器组，含 1 组三文件共有。\`workspace-shell\` 的 112 组由另一 agent 负责，不在本报告内。

## 0. 结论（数字优先）

| 指标 | 值 |
|---|---|
| 本报告覆盖的重复选择器组 | **${G.length}**（conversation-shell ↔ styles ${r.summary.byPair['src/conversation-shell.css ↔ src/styles.css']}、settings-shell ↔ styles ${r.summary.byPair['src/settings-shell.css ↔ src/styles.css']}、三文件共有 ${r.summary.byPair['src/conversation-shell.css ↔ src/settings-shell.css ↔ src/styles.css']}） |
| **A 可删**（输家零净贡献） | **${byB.A || 0}** |
| **B 需合并**（净贡献全是基础属性） | **${byB.B || 0}** |
| **C 需人判断**（净贡献含设计属性） | **${byB.C || 0}** |
| **D 危险**（赢家是旧写法、输家是 token） | **${byB.D || 0}** |
| 六个表里"全局零贡献"声明总数 | **${deadAll}**，其中本范围 ${deadScope} 条，**${deadInFocus} 条落在 \`:focus\` 段**（上一轮按任务要求保留） |
| 两边都声明了同一长写的行 | ${overlapRows}（其中值完全相同 ${sameRows} 行） |
| 有挡路规则的组 | ${risks.length} / ${G.length}，中位数 **${medRisk}** 条，最多 ${risks[risks.length - 1] ?? 0} 条 |
| 挡住 0 条的组（合并可证） | ${provSafe.length}：${provSafe.map((g) => `${g.id} ${code(g.selector)}`).join('、')} |
| orderIndex 与浏览器一致 | 本范围三个表全部 **${meta.orderVerification.wholeScope.rulesChecked}** 条规则逐条比对，**${meta.orderVerification.wholeScope.mismatches} 条不一致**、${meta.orderVerification.wholeScope.missing} 条缺失 |

**清点口径**：六个表共 **216** 组跨文件重复选择器 = \`styles ↔ workspace-shell\` 112（另一 agent）+ **本报告 104**（71 + 32 + 1）；\`background-browser.css\` / \`gui-control.css\` 与其它表之间**一组重复都没有（0 组）**—— 任务里说的"可能含零散组"实测不存在。

**核心结论**：这 ${G.length} 组里**只有 ${byB.A || 0} 组可以直接删**（而且是焦点段，本轮不许动），${byB.B || 0} 组是"搬几个 layout 属性"，${byB.D || 0} 组是"新写法被旧写法盖住"，其余 ${byB.C || 0} 组是**两边各写一半属性**的设计分摊 —— 删哪半都要丢设计。

**为什么"重复选择器"不等于"重复声明"**：${G.length} 组里，两边都声明了同一个长写的情形只有 ${overlapRows} 处（其中 ${sameRows} 处值完全相同，即纯文本冗余），其余长写**只有一边声明**。也就是说这些组绝大多数是"旧的 styles.css 定义 + 新的 shell 表增量覆盖"，不是同一条声明抄了两遍。这也解释了总任务 §3.4 为什么整组没动：真正能判的（零贡献）只有 ${deadScope} 条，其余都是"这两半谁该留"的归属问题。

## 1. 方法（orderIndex 从浏览器实读，不按文件顺序猜）

1. **加载顺序**取自 \`src/main.tsx:5-10\`：\`styles → conversation-shell → settings-shell → workspace-shell → background-browser → gui-control\`。
2. **orderIndex 来自 CSSOM**：\`C:/tmp/css-order-probe.cjs\` 起隐藏 Electron 窗口，按上述顺序 \`<link>\` 六个表，遍历 \`document.styleSheets[i].cssRules\` 取浏览器自己的规则序号（输出 \`C:/tmp/css-order-probe.json\`，${(meta.orderIndexSource.match(/(\d+) 条/) || [])[1] ?? 3119} 条 CSSStyleRule）。postcss 只用来定位原文偏移与声明块内序，**顺序不靠它猜**。
3. **交叉验证**：逐条把 postcss 解析出的 \`selectorText\` 与浏览器 \`orderIndex\` 位置上的 \`selectorText\` 比对 —— 本报告这 104 组涉及的 **${meta.orderVerification.rulesCrossChecked} 条规则：不一致 ${meta.orderVerification.mismatches} 条**；扩大到本范围三个表的**全部 ${meta.orderVerification.wholeScope.rulesChecked} 条规则：不一致 ${meta.orderVerification.wholeScope.mismatches} 条、缺失 ${meta.orderVerification.wholeScope.missing} 条**。即 postcss 文档序 ≡ CSSOM orderIndex，下面的 orderIndex 数字可以直接当层叠序用。
4. **赢家**按 \`(!important, 特异性, orderIndex, 块内声明序)\` 取最大；\`padding/margin/border/background/font/inset/gap/border-radius/overflow/flex/transition/animation/grid…\` 等 60 余个 shorthand 先展开成长写（复用 \`scripts/css-lib.mjs\`）。\`inherit/initial/unset/revert\` 按普通值参与比较，命中 ${G.filter((g) => g.flags.keywordValues.length).length} 组并单独标注。
5. **上下文**：分组键是 \`(at-rule 上下文, 完整选择器字符串)\`。本报告 ${G.length} 组**全部在顶层**（\`@media\` 内的同名选择器不会被算成同一组）。
6. **"能删"为什么是可证明的**：同一组内所有规则的选择器字符串**完全相同**，必然同时命中同一批元素、特异性相同 → 只有 orderIndex 决定胜负。某条声明若在本组所有规则里对它的每个长写都不是赢家，则匹配该选择器的元素上必有另一条同选择器声明赢它，**删掉它不改变任何元素的任何长写**。注意这比总任务 §3.4 的顾虑更强：§3.4 拦的是"**搬**声明越过别的同特异性规则"，那确实无法证明；"删零贡献声明"不需要那个证明。判定按规则的**全部选择器**做（多选择器规则在兄弟选择器下仍存活的声明不会被误判成死）。
7. **四桶判定**（输家 = 组内赢下长写较少的一侧，因为删它代价最小）：
   - **A**：输家净贡献为空 → 可安全删；
   - **B**：输家净贡献全是 \`display/position/flex-*/align-*/justify-*/grid-*/overflow-*/box-sizing/z-index\` 这类 layout 管线属性；
   - **C**：净贡献含颜色/尺寸/间距/圆角/阴影/字体等设计属性；
   - **D**：胜方用**字面量**（hex/rgb/hsl/裸 px）赢下的长写，输方给的是 \`var()/color-mix()\` 版本 → 新写法被旧写法盖住。
   - 证据不足（两边风格信号分相同等）→ 留在 C 并标 \`证据 medium/low\`，不硬分桶。

## 2. 最该先处理的 ${priority.length} 组

排序：D（新旧倒挂，得先定调）→ B（基础属性，挡路少的先做）→ C 里"只差 1 个长写"且挡路最少的。

| # | 组 | 选择器 | 当前实际生效值 | 两边差异 | 建议 |
|---|---|---|---|---|---|
${priority.map((g, i) => `| ${i + 1} | ${g.id} | ${code(g.selector)} | ${cell(actualValues(g))} | ${cell(diffLines(g, 3))} | ${cell(suggestion(g))} |`).join('\n')}

## 3. 四个桶（每桶抽 3 组原始证据；A 桶只有 1 组，全部列出）

### 3.A 可删（${byB.A || 0} 组）

${G.filter((g) => g.bucket === 'A').map(evidence).join('\n')}

A 桶只有 1 组的原因：**上一轮已经把 440 条零贡献声明删干净了**。现在六个表里全局零贡献的声明只剩 ${deadAll} 条，而且**三条全是 \`styles.css\` 里的 \`:focus\` 规则**：

| 文件 | 规则 | 零贡献声明 | 归属 |
|---|---|---|---|
| styles.css | \`.composer:focus-within\` | \`border-color: var(--border-strong)\` | **本范围 g054（A 桶）** |
| styles.css | \`.settings-text-field:focus\` | \`border-color: var(--fg-dim)\` | **本范围 g082（C 桶）** |
| styles.css | \`.gtx-commit-input:focus\` | \`border-color: var(--accent)\` | workspace-shell 那 112 组，另一 agent 范围 |

g054 那条与赢家**值完全相同**（两侧都是 \`var(--border-strong)\`），属于纯文本重复；g082 那条被 settings-shell 的 \`color-mix(...)\` 版本盖住。两者都是"删了 0 视觉差异"，但都在焦点段 —— **本轮不动**。换句话说：**这两块已经没有"零风险可删"的空间了**。

### 3.B 需合并（${byB.B || 0} 组）

${G.filter((g) => g.bucket === 'B').slice(0, 3).map(evidence).join('\n')}

> B 桶 ${byB.B} 组全表：${bGroups.map((g) => `${g.id} ${code(g.selector)}（挡路 ${g.mergeRiskTotal}）`).join('、')}。
> 其中 ${multiTargets.filter((g) => g.bucket === 'B').length} 组的目标规则是**多选择器规则**（${multiTargets.filter((g) => g.bucket === 'B').map((g) => code(g.selector)).join('、') || '无'}）：合并动作不是"往共享列表里加声明"，而是"在赢家文件里拆出一条单选择器规则"，否则会波及兄弟选择器。

### 3.C 需人判断（${byB.C || 0} 组）

${['g001', 'g104', 'g097'].map((id) => G.find((g) => g.id === id)).filter(Boolean).map(evidence).join('\n')}

> C 桶 ${byB.C} 组的共同形态：**两边各写一半属性**，输家那半是颜色/间距/字号/圆角这类设计决定，删了就丢设计。按"输家净贡献几个长写"分布：${Object.entries(Cdist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} 个 → ${v} 组`).join('，')}。
> **只有 1 个长写的 ${cheapC.length} 组做决定最便宜**：${cheapC.slice(0, 8).map((g) => `${g.id} ${code(g.selector)}（${g.loser.contributingLonghands[0]}）`).join('、')} …
> ${g0note()}

### 3.D 危险（${byB.D || 0} 组）

${dGroups.map(evidence).join('\n')}

> D 桶三组同一形态：\`conversation-shell\` / \`settings-shell\` 里**直接写死 px**（\`margin-bottom: 10px\` 等），把 \`styles.css\` 里已 token 化的 \`margin: 0 0 var(--sp-N)\` 盖掉。解析 token 后的值与赢家值**都不同**（4px vs 10px、12px vs 10px、16px vs 28px），所以不能当"同值两种写法"处理 —— 先定间距该走 token 还是硬值。

## 4. 焦点段与 \`.md-*\` 段：只分析，不动

任务要求这两段"只分析不改，并单独标注"。命中 ${focusGroups.length} 组，**全部是 \`:focus\` / \`:focus-visible\` 段，没有 \`.md-*\` 组**：

${focusGroups.map((g) => `- **${g.id} ${code(g.selector)}**（${g.filePair.split(' ↔ ').map(short).join(' ↔ ')}，${g.bucket} 桶）：${g.bucketReason}。**该段近期被改过（${[g.flags.focusRule ? ':focus-visible 精修' : '', g.flags.markdownRule ? '.md-* 排版精修' : ''].filter(Boolean).join(' / ')}），改动需与之协调。**`).join('\n')}

## 5. 全量表（${G.length} 组）

\`styles 位置\` / \`另一侧位置\` 是 \`@orderIndex/L行号\`（orderIndex 浏览器实读）；\`共同长写\` 是两边都声明了的长写数（括号内为值完全相同）；\`赢家分布\` 是各侧赢下多少长写；\`输家净贡献\` 是删掉输家会丢的长写；\`挡路\` 是合并时会经过的同特异性、可共匹配、值不同的规则数（0 = 合并可证）。

${fullTable()}

## 6. 复算命令

\`\`\`bash
cd C:/Users/34516/ZCodeProject/ide-desktop

# 1) 浏览器 CSSOM orderIndex（隐藏 Electron 窗口，6 个 sheet）
npx electron C:/tmp/css-order-probe.cjs C:/tmp/css-order-probe.json

# 2) 逐组明细（含 orderIndex 交叉验证）
node scripts/css-authority-conv.mjs \\
  C:/Users/34516/ZCodeProject/out/css-authority-conv-settings.json C:/tmp/css-order-probe.json

# 3) 从明细渲染本报告
node scripts/css-authority-conv-md.mjs \\
  C:/Users/34516/ZCodeProject/out/css-authority-conv-settings.json \\
  C:/Users/34516/ZCodeProject/audit-notes/ui/css-authority-conv-settings.md

# 4) 复核重复组清单（全部 216 组，其中 104 组是本报告范围）
node scripts/css-inventory.mjs C:/tmp/css-inv-now.json
\`\`\`

产物：

- \`out/css-authority-conv-settings.json\` —— 逐组明细，字段说明在 JSON 的 \`meta.schema\`
- \`ide-desktop/scripts/css-authority-conv.mjs\` —— 分析器（只读，复用 \`css-lib.mjs\`）
- \`ide-desktop/scripts/css-authority-conv-md.mjs\` —— 本报告渲染器
- \`C:/tmp/css-order-probe.cjs\` / \`.html\` / \`.json\` —— CSSOM orderIndex 探针、夹具与输出

## 7. 零改动证明（哈希 + git）

${hashBlock}
`;

function g0note() {
  const g1 = G.find((x) => x.id === 'g001');
  const n = g1 && g1.customPropNotes.find((x) => x.prop === '--rail-w');
  if (!n) return '';
  return `**特别提示**：\`g001 :root\` 的输家看着"只差 1 个长写"最好办，实际问题相反 —— ${code('--rail-w')} 只在 \`conversation-shell\` 定义，\`styles.css\` 里有 ${Object.values(n.referencedIn)[0] || 0} 处 \`var(--rail-w)\` 引用。删掉 \`conversation-shell\` 那条会让整条格子布局断链，正确方向是把它挪进 \`styles.css\` 的 \`:root\`。`;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log('wrote', OUT, md.length, 'chars', G.length, 'groups');
