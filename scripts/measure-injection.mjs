#!/usr/bin/env node
/**
 * measure-injection.mjs — 度量「每步 unshift 到消息数组头部的三个注入块」的真实成本。
 *
 * 只读：不改 src/、不写任何文件，全部结果打到 stdout（因此可以反复重跑、可对比）。
 *
 * 度量的对象（agent.ts:993-1020）：
 *   每次模型往返前，往 packed.messages 头部 unshift
 *     <past-reflections>          (formatReflections)
 *     [<relevant-project-memories>]  (formatMemories + 包裹标签)
 *     [<global-memory>]           (loadGlobalMemorySummary + 包裹标签)
 *   （还有 skillBlock，本会话没有 .aicode/skills，所以恒为 0 条，不参与。）
 *
 * 数据来源，全部是既有产物：
 *   <session>.json               —— 会话消息（用于还原"历史部分"的字符数）
 *   <session>.trajectory.jsonl   —— 每次往返的真实 usage / promptChars / 消息数 / 时间戳
 *   ~/.aicode/usage.jsonl        —— 每 turn 的 toolScope/toolCount（工具面指纹）
 *   <workspace>/.aicode/memory/entries.json     —— 项目记忆（重建块内容用）
 *   <workspace>/.aicode/reflections.json        —— 反思（重建块内容用）
 *   ~/.zcode/cli/memories/global/edits.jsonl    —— 全局记忆（重建块内容用）
 *
 * 三个层次，务必分清（报告里也叫这三个名字）：
 *   [实测]  注入块总字符 = promptChars(轮) − Σpacked(历史前缀)。精确到字符。
 *   [重建]  三个块各自的字符/占比：用同一套选择函数在今天（或指定 --now）的库上重放，
 *           再按 [实测] 总量归一。库内容会漂移，所以它只是拆分依据，不是测量值。
 *   [推算]  token：本仓库自己的估计器 ceil(utf8字节/4)（autoCompact.estimateTokens），
 *           不是真 tokenizer。
 *
 * 用法：
 *   node scripts/measure-injection.mjs
 *   node scripts/measure-injection.mjs --session <path> [--now ISO] [--ttl-sec 300]
 *        [--usage-log <path>] [--repay-min 5000] [--healthy 0.9]
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DIST = join(REPO, 'dist', 'src');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    session: join(REPO, '.aicode', 'sessions', 'sess_20261026115924_c6ffef29.json'),
    now: undefined,
    ttlSec: 300,
    usageLog: join(homedir(), '.aicode', 'usage.jsonl'),
    repayMin: 5000,
    healthy: 0.9,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session') out.session = resolve(argv[++i]);
    else if (a === '--now') out.now = argv[++i];
    else if (a === '--ttl-sec') out.ttlSec = Number(argv[++i]);
    else if (a === '--usage-log') out.usageLog = resolve(argv[++i]);
    else if (a === '--repay-min') out.repayMin = Number(argv[++i]);
    else if (a === '--healthy') out.healthy = Number(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log('node scripts/measure-injection.mjs [--session p] [--now ISO] [--ttl-sec 300] [--usage-log p]');
      process.exit(0);
    } else throw new Error(`未知参数 ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 纯工具
// ---------------------------------------------------------------------------

const median = (values) => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};
const round = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);
const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : 'n/a');
const pad = (v, n) => String(v).padStart(n);
const padEnd = (v, n) => String(v).padEnd(n);

// ---------------------------------------------------------------------------
// dist 里已有的纯函数（用仓库自己的实现，避免"我另写一份口径"）
// ---------------------------------------------------------------------------

async function loadRepoModules() {
  const must = (p) => {
    if (!existsSync(p)) throw new Error(`${p} 不存在：先 npm run build`);
    return pathToFileURL(p).href;
  };
  const autoCompact = await import(must(join(DIST, 'agent', 'autoCompact.js')));
  const contextBudget = await import(must(join(DIST, 'agent', 'contextBudget.js')));
  const memorySelect = await import(must(join(DIST, 'memory', 'select.js')));
  const memoryFormat = await import(must(join(DIST, 'memory', 'format.js')));
  const memoryTokens = await import(must(join(DIST, 'memory', 'tokens.js')));
  const reflectionTypes = await import(must(join(DIST, 'reflection', 'types.js')));
  return {
    estimateTokens: autoCompact.estimateTokens,
    APPROX_BYTES_PER_TOKEN: autoCompact.APPROX_BYTES_PER_TOKEN,
    compactMessagesForModel: contextBudget.compactMessagesForModel,
    messageChars: contextBudget.messageChars ?? ((m) => (typeof m.content === 'string' ? m.content.length : 0)),
    selectRelevantMemories: memorySelect.selectRelevantMemories,
    formatMemories: memoryFormat.formatMemories,
    rankMemories: memoryTokens.rankMemories,
    formatReflections: reflectionTypes.formatReflections,
  };
}

// ---------------------------------------------------------------------------
// 读入
// ---------------------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function readTrajectory(sessionPath) {
  const file = sessionPath.replace(/\.json$/, '.trajectory.jsonl');
  if (!existsSync(file)) return { file, rows: [] };
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return { file, rows };
}

/** 台账行（toolScope/toolCount），按 sessionId 过滤。 */
function readLedgerRows(logPath, sessionId) {
  if (!existsSync(logPath)) return [];
  const rows = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!sessionId || row.sessionId === sessionId) rows.push(row);
    } catch {
      /* 台账是 best-effort 写的，坏行跳过 */
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 三个块的重建
//
// 每个块都是「检索函数 × 当时的库」。库在今天已经漂移（本会话在跑的过程中就地
// 改代码、写记忆），所以按 --now 把"本会话之后才出现的东西"滤掉，尽量还原当时
// 的输入。仍然是重建，不是测量：报告里按 [重建] 标注。
// ---------------------------------------------------------------------------

/**
 * 项目记忆：与 agent.ts loadMemoryBlock 完全同路（selectRelevantMemories +
 * formatMemories），门前加一道 createdAt ≤ now 的时间过滤。
 */
function reconstructMemoryBlock(mods, workspaceRoot, prompt, nowMs) {
  const file = join(workspaceRoot, '.aicode', 'memory', 'entries.json');
  if (!existsSync(file)) return { text: undefined, entries: 0, note: 'entries.json 不存在' };
  const raw = readJson(file);
  const list = Array.isArray(raw) ? raw : (raw.entries ?? []);
  const asOf = list.filter((e) => {
    const ts = Date.parse(e.createdAt ?? '');
    return Number.isFinite(ts) ? ts <= nowMs : true;
  });
  const relevant = mods.selectRelevantMemories({ entries: asOf, goal: prompt, limit: 5 });
  if (relevant.length === 0) return { text: undefined, entries: 0, note: `库内 ${asOf.length} 条，无相关` };
  const body = mods.formatMemories(relevant);
  return {
    text: `<relevant-project-memories>\n${body}\n</relevant-project-memories>`,
    entries: relevant.length,
    note: `库内 ${asOf.length} 条 → 选中 ${relevant.length} 条`,
  };
}

/**
 * 全局记忆：src/memory/global.ts loadGlobalMemorySummary 的等价实现 + 时间过滤。
 * 抄写自该文件 245-289 行（topFiles / latestPerProject / formatWhen 的格式），
 * 唯一改动是 records 先按 at ≤ now 过滤——原实现读的是"今天"的整条账本。
 */
function reconstructGlobalBlock(workspaceRoot, nowMs, rootDir) {
  const ledger = join(rootDir ?? join(homedir(), '.zcode', 'cli', 'memories', 'global'), 'edits.jsonl');
  if (!existsSync(ledger)) return { text: undefined, records: 0, note: 'edits.jsonl 不存在' };
  const records = [];
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (typeof r?.at === 'string' && typeof r.path === 'string' && typeof r.workspace === 'string') records.push(r);
    } catch {
      /* 半行跳过 */
    }
  }
  const asOf = records.filter((r) => Date.parse(r.at) <= nowMs);
  if (asOf.length === 0) return { text: undefined, records: 0, note: '截至会话时点无记录' };
  const key = (w) => (process.platform === 'win32' ? w.replace(/[\\/]+$/, '').toLowerCase() : w.replace(/[\\/]+$/, ''));
  const currentKey = key(workspaceRoot);
  const same = asOf.filter((r) => key(r.workspace) === currentKey);
  const elsewhere = asOf.filter((r) => key(r.workspace) !== currentKey);
  const SUMMARY_FILE_LIMIT = 8;

  const lines = [];
  const files = new Map();
  for (const r of same) {
    const prev = files.get(r.path);
    if (prev) {
      prev.count += 1;
      if (r.at > prev.at) prev.at = r.at;
    } else files.set(r.path, { at: r.at, count: 1 });
  }
  const top = [...files.entries()]
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, SUMMARY_FILE_LIMIT)
    .map(([path, info]) => ({ path, ...info }));
  if (top.length > 0) {
    lines.push('This workspace, recently edited (earlier sessions included):');
    for (const f of top) lines.push(`- ${f.path} — ${globalWhen(f.at)}${f.count > 1 ? `, ${f.count} edits` : ''}`);
  }
  const byProject = new Map();
  for (const r of elsewhere) {
    const k = key(r.workspace);
    const cur = byProject.get(k);
    if (!cur || r.at > cur.at) byProject.set(k, r);
  }
  const other = [...byProject.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
  if (other.length > 0) {
    lines.push('Other projects, most recent edit:');
    for (const r of other) lines.push(`- ${globalProject(r.workspace)}: ${r.path} — ${globalWhen(r.at)}`);
  }
  if (lines.length === 0) return { text: undefined, records: asOf.length, note: '渲染后为空' };
  return {
    text: `<global-memory>\n${lines.join('\n')}\n</global-memory>`,
    records: asOf.length,
    note: `截至会话时点 ${asOf.length} 条记录（本工作区 ${same.length}）`,
  };
}

function globalWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function globalProject(workspaceRoot) {
  const trimmed = workspaceRoot.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || workspaceRoot;
}

/**
 * 反思：ReflectionStore.selectRelevant（src/reflection/store.ts:128-150）的等价实现，
 * 唯一改动是把 Date.now() 换成 --now——原实现里"30 天内 +1 分"会让同一份库在
 * 不同日子选出不同的条目，不钉死时间就不可复现。
 */
function reconstructReflectionBlock(mods, workspaceRoot, prompt, nowMs) {
  const file = join(workspaceRoot, '.aicode', 'reflections.json');
  if (!existsSync(file)) return { text: undefined, entries: 0, note: 'reflections.json 不存在' };
  const raw = readJson(file);
  const list = Array.isArray(raw) ? raw : (raw.entries ?? []);
  const entries = list
    .filter((e) => e && typeof e.topic === 'string' && typeof e.failure === 'string')
    .filter((e) => {
      const ts = Date.parse(e.at ?? '');
      return Number.isFinite(ts) ? ts <= nowMs : true;
    });
  if (entries.length === 0) return { text: undefined, entries: 0, note: '截至会话时点无条目' };
  const lower = prompt.toLowerCase();
  const scored = entries.map((entry) => {
    let score = 0;
    for (const w of reflTokenize(entry.topic)) if (w.length >= 2 && lower.includes(w)) score += 2;
    for (const w of reflTokenize(entry.failure)) if (w.length >= 3 && lower.includes(w)) score += 1;
    const ageDays = (nowMs - Date.parse(entry.at)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays < 30) score += 1;
    score += Math.min(2, (Number(entry.hits) || 0) / 5);
    return { entry, score };
  });
  const picked = scored
    .filter((s) => s.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.entry);
  if (picked.length === 0) return { text: undefined, entries: entries.length, note: `库内 ${entries.length} 条，无一条过阈值` };
  return {
    text: mods.formatReflections(picked),
    entries: picked.length,
    note: `库内 ${entries.length} 条 → 选中 ${picked.length} 条`,
  };
}

function reflTokenize(text) {
  const words = [];
  let cur = '';
  for (const ch of text.toLowerCase()) {
    if (/[a-z0-9_一-鿿]/.test(ch)) cur += ch;
    else {
      if (cur) words.push(cur);
      cur = '';
    }
  }
  if (cur) words.push(cur);
  for (const w of [...words]) {
    if (/[一-鿿]/.test(w) && w.length >= 3) {
      for (let i = 0; i + 2 <= w.length; i += 1) words.push(w.slice(i, i + 2));
    }
  }
  return words;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mods = await loadRepoModules();
  const session = readJson(opts.session);
  const { rows, file: trajectoryFile } = readTrajectory(opts.session);
  if (rows.length === 0) throw new Error(`没有轨迹 ${trajectoryFile}`);
  const workspaceRoot = session.workspaceRoot ?? REPO;
  const nowMs = Date.parse(opts.now ?? session.updatedAt ?? rows[rows.length - 1].completedAt ?? new Date().toISOString());

  const L = [];
  L.push('== 0. 输入与口径 ==');
  L.push(`  会话      ${opts.session}`);
  L.push(`  轨迹      ${trajectoryFile} （${rows.length} 次模型往返）`);
  L.push(`  台账      ${opts.usageLog}`);
  L.push(`  provider/model  ${session.provider} / ${session.model}`);
  L.push(`  重建基准时点 --now = ${new Date(nowMs).toISOString()}（库内容按此时间过滤，钉死以保证可重跑）`);
  L.push(`  token 口径  ceil(utf8字节 / ${mods.APPROX_BYTES_PER_TOKEN})  ← autoCompact.estimateTokens，本仓库自己的估计器`);

  // ---- 打包后的历史前缀（用仓库自己的 packing，确保与被发送的历史逐字节同源） ----
  // 口径必须和 agent.ts:1127 的 promptChars 完全一致：只数 content 的字符数
  //（contextBudget.messageChars 还会加 role/name/8 的每消息开销，那是别处的口径）。
  const contentChars = (m) => (typeof m.content === 'string' ? m.content.length : 0);
  const packed = mods.compactMessagesForModel(session.messages, { model: session.model });
  const prefix = [0];
  for (const m of packed.messages) prefix.push(prefix[prefix.length - 1] + contentChars(m));
  L.push(`  打包      mode=${packed.mode} messages=${packed.messages.length} chars=${packed.compactChars}`
    + ` dropped=${packed.droppedMessages} originalChars=${packed.originalChars}`);
  if (packed.mode === 'hard-pack') {
    L.push('  ⚠ 本轮打包是 hard-pack（丢掉了最老的消息），历史前缀与 session.messages 不再一一对应，注入字符的实测会失真。');
  }

  // ---- turn 切分（同 contextLedger.groupTurns） ----
  const turns = [];
  let prevStep = Number.NEGATIVE_INFINITY;
  rows.forEach((r, i) => {
    if (i === 0 || r.step === 1 || r.step <= prevStep) turns.push({ first: i, last: i });
    turns[turns.length - 1].last = i;
    prevStep = r.step;
  });

  const usageOf = (r) => r.usage ?? {};
  const inputOf = (r) => usageOf(r).inputTokens ?? 0;
  const readOf = (r) => usageOf(r).cacheReadTokens ?? 0;
  const promptTokOf = (r) => inputOf(r) + readOf(r);
  const hitOf = (r) => {
    const p = promptTokOf(r);
    return p > 0 ? readOf(r) / p : 0;
  };

  // ---- ① 每轮注入字符：promptChars − Σpacked(历史前缀) ----
  // 注入块数 k 未知（1~4），每个 k 给一个残差；同一 turn 内残差应恒定
  //（块每 turn 只加载一次、turn 内不变），据此选 k 并判定 turn 可信。
  const KS = [0, 1, 2, 3, 4];
  const residual = rows.map((r) => {
    const out = {};
    for (const k of KS) {
      const n = r.requestMessageCount - k;
      out[k] = n >= 0 && n <= packed.messages.length ? (r.promptChars ?? 0) - prefix[n] : NaN;
    }
    return out;
  });
  const turnResiduals = (turn, k) => [...Array(turn.last - turn.first + 1)]
    .map((_, j) => residual[turn.first + j][k])
    .filter(Number.isFinite);
  const turnMedian = (turn, k) => median(turnResiduals(turn, k));
  const TRUST_TOL = 64; // 字符：允许个别轮次的尾部提示（recovery hint / lastCall）造成偏移
  const AGREEMENT_MIN = 0.8;
  const turnAgreement = (turn, k) => {
    const v = turnResiduals(turn, k);
    if (v.length === 0) return 0;
    const m = median(v);
    return v.filter((x) => Math.abs(x - m) <= TRUST_TOL).length / v.length;
  };
  // 选 k：取"残差在 turn 内高度一致的 turn 数最多"的那个
  let bestK = 3;
  let bestScore = -1;
  for (const k of KS) {
    const score = turns.filter((t) => turnAgreement(t, k) >= AGREEMENT_MIN && turnMedian(t, k) >= 200).length;
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  const turnTrusted = turns.map((t) => turnAgreement(t, bestK) >= AGREEMENT_MIN && turnMedian(t, bestK) >= 200);

  L.push('');
  L.push('== 1. 每轮残差（= promptChars − 历史前缀字符，应等于注入块的字符数）==');
  L.push(`  ${pad('i', 3)} ${pad('turn', 4)} ${pad('step', 4)} ${pad('msgs', 4)} ${pad('chars', 7)} `
    + KS.map((k) => pad(`k${k}`, 9)).join(' '));
  rows.forEach((r, i) => {
    const ti = turns.findIndex((t) => i >= t.first && i <= t.last);
    L.push(`  ${pad(i, 3)} ${pad(ti + 1, 4)} ${pad(r.step, 4)} ${pad(r.requestMessageCount, 4)} ${pad(r.promptChars ?? 0, 7)} `
      + KS.map((k) => pad(Number.isFinite(residual[i][k]) ? round(residual[i][k], 0) : 'n/a', 9)).join(' '));
  });
  L.push('');
  L.push(`  逐 turn 残差一致性（k=0..4 各自，一致率 = 落在中位数 ±${TRUST_TOL} 字符内的轮次占比）：`);
  L.push(`  ${pad('turn', 4)} ${pad('rounds', 6)} ` + KS.map((k) => pad(`agree k${k}`, 11)).join(' '));
  turns.forEach((t, i) => {
    L.push(`  ${pad(i + 1, 4)} ${pad(t.last - t.first + 1, 6)} `
      + KS.map((k) => pad(pct(turnAgreement(t, k), 0), 11)).join(' '));
  });
  L.push(`  ⇒ 选定 k=${bestK}（一致且残差为正的 turn 数 ${bestScore}/${turns.length}）；`
    + `一致率 ≥ ${pct(AGREEMENT_MIN, 0)} 且残差中位数 ≥ 200 字符才算可信 turn。`);

  // ---- ② 逐 turn：注入字符、首轮重付、基线 ----
  const healthyInputs = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // cold start 不算基线
    if (hitOf(r) >= opts.healthy && promptTokOf(r) > 0) healthyInputs.push(inputOf(r));
  });
  const steady = median(healthyInputs);

  const repayedRounds = rows
    .map((r, i) => i)
    .filter((i) => inputOf(rows[i]) >= opts.repayMin && hitOf(rows[i]) < opts.healthy);

  const ledgerRows = readLedgerRows(opts.usageLog, session.id ?? null);
  const ledgerAligned = ledgerRows.length === turns.length;

  // 逐 turn 记录
  const T = turns.map((t, ti) => {
    const r0 = rows[t.first];
    const prev = t.first > 0 ? rows[t.first - 1] : undefined;
    const gapSec = prev ? (Date.parse(r0.startedAt) - Date.parse(prev.completedAt)) / 1000 : null;
    const resid = turnResiduals(t, bestK);
    const med = turnMedian(t, bestK);
    const measuredChars = turnTrusted[ti] ? med : null;
    const ledgerRow = ledgerAligned ? ledgerRows[ti] : undefined;
    return {
      ti,
      first: t.first,
      last: t.last,
      rounds: t.last - t.first + 1,
      input: inputOf(r0),
      cacheRead: readOf(r0),
      promptTok: promptTokOf(r0),
      hit: hitOf(r0),
      gapSec,
      surfaceCount: ledgerRow?.toolCount ?? null,
      surfaceScope: ledgerRow?.toolScope ?? null,
      measuredChars,
      trusted: turnTrusted[ti],
      /** turn 内残差偏离中位数 > 容差的轮次数（= 尾部被追加了别的消息）。 */
      outliers: resid.filter((v) => Math.abs(v - med) > TRUST_TOL).length,
      // turn 首轮的历史长度（消息条数），用来定位这一 turn 的 user prompt
      historyLen: r0.requestMessageCount - bestK,
    };
  });

  // 未实测的 turn（本会话是压缩前 3 个 turn：压缩把历史改写掉了，前缀对不上）
  const trustedChars = T.filter((t) => Number.isFinite(t.measuredChars)).map((t) => t.measuredChars);
  const fallbackChars = median(trustedChars);
  for (const t of T) if (!Number.isFinite(t.measuredChars)) t.measuredChars = fallbackChars;

  // 工具面 Δ（台账口径：scope+count 指纹变化）
  const fp = (row) => (row && row.surfaceCount !== null ? `${row.surfaceScope}/${row.surfaceCount}` : null);
  for (let i = 1; i < T.length; i += 1) T[i].surfaceChanged = fp(T[i]) !== null && fp(T[i - 1]) !== null && fp(T[i]) !== fp(T[i - 1]);
  T[0].surfaceChanged = null;

  // ---- ③ 三个块的重建（按 turn 的 user prompt） ----
  // 只有"历史前缀可还原"的 turn 才重放块内容；压缩前的 turn 历史已被摘要改写，
  // 前缀对不上，重放出来的 prompt 是错的，所以不给重建值（宁缺勿假）。
  for (const t of T) {
    if (!t.trusted) {
      t.prompt = null;
      continue;
    }
    const promptMsg = packed.messages[t.historyLen - 1];
    t.prompt = typeof promptMsg?.content === 'string' ? promptMsg.content : null;
  }
  for (const t of T) {
    if (!t.prompt) continue;
    t.blocks = {
      reflections: reconstructReflectionBlock(mods, workspaceRoot, t.prompt, nowMs),
      memories: reconstructMemoryBlock(mods, workspaceRoot, t.prompt, nowMs),
      global: reconstructGlobalBlock(workspaceRoot, nowMs),
    };
  }
  const blockKeys = ['reflections', 'memories', 'global'];
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  const reconSum = (t) => blockKeys.reduce((s, k) => s + (t.blocks[k].text?.length ?? 0), 0);
  const reconBytes = (t) => blockKeys.reduce((s, k) => s + bytesOf(t.blocks[k].text ?? ''), 0);
  const withBlocks = T.filter((t) => t.trusted && t.blocks);
  const reconTotalMedian = median(withBlocks.map(reconSum).filter((v) => v > 0));
  const measuredMedian = median(withBlocks.map((t) => t.measuredChars));
  // 每字符多少 utf8 字节（中文 ≈ 3）：用实际重建文本量出来的，不用 'x' 的假字节数
  const medianBpc = median(withBlocks.map((t) => reconBytes(t) / (reconSum(t) || 1)));
  // 三块占比（字符口径，重建）
  const share = {};
  for (const k of blockKeys) {
    share[k] = median(withBlocks.map((t) => (t.blocks[k].text?.length ?? 0) / (reconSum(t) || 1)));
  }

  // ---- ④ 反事实：块挪到消息列表末尾 ----
  // 缓存模型（见报告 §2）：
  //   * 前缀缓存：命中长度 = 与"上一次请求"从第 0 字节起的最长公共前缀
  //   * 缓存断点：整段 tools+system+messages（除最后一条）
  //   * 最小可缓存前缀：1024 token（OpenAI/DeepSeek 口径）；本会话每轮都在 2 万 token 以上，恒满足
  //   * TTL：5 分钟
  // 于是：
  //   现状  首轮付 input（= 整个前缀按全价重读）
  //   反事实末位首轮付 steady + 块 token（= 只有新增的 user 消息与块是新字节）
  //   反事实 turn 内每一步多付 块 token（块每步跟在末尾，前一步的块字节接不上下一步）
  const tokensOfChars = (chars) => Math.ceil((chars * medianBpc) / mods.APPROX_BYTES_PER_TOKEN);
  for (const t of T) {
    t.blockChars = t.measuredChars;
    t.blockTokens = tokensOfChars(t.blockChars);
    t.paidNow = t.input;
    t.cfInput = Math.round(steady) + t.blockTokens;
    t.coldStart = t.first === 0;
    // 冷启动之前没有任何请求，缓存本来就是空的：挪位置一分不省
    t.grossSaving = t.coldStart ? 0 : Math.max(0, t.input - t.cfInput);
    t.tailExtra = t.blockTokens * (t.rounds - 1);
    t.netSaving = t.grossSaving - t.tailExtra;
    t.ttlOk = t.gapSec !== null && t.gapSec <= opts.ttlSec;
    t.shareOfRepaid = t.input > 0 ? t.blockTokens / t.input : 0;
  }

  // 总账
  const totalInput = rows.reduce((s, r) => s + inputOf(r), 0);
  const totalRead = rows.reduce((s, r) => s + readOf(r), 0);
  const turnBoundaryInput = T.reduce((s, t) => s + t.input, 0);
  const turnBoundaryExcess = T.reduce((s, t) => s + Math.max(0, t.input - steady), 0);
  const turnFirstIdx = new Set(T.map((t) => t.first));
  const withinTurnInput = totalInput - turnBoundaryInput;
  const withinTurnExcess = rows.reduce(
    (s, r, i) => s + (turnFirstIdx.has(i) ? 0 : Math.max(0, inputOf(r) - steady)),
    0,
  );

  // 敏感性场景
  const compactionRounds = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    if ((rows[i - 1].requestMessageCount ?? 0) - (rows[i].requestMessageCount ?? 0) >= 3) compactionRounds.add(i);
  }
  const scenarios = [
    { id: 'S0 理论上限', keep: () => true, note: '只排除冷启动；假设其余首轮全部只因头部块变化而重付' },
    { id: 'S1 +TTL 5min', keep: (t) => t.ttlOk, note: '两次请求间隔 > 5min，缓存本来就过期' },
    { id: 'S2 +工具面变化', keep: (t) => t.ttlOk && t.surfaceChanged !== true, note: '工具数组在 system 之前，一变缓存从第 0 字节失效' },
    { id: 'S3 +压缩后首轮', keep: (t) => t.ttlOk && t.surfaceChanged !== true && !compactionRounds.has(t.first), note: '压缩把历史整段换掉，块放哪儿都省不下来' },
    { id: 'S4 悲观', keep: () => false, note: '假设缓存本来每轮都会断，挪位置一分不省' },
  ];
  for (const s of scenarios) {
    s.turns = T.filter(s.keep);
    s.grossSaving = s.turns.reduce((a, t) => a + t.grossSaving, 0);
    s.tailExtra = s.turns.reduce((a, t) => a + t.tailExtra, 0);
    s.netSaving = s.grossSaving - s.tailExtra;
  }

  // "稳定化"不挪位置：块字节跨 turn 恒定 → 首轮只付 steady，且 turn 内不额外付块
  const stabilisedGross = T.filter((t) => !t.coldStart).reduce((a, t) => a + Math.max(0, t.input - steady), 0);
  // "缩小"：块变小不改变"头部每 turn 都在变"这个事实，只是每次整段重读时少读几字节
  const shrinkSavedPerFullRead = Math.round(tokensOfChars(fallbackChars) * 0.75);
  const fullPrefixReads = repayedRounds.length + 1; // +1 = cold start
  const shrinkSaving = shrinkSavedPerFullRead * fullPrefixReads;

  // ---- 输出 ----
  const perTurn = (v) => round((v / Math.max(1, T.length)) * 100, 0);

  L.push('');
  L.push('== 2. 逐 turn 实测（注入字符 / 首轮重付）==');
  L.push(`  ${pad('turn', 4)} ${pad('rounds', 6)} ${pad('首轮i', 6)} ${pad('注入字符', 8)} ${pad('块token', 7)} `
    + `${pad('input', 8)} ${pad('cacheRd', 8)} ${pad('prompt', 8)} ${pad('hit', 7)} ${pad('块/重付', 8)} ${pad('gap s', 7)} ${pad('工具面', 12)} flag`);
  for (const t of T) {
    const flags = [];
    if (!t.trusted) flags.push('块字符=估算');
    if (t.outliers > 0) flags.push(`尾部偏移${t.outliers}轮`);
    if (t.coldStart) flags.push('cold');
    if (t.surfaceChanged === true) flags.push('surfaceΔ');
    if (compactionRounds.has(t.first)) flags.push('压缩后');
    if (t.gapSec === null || t.ttlOk === false) flags.push('TTL过期');
    L.push(`  ${pad(t.ti + 1, 4)} ${pad(t.rounds, 6)} ${pad(t.first, 6)} `
      + `${pad(`${t.trusted ? '' : '≈'}${round(t.blockChars, 0)}`, 8)} ${pad(t.blockTokens, 7)} `
      + `${pad(t.input, 8)} ${pad(t.cacheRead, 8)} ${pad(t.promptTok, 8)} ${pad(pct(t.hit), 7)} `
      + `${pad(pct(t.shareOfRepaid), 8)} ${pad(t.gapSec === null ? '-' : round(t.gapSec, 0), 7)} `
      + `${padEnd(`${t.surfaceScope ?? '-'}/${t.surfaceCount ?? '-'}`, 12)} ${flags.join(',')}`);
  }
  L.push('');
  L.push(`  稳态基线（命中率≥${pct(opts.healthy, 0)} 且非冷启动的净输入中位数） = ${round(steady, 1)} token`);
  L.push('  「块/重付」= 块 token ÷ 这一轮全价重读的净输入：块自己只占"被它作废的前缀"这么多。');
  L.push(`  全部净输入 Σinput = ${totalInput}，ΣcacheRead = ${totalRead}，加权命中率 = ${pct(totalRead / (totalInput + totalRead))}`);
  L.push(`  turn 首轮 ${T.length} 轮：Σinput = ${turnBoundaryInput}（占净输入 ${pct(turnBoundaryInput / totalInput)}），`
    + `超稳态 = ${round(turnBoundaryExcess)}`);
  L.push(`  turn 内部 ${rows.length - T.length} 轮：Σinput = ${withinTurnInput}（占 ${pct(withinTurnInput / totalInput)}），`
    + `超稳态 = ${round(withinTurnExcess)}，其中重付轮 ${repayedRounds.filter((i) => !turnFirstIdx.has(i)).length} 轮`);
  L.push(`  重付轮总数（净输入≥${opts.repayMin} 且命中率<${pct(opts.healthy, 0)}）= ${repayedRounds.length}/${rows.length}`);
  L.push(`  token 折算口径：${round(medianBpc, 2)} utf8 字节/字符（从重建文本量出）× 字符数 ÷ ${mods.APPROX_BYTES_PER_TOKEN}`);

  L.push('');
  L.push('== 3. 三个块各自多少 token（[实测]总量 + [重建]拆分）==');
  L.push(`  ${pad('turn', 4)} ${pad('prompt', 30)} ${pad('实测块字符', 10)} ${pad('重建Σ', 7)} `
    + `${pad('reflections', 11)} ${pad('memories', 11)} ${pad('global', 11)}`);
  for (const t of T) {
    const r = t.blocks ? reconSum(t) : null;
    const parts = blockKeys.map((k) => pad(t.blocks ? (t.blocks[k].text?.length ?? 0) : 'n/a', 11));
    L.push(`  ${pad(t.ti + 1, 4)} ${padEnd(JSON.stringify((t.prompt ?? '?').slice(0, 26)), 30)} `
      + `${pad(`${t.trusted ? '' : '≈'}${round(t.blockChars, 0)}`, 10)} ${pad(r === null ? 'n/a' : r, 7)} ${parts.join(' ')}`);
  }
  L.push('');
  L.push(`  重建 Σ 中位数 ${round(reconTotalMedian, 0)} 字符 vs 实测中位数 ${round(measuredMedian, 0)} 字符`
    + ` → 偏差 ${pct(reconTotalMedian > 0 ? measuredMedian / reconTotalMedian - 1 : NaN)}（库漂移；拆分按此比例归一）`);
  L.push(`  三块占比（重建中位数）：` + blockKeys.map((k) => `${k} ${pct(share[k])}`).join(' · '));
  const totalBlockChars = T.reduce((s, t) => s + t.blockChars, 0);
  const totalBlockTokens = T.reduce((s, t) => s + t.blockTokens, 0);
  L.push(`  全会话注入字符合计 = ${round(totalBlockChars)} chars，≈ ${totalBlockTokens} token（按条 role=user，不受 8000 字符裁剪）`);
  L.push(`  逐块折算（归一后，全会话）：` + blockKeys.map((k) => `${k} ≈ ${round(totalBlockTokens * share[k])} token`).join(' · '));

  L.push('');
  L.push('== 4. 反事实：三块挪到消息数组末尾 ==');
  L.push(`  ${pad('turn', 4)} ${pad('现状首轮input', 12)} ${pad('反事实input', 11)} ${pad('毛节省', 8)} ${pad('尾部新增', 8)} ${pad('净节省', 8)} 距上次请求(s)`);
  for (const t of T) {
    L.push(`  ${pad(t.ti + 1, 4)} ${pad(t.paidNow, 12)} ${pad(t.cfInput, 11)} ${pad(t.grossSaving, 8)} ${pad(t.tailExtra, 8)} ${pad(t.netSaving, 8)} ${t.gapSec === null ? '-' : round(t.gapSec, 0)}`);
  }

  L.push('');
  L.push('== 5. 敏感性 ==');
  L.push(`  ${padEnd('场景', 20)} ${pad('纳入turn', 8)} ${pad('毛节省', 9)} ${pad('尾部新增', 9)} ${pad('净节省', 9)} ${pad('占全部超额', 12)}  说明`);
  for (const s of scenarios) {
    L.push(`  ${padEnd(s.id, 20)} ${pad(`${s.turns.length}/${T.length}`, 8)} ${pad(s.grossSaving, 9)} ${pad(s.tailExtra, 9)} `
      + `${pad(s.netSaving, 9)} ${pad(pct(turnBoundaryExcess > 0 ? s.netSaving / turnBoundaryExcess : 0), 12)}  ${s.note}`);
  }
  const sBest = scenarios[0].netSaving;
  L.push('');
  L.push(`  对照 1「稳定化」（块字节跨 turn 恒定，位置不动）：≈ ${round(stabilisedGross)} token，无尾部新增`
    + `（比 S0 净节省多 ${round(stabilisedGross - sBest)}）`);
  L.push(`  对照 2「缩小」：块 ${round(fallbackChars)} 字符/≈${tokensOfChars(fallbackChars)} token，压到 25%`
    + `每次整段重读省 ${shrinkSavedPerFullRead} token × ${fullPrefixReads} 次整段重读 = ${round(shrinkSaving)} token`
    + `（占全部超额 ${pct(turnBoundaryExcess > 0 ? shrinkSaving / turnBoundaryExcess : 0)}）`);
  L.push(`  每 100 turn 外推（按本会话 ${T.length} turn 的均值线性外推）：`);
  L.push(`    什么都不做 = 每 100 turn 重付 ≈ ${perTurn(turnBoundaryExcess)} token（turn 首轮超额，全部）`);
  L.push(`    挪到末尾净省：S3 保守 ≈ ${perTurn(scenarios[3].netSaving)} · S0 上限 ≈ ${perTurn(sBest)} token / 100 turn`);
  L.push(`    稳定化净省（上限口径）≈ ${perTurn(stabilisedGross)} token / 100 turn`);
  L.push(`    缩小净省 ≈ ${perTurn(shrinkSaving)} token / 100 turn`);

  L.push('');
  L.push('== 6. 三个块在相邻 turn 之间是否真的变了（[重建]）==');
  L.push(`  ${pad('turn', 4)} ${padEnd('reflections', 13)} ${padEnd('memories', 13)} ${padEnd('global', 13)} 变化的块`);
  for (let i = 1; i < T.length; i += 1) {
    const a = T[i - 1].blocks;
    const b = T[i].blocks;
    if (!a || !b) {
      L.push(`  ${pad(i + 1, 4)} ${padEnd('n/a', 13)} ${padEnd('n/a', 13)} ${padEnd('n/a', 13)} 无重建`);
      continue;
    }
    const changed = blockKeys.filter((k) => (a[k].text ?? '') !== (b[k].text ?? ''));
    const mark = (k) => padEnd(a[k].text === b[k].text ? 'same' : 'CHANGED', 13);
    L.push(`  ${pad(i + 1, 4)} ${blockKeys.map(mark).join(' ')} ${changed.length === 0 ? '（三块全同）' : changed.join(',')}`);
  }

  L.push('');
  L.push('== 7. 复现 ==');
  L.push(`  cd ${REPO}`);
  L.push('  npm run build');
  L.push(`  node scripts/measure-injection.mjs --session "${opts.session}" --now ${new Date(nowMs).toISOString()}`);
  process.stdout.write(`${L.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`measure-injection 失败：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
