# AI Review & Literature Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI-powered literature review generation (OpenAI-compatible, streamed, preview-before-send) plus a deterministic literature-matrix export to the Electron paper assistant.

**Architecture:** Main process owns config (apiKey encrypted via `safeStorage`), prompt assembly, and SSE streaming over IPC events; renderer only sees `hasKey` and receives chunks. Two pure functions (`paper-digest.cjs`, `paper-matrix.cjs`) are TDD'd first; `ai-service.cjs` takes injected `safeStorage`-like codec and `fetchImpl` so config/SSE logic is testable in plain Node. UI: `ReviewDrawer` + `AiSettings` wired into the existing `activeDrawer` model extended with `'review'`.

**Tech Stack:** Electron (main IPC, safeStorage), Node global fetch + AbortController (SSE), React + Ant Design, Vitest + node:assert scripts.

**Spec:** `docs/superpowers/specs/2026-08-30-ai-review-and-literature-matrix.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `electron/paper-digest.cjs` | Pure: papers → grouped digest with truncation limits |
| `electron/paper-matrix.cjs` | Pure: papers → literature matrix Markdown |
| `electron/ai-service.cjs` | Config store (safeStorage), baseUrl validation, SSE streaming, cancel |
| `electron/main.cjs` | Register `ai:*` IPC + event forwarding |
| `electron/preload.cjs` | Expose `desktopApi.ai` |
| `scripts/test-paper-digest.cjs` | Digest unit tests |
| `scripts/test-paper-matrix.cjs` | Matrix unit tests |
| `scripts/test-ai-service.cjs` | Config + SSE parser tests (no Electron needed) |
| `scripts/test-ai-wiring.cjs` | Static wiring markers (main/preload/renderer) |
| `src/lib/uiState.ts` | Extend `ActiveDrawer` with `'review'` |
| `src/components/paper/ReviewDrawer.tsx` | Preview → stream → edit/save UI |
| `src/components/paper/AiSettings.tsx` | AI config form + test connection |
| `src/components/paper/DisplaySettings.tsx` | Render AiSettings section |
| `src/App.tsx` | Menu/drawer entries, pass filtered papers |
| `scripts/test-renderer-auth-wiring.cjs` | Extend markers for AI UI |

---

### Task 1: paper-digest.cjs (pure, TDD)

**Files:**
- Create: `electron/paper-digest.cjs`
- Create: `scripts/test-paper-digest.cjs`

- [ ] **Step 1: Write failing tests**

```js
// scripts/test-paper-digest.cjs
const assert = require('node:assert/strict');
const { buildReviewDigest } = require('../electron/paper-digest.cjs');

const paper = (overrides = {}) => ({
  id: 'p', title: 'T', authors: 'A', year: '2026', source: 'S', doi: '', url: '',
  status: '精读', tags: ['nlp'], question: 'Q', method: 'M', dataset: 'D',
  findings: 'F', limitations: 'L', credibility: 'C',
  evidence: [{ id: 'e1', claim: 'claim text', support: 'sup', locator: 'p.1', reliability: '高', tags: [] }],
  checklist: {},
  ...overrides,
});

function run() {
  const one = buildReviewDigest([paper()]);
  assert.equal(one.totalCount, 1);
  assert.equal(one.truncated, false);
  assert.equal(one.groups.length, 1);
  assert.equal(one.groups[0].tag, 'nlp');
  assert.equal(one.groups[0].papers[0].title, 'T');
  assert.match(one.groups[0].papers[0].evidence[0].claim, /claim text/);

  // 41 papers → truncated flag, only 40 kept
  const many = buildReviewDigest(Array.from({ length: 41 }, (_, i) => paper({ id: `p${i}`, title: `T${i}`, tags: [] })));
  assert.equal(many.truncated, true);
  assert.equal(many.totalCount, 41);
  const kept = many.groups.flatMap((g) => g.papers);
  assert.equal(kept.length, 40);

  // field truncation at 400 chars
  const longQ = 'x'.repeat(500);
  const d2 = buildReviewDigest([paper({ question: longQ })]);
  assert.equal(d2.groups[0].papers[0].question.length, 400);

  // evidence claim truncation + max 8 evidence per paper
  const evs = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, claim: 'y'.repeat(300), support: '', locator: '', reliability: '中', tags: [] }));
  const d3 = buildReviewDigest([paper({ evidence: evs })]);
  const p3 = d3.groups[0].papers[0];
  assert.equal(p3.evidence.length, 8);
  assert.equal(p3.evidence[0].claim.length, 200);

  // untagged papers grouped under 未分组
  const d4 = buildReviewDigest([paper({ tags: [] })]);
  assert.equal(d4.groups[0].tag, '未分组');

  // empty input
  const empty = buildReviewDigest([]);
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.totalCount, 0);

  console.log('paper digest tests passed');
}
run();
```

- [ ] **Step 2: Run (expect fail)** — `node scripts/test-paper-digest.cjs` → module not found.

- [ ] **Step 3: Implement**

```js
// electron/paper-digest.cjs
const MAX_PAPERS = 40;
const FIELD_LIMIT = 400;
const CLAIM_LIMIT = 200;
const MAX_EVIDENCE = 8;

function cut(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) : text;
}

function digestPaper(paper) {
  return {
    id: paper.id,
    title: cut(paper.title, FIELD_LIMIT),
    authors: cut(paper.authors, FIELD_LIMIT),
    year: cut(paper.year, FIELD_LIMIT),
    source: cut(paper.source, FIELD_LIMIT),
    status: paper.status || '',
    question: cut(paper.question, FIELD_LIMIT),
    method: cut(paper.method, FIELD_LIMIT),
    dataset: cut(paper.dataset, FIELD_LIMIT),
    findings: cut(paper.findings, FIELD_LIMIT),
    limitations: cut(paper.limitations, FIELD_LIMIT),
    credibility: cut(paper.credibility, FIELD_LIMIT),
    evidence: (Array.isArray(paper.evidence) ? paper.evidence : []).slice(0, MAX_EVIDENCE).map((e) => ({
      claim: cut(e.claim, CLAIM_LIMIT),
      locator: cut(e.locator, CLAIM_LIMIT),
    })),
  };
}

function buildReviewDigest(papers) {
  const list = Array.isArray(papers) ? papers : [];
  const selected = list.slice(0, MAX_PAPERS).map(digestPaper);
  const groupsMap = new Map();
  for (const item of selected) {
    const tags = Array.isArray(item.tags) ? [] : null; // tags were cut; read from source below
  }
  // Group by original tags (digest strips tags, so re-walk source list)
  const sourceSelected = list.slice(0, MAX_PAPERS);
  for (let i = 0; i < sourceSelected.length; i += 1) {
    const tags = Array.isArray(sourceSelected[i].tags) && sourceSelected[i].tags.length
      ? sourceSelected[i].tags
      : ['未分组'];
    for (const tag of tags) {
      if (!groupsMap.has(tag)) groupsMap.set(tag, []);
      groupsMap.get(tag).push(selected[i]);
    }
  }
  const groups = Array.from(groupsMap.entries())
    .map(([tag, items]) => ({ tag, papers: items }))
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh'));
  return { totalCount: list.length, selectedCount: selected.length, truncated: list.length > MAX_PAPERS, groups };
}

module.exports = { buildReviewDigest, MAX_PAPERS, FIELD_LIMIT, CLAIM_LIMIT, MAX_EVIDENCE };
```

Note: remove the dead `groupsMap` pre-walk loop (shown only to flag it) — the implementation must contain only the single grouping pass over `sourceSelected`. Do not keep dead code.

- [ ] **Step 4: Run (pass)** — `node scripts/test-paper-digest.cjs` → `paper digest tests passed`

- [ ] **Step 5: Commit if git available** — repo exists; commit `feat: add paper digest pure function for ai review`

---

### Task 2: paper-matrix.cjs (pure, TDD)

**Files:**
- Create: `electron/paper-matrix.cjs`
- Create: `scripts/test-paper-matrix.cjs`

- [ ] **Step 1: Write failing tests**

```js
// scripts/test-paper-matrix.cjs
const assert = require('node:assert/strict');
const { buildLiteratureMatrix } = require('../electron/paper-matrix.cjs');

function run() {
  const md = buildLiteratureMatrix([
    { id: 'p1', title: 'A|B', authors: 'X;Y', year: '2026', source: 'J', doi: '10.1/x', status: '精读',
      method: 'm1\nm2', dataset: 'd', findings: 'f', limitations: 'l' },
  ]);
  assert.match(md, /^\| # \| 论文 \| 作者 \| 年份 \| 来源 \| DOI \| 状态 \| 方法 \| 数据\/样本 \| 关键发现 \| 局限 \|/m);
  assert.match(md, /A\|B/.source ? /A\\\|B/ : /A\|B/); // pipe escaped
  assert.ok(!md.includes('m1\nm2')); // newline folded
  assert.match(md, /m1 m2/);
  assert.match(md, /共 1 篇/); // footer note

  const empty = buildLiteratureMatrix([]);
  assert.match(empty, /没有论文/);

  console.log('paper matrix tests passed');
}
run();
```

- [ ] **Step 2: Run (expect fail)**

- [ ] **Step 3: Implement**

```js
// electron/paper-matrix.cjs
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

function buildLiteratureMatrix(papers) {
  const list = Array.isArray(papers) ? papers : [];
  const header = '| # | 论文 | 作者 | 年份 | 来源 | DOI | 状态 | 方法 | 数据/样本 | 关键发现 | 局限 |';
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|';
  if (list.length === 0) {
    return `${header}\n${rule}\n| - | 没有论文 | | | | | | | | | |\n`;
  }
  const rows = list.map((p, i) => `| ${i + 1} | ${cell(p.title)} | ${cell(p.authors)} | ${cell(p.year)} | ${cell(p.source)} | ${cell(p.doi)} | ${cell(p.status)} | ${cell(p.method)} | ${cell(p.dataset)} | ${cell(p.findings)} | ${cell(p.limitations)} |`);
  const footer = `\n> 文献矩阵：共 ${list.length} 篇，生成于 ${new Date().toISOString().slice(0, 10)}。`;
  return [header, rule, ...rows, '', footer].join('\n');
}

module.exports = { buildLiteratureMatrix };
```

- [ ] **Step 4: Run (pass)** — `node scripts/test-paper-matrix.cjs`

- [ ] **Step 5: Commit** — `feat: add literature matrix pure function`

---

### Task 3: ai-service.cjs (config + SSE, testable without Electron)

**Files:**
- Create: `electron/ai-service.cjs`
- Create: `scripts/test-ai-service.cjs`

- [ ] **Step 1: Write failing tests**

```js
// scripts/test-ai-service.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  configureAiService, validateBaseUrl, parseSseStream, saveConfig, getPublicConfig,
  resetAiService,
} = require('../electron/ai-service.cjs');

const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`).toString('base64'),
  decryptString: (b) => Buffer.from(b, 'base64').toString('utf8').replace(/^enc:/, ''),
};

function run() {
  // baseUrl validation
  assert.doesNotThrow(() => validateBaseUrl('https://api.example.com/v1'));
  assert.doesNotThrow(() => validateBaseUrl('http://localhost:11434/v1'));
  assert.doesNotThrow(() => validateBaseUrl('http://127.0.0.1:8080/v1'));
  assert.throws(() => validateBaseUrl('http://api.example.com/v1'), /https/);
  assert.throws(() => validateBaseUrl('ftp://x'), /https/);
  assert.throws(() => validateBaseUrl(''), /required|必填/);

  // config roundtrip with fake codec
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ai-'));
  configureAiService({ userDataPath: tmp, safeStorageApi: codec });
  const saved = saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'gpt-test', temperature: 0.4, apiKey: 'sk-secret' });
  assert.equal(saved.ok, true);
  const pub = getPublicConfig();
  assert.equal(pub.hasKey, true);
  assert.equal(pub.baseUrl, 'https://api.example.com/v1');
  assert.equal(pub.apiKey, undefined); // never expose
  const raw = fs.readFileSync(path.join(tmp, 'ai-config.json'), 'utf8');
  assert.ok(!raw.includes('sk-secret')); // ciphertext only

  // codec unavailable → refuse save
  resetAiService();
  configureAiService({ userDataPath: tmp, safeStorageApi: { ...codec, isEncryptionAvailable: () => false } });
  const refused = saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-1' });
  assert.equal(refused.ok, false);

  // decrypt failure → hasKey false
  resetAiService();
  configureAiService({ userDataPath: tmp, safeStorageApi: { ...codec, decryptString: () => { throw new Error('boom'); } } });
  assert.equal(getPublicConfig().hasKey, false);

  // SSE parser: deltas, [DONE], junk lines tolerated
  const sse = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
    ': keep-alive\n' +
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
    'data: [DONE]\n\n';
  let out = '';
  for (const delta of parseSseStream(sse)) out += delta;
  assert.equal(out, 'Hello');

  resetAiService();
  console.log('ai service tests passed');
}
run();
```

- [ ] **Step 2: Run (expect fail)**

- [ ] **Step 3: Implement**

```js
// electron/ai-service.cjs
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'ai-config.json';
const REQUEST_TIMEOUT_MS = 120_000;

let userDataPath = '';
let safeStorageApi = null;
let currentController = null;

function configureAiService(options = {}) {
  if (options.userDataPath) userDataPath = options.userDataPath;
  if (options.safeStorageApi) safeStorageApi = options.safeStorageApi;
}

function resetAiService() {
  userDataPath = '';
  safeStorageApi = null;
  currentController = null;
}

function configPath() {
  return path.join(userDataPath, CONFIG_FILE);
}

function loadRawConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function validateBaseUrl(url) {
  const value = String(url || '').trim();
  if (!value) throw new Error('baseUrl 必填');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('baseUrl 格式不正确');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error('外网地址必须使用 https（本地服务可用 http://localhost）');
  }
  return value;
}

function decryptKey(cipher) {
  if (!cipher || !safeStorageApi) return null;
  try {
    const plain = safeStorageApi.decryptString(Buffer.from(cipher, 'base64'));
    return plain || null;
  } catch {
    return null; // treat as unconfigured
  }
}

function getPublicConfig() {
  const raw = loadRawConfig();
  return {
    baseUrl: raw.baseUrl || '',
    model: raw.model || '',
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.4,
    hasKey: Boolean(decryptKey(raw.apiKeyCipher)),
  };
}

function saveConfig(input) {
  if (!safeStorageApi || !safeStorageApi.isEncryptionAvailable()) {
    return { ok: false, error: '系统不支持密钥加密存储，无法启用 AI 功能' };
  }
  let baseUrl;
  try {
    baseUrl = validateBaseUrl(input.baseUrl);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const model = String(input.model || '').trim();
  if (!model) return { ok: false, error: 'model 必填' };
  const temperature = Math.min(2, Math.max(0, Number(input.temperature ?? 0.4)));
  const next = { ...loadRawConfig(), baseUrl, model, temperature };
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    next.apiKeyCipher = safeStorageApi.encryptString(input.apiKey.trim()).toString('base64');
  } else if (input.apiKey === '') {
    delete next.apiKeyCipher; // explicit clear
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return { ok: true };
}

function* parseSseStream(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield delta;
    } catch {
      // tolerate malformed lines
    }
  }
}

async function testConnection() {
  const cfg = getPublicConfig();
  const key = decryptKey(loadRawConfig().apiKeyCipher);
  if (!cfg.baseUrl || !cfg.model || !key) return { ok: false, error: 'AI 服务尚未配置完整' };
  try {
    const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      return { ok: false, error: `HTTP ${response.status}: ${text}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 200) };
  }
}

async function generateReviewStream({ messages, onDelta, onDone, onError, getSender }) {
  const cfg = getPublicConfig();
  const key = decryptKey(loadRawConfig().apiKeyCipher);
  if (!cfg.baseUrl || !cfg.model || !key) {
    onError('AI 服务尚未配置完整');
    return;
  }
  currentController = new AbortController();
  let received = '';
  try {
    const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, stream: true, messages }),
      signal: currentController.signal,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      onError(response.status === 429 ? '请求被限流（429），请稍后重试' : `HTTP ${response.status}: ${text}`);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const delta of parseSseStream(part)) {
          received += delta;
          onDelta(delta);
        }
      }
    }
    onDone(received);
  } catch (error) {
    if (error.name === 'AbortError') onDone(received, { stopped: true });
    else onError(String(error.message || error).slice(0, 200));
  } finally {
    currentController = null;
  }
}

function cancelReview() {
  if (currentController) currentController.abort();
}

module.exports = {
  configureAiService, resetAiService, validateBaseUrl, parseSseStream,
  saveConfig, getPublicConfig, testConnection, generateReviewStream, cancelReview,
};
```

- [ ] **Step 4: Run (pass)** — `node scripts/test-ai-service.cjs` → `ai service tests passed`

- [ ] **Step 5: Commit** — `feat: add ai service config store and sse streaming`

---

### Task 4: IPC + preload wiring

**Files:**
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Create: `scripts/test-ai-wiring.cjs`

- [ ] **Step 1: Write failing wiring test**

```js
// scripts/test-ai-wiring.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

for (const channel of ['ai:get-config', 'ai:save-config', 'ai:test-connection', 'ai:generate-review', 'ai:cancel-review']) {
  assert.ok(main.includes(`'${channel}'`), `main missing ${channel}`);
}
assert.ok(main.includes('configureAiService'), 'ai service not configured at startup');
assert.ok(preload.includes('ai:'), 'preload missing desktopApi.ai');
for (const event of ['ai:review-chunk', 'ai:review-done', 'ai:review-error']) {
  assert.ok(main.includes(`'${event}'`), `main missing event ${event}`);
  assert.ok(preload.includes(`'${event}'`), `preload missing event ${event}`);
}
console.log('ai wiring tests passed');
```

- [ ] **Step 2: Run (expect fail)**

- [ ] **Step 3: Implement main.cjs additions**

After existing requires:

```js
const { configureAiService, getPublicConfig, saveConfig, testConnection, generateReviewStream, cancelReview } = require('./ai-service.cjs');
```

Inside `app.whenReady().then(...)` after `auth.configureAuth(...)`:

```js
configureAiService({ userDataPath });
```

Handlers (near other handlers):

```js
ipcMain.handle('ai:get-config', () => getPublicConfig());
ipcMain.handle('ai:save-config', (_e, input) => saveConfig(input || {}));
ipcMain.handle('ai:test-connection', () => testConnection());
ipcMain.handle('ai:cancel-review', () => {
  cancelReview();
  return { ok: true };
});
ipcMain.handle('ai:generate-review', (event, payload) => {
  const sender = event.sender;
  generateReviewStream({
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    onDelta: (delta) => { if (!sender.isDestroyed()) sender.send('ai:review-chunk', delta); },
    onDone: (full, meta = {}) => { if (!sender.isDestroyed()) sender.send('ai:review-done', { full, stopped: Boolean(meta.stopped) }); },
    onError: (message) => { if (!sender.isDestroyed()) sender.send('ai:review-error', { message }); },
  });
  return { ok: true };
});
```

- [ ] **Step 4: Implement preload additions** (inside `desktopApi` object):

```js
ai: {
  getConfig: () => ipcRenderer.invoke('ai:get-config'),
  saveConfig: (input) => ipcRenderer.invoke('ai:save-config', input),
  testConnection: () => ipcRenderer.invoke('ai:test-connection'),
  generateReview: (messages) => ipcRenderer.invoke('ai:generate-review', { messages }),
  cancelReview: () => ipcRenderer.invoke('ai:cancel-review'),
  onChunk: (cb) => { const l = (_e, d) => cb(d); ipcRenderer.on('ai:review-chunk', l); return () => ipcRenderer.removeListener('ai:review-chunk', l); },
  onDone: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('ai:review-done', l); return () => ipcRenderer.removeListener('ai:review-done', l); },
  onError: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('ai:review-error', l); return () => ipcRenderer.removeListener('ai:review-error', l); },
},
```

- [ ] **Step 5: Run** — `node scripts/test-ai-wiring.cjs` → pass. Commit `feat: wire ai ipc channels`

---

### Task 5: ReviewDrawer + AiSettings components

**Files:**
- Create: `src/components/paper/ReviewDrawer.tsx`
- Create: `src/components/paper/AiSettings.tsx`
- Modify: `src/components/paper/DisplaySettings.tsx` (accept + render `aiSettings` node)

- [ ] **Step 1: Implement ReviewDrawer**

Props: `{ open: boolean; onClose: () => void; papers: Paper[]; onSaveMarkdown: (name: string, content: string) => void; }`

Internal phases per spec §8: `idle → preview → generating → done | stopped | error`.

- Preview: list titles+years (from `buildReviewDigest` import? No — renderer cannot import electron/*.cjs; duplicate limits via a small shared constant block in `src/lib/uiState.ts`: `AI_REVIEW_MAX_PAPERS = 40` etc. **Do not** require the .cjs from renderer; re-derive the digest client-side with a TS helper `buildReviewDigestTs(papers)` in `src/lib/reviewDigest.ts` mirroring the same limits (add unit test `src/lib/reviewDigest.test.ts` asserting same truncation behavior).
- 生成: assemble messages from digest (`system` from spec §7.4, `user` = grouped blocks) → `window.desktopApi.ai.generateReview(messages)`; subscribe `onChunk` (append), `onDone` (phase done/stopped), `onError` (phase error + message).
- Cancel button during generating calls `cancelReview()`; drawer `onClose` also calls it.
- Done: TextArea editable with `full`; buttons 重新生成 (back to preview) / 另存为 Markdown → `onSaveMarkdown('literature-review', content)`.
- Empty papers: show 没有论文 message, no generate.
- Note: if `!window.desktopApi?.ai` show 账户系统仅桌面端可用-style disabled state.

- [ ] **Step 2: Implement AiSettings**

Props: none (self-contained via `window.desktopApi.ai`).

- On open: load config → fill baseUrl/model/temperature; key field empty placeholder `已保存（不回显）` when `hasKey`.
- Save → `saveConfig({ baseUrl, model, temperature, apiKey: keyInput || undefined })`; show error/success.
- 测试连接 button → `testConnection()`; show result or `HTTP …` error.
- If `getConfig` returns but `saveConfig` errors with encryption unavailable — display as-is (main handles).

- [ ] **Step 3: DisplaySettings integration**

Add optional prop `aiSettings?: React.ReactNode`; render after 高级显示设置 with divider + title `AI 服务`.

- [ ] **Step 4: Unit test for renderer digest**

```ts
// src/lib/reviewDigest.test.ts
import { describe, expect, it } from 'vitest';
import { buildReviewDigest, AI_REVIEW_MAX_PAPERS } from './reviewDigest';

describe('buildReviewDigest (renderer mirror)', () => {
  it('truncates to max papers and marks truncated', () => {
    const papers = Array.from({ length: AI_REVIEW_MAX_PAPERS + 1 }, (_, i) => ({ id: `${i}`, title: `T${i}`, tags: [] }));
    const digest = buildReviewDigest(papers as never);
    expect(digest.truncated).toBe(true);
    expect(digest.selectedCount).toBe(AI_REVIEW_MAX_PAPERS);
  });
});
```

Run: `npm test -- src/lib/reviewDigest.test.ts` → pass.

- [ ] **Step 5: Build** — `npm run build` → pass. Commit `feat: add review drawer and ai settings ui`

---

### Task 6: App.tsx integration

**Files:**
- Modify: `src/lib/uiState.ts` (ActiveDrawer + `'review'`; `nextActiveDrawer` unchanged, type widens)
- Modify: `src/App.tsx`
- Modify: `scripts/test-renderer-auth-wiring.cjs`

- [ ] **Step 1: Extend wiring test markers first (RED)**

Add to markers array:

```js
  "activeDrawer: 'quality' | 'account' | 'review' | null", // or via ActiveDrawer import; marker: "ReviewDrawer",
  'ReviewDrawer',
  'AiSettings',
  'buildLiteratureMatrix',
  "label: '生成综述'",
```

Run → fail.

- [ ] **Step 2: Implement**

- `uiState.ts`: `export type ActiveDrawer = 'quality' | 'account' | 'review' | null;`
- `App.tsx`:
  - `openReview = () => setActiveDrawer((prev) => nextActiveDrawer(prev, 'review'))`
  - moreMenuItems add `{ key: 'review', label: '生成综述', onClick: openReview }` and `{ key: 'matrix', label: '导出文献矩阵', onClick: () => { void exportMatrix(); } }`
  - `exportMatrix()`:

```ts
async function exportMatrix() {
  if (filteredPapers.length === 0) { message.warning('当前筛选没有论文'); return; }
  const { buildLiteratureMatrix } = await import('../electron/paper-matrix.cjs');
  const md = buildLiteratureMatrix(filteredPapers);
  if (window.desktopApi) {
    const result = await window.desktopApi.saveMarkdown('literature-matrix', md);
    if (!result.canceled) message.success('文献矩阵已保存');
    return;
  }
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'literature-matrix.md'; link.click();
  URL.revokeObjectURL(url);
}
```

  **Import note:** `paper-matrix.cjs` is CommonJS with `module.exports`; Vite can import it via `import { buildLiteratureMatrix } from '../electron/paper-matrix.cjs'` only if it is dependency-free (it is). Prefer a static top-level import over dynamic. If tsc/vite rejects `.cjs` import from renderer, instead duplicate `buildLiteratureMatrix` into `src/lib/literatureMatrix.ts` with its own Vitest test, and have the electron copy remain for main-side use or delete it — **choose the TS duplicate path if the .cjs import fails at build; keep one source of truth in renderer TS and drop the .cjs** (update Task 2 test path accordingly at execution time, record the deviation in the report).
  - QualityDrawer export section: add two buttons `生成综述`（disabled when no `desktopApi.ai`） and `导出文献矩阵` — pass callbacks via existing props.
  - Render `<ReviewDrawer open={activeDrawer === 'review'} onClose={() => setActiveDrawer(null)} papers={filteredPapers} onSaveMarkdown={...} />` next to other drawers.
  - `<DisplaySettings ... aiSettings={<AiSettings />} />`
- `scripts/test-renderer-auth-wiring.cjs`: run → pass.

- [ ] **Step 3: Full verification**

```bash
node scripts/test-paper-digest.cjs
node scripts/test-paper-matrix.cjs
node scripts/test-ai-service.cjs
node scripts/test-ai-wiring.cjs
node scripts/test-renderer-auth-wiring.cjs
npm test
npm run build
```

All pass → commit `feat: integrate ai review and matrix into app`

---

### Task 7: Desktop verification + spec status

**Files:**
- Verify: runtime behavior
- Modify: `docs/superpowers/specs/2026-08-30-ai-review-and-literature-matrix.md` status line

- [ ] **Step 1: Rebuild native + launch**

```bash
npx @electron/rebuild -f -w better-sqlite3
./node_modules/.bin/electron . --user-data-dir="$(mktemp -d)" --remote-debugging-port=9444
```

Via CDP evaluate (same pattern as previous tasks):

1. `desktopApi.ai.getConfig()` returns `{baseUrl:'',model:'',temperature:0.4,hasKey:false}` (or saved shape)
2. Matrix export path: call renderer `buildLiteratureMatrix` equivalent via UI-less check if wired through TS lib; otherwise simulate click via DOM (`生成综述` menu item exists in 更多 dropdown DOM? Menu renders on open — assert via React tree is hard; accept DOM/menu click test optional, fallback: assert no console errors on load and review drawer opens via `activeDrawer` through UI click simulation with `document.querySelector` after opening 更多 menu).
3. AI generate without config → error event surfaces (drawer shows 未配置提示 / button disabled).
4. Matrix save writes file (mock dialog? no — assert `saveMarkdown` invoked is hard; skip file-write assert, manual step for user).

Minimum automated evidence: app boots, `ai:get-config` returns shape, no load errors, DevTools absent.

- [ ] **Step 2: Manual items to hand to user**

- 配置真实服务 → 测试连接 → 生成一次综述 → 另存
- 文献矩阵导出粘贴 Excel
- key 文件确认密文（`ai-config.json` 无明文 sk-）

- [ ] **Step 3: Spec status**

Set `状态：已实现` only after automated steps pass.

- [ ] **Step 4: Commit** — `docs: mark ai review feature implemented`

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| Digest truncation limits + grouping | 1 |
| Matrix format + escaping + footer | 2 |
| safeStorage config, hasKey-only exposure, decrypt-fail | 3 |
| baseUrl https/localhost rule | 3 |
| SSE parse + [DONE] + junk tolerance | 3 |
| 120s timeout / 429 / abort semantics | 3 (timeout via AbortSignal in stream TODO: add `AbortSignal.timeout(120000)` race in generateReviewStream — **must** be present) |
| ai:* IPC + chunk/done/error events | 4 |
| ReviewDrawer preview/stream/edit/save + cancel | 5 |
| AiSettings + test connection | 5 |
| activeDrawer 'review' + menu entries + quality drawer buttons | 6 |
| Matrix export uses filtered papers | 6 |
| Empty filter guard | 6 |
| Desktop verification + DevTools guard | 7 |

## Placeholder scan

No TBD. Two execution-time decision points are explicit (matrix .cjs import fallback → TS duplicate; timeout race must be included in Task 3 implementation).

## Type consistency

- `desktopApi.ai`: getConfig/saveConfig/testConnection/generateReview(messages)/cancelReview/onChunk/onDone/onError
- Events: `ai:review-chunk`(string) / `ai:review-done`({full,stopped}) / `ai:review-error`({message})
- ActiveDrawer: `'quality' | 'account' | 'review' | null`
- Digest shape: `{ totalCount, selectedCount, truncated, groups: [{ tag, papers: [...] }] }`

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-ai-review-literature-matrix.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review
2. **Inline Execution** — this session, task by task

Which approach?
