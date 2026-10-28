require('./lib/probe-guard.cjs');

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

// Focus visibility, measured instead of assumed. Two automation traps make the
// obvious approaches lie in a hidden window: (1) a window that never takes focus
// has document.hasFocus() === false, so Chromium never matches :focus-visible —
// synthetic Tab then reports "no ring" for every control; (2) the composer draws
// its focus state on an ancestor (:focus-within), so looking only at the focused
// element reports "no ring" for a control that is visibly focused. So: emulate
// page focus over CDP, focus each control with focusVisible:true, and compare a
// style signature that includes the focused element and its ancestors. If focus
// cannot be emulated, the phase is reported as not automatable instead of
// asserting on a value that means nothing.
const FOCUS_JS = `(() => {
  const visible = (element) => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const describe = (element) => {
    const classes = typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const label = element.getAttribute('aria-label');
    return (element.tagName.toLowerCase() + classes + (label ? '[' + label.slice(0, 16) + ']' : '')).slice(0, 44);
  };
  const signature = (element) => {
    const parts = [];
    let node = element;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth += 1) {
      const style = getComputedStyle(node);
      parts.push([style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow, style.borderTopColor, style.borderTopWidth, style.backgroundColor].join('|'));
      node = node.parentElement;
    }
    return parts.join('##');
  };
  const stops = [];
  for (const element of document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')) {
    if (element.disabled || element.tabIndex < 0 || !visible(element)) continue;
    if (document.activeElement && document.activeElement !== element) document.activeElement.blur();
    const before = signature(element);
    element.focus({ focusVisible: true, preventScroll: true });
    const after = signature(element);
    stops.push({ selector: describe(element), focusVisible: element.matches(':focus-visible'), ring: after !== before });
  }
  if (document.activeElement) document.activeElement.blur();
  return { hasFocus: document.hasFocus(), stops };
})()`;

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
      // Geometry is compared with the reading area at scroll top, so "the column
      // starts at the top of its scroll area" is a statement about layout and not
      // about how far a previous scenario happened to leave it scrolled.
      const streamElement = document.querySelector('.stream');
      if (streamElement) streamElement.scrollTop = 0;
      const main = rect('.main');
      const composer = rect('.composer');
      const stream = document.querySelector('.stream-inner') ? rect('.stream-inner') : null;
      const buttons = [...document.querySelectorAll('.composer-bar button')].map(element => { const box = element.getBoundingClientRect(); return { title: element.title, left: box.left, right: box.right, top: box.top, bottom: box.bottom }; });
      const styles = (selector) => { const style = getComputedStyle(document.querySelector(selector)); return { background: style.background, color: style.color, border: style.borderColor }; };
      const rail = document.querySelector('.rail');
      const scroller = streamElement ? rect('.stream') : null;
      return { main, composer, stream, scroller, buttons, rail: styles('.rail'), activeSession: styles('.rail-convo.active'), newChat: styles('.rail-primary-new'), model: styles('.composer-model'), railOverflow: rail.scrollWidth > rail.clientWidth + 1, streamOverflow: streamElement.scrollWidth > streamElement.clientWidth + 1, streamFits: streamElement.scrollHeight <= streamElement.clientHeight + 1, bodyOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
    })()`);
    const failures = [];
    if (report.bodyOverflow) failures.push('page overflows');
    if (report.railOverflow) failures.push('rail overflows horizontally');
    if (report.streamOverflow) failures.push('stream overflows horizontally');
    if (report.composer.right > report.main.right + 1 || report.composer.x < report.main.x) failures.push('composer outside main');
    if (report.composer.bottom > height + 1) failures.push('composer below window');
    if (report.stream && Math.abs(report.stream.x - report.composer.x) > 6) failures.push('reading column and composer are misaligned');
    // Vertical containment: the scroll area stays inside main and above the
    // composer, the reading column stays inside its scroll area, and while the
    // content still fits the column cannot reach under the composer.
    if (report.scroller) {
      if (report.scroller.y < report.main.y - 1) failures.push('reading area starts above main');
      if (report.scroller.bottom > report.composer.y + 1) failures.push('reading area overlaps composer');
      if (report.scroller.bottom > report.main.bottom + 1) failures.push('reading area runs past main');
    }
    if (report.stream && report.scroller) {
      if (report.stream.y < report.scroller.y - 1) failures.push('reading column starts above its scroll area');
      if (report.stream.x < report.scroller.x - 1 || report.stream.right > report.scroller.right + 1) failures.push('reading column escapes its scroll area');
      if (report.streamFits && report.stream.bottom > report.composer.y + 1) failures.push('reading column extends under composer');
    }
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

  if (!process.argv.includes('--workflows-only')) {
    window.setContentSize(1280, 860);
    await evaluate('document.documentElement.dataset.theme = "light"; window.uiPreview.scenario("conversation"); document.querySelector(".chat-shell").style.setProperty("--panel-w", "0px");');
    await settle();
    let emulated = false;
    try {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      emulated = true;
    } catch (error) { log(`focus emulation unavailable: ${error.message}`); }
    await settle();
    const probe = await evaluate(FOCUS_JS);
    if (emulated) { try { window.webContents.debugger.detach(); } catch (error) { log(`debugger detach: ${error.message}`); } }
    const focusFailures = [];
    const ringless = probe.stops.filter((stop) => !stop.focusVisible || !stop.ring);
    if (!probe.hasFocus) {
      // Recorded, explicitly excluded from the assertions: with no page focus
      // Chromium cannot match :focus-visible, so a verdict here would be about
      // the harness, not the product.
      log('SKIP focus-visible: not automatable — the hidden window never takes document focus');
    } else {
      for (const stop of ringless) focusFailures.push(`${stop.selector} shows no focus indicator`);
    }
    reports.push({ name: 'focus-visible', hasFocus: probe.hasFocus, automatable: probe.hasFocus, stops: probe.stops, failures: focusFailures });
    if (probe.hasFocus) log(`${focusFailures.length ? 'FAIL' : 'PASS'} focus-visible: ${probe.stops.length} stops, ${ringless.length} without a visible indicator`);
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
