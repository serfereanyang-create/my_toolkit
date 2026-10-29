/**
 * contextLedger.ts — 会话上下文连续性台账（只读报告）
 *
 * 目的：用真实落盘的会话产物回答"连续性到底在哪里丢钱"，而不是靠感觉。
 * 四个指标，全部来自既有产物，本文件不写任何运行时路径、不改变任何行为：
 *
 * 1. 工具面指纹 —— 每个 turn 送出的工具集合（scope + 工具数）的哈希，以及是否
 *    与上一个 turn 不同。工具数组序列化在 system 之前、落在缓存前缀之内，一变
 *    缓存就从第 0 字节失效；所以"哪一轮开始重付"的直接证据就是这里的 Δ。
 * 2. 前缀缓存命中率 —— 每轮 cacheRead / (input + cacheRead)，外加整段会话的
 *    加权平均。口径与 src/providers/usage-normalisation.test.ts 一致：
 *    `inputTokens` 是"净输入"（已被缓存的部分不含在内；OpenAI 系厂商回报的
 *    prompt_tokens 是含缓存的总数，usageFromOpenAI 已扣掉），因此命中率的分母
 *    必须是 input + cacheRead，否则缓存的 token 会被算两遍。
 * 3. 压缩后重付量 —— 压缩事件定位 + 压缩那一轮相对稳态多付的输入 token +
 *    压缩后第几轮才回到正常命中率。
 * 4. 同文件重复读 —— read_file / read_lines / read_many_files 的路径重复次数。
 * 5. 相邻轮次三向诊断 —— 每对相邻轮分别回答三个**互不替代**的问题：
 *    (a) 工具 SET 变没变（多重集合、规范排序后比较）；
 *    (b) 是否**只有顺序**变了（集合相同、序列不同）；
 *    (c) 前缀字节变没变（本地产物能证明的部分）。
 *    三者混在一起时，"记录顺序抖动"会被误读成"工具面变了"——工具数组落在
 *    缓存前缀第 0 字节上，真正的顺序变化会让缓存全灭，而**记录**顺序的变化
 *    只是噪声。规范表示（sort）只用于比较，绝不进入任何请求；实际发送顺序
 *    由 ToolRegistry.list() 的字母序决定，本文件不碰。
 *
 * 数据来源（三者都是既有产物，本脚本只读）：
 * - `<session>.json`             —— messages / toolCalls（压缩标记、重复读）
 * - `<session>.trajectory.jsonl` —— 每次模型往返的真实 usage（src/session/modelTrajectory.ts）
 * - `~/.aicode/usage.jsonl`       —— 每 turn 的 toolScope / toolCount（src/usage/ledger.ts）
 *
 * 关于工具面的诚实说明（这条很重要，别把指纹当成本来不是它的东西）：
 * 每轮**请求里真实的工具名列表有过两个来源，都还不够**。TrajectoryRecord 的
 * toolNames 记的是本轮*调用了*什么（模型输出顺序，不是发送顺序）；UsageLedgerEntry
 * 只记 toolScope + toolCount（本轮*发出了几个*工具）。所以本报告的主指纹仍是
 * "台账口径指纹"：对 scope + count 取 sha256，provenance 标为 `ledger-scope-count`。
 * 它足以发现工具面变化（本会话 274 → 260 → 274 → 340 都是它抓到的），但**不**足以
 * 证明两次 count 相同的 turn 送出了逐字节相同的数组。
 *
 * 三向诊断（指标 5）在此之上把三个问题拆开，并逐对标注它依据的是哪一层：
 * `sent-tools`（轨迹里有 toolSetNames，即真实发送数组）、`called-tools`
 * （toolNames，只能回答"这一轮调用了什么"）、`scope-count`（只能回答"数量变没变"）。
 * 层的名字出现在每一行里，所以"called-tools 层上集合变了"不会被读成"发送数组变了"。
 * toolSetNames 由 agent.ts 在实际发送前写入（`stepTools.list().map(t => t.name)`，
 * 即 `tools: stepTools.specs()` 的同一个注册表），包括规划 turn 末步撤成
 * 单工具 `propose_plan` 的那一轮。历史行没有这个字段时按 called-tools 回退，
 * 并在每一对上写明依据的层；在这之前产出的会话只能停在 called-tools 层。
 * `sent-tools` 层额外带一个顺序敏感哈希（toolSetOrderHash）：提供者按数组顺序
 * 取缓存，顺序变了就是前缀变了，而多重集合哈希看不见这一点。
 *
 * "轮"的口径：一轮 = 一次模型往返 = 轨迹里的一条记录（i 为 0 基下标）。
 * 一个 turn（一次用户输入）可以含很多轮；工具作用域每 turn 只解析一次
 * （agent.ts 进循环前调 resolveToolScope），所以 turn 内的工具数组是同一个。
 *
 * 用法：
 *   node dist/src/audit/contextLedger.js <session.json> [--index N]
 *        [--usage-log <path>] [--out <dir>] [--verify-registry]
 *   node dist/src/audit/contextLedger.js --latest [--session-dir <dir>]
 *        （不给路径时取 <cwd>/.aicode/sessions 下 mtime 最新的会话 JSON，
 *          `npm run ledger` 就是这条：分析对象是磁盘上最新的那次会话。）
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { SUMMARY_PREFIX } from '../agent/autoCompact.js';
import {
  diffToolNames,
  readTrajectoryRecords,
  recordedToolSurface,
  trajectoryPathFor,
  type TrajectoryRecord,
} from '../session/modelTrajectory.js';
import { resolveUsageLogPath } from '../usage/ledger.js';

// ---------------------------------------------------------------------------
// 常量与口径
// ---------------------------------------------------------------------------

/**
 * 命中率 ≥ 这个值算"这一轮的缓存是热的"。90% 以下就认为前缀被重建过一次：
 * 健康的追加式历史里，净输入只该占 prompt 的几个百分点。
 */
export const HEALTHY_HIT_RATE = 0.9;

/**
 * 一次"重付"的最小规模：净输入 ≥ 这个 token 数才算真的多付了钱。
 * 健康的追加式轮次净输入通常在几百 token，5000 是一个不会误报的下限。
 */
export const REPAY_MIN_INPUT_TOKENS = 5000;

/** 压缩检测：requestMessageCount 至少掉这么多条，才算历史被摘要改写而不是普通截断。 */
export const COMPACTION_MESSAGE_DROP = 3;

export const READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'read_lines', 'read_many_files']);

/** 会话 JSON 里本报告用得到的字段。 */
type SessionShape = {
  id?: string;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  messages?: Array<{ role?: string; content?: string; name?: string }>;
  toolCalls?: Array<{ tool?: string; input?: unknown; ok?: boolean }>;
};

/** 轨迹记录里真实存在的 usage 字段（TrajectoryRecord 的声明少了 cacheReadTokens）。 */
type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

/** 台账里本报告用得到的一行（src/usage/ledger.ts 的子集）。 */
type LedgerRow = {
  ts?: string;
  turnId?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheEfficiency?: number;
  toolScope?: string;
  toolCount?: number;
  /** 本 turn 的自动压缩支出（真实 token）；有它表示该 turn 触发过压缩。 */
  autoCompact?: { calls?: number; outcome?: 'completed' | 'failed' | 'cancelled' };
};

// ---------------------------------------------------------------------------
// 报告结构
// ---------------------------------------------------------------------------

export type ToolSurface = {
  scope: string | null;
  count: number | null;
  /** sha256(`scope=<s>;count=<n>`).slice(0,12)，null = 台账没有这一轮的记录。 */
  fingerprint: string | null;
  provenance: 'ledger-scope-count' | 'missing';
};

export type TurnRow = {
  turn: number;
  firstRound: number;
  lastRound: number;
  rounds: number;
  inputTokens: number;
  cacheReadTokens: number;
  promptTokens: number;
  hitRate: number;
  surface: ToolSurface;
  /** 与上一个 turn 的指纹相比是否变化；第一 turn 或指纹缺失时为 null。 */
  surfaceChanged: boolean | null;
  /** 台账这一行的 token 是否等于本 turn 各轮之和（口径核对）。 */
  ledgerMatches: boolean | null;
  ledgerTurnId: string | null;
};

export type RoundRow = {
  /** 轨迹下标，即"第几轮"（0 基）。 */
  i: number;
  turn: number;
  step: number;
  requestMessageCount: number;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  promptTokens: number;
  hitRate: number;
  /** 净输入 ≥ REPAY_MIN_INPUT_TOKENS 且命中率 < HEALTHY_HIT_RATE。 */
  repayed: boolean;
  /**
   * 本轮 cacheRead / 上一轮 prompt —— 提供者视角的"前缀被复用了多少"。
   * 上一轮没有 prompt、或任一轮没有 provider usage 时为 null（不是"复用 0%"）。
   * 比值上限为 1：见 `reuseCapped`。
   */
  observedReuse: number | null;
  /**
   * provider 报回的 cacheRead 大于上一轮整个 prompt。复用比例不可能超过 1 ——
   * 上一轮没算进 prompt 的字节（system/工具段的差异、预算裁剪、或中转自身的
   * 计数口径）被算成了"命中"。此时 `observedReuse` 记 1，这里记 true，异常可见
   * 而不是被一个 >1 的比值悄悄带进 APPEND 判据。
   */
  reuseCapped?: boolean;
  /** 本轮的轨迹记录是否带 provider usage；false 时 promptTokens=0 不代表空 prompt。 */
  usageRecorded?: boolean;
  /**
   * `repayed` 的子集：本轮重付了，但提供者仍复用了 ≥ HEALTHY_HIT_RATE 的上一轮
   * 前缀 —— 钱花在"这一轮一次性追加了大量新内容"，不是前缀被重建。
   * 判据（一步可复算）：`repayed && observedReuse !== null && observedReuse >= HEALTHY_HIT_RATE`。
   * 与 `repayed` 并存而不是替换它：重付轮总数仍是 `repayed` 的 40 轮，读者用它区分原因。
   */
  appendDriven: boolean;
  coldStart: boolean;
  /** 本轮是所在 turn 的第一次模型往返。 */
  turnFirst: boolean;
  surface: ToolSurface;
  /** 本轮是所在 turn 的第一次往返，且该 turn 的工具面与前一个 turn 不同。 */
  surfaceChanged: boolean;
};

export type CompactionEvent = {
  source: 'trajectory-message-drop';
  /** 压缩前最后一条轨迹记录的下标。 */
  beforeRound: number | null;
  /** 压缩后第一条轨迹记录的下标——"压缩发生的那一轮"。 */
  afterRound: number | null;
  requestMessagesBefore: number | null;
  requestMessagesAfter: number | null;
  /** 会话 messages 里压缩桩的位置（以 SUMMARY_PREFIX 开头的那条）。 */
  stubMessageIndex: number | null;
  summaryChars: number | null;
  /** 压缩前的一整轮 prompt 与压缩后第一轮的 prompt，用来显示"变小了但仍然全价"。 */
  promptTokensBefore: number;
  promptTokensAfter: number;
  /** 压缩那一轮的净输入。 */
  inputTokensAfter: number;
  /** 稳态下同样长度的增量通常只付多少（健康轮净输入的中位数）。 */
  steadyStateInputBaseline: number;
  /** 相对稳态多付的输入 token = inputTokensAfter - steadyStateInputBaseline。 */
  rePaidInputTokens: number;
  /** 压缩后第几轮回到健康命中率（1 = 紧接着的下一轮就恢复了）；null = 观察窗口内没恢复。 */
  recoveredAfterRounds: number | null;
  /** 压缩前后各若干轮的命中率曲线。 */
  curve: Array<{ i: number; hitRate: number; inputTokens: number }>;
};

export type RepeatRead = { path: string; count: number; tools: Record<string, number> };

/**
 * 一对相邻轮次的工具名比较依据的是哪一层记录。
 *
 * - `sent-tools`   —— 轨迹里记下了本轮真实发送的工具名（顺序即发送顺序）。
 * - `called-tools` —— 只有本轮*调用*了哪些工具：这是活动记录，不是工具面。
 * - `scope-count`  —— 只有台账的 scope + 工具数：能证明"数量变了"，看不到名字和顺序。
 * - `none`         —— 两层都没有，什么都不说。
 */
export type PairToolLayer = 'sent-tools' | 'called-tools' | 'scope-count' | 'none';

/**
 * 一对相邻轮次（prevRound → round）的三向诊断。
 *
 * 三个诊断必须分开：`toolSetChanged` 与 `toolOrderOnlyChanged` 混在一起时，
 * 记录顺序的抖动（模型先调 A 后调 B / 先 B 后 A）会被读成工具面在漂；而
 * `prefixBytesChanged` 又是另一件事——只有落在缓存段之内的字节变了才算。
 */
export type RoundPairRow = {
  prevRound: number;
  round: number;
  /** 这一对是否跨越 turn 边界（跨了才可能换 scope）。 */
  crossesTurn: boolean;
  /** 诊断一：工具集合是否变了（多重集合，按规范排序比较）。 */
  toolSetChanged: boolean | null;
  /** 诊断二：是否**只有**顺序变了（集合相同、序列不同）。 */
  toolOrderOnlyChanged: boolean | null;
  /**
   * 发送数组的顺序敏感哈希（`toolSetOrderHash`），只在 sent-tools 层有值。
   * 两个相邻轮相等 ⇒ 送出的工具名序列逐位相同；不等 ⇒ 前缀的工具段换了。
   * called-tools 层为 null：模型调用顺序不进入请求，哈希它等于编造一个不存在的字节序。
   */
  toolSetOrderHash: string | null;
  /** 上一轮同字段，用于人工核对（sent-tools 层以外都是 null）。 */
  prevToolSetOrderHash: string | null;
  /** 诊断三：前缀字节是否变了。false = 本地无变更证据，**不等于**没变。 */
  prefixBytesChanged: boolean | null;
  /** 上面两个"工具"诊断依据的层。 */
  layer: PairToolLayer;
  /** 名字层可见的增删（规范排序、含重数）。 */
  added: string[];
  removed: string[];
  /**
   * 台账 scope+count 探针：同一 turn 内恒为 false；跨 turn 且 scope/count 不同为
   * true（必有名字差异）；跨 turn 但 scope/count 相同为 null（count 相同**不**证明
   * 名字相同——本会话 274→260→274 就是反例）。
   */
  scopeCountChanged: boolean | null;
  /** 前缀变了的本地证据；空数组 + prefixBytesChanged=false 表示"本地没看到变更"。 */
  prefixEvidence: string[];
  /** 提供者自己的回答：本轮 cacheRead / 上一轮 prompt。1 ≈ 整段前缀被复用。 */
  observedReuse: number | null;
  /** 比值被上限截到 1（provider 报的 cacheRead 大于上一轮 prompt）。 */
  reuseCapped?: boolean;
  /** 提供者否认复用（observedReuse < HEALTHY_HIT_RATE）。 */
  providerSawBreak: boolean | null;
  inputTokens: number;
  repayed: boolean;
};

export type ContextLedgerReport = {
  session: {
    file: string;
    id: string | null;
    provider: string | null;
    model: string | null;
    messageCount: number;
    toolCallCount: number;
    trajectoryFile: string;
    trajectoryExists: boolean;
    usageLog: string;
  };
  rounds: RoundRow[];
  turns: TurnRow[];
  /** 逐对相邻轮次的三向诊断（长度 = 轮数 - 1）。 */
  pairs: RoundPairRow[];
  toolDiagnosis: {
    pairs: number;
    /** 每对落在哪一层 —— 混在一起的平均值没有意义，所以按层计数。 */
    layers: Record<PairToolLayer, number>;
    toolSetChanged: number;
    toolOrderOnlyChanged: number;
    prefixChanged: number;
    /** 本地无变更证据的轮对数（可能确实没变，也可能变化发生在我们看不见的字节里）。 */
    prefixNoEvidence: number;
    prefixUnknown: number;
    /**
     * 本地证据说"没变"、而提供者说"没复用"：缓存杀手在本地产物看不见的地方
     * （system 头部块、工具 schema 内容等），不是这份台账能归因的。
     */
    unexplainedBreaks: Array<{
      prevRound: number;
      round: number;
      observedReuse: number;
      inputTokens: number;
      repayed: boolean;
    }>;
    /**
     * 纯重排轮对。`called-tools` 层上这是记录噪声（模型换了调用顺序），
     * `sent-tools` 层上这才是真的缓存全灭——层写在同一行里。
     */
    orderOnlyPairs: Array<{ prevRound: number; round: number; layer: PairToolLayer }>;
    note: string;
  };
  cache: {
    rounds: number;
    roundsWithUsage: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    /** ΣcacheRead / Σ(input + cacheRead) —— 整段会话的加权平均命中率。 */
    weightedHitRate: number | null;
    /** 未加权（每轮命中率简单平均），只作对照。 */
    meanHitRate: number | null;
    repayedRounds: number[];
    /**
     * `repayedRounds` 的子集：提供者仍复用了 ≥ HEALTHY_HIT_RATE 的上一轮前缀，
     * 低命中率来自本轮一次性的大追加，不是前缀重建。判据见 `isAppendDriven`。
     */
    appendDrivenRounds: number[];
    coldStartRounds: number[];
    /** 没有 provider usage 记录的轮次：它们的 prompt 是"未知"，不是 0。 */
    roundsMissingUsage: number[];
    /** provider 报回的 cacheRead 大于上一轮 prompt、复用比被截到 1 的轮次。 */
    reuseCappedRounds: number[];
    /** 健康轮净输入的 token 中位数，作为"增量该付多少"的基线。 */
    steadyStateInputBaseline: number;
    /**
     * 重付按位置拆开：turn 首轮（历史之前的内容变了）vs turn 内部（同样的
     * 前缀在 turn 中途失效）。两者的修法完全不同，混在一起就只剩一句"命中率低"。
     */
    repayBreakdown: {
      turnBoundary: { rounds: number; repayed: number; inputTokens: number; excessInputTokens: number };
      withinTurn: { rounds: number; repayed: number; inputTokens: number; excessInputTokens: number };
    };
  };
  toolSurface: {
    provenance: 'ledger-scope-count' | 'missing';
    changes: Array<{
      turn: number;
      round: number;
      fromScope: string | null;
      fromCount: number | null;
      toScope: string | null;
      toCount: number | null;
      /** 这次变化所在轮是否正好是一轮重付。 */
      coincidedWithRepay: boolean;
    }>;
    counts: Array<{ turn: number; scope: string | null; count: number | null }>;
    /**
     * 工具面变化能不能和"turn 边界"分开。resolveToolScope 每个 turn 只解析一次，
     * 所以工具面变化必然落在 turn 首轮；若该会话的 turn 首轮本来就都在重付，
     * 这份数据就分不清是谁干的——必须说出来，不能把相关性当因果。
     */
    separation: {
      turnBoundaryRounds: number;
      turnBoundaryRepayed: number;
      separable: boolean;
      note: string;
    };
    note: string;
  };
  compactions: CompactionEvent[];
  repeatReads: {
    readCalls: number;
    distinctPaths: number;
    top: RepeatRead[];
  };
  warnings: string[];
  /** --verify-registry 时的复现尝试结果。 */
  registryReconstruction?: {
    compact: number;
    standard: number;
    full: number;
    recordedCounts: number[];
    reproduced: boolean;
    note: string;
  };
};

// ---------------------------------------------------------------------------
// 读入
// ---------------------------------------------------------------------------

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function readLedger(logPath: string, sessionId: string | null): LedgerRow[] {
  if (!existsSync(logPath)) return [];
  const rows: LedgerRow[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as LedgerRow;
      if (!sessionId || row.sessionId === sessionId) rows.push(row);
    } catch {
      /* 坏行跳过：台账是 best-effort 写的 */
    }
  }
  return rows;
}

function usageOf(record: TrajectoryRecord): RawUsage {
  const usage = (record as unknown as { usage?: RawUsage }).usage;
  return usage ?? {};
}

/**
 * Whether this round's record carries provider usage at all.
 *
 * A round with `usage: undefined` is missing data (the mock provider, a trace
 * failure, an older writer). Its `promptTokens` sums to 0, and a consumer that
 * reads that as "the previous prompt was empty" draws a different conclusion
 * than one that reads it as "unknown": the reuse ratio, `providerSawBreak` and
 * the cold-start diagnosis all hinge on the difference.
 */
function hasUsage(record: TrajectoryRecord): boolean {
  const usage = (record as unknown as { usage?: RawUsage }).usage;
  if (!usage) return false;
  return usage.inputTokens !== undefined || usage.cacheReadTokens !== undefined;
}

// ---------------------------------------------------------------------------
// 纯计算（导出以便单独验证）
// ---------------------------------------------------------------------------

export function hitRateOf(inputTokens: number, cacheReadTokens: number): number {
  const prompt = inputTokens + cacheReadTokens;
  return prompt > 0 ? cacheReadTokens / prompt : 0;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * 提供者视角的复用率：本轮 cacheRead / 上一轮 prompt。1.00 ≈ 上一轮的前缀整段被复用。
 * 第一轮（没有上一轮）为 null。与 `hitRateOf` 不同，这个比值不受"本轮追加了多少新内容"影响，
 * 所以它能把"一次性大追加"和"前缀被重建"分开。
 *
 * 两个边界：
 *  - 上一轮 prompt 为 0 时返回 null。0 在轨迹里既可能是"真的没有历史"，也可能是
 *    "这一轮的记录没带 usage"；前者无从比较，后者是没有数据。把两者都记成 0%
 *    会让 `providerSawBreak` 误报一次前缀重建。
 *  - 比值封顶 1。见 `reuseCapped`。
 */
export function observedReuseOf(
  previousPromptTokens: number,
  cacheReadTokens: number,
): number | null {
  if (!(previousPromptTokens > 0)) return null;
  if (!(cacheReadTokens > 0)) return 0;
  return Math.min(1, cacheReadTokens / previousPromptTokens);
}

/**
 * provider 报回的 cacheRead 是否超过了上一轮整个 prompt。
 *
 * 真实数据里出现过一次（`sess_20261026115924_c6ffef29` 第 86 轮：cacheRead
 * 108,800 对上一轮 prompt 106,564，比值 1.021）。复用不可能超过上一轮发出去
 * 的内容，超出的部分只能来自没被算进 prompt 的字节（工具段/system 差异、
 * 预算裁剪、中转计数口径）。留一个显式标记，读数的人知道比值被截过。
 */
export function reuseCapped(previousPromptTokens: number, cacheReadTokens: number): boolean {
  return previousPromptTokens > 0 && cacheReadTokens > previousPromptTokens;
}

/**
 * REPAY 的两个子类之一：重付了，但提供者仍复用了 ≥ HEALTHY_HIT_RATE 的上一轮前缀。
 *
 * 判据：`repayed && observedReuse !== null && observedReuse >= HEALTHY_HIT_RATE`。
 * 含义：这一轮命中率低是因为**本轮一次性追加了大量新内容**（新内容本来就不在缓存里），
 * 不是因为前缀被重建。`observedReuse` 为 null（第一轮）时无从判断，不算大追加。
 */
export function isAppendDriven(repayed: boolean, observedReuse: number | null): boolean {
  return repayed && observedReuse !== null && observedReuse >= HEALTHY_HIT_RATE;
}

export function surfaceFingerprint(scope: string | null, count: number | null): string | null {
  if (scope === null && count === null) return null;
  return createHash('sha256').update(`scope=${scope};count=${count}`).digest('hex').slice(0, 12);
}

export function surfaceOf(row: LedgerRow | null): ToolSurface {
  if (!row) return { scope: null, count: null, fingerprint: null, provenance: 'missing' };
  const scope = typeof row.toolScope === 'string' ? row.toolScope : null;
  const count = typeof row.toolCount === 'number' ? row.toolCount : null;
  return {
    scope,
    count,
    fingerprint: surfaceFingerprint(scope, count),
    provenance: scope === null && count === null ? 'missing' : 'ledger-scope-count',
  };
}

/**
 * 把轨迹切成 turn。一次用户输入可以花掉很多次模型往返，而工具作用域是每个
 * turn 解析一次，所以 turn 是"工具面可能变"的最小粒度：turn 内工具数组不变。
 */
export function groupTurns(records: TrajectoryRecord[]): Array<{ first: number; last: number }> {
  const turns: Array<{ first: number; last: number }> = [];
  let previousStep = Number.NEGATIVE_INFINITY;
  records.forEach((record, index) => {
    const startsTurn = index === 0 || record.step === 1 || record.step <= previousStep;
    if (startsTurn) turns.push({ first: index, last: index });
    turns[turns.length - 1].last = index;
    previousStep = record.step;
  });
  return turns;
}

/** 找到压缩事件：轨迹里 requestMessageCount 的骤降就是历史被摘要改写的那一轮。 */
export function detectCompactionDrops(
  records: TrajectoryRecord[],
): Array<{ beforeRound: number; afterRound: number; before: number; after: number }> {
  const drops: Array<{ beforeRound: number; afterRound: number; before: number; after: number }> = [];
  for (let i = 1; i < records.length; i++) {
    const before = records[i - 1].requestMessageCount ?? 0;
    const after = records[i].requestMessageCount ?? 0;
    if (before - after >= COMPACTION_MESSAGE_DROP) {
      drops.push({ beforeRound: i - 1, afterRound: i, before, after });
    }
  }
  return drops;
}

/** read_file / read_lines / read_many_files 的路径计数（read_many_files 按 paths 逐条计）。 */
export function countRepeatReads(session: SessionShape): {
  readCalls: number;
  counts: Map<string, { count: number; tools: Record<string, number> }>;
} {
  const counts = new Map<string, { count: number; tools: Record<string, number> }>();
  let readCalls = 0;
  for (const call of session.toolCalls ?? []) {
    const tool = call.tool ?? '';
    if (!READ_TOOLS.has(tool)) continue;
    readCalls++;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const paths: string[] = [];
    if (typeof input.path === 'string') paths.push(input.path);
    if (Array.isArray(input.paths)) {
      for (const path of input.paths) if (typeof path === 'string') paths.push(path);
    }
    if (Array.isArray(input.files)) {
      for (const path of input.files) if (typeof path === 'string') paths.push(path);
    }
    for (const path of paths) {
      const entry = counts.get(path) ?? { count: 0, tools: {} };
      entry.count++;
      entry.tools[tool] = (entry.tools[tool] ?? 0) + 1;
      counts.set(path, entry);
    }
  }
  return { readCalls, counts };
}

// ---------------------------------------------------------------------------
// 相邻轮次三向诊断
// ---------------------------------------------------------------------------

/**
 * 逐对相邻轮次回答三个互不替代的问题：
 *
 *  1. 工具 SET 变没变 —— 用**规范排序**后的多重集合比对（modelTrajectory.ts
 *     的 diffToolNames）。规范表示只用于比较，从不进入请求：发送顺序由
 *     ToolRegistry.list() 决定，本函数不改变任何发送行为。
 *  2. 是否只有顺序变了 —— 集合相同、原始序列不同。这一项存在的唯一理由，
 *     就是把"记录顺序抖动"从"工具面漂移"里拆出去；在 called-tools 层上它是
 *     噪声，在 sent-tools 层上它才是真的缓存全灭（提供者对数组按顺序取哈希）。
 *  3. 前缀字节变没变 —— 只用本地产物能证明的证据（发送数组变了、台账 scope/count
 *     变了、消息数没增长、promptChars 没增长、压缩骤降）。`false` 的含义是
 *     "本地没有变更证据"，不是"确实没变"：system 头部块的逐 turn 变化这份产物
 *     看不到。提供者自己的回答（observedReuse）另行给出，只用来对照，不用来
 *     替代任何一个诊断。
 */
export function diagnoseRoundPairs(records: TrajectoryRecord[], rounds: RoundRow[]): RoundPairRow[] {
  const pairs: RoundPairRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const before = records[i - 1];
    const after = records[i];
    const prevRound = rounds[i - 1];
    const curRound = rounds[i];
    const crossesTurn = (prevRound?.turn ?? 0) !== (curRound?.turn ?? 0);

    const surfaceBefore = recordedToolSurface(before);
    const surfaceAfter = recordedToolSurface(after);
    const nameLayer: PairToolLayer = surfaceBefore.layer === 'sent-tools' && surfaceAfter.layer === 'sent-tools'
      ? 'sent-tools'
      : surfaceBefore.layer === 'called-tools' && surfaceAfter.layer === 'called-tools'
        ? 'called-tools'
        : 'none';
    const diff = diffToolNames(surfaceBefore.raw, surfaceAfter.raw);

    // 台账口径的 scope + count 探针：与名字层完全独立的一条证据。
    const prevSurface = prevRound?.surface ?? null;
    const curSurface = curRound?.surface ?? null;
    const bothCounted = typeof prevSurface?.count === 'number' && typeof curSurface?.count === 'number';
    const scopeCountChanged: boolean | null = bothCounted
      // turn 内 scope 每 turn 只解析一次，所以 turn 内数组不变；
      // 跨 turn 才可能变，而 count 相同**不**证明名字相同（274→260→274 是反例）。
      ? crossesTurn
        ? prevSurface?.scope !== curSurface?.scope || prevSurface?.count !== curSurface?.count
        : false
      : null;

    const layer: PairToolLayer = nameLayer !== 'none'
      ? nameLayer
      : bothCounted
        ? 'scope-count'
        : 'none';

    let toolSetChanged: boolean | null;
    let toolOrderOnlyChanged: boolean | null;
    if (nameLayer !== 'none') {
      toolSetChanged = diff.setChanged;
      // 名字层之外的层看不到顺序，所以这一项在这些层上留 null 而不是猜 false。
      toolOrderOnlyChanged = diff.orderOnlyChange;
    } else if (scopeCountChanged === true) {
      toolSetChanged = true;
      toolOrderOnlyChanged = null;
    } else if (scopeCountChanged === false) {
      toolSetChanged = crossesTurn ? null : false;
      toolOrderOnlyChanged = null;
    } else {
      toolSetChanged = null;
      toolOrderOnlyChanged = null;
    }

    const evidence: string[] = [];
    if (nameLayer === 'sent-tools') {
      if (diff.setChanged) evidence.push('sent-tool-set-changed');
      if (diff.orderOnlyChange) evidence.push('sent-tool-order-changed');
    }
    if (scopeCountChanged === true) evidence.push('scope-count-changed');
    if ((before.requestMessageCount ?? 0) - (after.requestMessageCount ?? 0) >= COMPACTION_MESSAGE_DROP) {
      evidence.push('compaction-drop');
    }
    const messagesKnown = (before.requestMessageCount ?? 0) > 0 && (after.requestMessageCount ?? 0) > 0;
    const charsKnown = (before.promptChars ?? 0) > 0 && (after.promptChars ?? 0) > 0;
    if (messagesKnown && after.requestMessageCount <= before.requestMessageCount) evidence.push('message-count-not-grown');
    if (charsKnown && after.promptChars <= before.promptChars) evidence.push('prompt-chars-not-grown');

    const prevPrompt = prevRound?.promptTokens ?? 0;
    // Same presence rule as the per-round loop: a round whose record carries no
    // provider usage is missing data, not a 0-token prompt. Requiring the
    // CURRENT round's usage (the old code tested `promptTokens > 0`) would have
    // produced a 0 here — indistinguishable from "the provider reused nothing".
    //
    // `prevRound` is required too: it is the row this pair is compared against,
    // and when round `i-1` fell outside the analysed window there is no previous
    // prefix to measure even if its raw record happens to be on disk.
    const curHasUsage = hasUsage(after);
    const prevHasUsage = hasUsage(records[i - 1]);
    const observedReuse = prevRound && curHasUsage && prevHasUsage
      ? observedReuseOf(prevPrompt, curRound?.cacheReadTokens ?? 0)
      : null;

    pairs.push({
      prevRound: i - 1,
      round: i,
      crossesTurn,
      toolSetChanged,
      toolOrderOnlyChanged,
      prefixBytesChanged: evidence.length > 0 ? true : messagesKnown && charsKnown ? false : null,
      layer,
      added: diff.added,
      removed: diff.removed,
      scopeCountChanged,
      prefixEvidence: evidence,
      toolSetOrderHash: surfaceAfter.orderHash,
      prevToolSetOrderHash: surfaceBefore.orderHash,
      observedReuse,
      ...(reuseCapped(prevPrompt, curRound?.cacheReadTokens ?? 0) ? { reuseCapped: true } : {}),
      providerSawBreak: observedReuse === null ? null : observedReuse < HEALTHY_HIT_RATE,
      inputTokens: curRound?.inputTokens ?? 0,
      repayed: curRound?.repayed ?? false,
    });
  }
  return pairs;
}

function summarizePairs(pairs: RoundPairRow[]): ContextLedgerReport['toolDiagnosis'] {
  const layers: Record<PairToolLayer, number> = { 'sent-tools': 0, 'called-tools': 0, 'scope-count': 0, none: 0 };
  for (const pair of pairs) layers[pair.layer] += 1;
  const count = (predicate: (pair: RoundPairRow) => boolean) => pairs.filter(predicate).length;
  const note = layers['sent-tools'] > 0
    ? '每一对都按轨迹里记录的真实发送数组（toolSetNames）比较：集合/顺序/前缀三个诊断都可直接采信。'
    : layers['called-tools'] > 0
      ? '轨迹里没有记录真实发送数组（toolSetNames），三向诊断里前两项落在 called-tools 层：'
        + '它回答的是"这一轮调用了哪些工具"，不是"这一轮发出了哪些工具"。'
        + '因此该层上"集合变了"不能读成工具面变了、"只有顺序变了"是记录噪声而不是缓存事件；'
        + '前缀诊断只用本地证据（含台账 scope/count 与历史是否纯追加），不看这一层的增删。'
      : layers['scope-count'] > 0
        ? '既没有名字层也没有发送数组记录，工具诊断只剩台账 scope+count：能证伪"数量没变"以外的推断有限。'
        : '轨迹里没有任何工具名记录，工具诊断不可用。';
  return {
    pairs: pairs.length,
    layers,
    toolSetChanged: count((pair) => pair.toolSetChanged === true),
    toolOrderOnlyChanged: count((pair) => pair.toolOrderOnlyChanged === true),
    prefixChanged: count((pair) => pair.prefixBytesChanged === true),
    prefixNoEvidence: count((pair) => pair.prefixBytesChanged === false),
    prefixUnknown: count((pair) => pair.prefixBytesChanged === null),
    unexplainedBreaks: pairs
      .filter((pair) => pair.providerSawBreak === true && pair.prefixBytesChanged !== true)
      .map((pair) => ({
        prevRound: pair.prevRound,
        round: pair.round,
        observedReuse: pair.observedReuse ?? 0,
        inputTokens: pair.inputTokens,
        repayed: pair.repayed,
      })),
    orderOnlyPairs: pairs
      .filter((pair) => pair.toolOrderOnlyChanged === true)
      .map((pair) => ({ prevRound: pair.prevRound, round: pair.round, layer: pair.layer })),
    note,
  };
}

// ---------------------------------------------------------------------------
// 组装报告
// ---------------------------------------------------------------------------

export async function buildReport(options: {
  sessionPath: string;
  usageLogPath?: string;
  verifyRegistry?: boolean;
}): Promise<ContextLedgerReport> {
  const sessionPath = resolve(options.sessionPath);
  const session = readJson<SessionShape>(sessionPath);
  const trajectoryFile = trajectoryPathFor(sessionPath);
  const trajectoryExists = existsSync(trajectoryFile);
  const records = trajectoryExists ? readTrajectoryRecords(sessionPath) : [];
  const usageLog = resolveUsageLogPath(options.usageLogPath);
  const ledgerRows = readLedger(usageLog, session.id ?? null);

  const warnings: string[] = [];
  if (!trajectoryExists) {
    warnings.push(
      `没有找到轨迹文件 ${basename(trajectoryFile)}：每轮 usage 无从取得，指标 1–3 只有会话 JSON 能给的部分。`,
    );
  }
  if (records.length > 0 && ledgerRows.length === 0) {
    warnings.push(
      `台账 ${usageLog} 里没有本会话的行：工具面（scope + 工具数）无从确认，指标 1 只能标 missing。`
      + '可用 --usage-log 指定别的台账。',
    );
  }

  // ---- turn 与台账行配对 ---------------------------------------------------
  const turns = groupTurns(records);
  const turnLedger: Array<LedgerRow | null> = turns.map(() => null);
  if (turns.length > 0 && ledgerRows.length > 0) {
    if (ledgerRows.length === turns.length) {
      turns.forEach((_, index) => {
        turnLedger[index] = ledgerRows[index];
      });
    } else {
      warnings.push(
        `turn 数（${turns.length}）与台账行数（${ledgerRows.length}）不一致：改用"净输入 + 读缓存"总额逐 turn 对齐。`,
      );
      const remaining = [...ledgerRows];
      turns.forEach((turn, index) => {
        const sumInput = sumRange(records, turn.first, turn.last, (usage) => usage.inputTokens ?? 0);
        const sumRead = sumRange(records, turn.first, turn.last, (usage) => usage.cacheReadTokens ?? 0);
        const found = remaining.findIndex(
          (row) => (row.inputTokens ?? 0) === sumInput && (row.cacheReadTokens ?? 0) === sumRead,
        );
        if (found >= 0) {
          turnLedger[index] = remaining[found];
          remaining.splice(found, 1);
        }
      });
    }
  }

  // ---- 逐 turn -------------------------------------------------------------
  const surfaces: ToolSurface[] = turnLedger.map((row) => surfaceOf(row));
  const turnRows: TurnRow[] = turns.map((turn, index) => {
    const inputTokens = sumRange(records, turn.first, turn.last, (usage) => usage.inputTokens ?? 0);
    const cacheReadTokens = sumRange(records, turn.first, turn.last, (usage) => usage.cacheReadTokens ?? 0);
    const row = turnLedger[index];
    const previous = index > 0 ? surfaces[index - 1] : null;
    return {
      turn: index + 1,
      firstRound: turn.first,
      lastRound: turn.last,
      rounds: turn.last - turn.first + 1,
      inputTokens,
      cacheReadTokens,
      promptTokens: inputTokens + cacheReadTokens,
      hitRate: hitRateOf(inputTokens, cacheReadTokens),
      surface: surfaces[index],
      surfaceChanged: index === 0 || !surfaces[index].fingerprint || !previous?.fingerprint
        ? null
        : surfaces[index].fingerprint !== previous.fingerprint,
      ledgerMatches: row
        ? (row.inputTokens ?? 0) === inputTokens && (row.cacheReadTokens ?? 0) === cacheReadTokens
        : null,
      ledgerTurnId: row?.turnId ?? null,
    };
  });

  // ---- 逐轮 ---------------------------------------------------------------
  const turnOfRound: number[] = new Array(records.length).fill(0);
  turns.forEach((turn, turnIndex) => {
    for (let i = turn.first; i <= turn.last; i++) turnOfRound[i] = turnIndex;
  });

  const rounds: RoundRow[] = records.map((record, i) => {
    const usage = usageOf(record);
    const inputTokens = usage.inputTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    const turnIndex = turnOfRound[i];
    const turn = turnRows[turnIndex];
    // A round with no recorded usage cannot be classified as "repaid": its
    // input is unknown, and the REPAY floor (≥5,000 net input) is a claim about
    // real input. It also must not read as a healthy 0% — `usageRecorded`
    // says which one it is.
    const usageRecorded = hasUsage(record);
    const repayed = usageRecorded && inputTokens >= REPAY_MIN_INPUT_TOKENS && hitRateOf(inputTokens, cacheReadTokens) < HEALTHY_HIT_RATE;
    // 与 diagnoseRoundPairs 同一口径：上一轮的 prompt 与 info，本轮的 cacheRead。
    // Both sides must have usage: a missing previous record is "unknown", not an
    // empty prefix, and an empty prefix would turn the first measured round
    // after it into an APPEND.
    const previous = i > 0 ? records[i - 1] : null;
    const previousPromptTokens = previous ? (usageOf(previous).inputTokens ?? 0) + (usageOf(previous).cacheReadTokens ?? 0) : 0;
    const observedReuse = usageRecorded && previous && hasUsage(previous)
      ? observedReuseOf(previousPromptTokens, cacheReadTokens)
      : null;
    return {
      i,
      turn: turnIndex + 1,
      step: record.step,
      requestMessageCount: record.requestMessageCount ?? 0,
      promptChars: record.promptChars ?? 0,
      inputTokens,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens,
      promptTokens: inputTokens + cacheReadTokens,
      hitRate: hitRateOf(inputTokens, cacheReadTokens),
      repayed,
      observedReuse,
      ...(reuseCapped(previousPromptTokens, cacheReadTokens) ? { reuseCapped: true } : {}),
      usageRecorded,
      appendDriven: isAppendDriven(repayed, observedReuse),
      coldStart: i === 0,
      turnFirst: i === turn.firstRound,
      surface: surfaces[turnIndex],
      surfaceChanged: i === turn.firstRound && turn.surfaceChanged === true,
    };
  });

  // ---- 相邻轮次三向诊断 ---------------------------------------------------
  const pairs = diagnoseRoundPairs(records, rounds);
  const toolDiagnosis = summarizePairs(pairs);

  // ---- 命中率汇总 ---------------------------------------------------------
  // A round is in the cache statistics when its usage was recorded, even if the
  // prompt was empty — `promptTokens > 0` silently dropped the legacy mock
  // rounds (2,713 of 2,928 in the local corpus) and made `roundsWithUsage` mean
  // something other than its name.
  const withUsage = rounds.filter((round) => round.usageRecorded !== false);
  const totalInput = withUsage.reduce((sum, round) => sum + round.inputTokens, 0);
  const totalRead = withUsage.reduce((sum, round) => sum + round.cacheReadTokens, 0);
  const steadyStateInputBaseline = median(
    withUsage.filter((round) => round.hitRate >= HEALTHY_HIT_RATE && !round.coldStart).map((round) => round.inputTokens),
  );

  const bucket = (list: RoundRow[]) => ({
    rounds: list.length,
    repayed: list.filter((round) => round.repayed).length,
    inputTokens: list.reduce((sum, round) => sum + round.inputTokens, 0),
    excessInputTokens: list.reduce(
      (sum, round) => sum + Math.max(0, round.inputTokens - steadyStateInputBaseline),
      0,
    ),
  });
  const repayBreakdown = {
    turnBoundary: bucket(rounds.filter((round) => round.turnFirst)),
    withinTurn: bucket(rounds.filter((round) => !round.turnFirst)),
  };
  if (repayBreakdown.turnBoundary.rounds > 1
    && repayBreakdown.turnBoundary.repayed >= repayBreakdown.turnBoundary.rounds) {
    warnings.push(
      `每个 turn 的首轮都在重付（${repayBreakdown.turnBoundary.repayed}/${repayBreakdown.turnBoundary.rounds}），`
      + `共 ${repayBreakdown.turnBoundary.excessInputTokens} 输入 token：`
      + '说明缓存杀手在 turn 粒度上、位置在历史之前。逐 turn 变化的头部块是头号嫌疑'
      + '（agent.ts 每步 unshift 的 <past-reflections> / <relevant-project-memories> / <global-memory>，'
      + 'turn 内恒定、turn 间不同），工具面变化只是同一批位置上的另一种可能。',
    );
  }

  const surfaceChanges = turnRows
    .filter((turn) => turn.surfaceChanged === true)
    .map((turn) => {
      const previous = turnRows[turn.turn - 2];
      return {
        turn: turn.turn,
        round: turn.firstRound,
        fromScope: previous?.surface.scope ?? null,
        fromCount: previous?.surface.count ?? null,
        toScope: turn.surface.scope,
        toCount: turn.surface.count,
        coincidedWithRepay: rounds[turn.firstRound]?.repayed ?? false,
      };
    });

  // ---- 压缩 ---------------------------------------------------------------
  const stubIndexes = (session.messages ?? [])
    .map((message, index) => (typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX) ? index : -1))
    .filter((index) => index >= 0);
  const drops = detectCompactionDrops(records);
  const compactions: CompactionEvent[] = drops.map((drop, index) => {
    const after = rounds[drop.afterRound];
    const before = rounds[drop.beforeRound];
    const stub = (session.messages ?? [])[stubIndexes[index] ?? -1];
    const recovered = rounds
      .slice(drop.afterRound + 1)
      .findIndex((round) => round.hitRate >= HEALTHY_HIT_RATE);
    return {
      source: 'trajectory-message-drop',
      beforeRound: drop.beforeRound,
      afterRound: drop.afterRound,
      requestMessagesBefore: drop.before,
      requestMessagesAfter: drop.after,
      stubMessageIndex: stubIndexes[index] ?? null,
      summaryChars: typeof stub?.content === 'string' ? stub.content.length : null,
      promptTokensBefore: before?.promptTokens ?? 0,
      promptTokensAfter: after?.promptTokens ?? 0,
      inputTokensAfter: after?.inputTokens ?? 0,
      steadyStateInputBaseline,
      rePaidInputTokens: Math.max(0, (after?.inputTokens ?? 0) - steadyStateInputBaseline),
      recoveredAfterRounds: recovered >= 0 ? recovered + 1 : null,
      curve: rounds.slice(drop.afterRound, drop.afterRound + 6)
        .map((round) => ({ i: round.i, hitRate: round.hitRate, inputTokens: round.inputTokens })),
    };
  });
  if (stubIndexes.length > drops.length) {
    warnings.push(
      `会话里有 ${stubIndexes.length} 条压缩桩，但轨迹里只观测到 ${drops.length} 次消息数骤降：`
      + '多出来的那次压缩发生在轨迹开始之前（会话从摘要恢复），那一段重付在本次产物里看不到。',
    );
  }

  // ---- 重复读 -------------------------------------------------------------
  const { readCalls, counts } = countRepeatReads(session);
  const repeatTop: RepeatRead[] = [...counts.entries()]
    .map(([path, entry]) => ({ path, count: entry.count, tools: entry.tools }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 10);

  const allTurnsMatchLedger = turnRows.length > 0
    && ledgerRows.length > 0
    && turnRows.every((turn) => turn.ledgerMatches === true);
  const compactBilledRounds = turnRows
    .filter((turn) => ((turnLedger[turn.turn - 1] as LedgerRow | null)?.autoCompact?.calls ?? 0) > 0)
    .map((turn) => turn.turn);
  if (allTurnsMatchLedger && drops.length > 0) {
    warnings.push(
      '台账逐 turn 的 token 与轨迹逐轮之和完全相等 —— 压缩的摘要请求本身'
      + '（runAutoCompact 里直接调 provider.complete，不走主循环的 usageTotals）只在台账的 `autoCompact` 块里计费，'
      + '轨迹看不到它，而压缩后那一轮的重付是另一笔：两处都会被算进总花费，不要把它们当成同一笔。',
    );
  }
  if (compactBilledRounds.length > 0) {
    warnings.push(
      `台账里有 ${compactBilledRounds.length} 个 turn 记录了压缩支出（turn ${compactBilledRounds.join(', ')}）：`
      + '这部分是真实的 provider 计费，但不在轨迹的逐轮 usage 里，所以本报告的命中率与"超稳态多付"都不含它。',
    );
  }

  const report: ContextLedgerReport = {
    session: {
      file: sessionPath,
      id: session.id ?? null,
      provider: session.provider ?? null,
      model: session.model ?? null,
      messageCount: (session.messages ?? []).length,
      toolCallCount: (session.toolCalls ?? []).length,
      trajectoryFile,
      trajectoryExists,
      usageLog,
    },
    rounds,
    turns: turnRows,
    pairs,
    toolDiagnosis,
    cache: {
      rounds: rounds.length,
      roundsWithUsage: withUsage.length,
      totalInputTokens: totalInput,
      totalCacheReadTokens: totalRead,
      weightedHitRate: totalInput + totalRead > 0 ? totalRead / (totalInput + totalRead) : null,
      meanHitRate: withUsage.length > 0
        ? withUsage.reduce((sum, round) => sum + round.hitRate, 0) / withUsage.length
        : null,
      repayedRounds: rounds.filter((round) => round.repayed).map((round) => round.i),
      appendDrivenRounds: rounds.filter((round) => round.appendDriven).map((round) => round.i),
      coldStartRounds: rounds.filter((round) => round.coldStart).map((round) => round.i),
      roundsMissingUsage: rounds.filter((round) => round.usageRecorded === false).map((round) => round.i),
      reuseCappedRounds: rounds.filter((round) => round.reuseCapped === true).map((round) => round.i),
      steadyStateInputBaseline,
      repayBreakdown,
    },
    toolSurface: {
      provenance: surfaces.some((surface) => surface.provenance === 'ledger-scope-count')
        ? 'ledger-scope-count'
        : 'missing',
      changes: surfaceChanges,
      counts: turnRows.map((turn) => ({ turn: turn.turn, scope: turn.surface.scope, count: turn.surface.count })),
      separation: {
        turnBoundaryRounds: repayBreakdown.turnBoundary.rounds,
        turnBoundaryRepayed: repayBreakdown.turnBoundary.repayed,
        separable: surfaceChanges.length > 0
          && repayBreakdown.turnBoundary.rounds > 0
          && repayBreakdown.turnBoundary.repayed < repayBreakdown.turnBoundary.rounds,
        note: surfaceChanges.length === 0
          ? '工具面在本会话没有变化，无从谈归因。'
          : repayBreakdown.turnBoundary.repayed >= repayBreakdown.turnBoundary.rounds
            ? `本会话 ${repayBreakdown.turnBoundary.rounds} 个 turn 的首轮**全部**在重付，`
              + `而 ${surfaceChanges.length} 次工具面变化也全落在 turn 首轮（resolveToolScope 每 turn 只解析一次）。`
              + '所以"工具面变了→重付"与"turn 边界本身→重付"在这份数据里分不开，'
              + '只能说两者同时发生。能分开的样本需要"turn 中途工具面变化"，而结构上不存在这种样本。'
            : `${repayBreakdown.turnBoundary.rounds} 个 turn 首轮里只有 ${repayBreakdown.turnBoundary.repayed} 个重付，`
              + '而工具面变化每次都落在重付的首轮上：这是可以分开的，工具面变化是可归因的原因。',
      },
      note:
        '指纹 = sha256(`scope=<scope>;count=<工具数>`)，来源是 usage 台账的 toolScope/toolCount。'
        + 'turn 级指纹只回答"数量变没变"：count 相同的两个 turn 不保证送出的是同一个数组'
        + '（本会话 274→260→274 的抖动就是 scope 没变但工具数变了）。'
        + '逐轮的真实发送数组（toolSetNames + 顺序敏感 toolSetOrderHash）由 agent.ts 在发送前写入轨迹，'
        + '见 pairs 与 1b 节：那些行回答的是数组本身，不是它的长度。',
    },
    compactions,
    repeatReads: {
      readCalls,
      distinctPaths: counts.size,
      top: repeatTop,
    },
    warnings,
  };

  if (options.verifyRegistry) {
    report.registryReconstruction = await tryReconstructRegistry(turnRows);
  }
  return report;
}

function sumRange(
  records: TrajectoryRecord[],
  first: number,
  last: number,
  pick: (usage: RawUsage) => number,
): number {
  let total = 0;
  for (let i = first; i <= last; i++) total += pick(usageOf(records[i]));
  return total;
}

/**
 * 用当前 registry 复现台账里的工具数，验证"按名字重建工具面"这条路走不走得通。
 * 默认不跑：它要实例化整套工具（含原生依赖），而报告本身不需要。
 */
async function tryReconstructRegistry(turns: TurnRow[]): Promise<NonNullable<ContextLedgerReport['registryReconstruction']>> {
  try {
    const { createDefaultToolRegistry } = await import('../tools/index.js');
    const { selectScopedTools } = await import('../tools/scope.js');
    const registry = createDefaultToolRegistry();
    const compact = selectScopedTools(registry, 'compact').length;
    const standard = selectScopedTools(registry, 'standard').length;
    const full = selectScopedTools(registry, 'full').length;
    const recordedCounts = [
      ...new Set(turns.map((turn) => turn.surface.count).filter((count): count is number => typeof count === 'number')),
    ];
    const reproducible = new Set([compact, standard, full]);
    const reproduced = recordedCounts.length > 0 && recordedCounts.every((count) => reproducible.has(count));
    return {
      compact,
      standard,
      full,
      recordedCounts,
      reproduced,
      note: reproduced
        ? '当前 registry 的 scope 计数与台账记录一致：可以按名字重建工具面。'
        : '当前 registry 的 scope 计数与台账记录不一致（会话运行时的 registry 含插件/MCP 工具，'
          + '与今天编译出来的这套不同），因此"按名字重建"在本会话上不成立，只能用 scope+count 指纹。',
    };
  } catch (error) {
    return {
      compact: -1,
      standard: -1,
      full: -1,
      recordedCounts: [],
      reproduced: false,
      note: `registry 复现失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 人读输出
// ---------------------------------------------------------------------------

const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

export function formatReport(report: ContextLedgerReport, options: { index?: number } = {}): string {
  const lines: string[] = [];
  const s = report.session;
  lines.push(`context ledger — ${basename(s.file)}`);
  lines.push(`  ${s.provider ?? '?'} / ${s.model ?? '?'} · ${report.rounds.length} 轮模型往返 · ${report.turns.length} 个 turn`
    + ` · ${s.messageCount} 条消息 · ${s.toolCallCount} 次工具调用`);
  lines.push(`  轨迹 ${s.trajectoryExists ? basename(s.trajectoryFile) : `缺失 (${s.trajectoryFile})`}`
    + ` · 台账 ${s.usageLog}`);

  // ---- 1. 工具面 ---------------------------------------------------------
  lines.push('');
  lines.push('== 1. 工具面指纹（台账口径：scope + 工具数）==');
  if (report.toolSurface.provenance === 'missing') {
    lines.push('  台账没有本会话的 toolScope/toolCount，无法给出工具面指纹。');
  } else {
    lines.push(`  ${'turn'.padStart(4)} ${'rounds'.padEnd(9)} ${'scope'.padStart(9)} ${'n'.padStart(4)}  ${'fp'.padEnd(13)} Δ`);
    for (const turn of report.turns) {
      const delta = turn.surfaceChanged === null
        ? ''
        : turn.surfaceChanged
          ? `CHANGED → 该 turn 第 ${turn.firstRound} 轮起重付工具面`
          : 'same';
      lines.push(
        `  ${String(turn.turn).padStart(4)} ${`${turn.firstRound}-${turn.lastRound}`.padEnd(9)} `
        + `${(turn.surface.scope ?? '-').padStart(9)} ${String(turn.surface.count ?? '-').padStart(4)}  `
        + `${(turn.surface.fingerprint ?? '-').padEnd(13)} ${delta}`,
      );
    }
    lines.push('');
    if (report.toolSurface.changes.length === 0) {
      lines.push('  工具面在整个会话里没有变化。');
    } else {
      for (const change of report.toolSurface.changes) {
        lines.push(
          `  变化 @ turn ${change.turn}（第 ${change.round} 轮）：`
          + `${change.fromScope ?? '?'}/${change.fromCount ?? '?'} → ${change.toScope ?? '?'}/${change.toCount ?? '?'}`
          + `，该轮${change.coincidedWithRepay ? '正好是一轮重付' : '没有重付'}`,
        );
      }
    }
    const separation = report.toolSurface.separation;
    lines.push(`  可归因性：${separation.separable ? '工具面变化可以单独归因。' : '工具面变化与 turn 边界在这份数据里分不开。'}`);
    lines.push(`    ${separation.note}`);
    lines.push('  注：turn 级指纹只覆盖 scope+count；逐轮的真实发送数组（toolSetNames，含顺序）见上面的 1b 与 JSON 的 pairs。');
  }

  // ---- 1b. 相邻轮次三向诊断 ----------------------------------------------
  lines.push('');
  lines.push('== 1b. 相邻轮次三向诊断（工具集合 / 只有顺序 / 前缀字节）==');
  if (report.pairs.length === 0) {
    lines.push('  轨迹不足两轮，没有相邻轮对可比。');
  } else {
    const d = report.toolDiagnosis;
    const tri = (value: boolean | null, whenTrue: string, whenFalse: string) =>
      (value === null ? '?' : value ? whenTrue : whenFalse);
    lines.push(`  ${d.pairs} 对相邻轮次：集合变化 ${d.toolSetChanged} 对 · 只有顺序变化 ${d.toolOrderOnlyChanged} 对 · `
      + `前缀有变更证据 ${d.prefixChanged} 对 · 前缀无变更证据 ${d.prefixNoEvidence} 对 · 数据不足 ${d.prefixUnknown} 对`);
    lines.push(`  依据层：sent-tools ${d.layers['sent-tools']} 对（真实发送数组）· `
      + `called-tools ${d.layers['called-tools']} 对（本轮调用了什么）· `
      + `scope-count ${d.layers['scope-count']} 对（只有数量）· none ${d.layers.none} 对`);
    lines.push(`  ${'pair'.padEnd(8)} ${'turn'.padEnd(6)} ${'layer'.padEnd(13)} `
      + `${'set'.padStart(8)} ${'order'.padStart(8)} ${'prefix'.padStart(9)} ${'scope·n'.padStart(10)} `
      + `${'toolset-hash'.padEnd(14)} ${'reuse'.padStart(6)} ${'input'.padStart(8)}  evidence`);
    for (const pair of report.pairs) {
      const flags: string[] = [];
      if (pair.repayed) flags.push('REPAY');
      if (pair.providerSawBreak === true && pair.prefixBytesChanged !== true) flags.push('unexplained');
      // 只有 sent-tools 层的集合/顺序变化才是缓存事件，所以它已经在
      // prefixEvidence 里了；called-tools 层的增删不进这一列，避免把记录噪声
      // 写成前缀事件（层本身逐行写着）。
      const evidence = [...pair.prefixEvidence];
      const toolSetMark = pair.toolSetOrderHash === null
        ? '-'
        : pair.prevToolSetOrderHash !== null && pair.prevToolSetOrderHash === pair.toolSetOrderHash
          ? `=${pair.toolSetOrderHash}`
          : `${pair.prevToolSetOrderHash ?? '?'}→${pair.toolSetOrderHash}`;
      lines.push(
        `  ${`${pair.prevRound}→${pair.round}`.padEnd(8)} ${(pair.crossesTurn ? 'cross' : 'in').padEnd(6)} `
        + `${pair.layer.padEnd(13)} ${tri(pair.toolSetChanged, 'CHANGED', 'same').padStart(8)} `
        + `${tri(pair.toolOrderOnlyChanged, 'REORDER', 'same').padStart(8)} `
        + `${tri(pair.prefixBytesChanged, 'CHANGED', 'no-evid').padStart(9)} `
        + `${tri(pair.scopeCountChanged, 'changed', 'same').padStart(10)} `
        + `${toolSetMark.padEnd(14)} `
        + `${(pair.observedReuse === null ? 'n/a' : pair.observedReuse.toFixed(2)).padStart(6)} `
        + `${String(pair.inputTokens).padStart(8)}  ${[...evidence, ...flags].join(',')}`,
      );
    }
    lines.push('');
    lines.push(`  三个诊断互不替代：set=${'多重集合按规范排序比较'}，order=${'集合相同而序列不同'}，`
      + 'prefix=本地产物里能找到的变更证据（发送数组变化 / 台账 scope·count 变化 / '
      + '消息数未增长 / promptChars 未增长 / 压缩骤降）。prefix 的 no-evid **不等于**没变：'
      + 'system 头部块的逐 turn 变化这份产物看不见。');
    lines.push('  toolset-hash = sent-tools 层的顺序敏感哈希（toolSetOrderHash，12 位）；'
      + '`=x` 表示与上一轮逐位相同，`a→b` 表示工具数组的顺序或内容变了。这是缓存前缀字节等价性的本地证据；'
      + 'called-tools 层为 `-`（模型调用顺序不进入请求）。');
    lines.push(`  reuse = 本轮 cacheRead / 上一轮 prompt（1.00 ≈ 整段前缀被复用），是服务端的回答，只作对照，不替代上面三项。`);
    lines.push(`  依据层说明：${d.note}`);
    if (d.orderOnlyPairs.length > 0) {
      lines.push(`  只有顺序变化的轮对 ${d.orderOnlyPairs.length} 个：`
        + d.orderOnlyPairs.slice(0, 12).map((pair) => `${pair.prevRound}→${pair.round}@${pair.layer}`).join(', ')
        + (d.orderOnlyPairs.length > 12 ? ' …' : '')
        + `${d.layers['sent-tools'] === 0 ? '（called-tools 层：这是模型调用顺序的记录噪声，不是缓存事件）' : ''}`);
    } else {
      lines.push('  没有"集合相同、仅顺序不同"的轮对：记录顺序在这份会话里是稳定的。');
    }
    if (d.unexplainedBreaks.length > 0) {
      const total = d.unexplainedBreaks.reduce((sum, pair) => sum + pair.inputTokens, 0);
      lines.push(`  本地无变更证据、服务端却未复用（${d.unexplainedBreaks.length} 对，净输入合计 ${total} token）：`
        + `${d.unexplainedBreaks.slice(0, 12).map((pair) => `${pair.prevRound}→${pair.round}`).join(', ')}`
        + (d.unexplainedBreaks.length > 12 ? ' …' : ''));
      lines.push('    这些轮次的缓存失效点在工具数组与消息历史之外——逐 turn 变化的 system 头部块、'
        + '或提供者的缓存 TTL 过期，两者本报告都分不开。');
    }
  }

  // ---- 2. 每轮命中率 -----------------------------------------------------
  lines.push('');
  lines.push('== 2. 每轮前缀缓存 ==');
  lines.push(`  ${'i'.padStart(3)} ${'st'.padStart(3)} ${'turn'.padStart(4)} ${'msg'.padStart(4)} `
    + `${'prompt_tok'.padStart(10)} ${'input'.padStart(8)} ${'cache_rd'.padStart(9)} ${'hit%'.padStart(6)} `
    + `${'n'.padStart(4)} ${'fp'.padEnd(13)} flag`);
  for (const round of report.rounds) {
    const flags: string[] = [];
    if (round.usageRecorded === false) flags.push('no-usage');
    if (round.coldStart) flags.push('cold-start');
    if (round.repayed) flags.push('REPAY');
    if (round.appendDriven) flags.push('APPEND');
    if (round.reuseCapped) flags.push('reuse>1');
    if (round.surfaceChanged) flags.push('surface-changed');
    lines.push(
      `  ${String(round.i).padStart(3)} ${String(round.step).padStart(3)} ${String(round.turn).padStart(4)} `
      + `${String(round.requestMessageCount).padStart(4)} ${String(round.promptTokens).padStart(10)} `
      + `${String(round.inputTokens).padStart(8)} ${String(round.cacheReadTokens).padStart(9)} `
      + `${pct(round.hitRate).padStart(6)} ${String(round.surface.count ?? '-').padStart(4)} `
      + `${(round.surface.fingerprint ?? '-').padEnd(13)} ${flags.join(',')}`,
    );
  }
  lines.push('');
  const cache = report.cache;
  lines.push(`  整段加权命中率 ${pct(cache.weightedHitRate)} = ${cache.totalCacheReadTokens} / `
    + `(${cache.totalInputTokens} + ${cache.totalCacheReadTokens})`);
  lines.push(`  每轮命中率简单平均 ${pct(cache.meanHitRate)}（对照用，不等于加权值）`);
  lines.push(`  稳态（命中率 ≥ ${(HEALTHY_HIT_RATE * 100).toFixed(0)}%）轮次的净输入中位数 `
    + `${cache.steadyStateInputBaseline} token —— 追加式历史下"该付多少"的基线`);
  lines.push(`  重付轮（净输入 ≥ ${REPAY_MIN_INPUT_TOKENS} 且命中率 < 90%）：${cache.repayedRounds.length} 轮`
    + ` → ${cache.repayedRounds.join(', ') || '无'}`);
  lines.push(`  其中大追加轮（重付但上一轮前缀复用 ≥ 90%，低命中来自一次性新增内容而非前缀重建）：`
    + `${cache.appendDrivenRounds.length} 轮 → ${cache.appendDrivenRounds.join(', ') || '无'}`);
  lines.push(`  无 usage 记录的轮次（prompt 未知，不是 0）：${cache.roundsMissingUsage.length} 轮`
    + ` → ${cache.roundsMissingUsage.join(', ') || '无'}`);
  if (cache.reuseCappedRounds.length > 0) {
    lines.push(`  provider 报回 cacheRead > 上一轮 prompt、复用比已截到 1：${cache.reuseCappedRounds.length} 轮`
      + ` → ${cache.reuseCappedRounds.join(', ')}（超出的部分不在上一轮 prompt 的计数里，不要按 >1 的比值解读）`);
  }
  const breakdown = cache.repayBreakdown;
  const share = (tokens: number) => (cache.totalInputTokens > 0 ? `${((tokens / cache.totalInputTokens) * 100).toFixed(1)}%` : 'n/a');
  lines.push('  重付拆成两处（修法不同，不能混着说"命中率低"）：');
  lines.push(`    turn 首轮（历史之前的内容变了）：${breakdown.turnBoundary.repayed}/${breakdown.turnBoundary.rounds} 轮重付，`
    + `净输入 ${breakdown.turnBoundary.inputTokens} token（占全部净输入的 ${share(breakdown.turnBoundary.inputTokens)}），`
    + `其中超稳态基线 ${breakdown.turnBoundary.excessInputTokens} token`);
  lines.push(`    turn 内部（同一前缀中途失效）    ：${breakdown.withinTurn.repayed}/${breakdown.withinTurn.rounds} 轮重付，`
    + `净输入 ${breakdown.withinTurn.inputTokens} token（占 ${share(breakdown.withinTurn.inputTokens)}），`
    + `其中超稳态基线 ${breakdown.withinTurn.excessInputTokens} token`);

  // ---- 3. 压缩 -----------------------------------------------------------
  lines.push('');
  lines.push('== 3. 压缩事件 ==');
  if (report.compactions.length === 0) {
    lines.push('  轨迹里没有消息数骤降，未观测到会话内压缩。');
  }
  for (const event of report.compactions) {
    lines.push(`  压缩发生在第 ${event.afterRound} 轮之前（第 ${event.beforeRound} 轮之后）：`
      + `请求消息 ${event.requestMessagesBefore} → ${event.requestMessagesAfter} 条；`
      + `压缩桩在 messages[${event.stubMessageIndex ?? '?'}]（${event.summaryChars ?? '?'} 字符）`);
    lines.push(`  压缩前 prompt ${event.promptTokensBefore} token → 压缩后第一轮 prompt ${event.promptTokensAfter} token`);
    lines.push(`  压缩那一轮净输入 ${event.inputTokensAfter} token，稳态基线 ${event.steadyStateInputBaseline} token`
      + ` ⇒ 多付 ${event.rePaidInputTokens} 输入 token（整段新前缀按全价重读，而不是按缓存价）`);
    lines.push(`  压缩后第 ${event.recoveredAfterRounds ?? '—'} 轮回到命中率 ≥ 90%`
      + (event.recoveredAfterRounds === 1 ? '（紧接着的下一轮就恢复了）' : ''));
    lines.push('  命中率曲线:');
    for (const point of event.curve) {
      lines.push(`    i=${String(point.i).padStart(3)}  hit ${pct(point.hitRate).padStart(6)}  `
        + `input ${String(point.inputTokens).padStart(8)}`);
    }
  }

  // ---- 4. 重复读 ---------------------------------------------------------
  lines.push('');
  lines.push('== 4. 同文件重复读（read_file / read_lines / read_many_files）==');
  lines.push(`  ${report.repeatReads.readCalls} 次读取，覆盖 ${report.repeatReads.distinctPaths} 个不同路径`);
  if (report.repeatReads.top.length === 0) {
    lines.push('  没有读取类调用。');
  } else {
    lines.push(`  ${'#'.padStart(3)} ${'times'.padStart(5)} ${'path'.padEnd(50)} tools`);
    report.repeatReads.top.forEach((entry, index) => {
      const tools = Object.entries(entry.tools).map(([tool, count]) => `${tool}×${count}`).join(' ');
      lines.push(`  ${String(index + 1).padStart(3)} ${String(entry.count).padStart(5)} ${entry.path.padEnd(50)} ${tools}`);
    });
  }

  // ---- 单轮查询（核对传闻用）--------------------------------------------
  if (typeof options.index === 'number') {
    lines.push('');
    lines.push(`== 单轮查询 i=${options.index} ==`);
    const round = report.rounds[options.index];
    if (!round) {
      lines.push(`  轨迹里没有第 ${options.index} 轮（共 ${report.rounds.length} 轮，下标 0 起）。`);
    } else {
      lines.push(`  本轮本身：step ${round.step} · turn ${round.turn} · 请求消息 ${round.requestMessageCount} 条`
        + ` · prompt ${round.promptTokens} token（input ${round.inputTokens} + cacheRead ${round.cacheReadTokens}）`
        + ` · 命中率 ${pct(round.hitRate)}`);
      const turn = report.turns[round.turn - 1];
      lines.push(`  所在 turn ${turn.turn}（第 ${turn.firstRound}–${turn.lastRound} 轮，共 ${turn.rounds} 轮）：`
        + `prompt ${turn.promptTokens} token（input ${turn.inputTokens} + cacheRead ${turn.cacheReadTokens}）`
        + ` · turn 级命中率 ${pct(turn.hitRate)}`);
      lines.push('  两种口径不能混用：单轮是这一次模型往返，turn 是这个用户输入下所有往返的合计。');
    }
  }

  // ---- 备注 -------------------------------------------------------------
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('== 备注 ==');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  if (report.registryReconstruction) {
    const r = report.registryReconstruction;
    lines.push('');
    lines.push(`== registry 复现 ==  compact=${r.compact} standard=${r.standard} full=${r.full}`
      + ` · 台账记录 ${r.recordedCounts.join('/') || '-'} · ${r.reproduced ? '可复现' : '不可复现'}`);
    lines.push(`  ${r.note}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type CliOptions = {
  sessionPath?: string;
  index?: number;
  usageLogPath?: string;
  outDir: string;
  verifyRegistry: boolean;
  /** 没给会话路径时，取 --session-dir 下最新的会话文件。 */
  latest: boolean;
  sessionDir?: string;
};

const USAGE = '用法：node dist/src/audit/contextLedger.js <session.json> [--index N]'
  + ' [--usage-log <path>] [--out <dir>] [--verify-registry]\n'
  + '      node dist/src/audit/contextLedger.js --latest [--session-dir <dir>]';

/**
 * 最新会话文件（按 mtime），只取真实的会话 JSON——不是 .trajectory.jsonl。
 * `npm run ledger` 靠它跑起来而不需要背一个路径：分析对象是"磁盘上最新的那次
 * 会话"，脚本里因此没有硬编码任何 fixture。
 */
export function findLatestSession(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  const candidates = readdirSync(sessionDir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.trajectory.json'))
    .map((name) => join(sessionDir, name))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
  return candidates[0];
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outDir: resolve(process.cwd(), 'out', 'context-ledger'),
    verifyRegistry: false,
    latest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--index') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--index 需要一个非负整数');
      options.index = value;
    } else if (arg === '--usage-log') {
      const value = argv[++i];
      if (!value) throw new Error('--usage-log 需要一个路径');
      options.usageLogPath = value;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out 需要一个目录');
      options.outDir = resolve(value);
    } else if (arg === '--session-dir') {
      const value = argv[++i];
      if (!value) throw new Error('--session-dir 需要一个目录');
      options.sessionDir = value;
    } else if (arg === '--latest') {
      options.latest = true;
    } else if (arg === '--verify-registry') {
      options.verifyRegistry = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数 ${arg}`);
    } else if (!options.sessionPath) {
      options.sessionPath = arg;
    } else {
      throw new Error(`多余的参数 ${arg}`);
    }
  }
  return options;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (!options.sessionPath && options.latest) {
    const dir = resolve(options.sessionDir ?? join(process.cwd(), '.aicode', 'sessions'));
    const latest = findLatestSession(dir);
    if (!latest) {
      process.stderr.write(`${dir} 下没有会话 JSON，无法 --latest\n`);
      return 2;
    }
    options.sessionPath = latest;
  }
  if (!options.sessionPath) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!existsSync(options.sessionPath)) {
    process.stderr.write(`找不到会话文件 ${options.sessionPath}\n`);
    return 2;
  }

  const report = await buildReport({
    sessionPath: options.sessionPath,
    usageLogPath: options.usageLogPath,
    verifyRegistry: options.verifyRegistry,
  });
  process.stdout.write(`${formatReport(report, { index: options.index })}\n`);

  mkdirSync(options.outDir, { recursive: true });
  const outFile = join(options.outDir, `${basename(options.sessionPath).replace(/\.json$/, '')}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  process.stdout.write(`\nJSON 已写入 ${outFile}\n`);
  return 0;
}

const entry = process.argv[1] ?? '';
if (basename(entry) === 'contextLedger.js') {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`context ledger 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
