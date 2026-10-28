/**
 * 电脑操控 panel — rendered and driven for real.
 *
 * What is asserted here is the part that only exists at runtime and that a
 * person would notice: reading a window must NOT act on it, acting must ask
 * first, and the tree must be re-read after an action instead of going stale.
 *
 * The bridge is stubbed (scripts/gui-panel-preview.tsx) because the point is
 * the panel's decisions. The tools themselves — real windows, real UIA — are
 * covered by cli/tests/computer-*.test.ts and by the CLI smoke in
 * scripts/gui-control-smoke.cjs.
 *
 * Run: npx electron scripts/gui-panel-smoke.cjs
 */
'use strict';
require('./lib/probe-guard.cjs');

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'gui-panel-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let window;

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const type = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const plugin = { name: 'gui-panel-page', configureServer(vite) {
    vite.middlewares.use('/__gui-panel', async (_request, response, next) => {
      try {
        // The panel is `height:100%` inside the app's `.main` grid, so the page
        // must give it the same definite height or the flex body collapses to
        // zero and the screenshot stops proving anything about the layout.
        const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%}</style></head><body><div id="root"></div><script type="module" src="/scripts/gui-panel-preview.tsx"></script></body></html>';
        const html = await vite.transformIndexHtml('/__gui-panel', page);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
      } catch (error) { next(error); }
    });
  } };
  server = await createServer({ root, plugins: [plugin], server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const port = server.httpServer.address().port;
  window = new BrowserWindow({
    show: false, width: 1180, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'gui-panel-review' },
  });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadURL(`http://127.0.0.1:${port}/__gui-panel`);
  await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  for (let i = 0; i < 200; i += 1) {
    if (await evaluate('!!document.querySelector(".gui-panel")')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await evaluate('!!document.querySelector(".gui-panel")'), true, 'panel rendered');

  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

  // 1. Mount lists windows and reads the first one's controls, without touching
  //    focus: computer_elements is a read, so no confirmation may appear.
  const initial = await evaluate('window.__guiCalls');
  check('mount lists windows', initial.some((c) => c.tool === 'computer_list_windows'), JSON.stringify(initial.map((c) => c.tool)));
  check('mount reads the selected window', initial.some((c) => c.tool === 'computer_elements' && c.input.window === '100'), JSON.stringify(initial.at(-1)));
  check('reading a window does not ask to steal focus', await evaluate('!document.querySelector(".gui-confirm")'));


  const windowRows = await evaluate(`document.querySelectorAll('.gui-window').length`);
  check('both windows are listed', windowRows === 2, `rows=${windowRows}`);
  const cloaked = await evaluate(`document.querySelectorAll('.gui-window.cloaked').length`);
  check('a window that is not on screen is marked', cloaked === 1, `cloaked=${cloaked}`);
  const monogram = await evaluate(`document.querySelector('.gui-window .gui-monogram').textContent`);
  check('each window carries a legible monogram', /^[A-Z0-9?]{1,2}$/.test(monogram), monogram);

  const elementRows = await evaluate(`document.querySelectorAll('.gui-element').length`);
  check('the selected window\'s controls are listed', elementRows === 4, `rows=${elementRows}`);
  const verbs = await evaluate(`[...document.querySelectorAll('.gui-element-action')].map(n => n.textContent)`);
  check('each control says what pressing it does', verbs.includes('点击') && verbs.includes('文本'), JSON.stringify(verbs));
  await type('.gui-launch-app input', 'tools/Fixture.exe');
  await evaluate('[...document.querySelectorAll(".gui-launch-app button")].find(b => b.textContent.includes("启动应用")).click()');
  await settle();
  const guiCallsAfterOpen = await evaluate('window.__guiCalls');
  const openCall = guiCallsAfterOpen.find((c) => c.tool === 'computer_open');
  const waitCall = guiCallsAfterOpen.find((c) => c.tool === 'computer_wait_window');
  check('native app launcher sends only the validated path', openCall?.input.path === 'tools/Fixture.exe', JSON.stringify(openCall));
  check('native app launcher waits for the returned PID before refreshing', waitCall?.input.window === '4242', JSON.stringify(waitCall));

  // 1b. Layout: the panel has to fill the view, not size to its content. A
  //     collapsed body puts both panes at the top of a blank page, which is
  //     what a `height:100%` outside a definite-height parent produces.
  const bodyHeight = await evaluate(`document.querySelector('.gui-body').getBoundingClientRect().height`);
  check('the two panes fill the height of the view', bodyHeight > 300, `h=${Math.round(bodyHeight)}`);
  const wrapped = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.gui-type-row button')][0];
    return button ? Math.round(button.getBoundingClientRect().height) : -1;
  })()`);
  check('a button label stays on one line', wrapped > 0 && wrapped <= 32, `h=${wrapped}`);

  // 2. Pressing a control asks first. Nothing is sent until the user confirms.
  const before = (await evaluate('window.__guiCalls')).length;
  await evaluate(`document.querySelectorAll('.gui-element')[0].click()`);
  await settle();
  const asked = await evaluate(`(() => { const node = document.querySelector('.gui-confirm'); return node ? node.textContent : null; })()`);
  check('pressing a control asks before acting', !!asked && asked.includes('notes.txt - Notepad') && asked.includes('文件'), String(asked));
  check('nothing is sent while the confirmation is open', (await evaluate('window.__guiCalls')).length === before);

  // 3. Cancelling really cancels.
  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '取消').click()`);
  await settle();
  check('cancelling sends nothing', (await evaluate('window.__guiCalls')).length === before);
  check('cancelling dismisses the question', await evaluate('!document.querySelector(".gui-confirm")'));

  // 4. Confirming sends the press with the expected name, then re-reads the tree.
  await evaluate(`document.querySelectorAll('.gui-element')[0].click()`);
  await settle();
  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '确认').click()`);
  await settle();
  const afterPress = await evaluate('window.__guiCalls');
  const press = afterPress.find((c) => c.tool === 'computer_press');
  check('confirming presses the control by index and expected name', press?.input.index === 2 && press?.input.expected === '文件', JSON.stringify(press));
  const reread = afterPress.filter((c) => c.tool === 'computer_elements').length;
  check('the tree is re-read after pressing', reread >= 2, `reads=${reread}`);
  const opened = await evaluate(`[...document.querySelectorAll('.gui-element-name')].map(n => n.textContent).join('|')`);
  check('the newly opened menu shows up', opened.includes('新建标签页'), opened);

  // 5. Typing asks too, and the text field clears only after it ran.
  await type('.gui-type-input', 'hello');
  await evaluate(`[...document.querySelectorAll('.gui-type-row button')][0].click()`);
  await settle();
  check('typing asks before taking focus', (await evaluate('!!document.querySelector(".gui-confirm")')));
  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '确认').click()`);
  await settle();
  const typed = (await evaluate('window.__guiCalls')).find((c) => c.tool === 'computer_type');
  check('confirming types the text into the selected window', typed?.input.text === 'hello' && typed?.input.window === '100', JSON.stringify(typed));
  check('the text field clears after typing', (await evaluate(`document.querySelector('.gui-type-input').value`)) === '');

  // 6. A refused focus change is reported, not swallowed and not retried.
  await evaluate(`[...document.querySelectorAll('.gui-detail-actions button')][0].click()`);
  await settle();
  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '确认').click()`);
  await settle();
  const failed = await evaluate(`document.querySelector('.gui-status.error')?.textContent ?? ''`);
  check('a refused activation is reported in the panel', failed.includes('did not take focus'), failed);

  // 7. 交给智能体 hands the window over without sending anything.
  await evaluate(`[...document.querySelectorAll('.gui-head-actions button')].find(b => b.textContent.includes('交给智能体')).click()`);
  await settle();
  const handoff = await evaluate('window.__guiAsked');
  check('the handoff names the window and its controls', handoff.length === 1 && handoff[0].includes('notes.txt - Notepad') && handoff[0].includes('computer_elements'), JSON.stringify(handoff));

  // 8. Capture path: with a window selected the panel captures THAT WINDOW in
  //    the background, not the desktop — a desktop grab would show whatever the
  //    user happens to be looking at instead of the app they picked.
  await evaluate(`[...document.querySelectorAll('.gui-head-actions button')].find(b => b.textContent.includes('截取窗口')).click()`);
  await settle();
  const shotCalls = (await evaluate('window.__guiCalls')).filter((c) => c.tool.startsWith('computer_') && c.tool.includes('shot'));
  check('capture targets the selected window, not the desktop',
    shotCalls.some((c) => c.tool === 'computer_window_shot' && c.input.window === '100') && !shotCalls.some((c) => c.tool === 'computer_screenshot'),
    JSON.stringify(shotCalls));
  const shotSrc = await evaluate(`document.querySelector('.gui-shot-image')?.getAttribute('src') ?? ''`);
  check('the capture is rendered from the tool result', shotSrc.startsWith('data:image/png;base64,'), shotSrc.slice(0, 32));

  // 9. The button label says which of the two it will do, so "capture" never
  //    silently means "send me their whole screen".
  const shotLabel = await evaluate(`[...document.querySelectorAll('.gui-head-actions button')].map(b => b.textContent).join('|')`);
  check('the capture button names its subject', shotLabel.includes('截取窗口'), shotLabel);

  // 10. The capture is bound to the window it came from. A click on the picture
  //     is sent as { screenshotId, x, y } in *image* pixels — the tool does the
  //     window-offset and scale conversion, so a moved or scaled window refuses
  //     instead of clicking the wrong place.
  for (let i = 0; i < 50 && !(await evaluate('!!document.querySelector(".gui-shot-image.clickable")')); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const shotMeta = await evaluate(`document.querySelector('.gui-shot-meta')?.textContent ?? ''`);
  check('the capture shows the id its clicks are bound to',
    shotMeta.includes('shot-9f8e7d6c') && shotMeta.includes('Shift+拖动'), shotMeta);

  const geometry = await evaluate(`(() => {
    const img = document.querySelector('.gui-shot-image.clickable');
    if (!img || !img.naturalWidth) return null;
    const box = img.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  })()`);
  check('the capture is rendered at its real size, ready to be clicked', !!geometry, JSON.stringify(geometry));

  const atX = geometry.left + geometry.width * 0.5;
  const atY = geometry.top + geometry.height * 0.25;
  const beforeClick = (await evaluate('window.__guiCalls')).length;
  await evaluate(`document.querySelector('.gui-shot-image.clickable').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${atX}, clientY: ${atY} }))`);
  await settle();
  const clickAsk = await evaluate(`document.querySelector('.gui-confirm')?.textContent ?? ''`);
  const askPoint = clickAsk.match(/(\d+)\s*,\s*(\d+)/);
  check('clicking the capture asks first, naming the app and the point',
    clickAsk.includes('notes.txt - Notepad')
      && !!askPoint && Math.abs(Number(askPoint[1]) - 400) <= 3 && Math.abs(Number(askPoint[2]) - 150) <= 3,
    clickAsk);
  check('nothing is clicked while the confirmation is open', (await evaluate('window.__guiCalls')).length === beforeClick);

  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '确认').click()`);
  await settle();
  const shotClick = (await evaluate('window.__guiCalls')).find((c) => c.tool === 'computer_click');
  // 50% across and 25% down an 800×600 capture is image pixel (400, 150). Sending
  // the CSS position instead would be indistinguishable here, which is why the
  // stub image is a real 800×600 PNG scaled by the layout.
  const pixelOk = shotClick
    && Math.abs(shotClick.input.x - 400) <= 2
    && Math.abs(shotClick.input.y - 150) <= 2;
  check('the click is sent in capture pixels with the capture id',
    shotClick?.input.screenshotId === 'shot-9f8e7d6c' && shotClick?.input.window === '100' && pixelOk,
    JSON.stringify(shotClick));

  // 11. A canvas or slider has no control to press: it is operated by dragging
  //     on the picture. Shift+drag draws the band first, then asks like every
  //     other pointer action, and the endpoints travel in capture pixels.
  const fromX = geometry.left + geometry.width * 0.25;
  const fromY = geometry.top + geometry.height * 0.75;
  const toX = geometry.left + geometry.width * 0.75;
  const toY = geometry.top + geometry.height * 0.75;
  const beforeDrag = (await evaluate('window.__guiCalls')).length;
  const dragEvent = (kind, x, y) => evaluate(`document.querySelector('.gui-shot-image.clickable').dispatchEvent(new MouseEvent('${kind}', { bubbles: true, shiftKey: true, clientX: ${x}, clientY: ${y} }))`);
  await dragEvent('mousedown', fromX, fromY);
  await settle();
  check('Shift+drag starts drawing a band without acting yet',
    (await evaluate('!!document.querySelector(".gui-shot-band")')) && (await evaluate('window.__guiCalls')).length === beforeDrag);
  await dragEvent('mousemove', toX, toY);
  await settle();
  const band = await evaluate(`(() => { const n = document.querySelector('.gui-shot-band'); return n ? n.getBoundingClientRect().width : -1; })()`);
  check('the band follows the pointer', band > geometry.width * 0.3, `band=${Math.round(band)} of ${Math.round(geometry.width)}`);
  await dragEvent('mouseup', toX, toY);
  await settle();
  const dragAsk = await evaluate(`document.querySelector('.gui-confirm')?.textContent ?? ''`);
  check('a drag asks first and names both endpoints', dragAsk.includes('notes.txt - Notepad') && dragAsk.includes('→'), dragAsk);
  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '确认').click()`);
  await settle();
  const dragCall = (await evaluate('window.__guiCalls')).find((c) => c.tool === 'computer_drag');
  // left quarter → right quarter of an 800×600 capture is (200,450) → (600,450).
  const dragOk = dragCall
    && Math.abs(dragCall.input.fromX - 200) <= 3 && Math.abs(dragCall.input.fromY - 450) <= 3
    && Math.abs(dragCall.input.toX - 600) <= 3 && Math.abs(dragCall.input.toY - 450) <= 3;
  check('the drag is sent in capture pixels with the capture id',
    dragCall?.input.screenshotId === 'shot-9f8e7d6c' && dragOk, JSON.stringify(dragCall));

  // 12. After acting on the window the picture is history: it must be marked as
  //     such, so an old screenshot never silently stands in for the current one.
  const staleMeta = (await evaluate(`document.querySelector('.gui-shot-meta')?.textContent ?? ''`));
  check('a capture goes stale after the window changed', staleMeta.includes('已过期'), staleMeta);
  check('a stale capture offers a re-capture', await evaluate(`[...document.querySelectorAll('.gui-shot .gui-btn')].some(b => b.textContent.includes('重新截取'))`));
  const staleDim = await evaluate(`document.querySelector('.gui-shot-image')?.classList.contains('stale')`);
  check('a stale capture is visibly dimmed', staleDim === true);

  // 13. The centre button is the absolute-coordinate path, and it must still
  //     name the app it is about to click rather than "the desktop".
  await evaluate(`[...document.querySelectorAll('.gui-detail-actions button')].find(b => b.textContent.includes('点中心'))?.click()`);
  await settle();
  const centreAsk = await evaluate(`document.querySelector('.gui-confirm')?.textContent ?? ''`);
  check('the centre click names the window it targets', centreAsk.includes('notes.txt - Notepad'), centreAsk);
  await evaluate(`[...document.querySelectorAll('.gui-confirm button')].find(b => b.textContent === '取消')?.click()`);
  await settle();

  // 14. A minimized window is now capturable (rendered offscreen), but the
  //     picture has no screen point behind it. The panel must show it as
  //     something to look at, not offer a click that the tool would refuse —
  //     and the meta line has to say which of the two it is.
  await evaluate(`[...document.querySelectorAll('.gui-window')].find(r => r.textContent.includes('设置'))?.click()`);
  await settle();
  await evaluate(`[...document.querySelectorAll('.gui-head-actions button')].find(b => b.textContent.includes('截取窗口'))?.click()`);
  await settle();
  for (let i = 0; i < 50 && !(await evaluate('!!document.querySelector(".gui-shot-image.readonly")')); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const miniMeta = await evaluate(`document.querySelector('.gui-shot-meta')?.textContent ?? ''`);
  check('a minimized capture says it is view-only', miniMeta.includes('已最小化') && miniMeta.includes('仅供查看'), miniMeta);
  check('a minimized capture is not offered as clickable',
    (await evaluate('!!document.querySelector(".gui-shot-image.clickable")')) === false);
  const shotsBefore = (await evaluate('window.__guiCalls')).filter((c) => c.tool === 'computer_click').length;
  await evaluate(`document.querySelector('.gui-shot-image.readonly')?.click()`);
  await settle();
  const shotsAfter = (await evaluate('window.__guiCalls')).filter((c) => c.tool === 'computer_click').length;
  check('clicking a view-only capture sends nothing', shotsAfter === shotsBefore, `${shotsBefore} → ${shotsAfter}`);

  // 15. The window list and the control list must not present a minimized
  //     window's numbers as if they were a place. Its rect is where it WOULD be
  //     restored to, so the panel says "已最小化" instead of a size, and the
  //     element rows keep their indexes while showing no rectangle.
  const miniWindowMeta = await evaluate(`[...document.querySelectorAll('.gui-window')].find(r => r.textContent.includes('设置'))?.querySelector('.gui-window-meta')?.textContent ?? ''`);
  check('a minimized window is labelled instead of sized', miniWindowMeta.includes('已最小化'), miniWindowMeta);
  check('a minimized capture does not claim a size', !miniWindowMeta.includes('600×600'), miniWindowMeta);

  await evaluate(`[...document.querySelectorAll('.gui-detail-actions button')].find(b => b.textContent.includes('控件'))?.click()`);
  for (let i = 0; i < 50 && !(await evaluate('document.querySelectorAll(".gui-element").length')); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const miniElements = await evaluate(`[...document.querySelectorAll('.gui-element')].map(b => ({ name: b.querySelector('.gui-element-name')?.textContent ?? '', title: b.getAttribute('title') ?? '' }))`);
  check('a minimized window still lists its controls', miniElements.length >= 3, JSON.stringify(miniElements).slice(0, 200));
  check('a minimized control does not advertise a position',
    miniElements.every((el) => el.title.includes('已最小化')), JSON.stringify(miniElements).slice(0, 300));

  fs.writeFileSync(path.join(output, 'panel.png'), (await window.webContents.capturePage()).toPNG());
  const overflow = await evaluate(`document.documentElement.scrollWidth > innerWidth + 1`);
  check('the panel does not overflow horizontally', overflow === false);
  check('no renderer errors', errors.length === 0, errors.join(' | '));

  console.log(results.join('\n'));
  const failures = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failures}/${results.length} passed`);
  process.exitCode = failures > 0 ? 1 : 0;
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await server.close();
  if (window) window.destroy();
  app.quit();
});
