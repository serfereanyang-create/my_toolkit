const fs = require('node:fs');
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

function resolveUsageLogPath(env = process.env) {
  const chosen = env.AICODE_USAGE_LOG;
  if (chosen && String(chosen).trim()) return path.resolve(chosen);
  return path.resolve(os.homedir(), '.aicode', 'usage.jsonl');
}

// Local (not UTC) YYYY-MM-DD so a day boundary matches the user's wall clock.
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseEntries(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // Skip corrupt lines rather than failing the whole summary.
    }
    const input = Number(obj.inputTokens) || 0;
    const output = Number(obj.outputTokens) || 0;
    if (input <= 0 && output <= 0) continue;
    const ts = typeof obj.ts === 'string' ? Date.parse(obj.ts) : NaN;
    if (Number.isNaN(ts)) continue;
    // cacheReadTokens is only present when the provider actually reported prompt
    // cache metrics. `undefined` (field absent) is distinct from a real 0, so we
    // keep it undefined here and only treat numbers as reported cache data.
    const cacheRead = typeof obj.cacheReadTokens === 'number' ? obj.cacheReadTokens : undefined;
    const cacheCreation = typeof obj.cacheCreationTokens === 'number' ? obj.cacheCreationTokens : undefined;
    const localPredicted = typeof obj.localCachePredictedRate === 'number' ? obj.localCachePredictedRate : undefined;
    const reasoningEffort = typeof obj.reasoningEffort === 'string' && obj.reasoningEffort ? obj.reasoningEffort : undefined;
    const baseUrl = typeof obj.baseUrl === 'string' && obj.baseUrl ? obj.baseUrl : undefined;
    entries.push({
      ts,
      model: typeof obj.model === 'string' && obj.model ? obj.model : 'unknown',
      provider: typeof obj.provider === 'string' ? obj.provider : 'unknown',
      input,
      output,
      cacheRead,
      cacheCreation,
      localPredicted,
      reasoningEffort,
      baseUrl,
    });
  }
  return entries;
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
 * Build a per-day, per-model summary for the last `days` days (inclusive of
 * today). Returns a dense day list (zero-filled) so the chart has one column
 * per day regardless of gaps.
 */
function summarize(entries, days, now = new Date()) {
  const windowDays = days === 90 ? 90 : days === 30 ? 30 : 7;
  // Start of the window: midnight local, (windowDays-1) days ago.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (windowDays - 1));
  const startMs = start.getTime();

  // date -> { model -> ModelStats, total, rounds, input, output, cacheRead, cacheCreation }
  const byDate = new Map();
  const modelTotals = new Map();
  let totalTokens = 0;
  let totalRounds = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  for (const entry of entries) {
    if (entry.ts < startMs) continue;
    const dateKey = localDateKey(new Date(entry.ts));
    if (!byDate.has(dateKey)) byDate.set(dateKey, {
      models: new Map(), total: 0, rounds: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
    });
    const day = byDate.get(dateKey);
    const tokens = entry.input + entry.output;
    const m = day.models.get(entry.model) || { input: 0, output: 0, total: 0, cacheRead: 0, cacheCreation: 0, rounds: 0 };
    m.input += entry.input;
    m.output += entry.output;
    m.total += tokens;
    m.cacheRead += entry.cacheRead || 0;
    m.cacheCreation += entry.cacheCreation || 0;
    m.rounds += 1;
    day.models.set(entry.model, m);
    day.total += tokens;
    day.rounds += 1;
    day.input += entry.input;
    day.output += entry.output;
    day.cacheRead += entry.cacheRead || 0;
    day.cacheCreation += entry.cacheCreation || 0;

    let modelTotal = modelTotals.get(entry.model);
    if (!modelTotal) {
      modelTotal = { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, rounds: 0, lastUsed: entry.ts };
      modelTotals.set(entry.model, modelTotal);
    }
    modelTotal.total += tokens;
    modelTotal.input += entry.input;
    modelTotal.output += entry.output;
    modelTotal.cacheRead += entry.cacheRead || 0;
    modelTotal.cacheCreation += entry.cacheCreation || 0;
    modelTotal.rounds += 1;
    // Track the most recent usage timestamp
    if (entry.ts > modelTotal.lastUsed) {
      modelTotal.lastUsed = entry.ts;
    }

    totalTokens += tokens;
    totalRounds += 1;
    totalInput += entry.input;
    totalOutput += entry.output;
    totalCacheRead += entry.cacheRead || 0;
    totalCacheCreation += entry.cacheCreation || 0;
  }

  // Dense day list, oldest first.
  const daily = [];
  for (let i = 0; i < windowDays; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = localDateKey(d);
    const day = byDate.get(key);
    const byModel = {};
    if (day) for (const [model, v] of day.models.entries()) byModel[model] = v.total;
    daily.push({
      date: key,
      total: day ? day.total : 0,
      rounds: day ? day.rounds : 0,
      input: day ? day.input : 0,
      output: day ? day.output : 0,
      cacheRead: day ? day.cacheRead : 0,
      cacheCreation: day ? day.cacheCreation : 0,
      byModel,
    });
  }

  // Models sorted by total usage descending (drives legend + color order).
  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([model, stats]) => ({ model, ...stats }));

  return {
    days: windowDays,
    daily,
    models,
    totals: {
      tokens: totalTokens,
      rounds: totalRounds,
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreation: totalCacheCreation,
    },
  };
}

/**
 * Build a per-hour summary for the last `hours` hours (24/36/48).
 * Dense hour list, oldest first. Each point exposes input/output/cache fields
 * so the UI can render stacked trends and hit rates in real time.
 */
function summarizeHourly(entries, hours, now = new Date()) {
  const windowHours = hours === 48 ? 48 : hours === 36 ? 36 : 24;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
  start.setHours(start.getHours() - (windowHours - 1));
  const startMs = start.getTime();

  const byHour = new Map();
  const modelTotals = new Map();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalRounds = 0;
  let totalTokens = 0;

  const windowRecords = [];

  for (const entry of entries) {
    if (entry.ts < startMs) continue;
    windowRecords.push(entry);
    const hourKey = localHourKey(new Date(entry.ts));
    if (!byHour.has(hourKey)) byHour.set(hourKey, {
      models: new Map(), total: 0, rounds: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
    });
    const bucket = byHour.get(hourKey);
    const tokens = entry.input + entry.output;
    const m = bucket.models.get(entry.model) || { input: 0, output: 0, total: 0, cacheRead: 0, cacheCreation: 0, rounds: 0 };
    m.input += entry.input;
    m.output += entry.output;
    m.total += tokens;
    m.cacheRead += entry.cacheRead || 0;
    m.cacheCreation += entry.cacheCreation || 0;
    m.rounds += 1;
    bucket.models.set(entry.model, m);
    bucket.total += tokens;
    bucket.rounds += 1;
    bucket.input += entry.input;
    bucket.output += entry.output;
    bucket.cacheRead += entry.cacheRead || 0;
    bucket.cacheCreation += entry.cacheCreation || 0;

    let modelTotal = modelTotals.get(entry.model);
    if (!modelTotal) {
      modelTotal = { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, rounds: 0, lastUsed: entry.ts };
      modelTotals.set(entry.model, modelTotal);
    }
    modelTotal.total += tokens;
    modelTotal.input += entry.input;
    modelTotal.output += entry.output;
    modelTotal.cacheRead += entry.cacheRead || 0;
    modelTotal.cacheCreation += entry.cacheCreation || 0;
    modelTotal.rounds += 1;
    // Track the most recent usage timestamp
    if (entry.ts > modelTotal.lastUsed) {
      modelTotal.lastUsed = entry.ts;
    }

    totalTokens += tokens;
    totalInput += entry.input;
    totalOutput += entry.output;
    totalCacheRead += entry.cacheRead || 0;
    totalCacheCreation += entry.cacheCreation || 0;
    totalRounds += 1;
  }

  // Dense hour list.
  const hourly = [];
  for (let i = 0; i < windowHours; i += 1) {
    const d = new Date(start);
    d.setHours(start.getHours() + i);
    const key = localHourKey(d);
    const bucket = byHour.get(key);
    const byModel = {};
    if (bucket) for (const [model, v] of bucket.models.entries()) byModel[model] = v.total;
    hourly.push({
      startTs: d.getTime(),
      label: `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:00`,
      total: bucket ? bucket.total : 0,
      rounds: bucket ? bucket.rounds : 0,
      input: bucket ? bucket.input : 0,
      output: bucket ? bucket.output : 0,
      cacheRead: bucket ? bucket.cacheRead : 0,
      cacheCreation: bucket ? bucket.cacheCreation : 0,
      byModel,
    });
  }

  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([model, stats]) => ({ model, ...stats }));

  return {
    hours: windowHours,
    hourly,
    models,
    totals: {
      tokens: totalTokens,
      rounds: totalRounds,
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreation: totalCacheCreation,
    },
    records: windowRecords,
  };
}

/**
 * Predict the prompt-cache hit rate for `model` from REAL history.
 *
 * Honesty contract:
 *   - Prefer the agent's own per-turn local estimate (localPredicted) because it
 *     does not depend on a provider exposing cache fields.
 *   - Fall back to provider-reported cacheRead/input only when local estimates do
 *     not have enough samples yet.
 *   - The rate is input-token-weighted over the last `windowDays` days for the
 *     same model, so tiny turns do not skew it.
 *   - Below `minSamples` weighted turns, returns { predicted: null }.
 */
function predictCacheHitRate(entries, model, now = new Date(), windowDays = 30, minSamples = 3) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (windowDays - 1));
  const startMs = start.getTime();

  let sumInput = 0;
  let sumPredicted = 0;
  let samples = 0;
  let source = 'local-estimate';
  for (const entry of entries) {
    if (entry.ts < startMs) continue;
    if (model && entry.model !== model) continue;
    if (typeof entry.localPredicted !== 'number') continue;
    if (entry.input <= 0) continue;
    sumInput += entry.input;
    sumPredicted += entry.localPredicted * entry.input;
    samples += 1;
  }

  if (samples >= minSamples && sumInput > 0) {
    return {
      predicted: Math.max(0, Math.min(1, sumPredicted / sumInput)),
      samples,
      model: model || null,
      windowDays,
      source,
    };
  }

  sumInput = 0;
  let sumCacheRead = 0;
  samples = 0;
  source = 'provider-reported';
  for (const entry of entries) {
    if (entry.ts < startMs) continue;
    if (model && entry.model !== model) continue;
    if (typeof entry.cacheRead !== 'number') continue;
    if (entry.input <= 0) continue;
    sumInput += entry.input;
    sumCacheRead += entry.cacheRead;
    samples += 1;
  }

  if (samples < minSamples || sumInput <= 0) {
    return { predicted: null, samples, model: model || null, windowDays, source };
  }
  return {
    predicted: Math.max(0, Math.min(1, sumCacheRead / sumInput)),
    samples,
    model: model || null,
    windowDays,
    source,
  };
}

/**
 * Get paginated detailed records for the last N hours.
 * Returns individual usage entries (newest first) for detailed inspection.
 */
function getDetailedRecords(entries, hours, offset = 0, limit = 20) {
  const windowHours = hours === 48 ? 48 : hours === 36 ? 36 : 24;
  const now = new Date();
  const start = new Date(now);
  start.setHours(start.getHours() - windowHours);
  const startMs = start.getTime();

  // Filter entries in time window, newest first
  const filtered = entries
    .filter(e => e.ts >= startMs)
    .sort((a, b) => b.ts - a.ts);

  const total = filtered.length;
  const records = filtered.slice(offset, offset + limit).map((entry, index) => ({
    id: `${entry.ts}-${offset + index}`,
    timestamp: entry.ts,
    model: entry.model,
    provider: entry.provider,
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead || 0,
    cacheCreation: entry.cacheCreation || 0,
    total: entry.input + entry.output,
    reasoningEffort: entry.reasoningEffort,
    baseUrl: entry.baseUrl,
  }));

  return { records, total };
}

function createUsageStore(options = {}) {
  const logPath = options.logPath || resolveUsageLogPath();

  function readEntries() {
    let text = '';
    try {
      text = fs.readFileSync(logPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    return parseEntries(text);
  }

  function summary(days) {
    return summarize(readEntries(), days);
  }

  function hourly(hours) {
    return summarizeHourly(readEntries(), hours);
  }

  // Real historical cache-hit-rate prediction for a given model (or all models
  // when omitted). Reads the same ledger; never synthesizes samples.
  function cachePrediction(model) {
    return predictCacheHitRate(readEntries(), model);
  }

  // Paginated detailed records for the last N hours
  function records(hours = 24, offset = 0, limit = 20) {
    return getDetailedRecords(readEntries(), hours, offset, limit);
  }

  return { summary, hourly, cachePrediction, records, logPath };
}

module.exports = {
  createUsageStore,
  resolveUsageLogPath,
  parseEntries,
  summarize,
  summarizeHourly,
  predictCacheHitRate,
  getDetailedRecords,
  localDateKey,
  localHourKey,
};
