const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const svc = require('../electron/ai-service.cjs');

const goodCodec = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from('enc:' + plain, 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^enc:/, ''),
});

const tmpDirs = [];
const makeTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ai-'));
  tmpDirs.push(dir);
  return dir;
};

function testValidateBaseUrl() {
  assert.equal(svc.validateBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.ok(svc.validateBaseUrl('http://localhost:11434/v1'));
  assert.ok(svc.validateBaseUrl('http://127.0.0.1:8080/v1'));
  assert.throws(() => svc.validateBaseUrl('http://api.example.com/v1'), /https/);
  assert.throws(() => svc.validateBaseUrl('ftp://files.example.com'), /https/);
  assert.throws(() => svc.validateBaseUrl(''), /必填/);
  assert.throws(() => svc.validateBaseUrl('   '), /必填/);
  assert.throws(() => svc.validateBaseUrl('not a url'), /解析/);
}

function testConfigRoundtrip() {
  const dir = makeTmp();
  svc.configureAiService({ userDataPath: dir, safeStorageApi: goodCodec() });

  const noUrl = svc.saveConfig({ baseUrl: '', model: 'm', apiKey: 'k' });
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.error, /必填/);
  const noModel = svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: '', apiKey: 'k' });
  assert.equal(noModel.ok, false);
  assert.match(noModel.error, /必填/);
  const badUrl = svc.saveConfig({ baseUrl: 'http://api.example.com/v1', model: 'm', apiKey: 'k' });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.error, /https/);

  const saved = svc.saveConfig({
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-test',
    apiKey: 'sk-plain-123',
    temperature: 0.7,
  });
  assert.deepEqual(saved, { ok: true });

  const pub = svc.getPublicConfig();
  assert.equal(pub.hasKey, true);
  assert.equal(pub.model, 'gpt-test');
  assert.equal(pub.temperature, 0.7);
  assert.equal('apiKey' in pub, false);
  assert.equal('apiKeyCipher' in pub, false);

  const raw = fs.readFileSync(path.join(dir, 'ai-config.json'), 'utf8');
  assert.ok(!raw.includes('sk-plain-123'), 'raw config file must not contain plaintext key');
  assert.match(raw, /"apiKeyCipher"/);

  svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: '' });
  assert.equal(svc.getPublicConfig().hasKey, false, "apiKey '' must clear stored key");
}

function testEncryptionUnavailable() {
  const unavailable = { ...goodCodec(), isEncryptionAvailable: () => false };
  svc.configureAiService({ userDataPath: makeTmp(), safeStorageApi: unavailable });
  const refused = svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /系统不支持密钥加密存储/);

  svc.configureAiService({ userDataPath: makeTmp(), safeStorageApi: null });
  const noApi = svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' });
  assert.equal(noApi.ok, false);
  assert.match(noApi.error, /系统不支持密钥加密存储/);
}

function testDecryptFailure() {
  const dir = makeTmp();
  svc.configureAiService({ userDataPath: dir, safeStorageApi: goodCodec() });
  assert.deepEqual(
    svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-x' }),
    { ok: true },
  );
  assert.equal(svc.getPublicConfig().hasKey, true);

  const brokenCodec = {
    isEncryptionAvailable: () => true,
    encryptString: goodCodec().encryptString,
    decryptString: () => {
      throw new Error('keyring changed');
    },
  };
  svc.configureAiService({ userDataPath: dir, safeStorageApi: brokenCodec });
  assert.equal(svc.getPublicConfig().hasKey, false, 'decrypt failure must read as unconfigured');
}

function testSseParser() {
  const stream = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\n'
    + ': keep-alive\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\n'
    + 'data: [DONE]\n\n';
  let joined = '';
  for (const piece of svc.parseSseStream(stream)) joined += piece;
  assert.equal(joined, 'Hello');

  const malformed = 'data: {oops\n\n'
    + 'data: {"choices":[{"delta":{"content":"A"}}]}\n\n'
    + 'data: 42\n\n'
    + 'data: [DONE]\n\n'
    + 'data: {"choices":[{"delta":{"content":"X"}}]}\n\n';
  let joined2 = '';
  for (const piece of svc.parseSseStream(malformed)) joined2 += piece;
  assert.equal(joined2, 'A', 'malformed JSON must be skipped and [DONE] must stop the stream');
}

function testTemperatureClamp() {
  svc.configureAiService({ userDataPath: makeTmp(), safeStorageApi: goodCodec() });
  svc.saveConfig({ baseUrl: 'https://a.com/v1', model: 'm', apiKey: 'k', temperature: 5 });
  assert.equal(svc.getPublicConfig().temperature, 2);
  svc.saveConfig({ baseUrl: 'https://a.com/v1', model: 'm', apiKey: 'k', temperature: -1 });
  assert.equal(svc.getPublicConfig().temperature, 0);
  svc.saveConfig({ baseUrl: 'https://a.com/v1', model: 'm', apiKey: 'k' });
  assert.equal(svc.getPublicConfig().temperature, 0.4, 'missing temperature defaults to 0.4');
}

async function testUnconfiguredConnection() {
  svc.configureAiService({ userDataPath: makeTmp(), safeStorageApi: goodCodec() });
  const res = await svc.testConnection();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'AI 服务尚未配置完整');

  svc.resetAiService();
  assert.deepEqual(svc.getPublicConfig(), { baseUrl: '', model: '', temperature: 0.4, hasKey: false });
  const res2 = await svc.testConnection();
  assert.equal(res2.ok, false);
  assert.equal(res2.error, 'AI 服务尚未配置完整');
}

async function testStreaming() {
  const dir = makeTmp();
  const events = [
    'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
    ': keep-alive\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let seenUrl = '';
  let seenInit = null;
  const fakeFetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return {
      ok: true,
      status: 200,
      body: (async function* generate() {
        for (const event of events) yield Buffer.from(event, 'utf8');
      })(),
    };
  };
  svc.configureAiService({ userDataPath: dir, safeStorageApi: goodCodec(), fetchImpl: fakeFetch });
  assert.deepEqual(
    svc.saveConfig({ baseUrl: 'https://api.example.com/v1/', model: 'gpt-test', apiKey: 'sk-x', temperature: 0.6 }),
    { ok: true },
  );

  assert.equal(svc.cancelReview(), false, 'cancel with no in-flight stream returns false');

  const deltas = [];
  let doneInfo = null;
  let errorInfo = null;
  const result = await svc.generateReviewStream({
    messages: [{ role: 'user', content: '写综述' }],
    onDelta: (piece) => deltas.push(piece),
    onDone: (text, meta) => { doneInfo = { text, meta }; },
    onError: (message) => { errorInfo = message; },
  });
  assert.equal(result.ok, true);
  assert.equal(errorInfo, null);
  assert.deepEqual(deltas, ['He', 'llo']);
  assert.equal(doneInfo.text, 'Hello');
  assert.deepEqual(doneInfo.meta, { stopped: false });
  assert.equal(result.text, 'Hello');

  assert.equal(seenUrl, 'https://api.example.com/v1/chat/completions');
  assert.ok(seenInit.signal instanceof AbortSignal);
  assert.equal(seenInit.headers.Authorization, 'Bearer sk-x');
  const sentBody = JSON.parse(seenInit.body);
  assert.equal(sentBody.stream, true);
  assert.equal(sentBody.model, 'gpt-test');
  assert.equal(sentBody.temperature, 0.6);
  assert.deepEqual(sentBody.messages, [{ role: 'user', content: '写综述' }]);

  assert.equal(svc.cancelReview(), false, 'finished stream is no longer in flight');
}

async function testCancelMidStream() {
  const dir = makeTmp();
  const fakeFetchBlocking = async (url, init) => ({
    ok: true,
    status: 200,
    body: (async function* generate() {
      yield Buffer.from('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
      await new Promise((resolve) => {
        if (init.signal.aborted) return resolve();
        init.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    })(),
  });
  svc.configureAiService({ userDataPath: dir, safeStorageApi: goodCodec(), fetchImpl: fakeFetchBlocking });
  assert.deepEqual(
    svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }),
    { ok: true },
  );

  let resolveFirstDelta;
  const firstDelta = new Promise((resolve) => { resolveFirstDelta = resolve; });
  let resolveDone;
  const donePromise = new Promise((resolve) => { resolveDone = resolve; });
  const deltas = [];
  const generating = svc.generateReviewStream({
    messages: [{ role: 'user', content: '写综述' }],
    onDelta: (piece) => { deltas.push(piece); resolveFirstDelta(); },
    onDone: (text, meta) => resolveDone({ text, meta }),
    onError: (message) => resolveDone({ error: message }),
  });

  await firstDelta;
  assert.equal(svc.cancelReview(), true, 'cancelReview aborts the in-flight stream');
  const done = await donePromise;
  await generating;

  assert.deepEqual(deltas, ['部分']);
  assert.equal(done.text, '部分');
  assert.deepEqual(done.meta, { stopped: true });
}

async function testStreamTimeout() {
  const dir = makeTmp();
  const fakeFetchStalled = async (url, init) => ({
    ok: true,
    status: 200,
    body: (async function* generate() {
      yield Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      await new Promise((resolve) => {
        if (init.signal.aborted) return resolve();
        init.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    })(),
  });
  svc.configureAiService({
    userDataPath: dir,
    safeStorageApi: goodCodec(),
    fetchImpl: fakeFetchStalled,
    streamTimeoutMs: 50,
  });
  assert.deepEqual(
    svc.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }),
    { ok: true },
  );

  // AbortSignal.timeout 的定时器是 unref 的：裸 Node 进程需手动保活事件循环，
  // Electron 主进程里 socket 等句柄天然保活，无此问题。
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    let resolveDone;
    const donePromise = new Promise((resolve) => { resolveDone = resolve; });
    const deltas = [];
    const generating = svc.generateReviewStream({
      messages: [{ role: 'user', content: '写综述' }],
      onDelta: (piece) => deltas.push(piece),
      onDone: (text, meta) => resolveDone({ text, meta }),
      onError: (message) => resolveDone({ error: message }),
    });
    const done = await donePromise;
    await generating;

    assert.deepEqual(deltas, ['a']);
    assert.equal(done.text, 'a', 'timeout keeps already received content');
    assert.deepEqual(done.meta, { stopped: true });
    assert.equal(svc.cancelReview(), false);
  } finally {
    clearTimeout(keepAlive);
  }
}

async function main() {
  try {
    testValidateBaseUrl();
    testConfigRoundtrip();
    testEncryptionUnavailable();
    testDecryptFailure();
    testSseParser();
    testTemperatureClamp();
    await testUnconfiguredConnection();
    await testStreaming();
    await testCancelMidStream();
    await testStreamTimeout();
    svc.resetAiService();
    console.log('ai service tests passed');
  } finally {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
