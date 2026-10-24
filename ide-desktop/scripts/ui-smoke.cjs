const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'ui-review');
fs.mkdirSync(output, { recursive: true });
const logPath = path.join(output, 'runner.log');
fs.writeFileSync(logPath, 'Starting isolated Electron UI review\n');
const log = (message) => { fs.appendFileSync(logPath, `${message}\n`); console.log(message); };
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const observe = process.argv.includes('--observe');
let server;
let window;

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

app.whenReady().then(async () => {
  log('Electron ready');
  const { createServer } = require('vite');
  const previewPlugin = { name: 'ui-review-page', configureServer(vite) {
    vite.middlewares.use('/__ui-review', async (_request, response, next) => {
    try {
      const html = await vite.transformIndexHtml('/__ui-review', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/ui-preview.tsx"></script></body></html>');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
    } catch (error) { next(error); }
    });
  } };
  server = await createServer({ root, plugins: [previewPlugin], server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  log('Preview server listening');
  const port = server.httpServer.address().port;
  window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'ui-review' } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) { errors.push(message); log(`Renderer error: ${message}`); } });
  log('Loading real UI components');
  await window.loadURL(`http://127.0.0.1:${port}/__ui-review`);
  await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  for (let index = 0; index < 300; index += 1) {
    if (await evaluate('document.documentElement.dataset.previewReady === "true"')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate('document.documentElement.dataset.previewReady'), 'true', errors.join('\n'));
  const reports = [];
  const cases = [
    ['light-empty', 1440, 960, 'light', 'empty', false],
    ['light-conversation', 1440, 960, 'light', 'conversation', false],
    ['dark-running', 1280, 860, 'dark', 'running', false],
    ['narrow-conversation', 1100, 720, 'light', 'conversation', false],
    ['narrow-panel', 1100, 720, 'dark', 'conversation', true],
    ['light-approval', 1280, 860, 'light', 'approval', false],
    ['dark-failure', 1280, 860, 'dark', 'failure', false],
    ['large-type-panel', 1100, 720, 'light', 'conversation', true],
    ['light-tool-failure', 1280, 860, 'light', 'tool-failure', false],
    ['dark-tool-failure', 1280, 860, 'dark', 'tool-failure', false],
    ['narrow-changes', 1100, 720, 'light', 'changes', true],
  ];
  for (const [name, width, height, theme, scenario, panel] of (process.argv.includes('--workflows-only') ? [] : cases)) {
    window.setContentSize(width, height);
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.uiPreview.scenario(${JSON.stringify(scenario)}); document.querySelector('.chat-shell').style.setProperty('--panel-w', ${JSON.stringify(panel ? '380px' : '0px')});`);
    await evaluate(`document.documentElement.style.setProperty('--fs-base', '${name === 'large-type-panel' ? 18 : 14}px')`);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 160));
    const report = await evaluate(`(() => {
      const rect = (selector) => { const element = document.querySelector(selector); const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
      const main = rect('.main');
      const composer = rect('.composer');
      const stream = document.querySelector('.stream-inner') ? rect('.stream-inner') : null;
      const buttons = [...document.querySelectorAll('.composer-bar button')].map(element => { const box = element.getBoundingClientRect(); return { title: element.title, left: box.left, right: box.right, top: box.top, bottom: box.bottom }; });
      const styles = (selector) => { const style = getComputedStyle(document.querySelector(selector)); return { background: style.background, color: style.color, border: style.borderColor }; };
      const rail = document.querySelector('.rail');
      const streamElement = document.querySelector('.stream');
      return { main, composer, stream, buttons, rail: styles('.rail'), activeSession: styles('.rail-convo.active'), newChat: styles('.rail-primary-new'), model: styles('.composer-model'), railOverflow: rail.scrollWidth > rail.clientWidth + 1, streamOverflow: streamElement.scrollWidth > streamElement.clientWidth + 1, bodyOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, focusVisible: !!document.querySelector(':focus-visible') };
    })()`);
    const failures = [];
    if (report.bodyOverflow) failures.push('page overflows');
    if (report.railOverflow) failures.push('rail overflows horizontally');
    if (report.streamOverflow) failures.push('stream overflows horizontally');
    if (report.composer.right > report.main.right + 1 || report.composer.x < report.main.x) failures.push('composer outside main');
    if (report.composer.bottom > height + 1) failures.push('composer below window');
    if (report.stream && Math.abs(report.stream.x - report.composer.x) > 6) failures.push('reading column and composer are misaligned');
    for (const button of report.buttons) if (button.right > report.composer.right + 1 || button.left < report.composer.x - 1) failures.push(`${button.title} outside composer`);
    for (let index = 1; index < report.buttons.length; index += 1) {
      const previous = report.buttons[index - 1];
      const current = report.buttons[index];
      if (current.left < previous.right - 1 && current.top < previous.bottom && current.bottom > previous.top) failures.push(`${current.title} overlaps ${previous.title}`);
    }
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, `${observe ? 'before-' : ''}${name}.png`), image.toPNG());
    reports.push({ name, ...report, failures });
    log(`${failures.length ? 'FAIL' : 'PASS'} ${name}: ${failures.join(', ') || 'layout contained'}`);
  }
  fs.writeFileSync(path.join(output, `${observe ? 'before-' : ''}layout.json`), JSON.stringify({ reports, errors }, null, 2));
  if (process.argv.includes('--workflows-only')) {
    await require('./ui-workflow-checks.cjs')({ window, evaluate, settle, output });
    log('PASS isolated session and execution workflows');
  } else if (!observe) {
    await evaluate('window.uiPreview.clear(); window.uiPreview.scenario("empty"); document.documentElement.dataset.theme = "light";');
    await settle();
    await evaluate('document.querySelector(".chat-welcome-chip").click()');
    await settle();
    assert.equal(await evaluate('document.querySelector("textarea").value'), '梳理这个项目的结构', 'suggestion fills composer');
    assert.equal(await evaluate('document.activeElement === document.querySelector("textarea")'), true, 'suggestion focuses composer');
    assert.equal(await evaluate('window.uiPreview.events().some(event => event.type === "submit")'), false, 'suggestion must not submit');
    await evaluate('document.querySelector("textarea").focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await settle();
    assert.equal(await evaluate('window.uiPreview.events().filter(event => event.type === "submit").at(-1).value'), '梳理这个项目的结构', 'Enter submits actual draft');
    assert.equal(await evaluate('document.querySelector("textarea").value'), '', 'draft clears after submit');
    await evaluate('window.uiPreview.draft("第一行");');
    await settle();
    await evaluate('document.querySelector("textarea").focus(); document.querySelector("textarea").setSelectionRange(3, 3)');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
    await settle();
    assert.equal(await evaluate('document.querySelector("textarea").value.includes("\\n")'), true, 'Shift+Enter inserts newline');
    await evaluate('window.uiPreview.draft(Array.from({length: 14}, (_, index) => `第 ${index + 1} 行需求`).join("\\n"));');
    await settle();
    const draftSize = await evaluate('({height: document.querySelector("textarea").clientHeight, scrollHeight: document.querySelector("textarea").scrollHeight})');
    assert.ok(draftSize.height >= 160 && draftSize.height <= 180 && draftSize.scrollHeight > draftSize.height, 'long draft grows then scrolls');
    const submitsBeforeComposition = await evaluate('window.uiPreview.events().filter(event => event.type === "submit").length');
    await evaluate('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true }))');
    await settle();
    assert.equal(await evaluate('window.uiPreview.events().filter(event => event.type === "submit").length'), submitsBeforeComposition, 'IME confirmation does not submit');
    await evaluate('document.querySelector(".composer-model").click()');
    await settle();
    assert.equal(await evaluate('!!document.querySelector(".model-menu")'), true, 'model selector opens');
    await evaluate('document.querySelector(".composer-model").click(); window.uiPreview.scenario("running");');
    await settle();
    await evaluate('document.querySelector(".composer-stop").click()');
    await settle();
    assert.equal(await evaluate('window.uiPreview.events().some(event => event.type === "stop")'), true, 'stop remains reachable');
    await evaluate('window.uiPreview.scenario("approval")');
    await settle();
    await evaluate('document.querySelector(".approval-btn.deny").click()');
    await settle();
    assert.equal(await evaluate('window.uiPreview.events().some(event => event.type === "approval" && event.value.decision === "deny")'), true, 'approval denial remains reachable');
    await evaluate('window.uiPreview.scenario("conversation"); window.uiPreview.draft("快捷键检查"); window.uiPreview.sendShortcut("mod-enter")');
    await settle();
    const beforeModEnter = await evaluate('window.uiPreview.events().filter(event => event.type === "submit").length');
    await evaluate('document.querySelector("textarea").focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await settle();
    assert.equal(await evaluate('window.uiPreview.events().filter(event => event.type === "submit").length'), beforeModEnter, 'Enter does not submit in Ctrl+Enter mode');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await settle();
    assert.equal(await evaluate('window.uiPreview.events().filter(event => event.type === "submit").length'), beforeModEnter + 1, 'Ctrl+Enter submits in configured mode');
    for (const [button, menu] of [['.composer-model', '.model-menu'], ['.composer-access', '.thinking-menu'], ['.composer-context', '.context-menu']]) {
      await evaluate(`document.querySelector(${JSON.stringify(button)}).click()`);
      await settle();
      const bounds = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(menu)}).getBoundingClientRect(); const main = document.querySelector('.main').getBoundingClientRect(); return { x: rect.x, right: rect.right, top: rect.top, mainX: main.x, mainRight: main.right }; })()`);
      assert.ok(bounds.x >= bounds.mainX && bounds.right <= bounds.mainRight && bounds.top >= 0, `${menu} fits narrow main pane`);
      fs.writeFileSync(path.join(output, `narrow${menu}.png`), (await window.webContents.capturePage()).toPNG());
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await settle();
      assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(menu)})`), false, `${menu} closes with Escape`);
    }
    log('PASS interactions: prefill and focus, Enter, Shift+Enter, draft growth, IME, model menu, stop, deny, Ctrl+Enter, narrow menus, Escape');
    await require('./ui-workflow-checks.cjs')({ window, evaluate, settle, output });
    log('PASS workflows: session selection, menu keyboard navigation, IME, Escape focus, outside click, step details, file keyboard activation, undo callback, failure state');
  }
  fs.writeFileSync(path.join(output, `${observe ? 'before-' : ''}layout.json`), JSON.stringify({ reports, errors }, null, 2));
  if (!observe) {
    assert.deepEqual(errors, [], 'renderer errors');
    assert.deepEqual(reports.flatMap((report) => report.failures.map((failure) => `${report.name}: ${failure}`)), [], 'layout checks');
  }
  log(`UI review saved to ${output}`);
}).catch((error) => { log(error.stack || String(error)); process.exitCode = 1; }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await server.close();
  app.exit(process.exitCode || 0);
});
