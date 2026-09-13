const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/*
 * Reads the REAL token-usage ledger the CLI appends to (one JSON line per
 * completed turn) and aggregates it for the desktop statistics page. There is
 * no synthetic data: if the ledger is empty or missing, the summary is empty.
 *
 * Ledger path resolution mirrors the CLI (cli/src/usage/ledger.ts):
 *   AICODE_USAGE_LOG env  >  ~/.aicode/usage.jsonl
 */

const USAGE_SOURCES = Object.freeze({
  PROVIDER_REPORTED: 'provider-reported',
  LOCAL_ESTIMATE: 'local-estimate',
});

function resolveUsageLogPath(env = process.env) {
  const chosen = env.AICODE_USAGE_LOG;
  if (chosen && String(chosen).trim()) return path.resolve(chosen);
  return path.resolve(os.homedir(), '.aicode', 'usage.jsonl');
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

function normalizeDays(days) {
  return days === 90 ? 90 : days === 30 ? 30 : 7;
}

function normalizeHours(hours) {
  return hours === 48 ? 48 : hours === 36 ? 36 : 24;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Local (not UTC) YYYY-MM-DD so a day boundary matches the user's wall clock.
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Local hour bucket key: YYYY-MM-DDTHH (matches wall-clock hours).
function localHourKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}`;
}

/**
 * All usage views use bucket-aligned, half-open windows:
 *   - days: midnight of (days - 1) days ago through tomorrow midnight
 *   - hours: start of the current hour - (hours - 1) through next hour
 *
 * Aligning the end to the next bucket keeps the selected current day/hour
 * consistent across summary, charts, and records, including entries written
 * later in the current bucket.
 */
function getDayWindow(days, now = new Date()) {
  const windowDays = normalizeDays(days);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - windowDays);
  return { size: windowDays, start, end, startMs: start.getTime(), endMs: end.getTime() };
}

function getHourWindow(hours, now = new Date()) {
  const windowHours = normalizeHours(hours);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  const start = new Date(end);
  start.setHours(start.getHours() - windowHours);
  return { size: windowHours, start, end, startMs: start.getTime(), endMs: end.getTime() };
}

function inWindow(timestamp, window) {
  return timestamp >= window.startMs && timestamp < window.endMs;
}

function parseEntries(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // Skip corrupt lines rather than failing the whole summary.
    }

    const input = nonNegativeNumber(Number(obj.inputTokens));
    const output = nonNegativeNumber(Number(obj.outputTokens));
    if (input <= 0 && output <= 0) continue;
    const ts = typeof obj.ts === 'string' ? Date.parse(obj.ts) : NaN;
    if (Number.isNaN(ts)) continue;

    // A cache field is provider-reported only when the provider actually sent
    // that field. `0` is meaningful and must not be confused with omission.
    const cacheRead = optionalNonNegativeNumber(obj.cacheReadTokens);
    const cacheCreation = optionalNonNegativeNumber(obj.cacheCreationTokens);
    const localPredictedRaw = optionalNonNegativeNumber(obj.localCachePredictedRate);
    const localPredicted = localPredictedRaw === undefined
      ? undefined
      : Math.max(0, Math.min(1, localPredictedRaw));
    const providerCacheReported = cacheRead !== undefined || cacheCreation !== undefined;
    const source = providerCacheReported
      ? USAGE_SOURCES.PROVIDER_REPORTED
      : localPredicted !== undefined
        ? USAGE_SOURCES.LOCAL_ESTIMATE
        : undefined;
    const reasoningEffort = typeof obj.reasoningEffort === 'string' && obj.reasoningEffort ? obj.reasoningEffort : undefined;
    const baseUrl = normalizeBaseUrl(obj.baseUrl);
    // 关联字段（旧 ledger 行没有这些字段，保持 undefined 即可）。
    const sessionId = typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : undefined;
    const turnId = typeof obj.turnId === 'string' && obj.turnId ? obj.turnId : undefined;
    const toolCalls = optionalNonNegativeNumber(obj.toolCalls);
    const toolsUsed = Array.isArray(obj.toolsUsed)
      ? obj.toolsUsed.filter((name) => typeof name === 'string' && name).slice(0, 12)
      : undefined;
    const boardId = typeof obj.boardId === 'string' && obj.boardId ? obj.boardId : undefined;
    const taskId = typeof obj.taskId === 'string' && obj.taskId ? obj.taskId : undefined;
    const durationMs = optionalNonNegativeNumber(obj.durationMs);

    entries.push({
      ts,
      model: typeof obj.model === 'string' && obj.model ? obj.model : 'unknown',
      provider: typeof obj.provider === 'string' && obj.provider ? obj.provider : 'unknown',
      input,
      output,
      cacheRead,
      cacheCreation,
      localPredicted,
      reasoningEffort,
      baseUrl,
      source,
      sessionId,
      turnId,
      toolCalls,
      toolsUsed,
      boardId,
      taskId,
      durationMs,
    });
  }
  return entries;
}

// The identity is deliberately provider + endpoint + model. Model ids are not
// globally unique: two providers may expose the same id with different prices.
function usageIdentityKey(entry) {
  return JSON.stringify([
    typeof entry.provider === 'string' && entry.provider ? entry.provider : 'unknown',
    normalizeBaseUrl(entry.baseUrl) || '',
    typeof entry.model === 'string' && entry.model ? entry.model : 'unknown',
  ]);
}

function mergeSource(current, next) {
  // If a window contains both kinds, the actual provider report wins because
  // it is the source for the cache fields shown by the usage UI.
  if (next === USAGE_SOURCES.PROVIDER_REPORTED) return next;
  return current || next;
}

function createMetrics() {
  return {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    rounds: 0,
    lastUsed: undefined,
    source: undefined,
  };
}

function addMetrics(target, entry) {
  const tokens = entry.input + entry.output;
  target.total += tokens;
  target.input += entry.input;
  target.output += entry.output;
  target.cacheRead += entry.cacheRead || 0;
  target.cacheCreation += entry.cacheCreation || 0;
  target.rounds += 1;
  target.lastUsed = target.lastUsed === undefined ? entry.ts : Math.max(target.lastUsed, entry.ts);
  target.source = mergeSource(target.source, entry.source);
}

function createModelMetrics(entry, key) {
  return {
    key,
    model: entry.model,
    provider: entry.provider,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...createMetrics(),
  };
}

function addToBucket(bucket, entry, key) {
  let model = bucket.models.get(key);
  if (!model) {
    model = createModelMetrics(entry, key);
    bucket.models.set(key, model);
  }
  addMetrics(model, entry);

  // Keep the old model-only map for IPC consumers that only know model ids.
  // `byIdentity` is the lossless representation for duplicate model ids.
  bucket.byModel.set(entry.model, (bucket.byModel.get(entry.model) || 0) + entry.input + entry.output);
  bucket.byIdentity.set(key, (bucket.byIdentity.get(key) || 0) + entry.input + entry.output);
  addMetrics(bucket, entry);
}

function createBucket() {
  return {
    models: new Map(),
    byModel: new Map(),
    byIdentity: new Map(),
    ...createMetrics(),
  };
}

function sourceField(source) {
  return source ? { source } : {};
}

function modelStats(model) {
  return {
    key: model.key,
    model: model.model,
    provider: model.provider,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    total: model.total,
    input: model.input,
    output: model.output,
    cacheRead: model.cacheRead,
    cacheCreation: model.cacheCreation,
    rounds: model.rounds,
    ...(model.lastUsed === undefined ? {} : { lastUsed: model.lastUsed }),
    ...sourceField(model.source),
  };
}

function mapToObject(map) {
  const result = {};
  for (const [key, value] of map.entries()) result[key] = value;
  return result;
}

/**
 * 按会话聚合（关联下钻）：每会话的轮次、token、工具调用与最后活跃时间。
 * 只有带 sessionId 的新 ledger 行参与聚合；按总 token 降序，取前 10 个。
 */
function summarizeSessions(entries, window) {
  const sessions = new Map();
  for (const entry of entries) {
    if (!inWindow(entry.ts, window)) continue;
    if (!entry.sessionId) continue;
    let session = sessions.get(entry.sessionId);
    if (!session) {
      session = {
        sessionId: entry.sessionId,
        rounds: 0,
        tokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        toolCalls: 0,
        firstTs: entry.ts,
        lastTs: entry.ts,
        toolsUsed: new Set(),
        ...(entry.boardId ? { boardId: entry.boardId } : {}),
      };
      sessions.set(entry.sessionId, session);
    }
    session.rounds += 1;
    session.tokens += entry.input + entry.output;
    session.input += entry.input;
    session.output += entry.output;
    session.cacheRead += entry.cacheRead || 0;
    session.toolCalls += entry.toolCalls || 0;
    session.firstTs = Math.min(session.firstTs, entry.ts);
    session.lastTs = Math.max(session.lastTs, entry.ts);
    for (const tool of entry.toolsUsed ?? []) session.toolsUsed.add(tool);
    if (entry.taskId) session.taskId = entry.taskId;
  }
  return [...sessions.values()]
    .sort((a, b) => b.tokens - a.tokens || a.sessionId.localeCompare(b.sessionId))
    .slice(0, 10)
    .map((session) => ({
      ...session,
      toolsUsed: [...session.toolsUsed].slice(0, 12),
    }));
}

/**
 * Build a per-day, per-provider+baseUrl+model summary for the selected window.
 * Returns a dense day list (zero-filled) so the chart has one column per day.
 */
function summarize(entries, days, now = new Date()) {
  const window = getDayWindow(days, now);
  const byDate = new Map();
  const modelTotals = new Map();
  const totals = createMetrics();

  for (const entry of entries) {
    if (!inWindow(entry.ts, window)) continue;
    const dateKey = localDateKey(new Date(entry.ts));
    if (!byDate.has(dateKey)) byDate.set(dateKey, createBucket());
    const key = usageIdentityKey(entry);
    addToBucket(byDate.get(dateKey), entry, key);

    let modelTotal = modelTotals.get(key);
    if (!modelTotal) {
      modelTotal = createModelMetrics(entry, key);
      modelTotals.set(key, modelTotal);
    }
    addMetrics(modelTotal, entry);
    addMetrics(totals, entry);
  }

  // Dense day list, oldest first.
  const daily = [];
  for (let i = 0; i < window.size; i += 1) {
    const d = new Date(window.start);
    d.setDate(d.getDate() + i);
    const key = localDateKey(d);
    const day = byDate.get(key);
    daily.push({
      date: key,
      total: day ? day.total : 0,
      rounds: day ? day.rounds : 0,
      input: day ? day.input : 0,
      output: day ? day.output : 0,
      cacheRead: day ? day.cacheRead : 0,
      cacheCreation: day ? day.cacheCreation : 0,
      byModel: day ? mapToObject(day.byModel) : {},
      byIdentity: day ? mapToObject(day.byIdentity) : {},
      ...sourceField(day?.source),
    });
  }

  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([, stats]) => modelStats(stats));

  return {
    days: window.size,
    daily,
    models,
    sessions: summarizeSessions(entries, window),
    totals: {
      tokens: totals.total,
      rounds: totals.rounds,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheCreation: totals.cacheCreation,
      ...sourceField(totals.source),
    },
    ...sourceField(totals.source),
  };
}

/**
 * Build a per-hour summary for the selected window. Dense hour list, oldest
 * first. Each point exposes input/output/cache fields so the UI can render
 * stacked trends and hit rates in real time.
 */
function summarizeHourly(entries, hours, now = new Date()) {
  const window = getHourWindow(hours, now);
  const byHour = new Map();
  const modelTotals = new Map();
  const totals = createMetrics();
  const windowRecords = [];

  for (const entry of entries) {
    if (!inWindow(entry.ts, window)) continue;
    windowRecords.push(entry);
    const hourKey = localHourKey(new Date(entry.ts));
    if (!byHour.has(hourKey)) byHour.set(hourKey, createBucket());
    const key = usageIdentityKey(entry);
    addToBucket(byHour.get(hourKey), entry, key);

    let modelTotal = modelTotals.get(key);
    if (!modelTotal) {
      modelTotal = createModelMetrics(entry, key);
      modelTotals.set(key, modelTotal);
    }
    addMetrics(modelTotal, entry);
    addMetrics(totals, entry);
  }

  const hourly = [];
  for (let i = 0; i < window.size; i += 1) {
    const d = new Date(window.start);
    d.setHours(d.getHours() + i);
    const key = localHourKey(d);
    const bucket = byHour.get(key);
    hourly.push({
      startTs: d.getTime(),
      label: `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:00`,
      total: bucket ? bucket.total : 0,
      rounds: bucket ? bucket.rounds : 0,
      input: bucket ? bucket.input : 0,
      output: bucket ? bucket.output : 0,
      cacheRead: bucket ? bucket.cacheRead : 0,
      cacheCreation: bucket ? bucket.cacheCreation : 0,
      byModel: bucket ? mapToObject(bucket.byModel) : {},
      byIdentity: bucket ? mapToObject(bucket.byIdentity) : {},
      ...sourceField(bucket?.source),
    });
  }

  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([, stats]) => modelStats(stats));

  return {
    hours: window.size,
    hourly,
    models,
    totals: {
      tokens: totals.total,
      rounds: totals.rounds,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheCreation: totals.cacheCreation,
      ...sourceField(totals.source),
    },
    records: windowRecords.map((entry, index) => toUsageRecord(entry, index)),
    ...sourceField(totals.source),
  };
}

/**
 * Predict the prompt-cache hit rate for `model` from REAL history.
 *
 * Honesty contract:
 *   - Prefer the agent's own per-turn local estimate because it does not depend
 *     on a provider exposing cache fields.
 *   - Fall back to provider-reported cacheRead/input only when local estimates
 *     do not have enough samples yet.
 *   - The rate is input-token-weighted over the selected day window.
 *   - Below `minSamples` weighted turns, returns { predicted: null }.
 */
function predictCacheHitRate(entries, model, now = new Date(), windowDays = 30, minSamples = 3) {
  const window = getDayWindow(windowDays, now);
  const normalizedWindowDays = window.size;
  let sumInput = 0;
  let sumPredicted = 0;
  let samples = 0;

  for (const entry of entries) {
    if (!inWindow(entry.ts, window)) continue;
    if (model && entry.model !== model) continue;
    if (typeof entry.localPredicted !== 'number' || entry.input <= 0) continue;
    sumInput += entry.input;
    sumPredicted += entry.localPredicted * entry.input;
    samples += 1;
  }

  if (samples >= minSamples && sumInput > 0) {
    return {
      predicted: Math.max(0, Math.min(1, sumPredicted / sumInput)),
      samples,
      model: model || null,
      windowDays: normalizedWindowDays,
      source: USAGE_SOURCES.LOCAL_ESTIMATE,
    };
  }

  sumInput = 0;
  let sumCacheRead = 0;
  samples = 0;
  for (const entry of entries) {
    if (!inWindow(entry.ts, window)) continue;
    if (model && entry.model !== model) continue;
    if (typeof entry.cacheRead !== 'number' || entry.input <= 0) continue;
    sumInput += entry.input;
    sumCacheRead += entry.cacheRead;
    samples += 1;
  }

  if (samples < minSamples || sumInput <= 0) {
    return { predicted: null, samples, model: model || null, windowDays: normalizedWindowDays, source: USAGE_SOURCES.PROVIDER_REPORTED };
  }
  return {
    predicted: Math.max(0, Math.min(1, sumCacheRead / sumInput)),
    samples,
    model: model || null,
    windowDays: normalizedWindowDays,
    source: USAGE_SOURCES.PROVIDER_REPORTED,
  };
}

function toUsageRecord(entry, index) {
  return {
    id: `${entry.ts}-${index}`,
    timestamp: entry.ts,
    model: entry.model,
    provider: entry.provider,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead || 0,
    cacheCreation: entry.cacheCreation || 0,
    total: entry.input + entry.output,
    reasoningEffort: entry.reasoningEffort,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
    ...(entry.toolsUsed && entry.toolsUsed.length > 0 ? { toolsUsed: entry.toolsUsed } : {}),
    ...(entry.boardId ? { boardId: entry.boardId } : {}),
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...sourceField(entry.source),
  };
}

/**
 * Get paginated detailed records for the selected hour window. The records use
 * the exact same bucket-aligned bounds as summarizeHourly.
 */
function getDetailedRecords(entries, hours, offset = 0, limit = 20, now = new Date()) {
  const window = getHourWindow(hours, now);
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;

  const filtered = entries
    .filter((entry) => inWindow(entry.ts, window))
    .sort((a, b) => b.ts - a.ts);

  const total = filtered.length;
  const records = filtered
    .slice(safeOffset, safeOffset + safeLimit)
    .map((entry, index) => toUsageRecord(entry, safeOffset + index));

  return { records, total };
}

function fileSignature(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
}

function createUsageStore(options = {}) {
  const logPath = options.logPath || resolveUsageLogPath();
  let cachedSignature;
  let cachedEntries = [];
  let inFlight = null;

  // Synchronous compatibility path for existing in-process consumers. The
  // desktop IPC handlers use the async methods below, so ledger I/O never
  // blocks the Electron main process on normal usage-page requests.
  function readEntries() {
    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        cachedSignature = 'missing';
        cachedEntries = [];
        return cachedEntries;
      }
      throw error;
    }
    const signature = fileSignature(stat);
    if (cachedSignature === signature) return cachedEntries;
    const text = fs.readFileSync(logPath, 'utf8');
    cachedEntries = parseEntries(text);
    cachedSignature = signature;
    return cachedEntries;
  }

  async function readEntriesAsync() {
    let stat;
    try {
      stat = await fsp.stat(logPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        cachedSignature = 'missing';
        cachedEntries = [];
        return cachedEntries;
      }
      throw error;
    }

    const signature = fileSignature(stat);
    if (cachedSignature === signature) return cachedEntries;
    if (inFlight && inFlight.signature === signature) return inFlight.promise;

    const promise = fsp.readFile(logPath, 'utf8').then((text) => {
      const parsed = parseEntries(text);
      cachedEntries = parsed;
      cachedSignature = signature;
      return parsed;
    });
    inFlight = { signature, promise };
    try {
      return await promise;
    } finally {
      if (inFlight && inFlight.promise === promise) inFlight = null;
    }
  }

  function summary(days) {
    return summarize(readEntries(), days);
  }

  async function summaryAsync(days) {
    return summarize(await readEntriesAsync(), days);
  }

  function hourly(hours) {
    return summarizeHourly(readEntries(), hours);
  }

  async function hourlyAsync(hours) {
    return summarizeHourly(await readEntriesAsync(), hours);
  }

  function cachePrediction(model) {
    return predictCacheHitRate(readEntries(), model);
  }

  async function cachePredictionAsync(model) {
    return predictCacheHitRate(await readEntriesAsync(), model);
  }

  function records(hours = 24, offset = 0, limit = 20) {
    return getDetailedRecords(readEntries(), hours, offset, limit);
  }

  async function recordsAsync(hours = 24, offset = 0, limit = 20) {
    return getDetailedRecords(await readEntriesAsync(), hours, offset, limit);
  }

  return {
    summary,
    summaryAsync,
    hourly,
    hourlyAsync,
    cachePrediction,
    cachePredictionAsync,
    records,
    recordsAsync,
    logPath,
  };
}

module.exports = {
  createUsageStore,
  resolveUsageLogPath,
  normalizeBaseUrl,
  parseEntries,
  summarize,
  summarizeHourly,
  predictCacheHitRate,
  getDetailedRecords,
  getDayWindow,
  getHourWindow,
  usageIdentityKey,
  localDateKey,
  localHourKey,
  USAGE_SOURCES,
};
