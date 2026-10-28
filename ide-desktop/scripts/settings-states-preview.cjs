/*
 * Inner-state runner for the settings pages.
 *
 * `scripts/settings-preview.tsx` can render one named inner state per load
 * (`?state=<id>`); `scripts/settings-states-preview.tsx` defines them and drives
 * the page into that state with real DOM steps (a click, a keystroke, a typed
 * value) plus optional host-call patches (delay / reject / resolve). This script
 * is the other half: it loads every id in a hidden window, waits for the drive
 * to settle, and reads back `window.__previewStateReport` — the missing and
 * forbidden selectors, plus the text the state promised.
 *
 * Nothing here measures pixels. Contrast/name/font are `scripts/a11y-audit.cjs`
 * (`npm run a11y --page=settings`); this runner answers a different question:
 * does the state exist at all, and does it say what it claims to say.
 *
 * Usage:
 *   electron scripts/settings-states-preview.cjs
 *   electron scripts/settings-states-preview.cjs --list
 *   electron scripts/settings-states-preview.cjs --state=model-test-fail
 *   electron scripts/settings-states-preview.cjs --theme=dark --verbose
 *
 * Exit code 1 when a state fails (a missing selector, a forbidden one, wrong
 * text, a drive error, or a renderer exception). A state marked
 * `expectMissingIsFinding` is reported as FINDING instead: its point is that the
 * UI it looks for does not (or should not) exist, so it never fails the run.
 */

'use strict';

require('./lib/probe-guard.cjs');

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = argv.find((argument) => argument.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const verbose = flag('verbose');
const onlyState = option('state', null);
const theme = option('theme', 'light');
if (!['light', 'dark'].includes(theme)) {
  console.error(`unknown --theme=${theme}; want light or dark`);
  process.exit(2);
}

const outDir = path.resolve(root, option('out', path.join('out', 'settings-states')));
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'report.json');
const logPath = path.join(outDir, 'run.log');
fs.writeFileSync(logPath, '');
const log = (message) => { fs.appendFileSync(logPath, `${message}\n`); if (verbose) console.log(message); };

// A state's drive waits at most ~6s (a delay patch), the settle window adds a
// little; anything past this is a hung page, not a slow state.
const STATE_TIMEOUT_MS = 20000;

app.setPath('userData', path.join(outDir, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

let server;
let window;
let rendererErrors = [];

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const previewPlugin = {
    name: 'settings-states-page',
    configureServer(vite) {
      vite.middlewares.use('/__settings-states', async (request, response, next) => {
        try {
          const html = await vite.transformIndexHtml(
            '/__settings-states',
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/settings-preview.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  };

  server = await createServer({ root, plugins: [previewPlugin], server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const port = server.httpServer.address().port;
  log(`preview server on ${port}`);

  window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'settings-states' },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) rendererErrors.push(message);
  });

  const baseUrl = `http://127.0.0.1:${port}/__settings-states`;

  const waitReady = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate('document.documentElement.dataset.previewReady === "true"')) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  // The catalog is read from the fixture, not repeated here: one source of
  // truth, and a state that disappears from the fixture cannot linger in a list.
  rendererErrors = [];
  await window.loadURL(`${baseUrl}?theme=${theme}`);
  if (!await waitReady()) {
    console.error(`the fixture never painted. renderer errors:\n${rendererErrors.slice(0, 5).join('\n')}`);
    if (server) await server.close();
    app.exit(1);
    return;
  }
  const catalogue = await evaluate('window.__previewStates || []');
  const ids = catalogue.map((entry) => entry.id);
  const queryOf = new Map(catalogue.map((entry) => [entry.id, entry.query || '']));
  if (!ids.length) {
    console.error('window.__previewStates is empty — the fixture did not publish its catalogue');
    if (server) await server.close();
    app.exit(1);
    return;
  }
  log(`catalogue: ${ids.length} states`);
  if (flag('list')) {
    for (const id of ids) console.log(id);
    if (server) await server.close();
    app.exit(0);
    return;
  }

  const targets = onlyState ? ids.filter((id) => id === onlyState) : ids;
  if (!targets.length) {
    console.error(`unknown --state=${onlyState}; known: ${ids.join(', ')}`);
    if (server) await server.close();
    app.exit(2);
    return;
  }

  const results = [];
  for (const id of targets) {
    rendererErrors = [];
    const started = Date.now();
    let report = null;
    let failure = null;
    try {
      // A state that needs `scenario=empty` names it in `query`; it has to be in
      // the load URL because the fixture mock reads it at module evaluation.
      const extra = queryOf.get(id) ?? '';
      const search = [`state=${encodeURIComponent(id)}`, `theme=${theme}`, extra].filter(Boolean).join('&');
      await window.loadURL(`${baseUrl}?${search}`);
      const settled = await Promise.race([
        (async () => {
          for (let attempt = 0; attempt < STATE_TIMEOUT_MS / 100; attempt += 1) {
            const state = await evaluate('document.documentElement.dataset.previewState || ""');
            if (state === id) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return false;
        })(),
        new Promise((resolve) => setTimeout(() => resolve(false), STATE_TIMEOUT_MS)),
      ]);
      if (!settled) {
        failure = `drive never settled (waited ${STATE_TIMEOUT_MS}ms)`;
      } else {
        report = await evaluate('window.__previewStateReport || null');
        if (!report) failure = 'state published no report';
      }
    } catch (error) {
      failure = error && error.message ? error.message : String(error);
    }
    const ms = Date.now() - started;
    results.push({
      id,
      ms,
      failure,
      report,
      rendererErrors: [...new Set(rendererErrors)].slice(0, 4),
    });
    log(`${id}: ${failure ? `ERROR ${failure}` : 'settled'} in ${ms}ms`);
  }

  /* ── verdicts ────────────────────────────────────────────────────────────── */
  const rows = [];
  let failures = 0;
  let findings = 0;
  for (const result of results) {
    const report = result.report;
    const problems = [];
    if (result.failure) problems.push(result.failure);
    if (report) {
      for (const selector of report.missing ?? []) problems.push(`missing ${selector}`);
      for (const selector of report.forbidden ?? []) problems.push(`unexpected ${selector}`);
      for (const mismatch of report.textMismatch ?? []) problems.push(`${mismatch.selector} lacks text "${mismatch.expected}"`);
      for (const error of report.errors ?? []) problems.push(`drive error: ${error}`);
    }
    const isFinding = Boolean(report && report.expectMissingIsFinding);
    if (isFinding) findings += 1;
    else if (problems.length) failures += 1;
    rows.push({
      id: result.id,
      verdict: isFinding ? 'FINDING' : problems.length ? 'FAIL' : 'PASS',
      problems,
      ms: result.ms,
      rendererErrors: result.rendererErrors,
    });
  }

  const width = Math.max(...rows.map((row) => row.id.length), 4);
  console.log(`\n${'state'.padEnd(width)}  verdict  ms    detail`);
  console.log(`${'-'.repeat(width)}  -------  ----  ------`);
  for (const row of rows) {
    const detail = row.verdict === 'PASS' ? '' : row.problems.join('; ');
    console.log(`${row.id.padEnd(width)}  ${row.verdict.padEnd(7)}  ${String(row.ms).padStart(4)}  ${detail}`);
    for (const error of row.rendererErrors) {
      console.log(`${' '.repeat(width)}           renderer: ${error.split('\n')[0].slice(0, 160)}`);
    }
  }

  const passed = rows.filter((row) => row.verdict === 'PASS').length;
  console.log(`\n${passed}/${rows.length} states rendered as expected, ${findings} finding, ${failures} failed (${theme} theme)`);

  fs.writeFileSync(reportPath, `${JSON.stringify({ theme, ranAt: new Date().toISOString(), total: rows.length, passed, findings, failures, rows }, null, 2)}\n`);
  log(`report: ${reportPath}`);

  if (server) await server.close();
  window.destroy();
  app.exit(failures ? 1 : 0);
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
