'use strict';
require('./lib/probe-guard.cjs');

// 对话流式渲染的测量台：跑真实 ConversationStream + 真实 reducer，按真实 CLI
// bridge 实测到的节奏（约 31ms 一个 delta）推流式事件，量出每帧渲染/布局开销、
// 长任务和 DOM 规模。改前改后跑同一个脚本，数字可比。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'conversation-stream');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let previewWindow;
const errors = [];
const evaluate = (expression) => previewWindow.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function waitFor(expression, name) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${name}`);
}
async function capture(name) {
  const image = await new Promise((resolve, reject) => {
    const onPaint = (_event, _rect, frame) => { clearTimeout(timeout); resolve(frame); };
    const timeout = setTimeout(() => { previewWindow.webContents.removeListener('paint', onPaint); reject(new Error('No fresh screenshot frame')); }, 4000);
    previewWindow.webContents.once('paint', onPaint);
    previewWindow.webContents.invalidate();
  });
  fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
}

// 24 轮历史 = 72 条气泡，60 轮 = 180 条，覆盖「刚开对话」和「翻旧账」两种体量。
const CASES = [
  { name: 'history-24', turns: 24, deltas: 60 },
  { name: 'history-60', turns: 60, deltas: 60 },
];

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const plugin = {
    name: 'conversation-review-page',
    configureServer(vite) {
      vite.middlewares.use('/__conversation-review', async (_request, response, next) => {
        try {
          const html = await vite.transformIndexHtml('/__conversation-review', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/conversation-preview.tsx"></script></body></html>');
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
  server = await createServer({ root, cacheDir: path.join(output, 'vite'), plugins: [plugin], server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
  await server.listen();
  previewWindow = new BrowserWindow({
    show: false, width: 1440, height: 960,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true, partition: 'conversation-review' },
  });
  previewWindow.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await previewWindow.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__conversation-review`);
  await waitFor('document.documentElement.dataset.conversationPreviewReady === "true"', 'conversation preview');

  const results = [];
  for (const testCase of CASES) {
    await evaluate(`window.conversationPreview.reset(${testCase.turns})`);
    await settle();
    const metrics = await evaluate(`window.conversationPreview.stream({ deltas: ${testCase.deltas}, gapMs: 31 })`);
    results.push({ case: testCase.name, turns: testCase.turns, ...metrics });
    console.log(`\n--- ${testCase.name} ---`);
    console.log(` 历史行数 ${metrics.rows} / DOM 节点 ${metrics.domNodes}`);
    console.log(` 每次 delta 渲染 中位 ${metrics.renderMedian}ms  P95 ${metrics.renderP95}ms  最大 ${metrics.renderMax}ms  合计 ${metrics.renderTotal}ms`);
    console.log(` 布局 中位 ${metrics.layoutMedian}ms  P95 ${metrics.layoutP95}ms`);
    console.log(` 长任务 ${metrics.longTasks.length} 个，合计 ${metrics.longTaskTotal}ms`);
    console.log(` 流式气泡字数 ${metrics.streamingTextLength}`);
  }
  await capture('streaming');

  // 流式期间的表现必须可测：气泡真的在长，且没有把主线程占死。
  // 前 5 个 delta 包含流式气泡的首次挂载（第一次把 markdown 块建进 DOM），
  // 是一次性开销，单独报告，不混进稳态预算——否则测量的就只是挂载那一下。
  const MOUNT_DELTAS = 5;
  const measured = results.map((item) => {
    const steady = item.renderSeries.slice(MOUNT_DELTAS).sort((left, right) => left - right);
    const pick = (ratio) => steady[Math.min(steady.length - 1, Math.floor(steady.length * ratio))] ?? 0;
    return {
      ...item,
      mountMs: Math.max(...item.renderSeries.slice(0, MOUNT_DELTAS)),
      steadyP95: pick(0.95),
      steadyMax: steady[steady.length - 1] ?? 0,
      steadyTotal: Math.round(steady.reduce((sum, value) => sum + value, 0)),
    };
  });
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ results: measured, errors }, null, 2));
  for (const item of measured) {
    console.log(` 稳态：P95 ${item.steadyP95}ms / 最大 ${item.steadyMax}ms / 合计 ${item.steadyTotal}ms；气泡挂载 ${item.mountMs}ms`);
  }
  const worst = measured.reduce((worstSoFar, item) => (item.steadyP95 > worstSoFar.steadyP95 ? item : worstSoFar), measured[0]);
  assert.ok(measured.every((item) => item.streamingTextLength > 200), '流式气泡必须真的累积了文字');
  assert.ok(measured.every((item) => item.mountMs < 60), `气泡挂载必须在 60ms 内（最差 ${Math.max(...measured.map((item) => item.mountMs))}ms）`);
  assert.ok(worst.steadyP95 < 12, `稳态单次 delta 渲染 P95 必须在 12ms 内（当前 ${worst.steadyP95}ms，${worst.case}）`);
  assert.ok(worst.steadyMax < 25, `稳态最坏一次必须在 25ms 内（当前 ${worst.steadyMax}ms，${worst.case}）`);
  assert.deepEqual(errors, [], 'renderer errors');

  console.log(`\nPASS 流式渲染在预算内（最差稳态 P95 ${worst.steadyP95}ms / 最大 ${worst.steadyMax}ms）`);
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
  if (server) await server.close();
  app.exit(process.exitCode || 0);
});
