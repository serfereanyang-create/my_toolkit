import type { CommandIntent, CommandSlots, Confidence, ExtractionResult } from './types.js';

const DOC_PATH_EXTENSIONS = 'docx|doc|pdf|txt|csv|xlsx|xls|pptx|ppt|png|jpe?g|gif|webp|zip|log|xml|html?';
const CODE_PATH_EXTENSIONS = `[cm]?[jt]sx?|java|kt|kts|py|rb|go|rs|swift|cs|cpp|cc|cxx|c|h|hpp|vue|svelte|json|ya?ml|toml|md|${DOC_PATH_EXTENSIONS}`;
const CODE_PATH_TOKEN_CHAR = 'A-Za-z0-9_./\\\\@+~%-';
const CODE_PATH_PATTERN = new RegExp(
  `(?<![${CODE_PATH_TOKEN_CHAR}])(?:[${CODE_PATH_TOKEN_CHAR}]+[\\\\/])*[${CODE_PATH_TOKEN_CHAR}]+\\.(?:${CODE_PATH_EXTENSIONS})(?![${CODE_PATH_TOKEN_CHAR}])`,
  'i',
);
// Absolute Windows path that may include non-ASCII (e.g. Desktop/测试.docx) and trailing Chinese verbs.
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|*?]+\.[A-Za-z0-9]{1,8}/;
const DESKTOP_PATH_PATTERN = /desktop[\\/][^\s"'<>|*?]+/i;
const TRAILING_READ_NOISE = /(?:看|查看|读取|读一下|打开|内容|的?内容|一下)+$/u;

export function extractCommand(prompt: string): ExtractionResult {
  const referenceStart = prompt.search(/^(?:--- 引用上下文 ---|\[user provided files\])[\t ]*\r?$/m);
  if (referenceStart >= 0) {
    const request = extractCommand(prompt.slice(0, referenceStart));
    return {
      ...request,
      confidence: request.confidence === 'high' ? 'medium' : request.confidence,
      reasons: [...request.reasons, 'referenced context requires provider analysis'],
    };
  }
  const normalized = prompt.toLowerCase();
  const path = extractPath(prompt);
  const query = extractSearchQuery(prompt);
  const drive = extractDrive(normalized);
  const hours = extractNumber(normalized, /(最近|past|last)\s*(\d+)\s*(小时|hours?)/i, 2) ?? extractNumber(normalized, /(\d+)\s*(小时|hours?)/i, 1);
  const minMb = extractNumber(normalized, /(大于|超过|over|above)\s*(\d+)\s*m/i, 2);
  const limit = extractNumber(normalized, /(前|top)\s*(\d+)/i, 2);
  const command = extractShellCommand(prompt);
  const slots: CommandSlots = {
    path,
    query,
    drive,
    hours: hours ?? undefined,
    minMb: minMb ?? undefined,
    limit: limit ?? undefined,
    command,
  };

  // Cache probe: only a prompt that *is* the reading ("缓存命中率", "/cache")
  // short-circuits here, and it answers from this process's counters without the
  // model. The rule is anchored whole-prompt matching, so a real question that
  // merely mentions the number ("这次缓存命中率为什么这么低") is no longer
  // hijacked: it costs one model call and falls through to the intent rules
  // below. That is the intended trade — an extra call buys an answer grounded in
  // the actual conversation instead of a four-millisecond lookup table. The model
  // still has cache_probe as a tool and calls it when it needs the number.
  if (isCacheProbePrompt(prompt, normalized)) {
    return result('cache_probe', slots, 'high', ['anchored cache reading request']);
  }

  // ---- The reading / answer line ----
  // Every rule below answers a *reading*: "what is this number right now". The
  // judgment each one has to make is reading vs. answer: "内存占用" wants the
  // table; "内存泄漏怎么排查" wants the model. Three tools do that here:
  //   1. the shared answer guard right below, so a why/how-it-works/diagnosis/
  //      transform request never becomes a local lookup or a one-shot read;
  //   2. whole-sentence anchoring (the cache-probe rule's 口径) for triggers that
  //      are also ordinary code nouns or business words (环境 / 索引 / 状态 /
  //      最近 / 增长 / 内存), where a keyword anywhere in the sentence proves
  //      nothing about what was asked;
  //   3. subject requirements for verbs and measure words that name nothing on
  //      their own (清理, 多大, 容量, 占用).
  // The guard deliberately omits bare 实现 / 设计 / 优化: those are edit verbs
  // ("实现一个登录页", "优化启动速度") and guarding them would send real edits to
  // the model as if they were questions. They only guard in explanation shape
  // (…的实现 / 实现原理 / 设计原则).
  // Order matters more than the guards themselves: this block sits *above* the
  // path, edit, read and search rules on purpose. It used to sit below them, so
  // a question that merely carried a path ("report.docx 里的表格为什么错位了")
  // or a search verb ("这个函数在哪里被引用的，为什么没生效") was answered by a
  // one-shot tool call before the guard was ever consulted — the guard only ever
  // protected the reading rules underneath it.
  // Two exemptions keep the guard from swallowing real requests:
  //   - an *imperative* edit verb outranks it ("为什么编译不过，帮我修复" is an
  //     edit request with a why-clause, and code_edit is strategy-only anyway).
  //     A deliberative one does not outrank it ("要不要优化" asks about the edit);
  //   - a prompt that OPENS with a read imperative keeps its read plan
  //     ("读取 report.docx 是什么内容").
  if (asksForExplanation(normalized) && !hasImperativeEditVerb(normalized) && !startsWithReadImperative(prompt)) {
    return result('unknown', slots, 'low', ['explanatory/diagnosis question; model decides']);
  }

  // Document/path-first: "C:\...\测试.docx看" / "desktop/x.docx" → one-shot read_file, no model loop.
  // Anchored to a read request: the prompt must ask for the content (a read verb
  // or the bare path). Merely naming a document used to be enough, so
  // "notes.md 里补充一下第二种方案" was answered with a raw 50 KB dump instead of
  // the edit the user asked for.
  if (
    path
    && isDocumentPath(path)
    && !hasEditVerb(normalized)
    && !hasSearchVerb(normalized)
    && (hasReadVerb(normalized) || isPathOnlyPrompt(prompt, path))
  ) {
    return result('file_read', slots, 'high', ['document or absolute path with a read request']);
  }

  if (hasEditVerb(normalized) && (path || hasCodeContext(normalized))) {
    return result('code_edit', slots, 'medium', ['edit intent with code context is strategy-only']);
  }

  if ((hasReadVerb(normalized) || isPathOnlyPrompt(prompt, path)) && path) {
    return result('file_read', slots, 'high', ['explicit read with path']);
  }

  // Search: a search verb only counts with a *named* target. "在哪里引用了
  // createSession" names one; "定位这个 bug 需要看哪些文件" names a goal, not a
  // symbol, and used to run search_text over the whole sentence before the model
  // ever saw it. An unnamed search still returns a (low-confidence) search hint
  // at the tail of this function, so the model gets the hint without losing the
  // turn to a pointless grep.
  if (hasSearchVerb(normalized) && isNamedSearchTarget(query ?? path)) {
    return result('code_search', slots, 'high', ['search intent with a named target']);
  }

  // ---- The reading / answer line ----
  // Everything below answers a *reading*: "what is this number right now". The
  // shared answer guard for these sits above the path/search rules on purpose —
  // see the comment there — so by the time a rule down here runs, the prompt has
  // already been cleared of why/how/diagnose/transform shapes. What is left to
  // decide is trigger vs. subject:
  //   - whole-sentence anchoring (the cache-probe rule's 口径) for triggers that
  //     are also ordinary code nouns or business words (环境 / 索引 / 状态 /
  //     最近 / 增长 / 内存 / 磁盘), where a keyword anywhere in the sentence
  //     proves nothing about what was asked;
  //   - subject requirements for words that name nothing on their own (清理,
  //     多大, 容量, 占用).

  // Disk growth: 增长 alone is business vocabulary ("QPS 增长了 3 倍"), so it needs
  // a disk/file subject before it counts as this reading. 大文件 / 最近文件 name
  // files themselves. 清理 is a verb users also apply to code ("清理无用代码"), so
  // it needs the same subject.
  const diskSubject = hasChineseOrEnglishWord(normalized, ['磁盘', '硬盘', '空间', '文件', '目录', '盘'], ['disk', 'drive', 'space', 'file', 'files', 'directory']);
  // 清理 is also an action on a named object ("帮我清理 node_modules", "清理一下
  // 构建产物"): that is a request to delete something, not a request for a
  // file-size table, so it does not count as this reading.
  const cleanupTargetShape = /(?:清理|清空|释放)\s*(?:一下|掉|下)?\s*(?:[A-Za-z0-9_.@$/-]{2,}|依赖|缓存|日志|临时文件|无用代码|构建产物|产物)/;
  const diskGrowthReading =
    (hasChineseOrEnglishWord(normalized, ['增长', '涨了'], ['grow', 'grew', 'grown', 'growing', 'growth']) && diskSubject)
    || hasChineseOrEnglishWord(normalized, ['大文件', '最近文件', '占用空间最多'], ['large files', 'recent files', 'disk growth'])
    || (hasChineseOrEnglishWord(normalized, ['清理'], ['clean up', 'cleanup', 'free up']) && diskSubject && !cleanupTargetShape.test(normalized));
  if (diskGrowthReading) {
    return result('disk_growth', { ...slots, hours: slots.hours ?? 48, minMb: slots.minMb ?? 16 }, 'high', ['disk growth with a disk subject']);
  }

  // Disk capacity: a disk subject on its own is a topic ("帮我优化磁盘读写性能" is
  // an edit, "磁盘队列深度设置多少合适" a tuning question), so the prompt also has
  // to ask about capacity. Bare 容量/多大/空间 also describe file sizes and memory
  // ("内存有多大"), so a measure word only counts next to a free-space word.
  const diskCapacityReading =
    (hasChineseOrEnglishWord(normalized, ['磁盘', '硬盘', 'c盘', 'd盘', '盘'], ['disk', 'drive'])
      && hasChineseOrEnglishWord(normalized, ['容量', '多大', '多少g', '多少gb', '多少空间', '剩', '余量', '可用', '够用', '够不够', '满了'], ['capacity', 'how much space', 'free space', 'available', 'remaining', 'left', 'full']))
    || (hasChineseOrEnglishWord(normalized, ['容量', '多大', '空间'], ['capacity', 'how much space'])
      && hasChineseOrEnglishWord(normalized, ['剩', '还有', '可用', '够'], ['left', 'free', 'available', 'remaining']));
  if (diskCapacityReading && !path && !cleanupTargetShape.test(normalized)) {
    return result('disk_capacity', { ...slots, drive: slots.drive ?? 'C' }, 'high', ['disk capacity reading']);
  }

  // Process memory: 内存/进程/占用 name a measurement, and dashboard phrasings vary
  // too widely ("谁占用内存高", "哪个进程占内存最多", "top 10 memory processes")
  // for a whole-sentence anchor. Verdict: keep, with a subject requirement —
  // 内存 (the measurement itself) may stand alone, 进程/占用 (a port is "占用"ed,
  // a worker process can crash) need a ranking shape. English is word-boundary
  // matched, so "processing"/"processor" (code) are not this reading, and a bare
  // "process exits with code 1" needs a ranking word like "top"/"most" to count.
  const memorySubject = hasChineseOrEnglishWord(normalized, ['内存', '内存占用'], ['memory', 'memory usage', 'ram']);
  const processSubject = hasChineseOrEnglishWord(normalized, ['进程', '占用'], ['process', 'processes', 'process memory']);
  const rankingShape = hasChineseOrEnglishWord(normalized, ['谁', '哪个', '哪些', '多少', '最高', '最多', '排行', '排名', '前几'], ['top', 'most', 'list', 'rank', 'ranked', 'highest', 'usage', 'hog', 'hogging']);
  if (memorySubject || (processSubject && rankingShape)) {
    return result('process_memory', { ...slots, limit: slots.limit ?? 10 }, 'high', ['process/memory reading']);
  }

  // Runtime/environment: 环境 is the most overloaded trigger in this file —
  // "环境变量在哪配置" and "生产环境和测试环境有什么区别" are questions, and both
  // used to run environment_info. Verdict: anchored — the prompt must BE the
  // environment reading.
  if (isRuntimeInfoPrompt(prompt)) {
    return result('runtime_info', slots, 'high', ['anchored runtime/environment reading']);
  }

  // Recent activity: 最近 / 活动 / 会话 / 历史 are ordinary words ("最近 CI 老是
  // 失败", "git 历史里那次提交", "用户会话超时"). Verdict: anchored — the prompt
  // must BE the recent-activity reading, or be short enough that nothing but the
  // reading fits. "在干嘛" / "活动记录" / "会话历史" name the reading themselves.
  if (isRecentActivityPrompt(prompt)) {
    return result('recent_activity', { ...slots, limit: slots.limit ?? 5 }, 'high', ['anchored recent activity reading']);
  }

  // Project index: 索引 is both this CLI's code index and a database index, and
  // "index" is a substring of "indexOf". Verdict: anchored to the reading itself.
  if (isProjectIndexPrompt(prompt)) {
    return result('project_index', slots, 'high', ['anchored project index reading']);
  }

  // Project status: the widest triggers in the file. Keyword matching answered
  // "缓存状态" / "cache status" with a project snapshot nobody asked for, and
  // "这个项目为什么编译不过" never reached the model. Verdict: anchored to the
  // readings (状态 / 项目状态 / 概况 / 列出文件 / 有哪些文件 / status / list files).
  // A topic-qualified "<某物>状态" now matches nothing and falls through to
  // unknown → the model.
  if (isProjectStatusPrompt(prompt)) {
    return result('project_status', slots, 'high', ['anchored project status/overview reading']);
  }

  if (hasEditVerb(normalized)) {
    return result('code_edit', slots, 'medium', ['edit intent is strategy-only']);
  }

  if (hasAny(normalized, ['创建', '生成', 'create', 'write']) && path) {
    return result('code_edit', slots, 'medium', ['explicit write/create remains strategy or mock-demo only']);
  }

  if (command || hasAny(normalized, ['运行', '执行', 'run command', 'execute'])) {
    return result('shell_command', slots, command ? 'medium' : 'low', ['shell intent is strategy-only']);
  }

  if (hasReadVerb(normalized) && !path) {
    return result('file_read', slots, 'low', ['read intent without path']);
  }

  if (hasSearchVerb(normalized)) {
    return result('code_search', slots, 'low', ['search intent without a named target']);
  }

  return result('unknown', slots, 'low', ['no strong intent']);
}

function result(intent: CommandIntent, slots: CommandSlots, confidence: Confidence, reasons: string[]): ExtractionResult {
  return { intent, slots, confidence, reasons };
}

function isCacheProbePrompt(prompt: string, normalized: string) {
  const compact = prompt.replace(/\s+/g, '');
  const text = normalized.trim().replace(/\s+/g, ' ');
  // ---- Second safety net, kept on purpose ----
  // The anchored rules at the end of this function only accept a prompt that IS
  // the reading request, so implementation- or explanation-flavoured phrasing no
  // longer reaches them and these guards effectively never fire. They stay
  // because they are exactly what stops the hole from reopening: widen an anchor
  // back toward keyword matching and "缓存机制的源码" / "解释一下缓存命中率" are
  // again answered by a local lookup table before the model ever runs.
  if (/缓存(机制|逻辑|实现|模块|代码|源码|策略|算法|bug|问题)|(实现|写|重构|修复|优化|设计)[^。]{0,6}cache|cache\s*(implementation|module|logic|bug|code)/i.test(compact)) {
    return false;
  }
  // Explanatory phrasing asks what the concept IS, not what this CLI's cache is
  // doing: "解释缓存命中率" / "为什么缓存能省钱" are questions for the model.
  // The agent still has cache_probe as a tool, so a real diagnostic request can
  // be served after the model decides. Matched against the spaced text:
  // `\bexplain\b` cannot match a compaction that glued every word together.
  if (/解释|说明|讲讲|说说|科普|是什么|什么意思|什么是|为什么|为何|原理|如何理解/i.test(compact)) {
    return false;
  }
  if (/\bexplain\b|\bwhat\s+(is|are|does)\b|\bwhy\b|\bhow\s+does\b|\bmeans?\b|\bmeaning\b/i.test(text)) {
    return false;
  }

  // ---- First line: explicit command form ----
  // /cache, cache, probe, probe cache, /probe (case-insensitive).
  if (/^\/?(?:cache|probe)(?: cache)?$/.test(text)) return true;
  if (/^(?:show|check|get|display) (?:the )?(?:cache|probe)$/.test(text)) return true;

  // ---- Whole sentence that asks for the reading, and nothing else ----
  // [polite/imperative lead] + [one cache reading term] + [interrogative tail],
  // anchored at both ends. A second topic anywhere in the prompt fails the match
  // and the prompt continues to the intent rules below — i.e. to the model:
  // "缓存命中率为什么这么低" (tail), "帮我看看缓存命中率是不是有问题" (tail),
  // "这次会话缓存命中多少，顺便读一下 package.json" (second topic).
  // Deliberately absent: qualified variants (缓存性能 / 缓存效率 / 缓存状态 /
  // 缓存情况 / cache performance). They read like health dashboards but are just
  // as often the opening of a real question, so they now cost a model call.
  if (/^(?:当前|现在的)?(?:麻烦|请|帮我|帮忙)?(?:查一下|查看一下|查一查|查查|查看|看一下|看看|看|查|显示|检查)?(?:缓存命中率|缓存命中|命中率|缓存探针|缓存)(?:是多少|多少|怎么样|如何|呢|吗)?$/.test(compact)) {
    return true;
  }
  // Same shape in English: an entire prompt that is the hit-rate reading.
  if (/^(?:(?:average|overall) )?(?:cache hit rate|cache hit ratio|cache hit|hit rate|hit ratio|average hit rate)$/.test(text)) {
    return true;
  }
  return false;
}

// ---- Shared shapes for the anchored reading rules ----
// LEAD_VERB is the polite/imperative opener users put in front of a reading
// ("帮我看看…", "查一下…", "show me…"). It is optional, so the bare noun
// ("环境", "索引", "status") still counts as a dashboard request.
const LEAD_VERB = '(?:麻烦|请|帮我|帮忙)?(?:查一下|查看一下|查一查|查查|查看|看一下|看看|看|查|显示|检查|告诉我)?';
const EN_LEAD_VERB = '(?:(?:show|display|get|check|print)(?: me)? )?';

// Explanatory / diagnostic / transform shape shared by every reading rule. A
// prompt that asks why something is, how it works, how to design/fix it, what a
// passage says in another language, or that *reports a symptom* wants an answer,
// not a counter, so the reading rules below are skipped and the prompt keeps
// falling through the normal rules (an edit verb still lands on code_edit; a
// pure question lands on unknown) — either way the provider runs.
// Deliberately absent: bare 实现 / 修复 / 优化 / 设计 / debug. Those are edit
// verbs ("实现一个登录页", "修复内存泄漏的 bug"), and guarding them would send
// real edits to the model as if they were questions. Only their explanation
// shapes are caught (如何实现 / 怎么设计 / how to fix …).
// The symptom list (报错 / 失败 / 崩溃 / 超时 / 很慢 / 泄漏 …) is the cheap second
// net under the anchored rules: "最近 CI 老是失败" and "磁盘 IO 为什么这么慢"
// carry a reading keyword and a complaint, and a counter table never answered a
// complaint.
const EXPLANATION_SHAPE =
  /为什么|为何|为啥|原理|是什么|什么意思|什么是|如何理解|解释|说明一下|讲讲|说说|科普|有什么区别|有何区别|怎么办|咋办|怎么排查|如何排查|怎么定位|如何定位|怎么调试|如何调试|怎么设计|如何设计|怎么实现|如何实现|怎么配置|如何配置|怎么部署|如何部署|怎么管理|如何管理|怎么处理|如何处理|怎么解决|如何解决|怎么修|如何修|怎么优化|如何优化|怎么提高|如何提高|怎么避免|如何避免|怎么引入|如何引入|怎么防止|如何防止|怎么看|如何看|怎么\s*[a-z]|能不能|能否|可不可以|要不要|该不该|是不是|有没有|是否|要不要|翻译|总结|概括|归纳|改写|重写|润色|校对|评审|评估|分析|对比|报错|错误|失败|崩溃|超时|卡死|卡顿|延迟|抖动|泄漏|溢出|异常|暴涨|飙升|爆满|太大|过大|过高|变慢|很慢|太慢|慢了|慢|装不上|跑不起来|起不来|不生效|没生效|没反应|不工作|不兼容|吗/i;
const EXPLANATION_SHAPE_EN =
  /\bexplain\b|\bwhy\b|\bwhat\s+(?:is|are|does|do)\b|\bwhat'?s\b|\bhow\s+does\b|\bhow\s+(?:to|do|can|should)\b|\bmeaning\b|\bmeans\b|\bdifference between\b|\bleak|\bdiagnos|\btranslate|\bsummari[sz]e\b|\brewrite\b|\breview\b|\banaly[sz]e\b|\bcompare\b|\berror|\bfail|\bcrash|\btimeout\b|\bslow|\btoo long\b|\bstuck\b|\bhang|\bbroken\b|\bexception\b|\blatency\b|\bissue\b/i;

function asksForExplanation(value: string) {
  return EXPLANATION_SHAPE.test(value) || EXPLANATION_SHAPE_EN.test(value);
}

// A prompt that OPENS with a read imperative is a read request even when it
// carries a question tail ("读取 report.docx 是什么内容"): the user already named
// the action, so the one-shot read is the right plan.
function startsWithReadImperative(prompt: string) {
  const trimmed = prompt.trim();
  return /^(?:读取|读一下|读|打开|查看|看一下|看看|看|预览)/.test(trimmed)
    || /^(?:read|open|show|cat|view|display|preview)\b/i.test(trimmed);
}

// A search without a target is a goal, not a search ("定位这个 bug 需要看哪些
// 文件" used to grep for the whole sentence). Real targets are short and named:
// a path, an identifier, or a two-to-four word phrase.
const PROSE_OR_QUESTION = /需要|哪些|什么|如何|怎么|为什么|帮我|请|是不是|要不要|该不该|吗|呢/;

function isNamedSearchTarget(value: string | undefined) {
  const target = (value ?? '').trim();
  if (!target) return false;
  // extractSearchQuery leaves the verb's leftovers in place ("引用了 createSession"
  // for "在哪里引用了 createSession"); strip them before judging the target.
  const named = target.replace(/^(?:了|的|引用了|调用了|使用了|定义的|定义了|搜索|查找)/, '').trim();
  if (!named) return false;
  if (PROSE_OR_QUESTION.test(named)) return false;
  if (/[\\/]/.test(named)) return true;
  if (/^[A-Za-z0-9_.$@~-]{2,}$/.test(named)) return true;
  if (/[A-Za-z_][A-Za-z0-9_$]{2,}/.test(named)) return named.length <= 16;
  return named.length <= 8;
}

// "环境" is also the ordinary word for an environment variable, a deployment
// target, or a coding environment. The prompt must BE the environment reading;
// a question that merely mentions it ("环境变量在哪配置", "生产环境和测试环境有
// 什么区别") is left to the model.
function isRuntimeInfoPrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, '');
  const text = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  const zh = new RegExp(
    `^(?:你|我)?${LEAD_VERB}(?:你|我)?(?:当前|现在|所在|所处)?的?(?:运行|容器|系统|运行时|runtime)?的?(?:环境信息|容器信息|系统信息|运行时信息|运行环境|环境|容器|runtime)(?:信息|详情|是什么|怎么样|如何|呢|吗)?$`,
  );
  if (zh.test(compact)) return true;
  return new RegExp(
    `^${EN_LEAD_VERB}(?:(?:the|my|current) )?(?:environment|runtime|container|system info|environment info|runtime info|container info|system information|environment information)$`,
  ).test(text);
}

// "索引" is this CLI's code index, a database index, or a variable called
// somethingIndex. "index" is also a substring of indexOf. The prompt must BE the
// index reading: "数据库索引怎么设计" and "调用 indexOf 的地方" are questions.
function isProjectIndexPrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, '');
  const text = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  const zh = new RegExp(
    `^(?:你|我)?${LEAD_VERB}(?:这个|当前|现在)?(?:项目|代码)?(?:项目结构|代码结构|目录结构|项目索引|代码索引|索引|项目结构概览)(?:信息|详情|是什么|怎么样|如何|呢|吗)?$`,
  );
  if (zh.test(compact)) return true;
  return new RegExp(
    `^${EN_LEAD_VERB}(?:(?:the|my) )?(?:(?:project|code|repo|repository) )?(?:index|code index|project index|code structure|project structure|repo structure|repository structure)$`,
  ).test(text);
}

// The widest triggers in the file: 项目 / 状态 / status / list files each name a
// dozen other things. The prompt must BE a project reading. "<某物>状态"
// (缓存状态 / cache status) and "这个项目为什么编译不过" deliberately match
// nothing here and continue to unknown → the model.
function isProjectStatusPrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, '');
  const text = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  const zh = new RegExp(
    `^(?:你|我)?${LEAD_VERB}(?:这个|本|当前|现在的)?(?:项目)?(?:里面|里|中|内)?的?(?:项目状态|项目概况|项目概览|状态|概况|概览|有哪些文件|列出文件|文件列表|项目)(?:信息|详情|是什么|怎么样|如何|呢|吗)?$`,
  );
  if (zh.test(compact)) return true;
  return new RegExp(
    `^${EN_LEAD_VERB}(?:(?:the|my|current) )?(?:(?:project|repo) )?(?:status|overview|summary|list files|file list|project status|project overview|project summary)$`,
  ).test(text);
}

// 最近 / 活动 / 会话 / 历史 are ordinary words: "最近 CI 老是失败", "帮我查一下
// git 历史里那次提交" and "用户会话超时时间太长" each carry one, and none of them
// asks for a session-history table. Verdict: anchored, in four shapes —
//   - phrases that name the reading themselves (在干嘛 / 活动记录 / 会话历史);
//   - a whole prompt that is nothing but the reading ("最近改了什么", "最近的会话");
//   - a short bare dashboard ("最近", "history");
//   - a recent-time scope followed by an activity noun ("最近几天有什么活动"):
//     [lead] + time scope (最近/近来/这两天/这周, optionally + 几天/一周/一个月) +
//     [at most one short bridge of question or activity words (有什么/都做过/哪些)]
//     + one activity noun (活动/会话/历史/记录/改动/提交) + [question tail].
// A trigger inside a longer sentence stays with the model: "最近 CI 老是失败" and
// "最近为什么构建这么慢" have a time word but no activity noun, and "帮我查一下
// git 历史里那次提交" has the noun but no recent-time scope.
const RECENT_NUM = '(?:[几一二两三四五六七八九十半]|\\d+)';
const RECENT_UNIT = '(?:天|日|周|星期|礼拜|月|个小时?|小时)';
const RECENT_SCOPE =
  `(?:(?:最近|近来)(?:(?:这)?${RECENT_NUM}个?${RECENT_UNIT})?`
  + `|(?:这|近)(?:${RECENT_NUM}个?${RECENT_UNIT}|[天日周]))`;
const RECENT_BRIDGE =
  '(?:都|又|还)?(?:有|发生了|做了|做过|干了|干过|聊过|讨论了?|参加了?)?(?:什么|哪些|啥|多少)?';
const RECENT_TAIL =
  '(?:都|又|还|具体)?(?:有|是|包括)?(?:哪些|什么|啥|多少|几件|几条|几次)?(?:呢|吗|了)?';

function isRecentActivityPrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, '');
  if (/在干嘛|活动记录|会话历史|历史记录|操作记录|改动记录|最近活动|最近的会话|最近的提交|最近的改动/.test(compact)) return true;
  if (/^(?:你|我)?(?:麻烦|请|帮我|帮忙)?(?:查一下|查看一下|查查|查看|看一下|看看|看|查|显示|检查|告诉我)?(?:最近|近来)?的?(?:活动|会话|历史|记录|改动|提交)(?:记录|列表|信息|详情|是什么|怎么样|呢|吗)?$/.test(compact)) return true;
  if (/^(?:你|我)?(?:麻烦|请|帮我|帮忙)?(?:查一下|查看一下|查查|查看|看一下|看看|看|查)?(?:最近|近来)(?:都|在|有)?[^。！？\n]{0,8}(?:改了什么|做了什么|改了啥|干了什么|在做什么|做了哪些|改过什么|改过哪些|发生了什么|有什么变化)(?:呢|吗)?$/.test(compact)) return true;
  if (/^(?:最近|近来)(?:呢|吗|怎么样|如何)?$/.test(compact)) return true;
  // "最近几天有什么活动" / "最近有什么活动": a recent-time scope followed by one
  // activity noun, with at most a short question/activity bridge between them.
  // Both halves are required, which is what keeps the two ordinary-word prompts
  // out: "最近 CI 老是失败" has a time word but no activity noun, and
  // "帮我查一下 git 历史里那次提交" has the noun but no recent-time scope.
  if (new RegExp(
    `^(?:你|我)?${LEAD_VERB}(?:你|我)?${RECENT_SCOPE}的?${RECENT_BRIDGE}(?:活动|会话|历史|记录|改动|提交)${RECENT_TAIL}$`,
  ).test(compact)) return true;
  const text = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  return /^(?:(?:show|display|list|get|check)(?: me)? )?(?:(?:the|my|recent|latest) )*(?:recent activity|recent activities|activity log|activity|activities|recent history|session history|sessions|history|what did i do(?: recently)?|what changed(?: recently)?)$/.test(text);
}

function hasReadVerb(value: string) {
  // Include short Chinese "看" / "看看" which users type after a path, but not
  // the observation forms: "这个补丁看着没问题" / "看起来" / "我的看法" name a
  // judgement, and 看 there used to make the whole prompt a one-shot read of the
  // file it happened to mention.
  if (/看(?!着|起来|上去|上|法|作|板|来|得|不|完|了)/.test(value)) return true;
  if (/内容|全文|预览/.test(value)) return true;
  return hasChineseOrEnglishWord(value, ['读取', '读', '打开', '查看', '看看'], ['read', 'open', 'show', 'view', 'preview', 'cat']);
}

function hasSearchVerb(value: string) {
  return hasChineseOrEnglishWord(value, ['查找', '搜索', '在哪里', '引用', '定位'], ['find', 'search', 'grep', 'reference', 'where']);
}

function hasEditVerb(value: string) {
  return hasChineseOrEnglishWord(
    value,
    ['修复', '修改', '实现', '新增', '删除', '重构', '优化', '改成', '改'],
    ['fix', 'modify', 'implement', 'add', 'delete', 'refactor', 'optimize', 'update', 'create', 'write'],
  );
}

// A deliberative edit verb is a question, not an instruction: "要不要优化",
// "怎么优化", "该不该重构" weigh the edit instead of asking for it. hasEditVerb
// matches the verb either way, so the answer guard used to be lifted by 优化 and
// the question fell through to a reading rule — "内存占用高是怎么回事，要不要
// 优化" came back as process_memory/high on the bare 内存 subject.
const DELIBERATIVE_BEFORE_EDIT =
  /(?:要不要|该不该|需不需要|用不用|能不能|能否|可不可以|是不是|是否|如何|怎么|怎样|为何|为什么|值得|有必要|should\s+(?:i|we)|whether\s+to|how\s+to)[\s的]{0,2}$/;

function hasImperativeEditVerb(value: string) {
  const chineseNeedles = ['修复', '修改', '实现', '新增', '删除', '重构', '优化', '改成', '改'];
  const englishNeedles = ['fix', 'modify', 'implement', 'add', 'delete', 'refactor', 'optimize', 'update', 'create', 'write'];
  const positions: number[] = [];
  for (const needle of chineseNeedles) {
    for (let i = value.indexOf(needle); i >= 0; i = value.indexOf(needle, i + 1)) positions.push(i);
  }
  for (const needle of englishNeedles) {
    const match = englishWordBoundaryPattern(needle).exec(value);
    if (match) positions.push(match.index);
  }
  if (!positions.length) return false;
  return positions.some((index) => !DELIBERATIVE_BEFORE_EDIT.test(value.slice(Math.max(0, index - 6), index)));
}

function hasCodeContext(value: string) {
  return hasAny(value, ['代码', '源码', '源文件', 'bug', '按钮', '函数', '组件', '解析器', '显示', 'code', 'source', 'button', 'function', 'component', 'class', 'parser', 'handler', 'display']);
}

function extractPath(prompt: string) {
  const quoted = prompt.match(/"([^"\n]+)"|'([^'\n]+)'/);
  if (quoted) {
    const candidate = (quoted[1] ?? quoted[2] ?? '').trim();
    if (candidate && /\.[A-Za-z0-9]{1,8}$/.test(candidate)) return cleanExtractedPath(candidate);
  }

  const absolute = prompt.match(ABSOLUTE_PATH_PATTERN);
  if (absolute?.[0]) return cleanExtractedPath(absolute[0]);

  const desktop = prompt.match(DESKTOP_PATH_PATTERN);
  if (desktop?.[0]) return cleanExtractedPath(desktop[0].replace(/\\/g, '/'));

  const match = prompt.match(CODE_PATH_PATTERN)
    ?? prompt.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|(?:^|\s)(\.smoke\/[A-Za-z0-9_.-]+)|(?:^|\s)([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/);
  if (!match) return undefined;
  return cleanExtractedPath((match[0] ?? match[1] ?? match[2])?.trim() ?? '');
}

function cleanExtractedPath(value: string) {
  let path = value.trim().replace(/^["']|["']$/g, '');
  // Strip trailing Chinese verbs glued to the extension: 测试.docx看
  path = path.replace(TRAILING_READ_NOISE, '');
  path = path.replace(/[，。！？；：、,.!?;:]+$/u, '');
  return path.trim() || undefined;
}

function isDocumentPath(path: string) {
  return /\.(docx?|pdf|txt|csv|xlsx?|pptx?|png|jpe?g|gif|webp|md|log|xml|html?)$/i.test(path)
    || /^desktop[\\/]/i.test(path)
    || /^[A-Za-z]:[\\/]/.test(path);
}

function isPathOnlyPrompt(prompt: string, path: string | undefined) {
  if (!path) return false;
  const leftover = prompt
    .replace(path, ' ')
    .replace(TRAILING_READ_NOISE, ' ')
    .replace(/["']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return leftover.length === 0 || leftover.length <= 4;
}

function extractSearchQuery(prompt: string) {
  const quoted = prompt.match(/["'“”‘’]([^"'“”‘’]{1,120})["'“”‘’]/);
  if (quoted?.[1]) return quoted[1].trim();
  const cleaned = prompt
    .replace(/帮我|请|一下|修复|修改|实现|新增|删除|重构|优化|查找|搜索|在哪里|读取|读|打开|查看|的问题|问题/gi, ' ')
    .replace(/\b(?:please|kindly|fix|modify|implement|add|delete|refactor|optimize|update|find|search|look\s+for|locate|read|open|show)\b/gi, ' ')
    .replace(/^\s*for\b/i, ' ')
    .replace(CODE_PATH_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  if (cleaned.length > 80) return cleaned.slice(0, 80).trim();
  return cleaned;
}

function extractDrive(normalized: string) {
  if (normalized.includes('d盘') || /\b[d]:/.test(normalized)) return 'D';
  if (normalized.includes('c盘') || /\b[c]:/.test(normalized)) return 'C';
  return undefined;
}

function extractShellCommand(prompt: string) {
  const match = prompt.match(/(?:运行|执行|run|execute)\s+([^，。\n]+)/i);
  return match?.[1]?.trim();
}

function extractNumber(value: string, pattern: RegExp, group: number) {
  const match = value.match(pattern);
  if (!match?.[group]) return undefined;
  const parsed = Number(match[group]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

const ENGLISH_WORD_BOUNDARY_PATTERNS = new Map<string, RegExp>();

function englishWordBoundaryPattern(needle: string) {
  let pattern = ENGLISH_WORD_BOUNDARY_PATTERNS.get(needle);
  if (!pattern) {
    pattern = new RegExp(`\\b${needle}\\b`);
    ENGLISH_WORD_BOUNDARY_PATTERNS.set(needle, pattern);
  }
  return pattern;
}

function hasChineseOrEnglishWord(value: string, chineseNeedles: string[], englishNeedles: string[]) {
  if (chineseNeedles.some((needle) => value.includes(needle))) return true;
  return englishNeedles.some((needle) => englishWordBoundaryPattern(needle).test(value));
}
