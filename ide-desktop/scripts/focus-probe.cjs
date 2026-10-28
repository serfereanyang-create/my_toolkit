'use strict';
require('./lib/probe-guard.cjs');

/*
 * focus-probe.cjs — keyboard-focus audit for the renderer.
 *
 * Drives scripts/focus-preview.tsx (the REAL components + the REAL six-file
 * stylesheet cascade, in production order) inside a hidden Electron window, and
 * moves focus with real CDP key events. Prints a PASS/FAIL table.
 *
 * Why CDP and not webContents.sendInputEvent: this was measured two rounds ago.
 * `sendInputEvent` with Tab does not set the user-input modality flag, so
 * Chromium never matches :focus-visible and every control reads as "no ring"
 * even when a perfectly good rule exists. `Input.dispatchKeyEvent` goes through
 * the real event path, so the numbers below are the numbers a person sees.
 *
 * What each surface is asked:
 *   reach  - how many distinct Tab stops exist inside it (and does focus stay in)
 *   ring   - is an outline actually painted, at what width / contrast
 *   enter  - does Enter activate the focused control
 *   esc    - does Escape close the surface
 *   back   - does focus return to the element that opened it
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'focus-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

let server;
let win;
let code = 0;

const results = [];
const record = (surface, check, pass, detail) => results.push({ surface, check, pass, detail });

const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');

/* ── in-page instrumentation ─────────────────────────────────────────────────
   Kept in the renderer so every read is a getComputedStyle on the focused
   element, i.e. what is painted - not "does a rule exist". */
const INSTRUMENT = String.raw`
window.__fx = (() => {
  const parse = (input) => {
    const m = String(input).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const backdrop = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a >= 0.999) return bg;
      node = node.parentElement;
    }
    const b = parse(getComputedStyle(document.body).backgroundColor);
    return b && b.a >= 0.999 ? b : { r: 255, g: 255, b: 255, a: 1 };
  };
  const name = (el) => {
    if (!el) return 'null';
    const label = el.getAttribute('aria-label') || el.getAttribute('title')
      || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 34) || '(无名)';
    const role = el.getAttribute('role');
    return (role ? role + ' ' : '') + el.tagName.toLowerCase() + ' "' + label + '"';
  };
  return {
    name,
    active: () => name(document.activeElement),
    activeVisible: () => !!(document.activeElement && document.activeElement.matches && document.activeElement.matches(':focus-visible')),
    /* ring of the focused element; falls back to the nearest ancestor that
       paints one, which is how .qopen-bar / .composer textarea are handled */
    ring: () => {
      const el = document.activeElement;
      if (!el || el === document.body) return { painted: false, why: 'activeElement 是 body' };
      for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
        const cs = getComputedStyle(node);
        const width = parseFloat(cs.outlineWidth) || 0;
        const painted = cs.outlineStyle !== 'none' && width > 0;
        if (!painted) continue;
        const offset = parseFloat(cs.outlineOffset) || 0;
        // offset >= 0 画在父级面上；负值画在元素自身面上。
        const base = offset >= 0 ? backdrop(node.parentElement || node) : backdrop(node);
        const stroke = parse(cs.outlineColor);
        const solid = stroke.a >= 0.999 ? stroke : over(stroke, base);
        return {
          painted: true, ancestor: depth > 0, width, style: cs.outlineStyle, offset,
          color: 'rgb(' + Math.round(solid.r) + ',' + Math.round(solid.g) + ',' + Math.round(solid.b) + ')',
          ratio: Number(ratio(solid, base).toFixed(2)),
          focusVisible: el.matches(':focus-visible'),
        };
      }
      return { painted: false, focusVisible: el.matches(':focus-visible') };
    },
    /* every element inside root that the browser would stop on with Tab */
    stops: (selector) => {
      const scope = document.querySelector(selector);
      if (!scope) return null;
      return [...scope.querySelectorAll('button, a[href], input, textarea, select, [tabindex]')]
        .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0)
        .map((el) => name(el));
    },
    inside: (selector) => {
      const scope = document.querySelector(selector);
      return !!(scope && document.activeElement && scope.contains(document.activeElement));
    },
    exists: (selector) => !!document.querySelector(selector),
    focusIds: (id) => { const el = document.getElementById(id); if (el) el.focus(); return document.activeElement && document.activeElement.id; },
    /* self-test probes: prove the instrument reports 'no ring' for a control
       that has none, and 'ring' for one that does. Without this pair, a table
       of zeros is indistinguishable from a broken instrument. */
    selfTest() {
      const host = document.createElement('div');
      host.id = '__fx_selftest';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;color:#000;';
      host.innerHTML = '<button id="__fx_none">x</button><button id="__fx_ring" style="outline:2px solid rgb(0,102,221);outline-offset:2px">y</button>';
      document.body.appendChild(host);
      const first = document.getElementById('__fx_none');
      first.style.outline = 'none';
      first.focus({ focusVisible: true });
      const none = getComputedStyle(first);
      const nonePainted = none.outlineStyle !== 'none' && parseFloat(none.outlineWidth) > 0;
      const second = document.getElementById('__fx_ring');
      second.focus({ focusVisible: true });
      const ringed = getComputedStyle(second);
      const ringPainted = ringed.outlineStyle !== 'none' && parseFloat(ringed.outlineWidth) > 0;
      host.remove();
      return { nonePainted, ringPainted };
    },
  };
})();
true;
`;

/* `rawKeyDown` is keydown with no character event, so anything whose default
   action rides on keypress (text insertion, <button> activation) silently does
   nothing. Use keyDown when the key carries text, rawKeyDown when it doesn't -
   this was a probe bug that first reported "typing @ does not open the mention
   picker" and "Enter does not activate the button", both false. */
async function key(keyName, virtualKey, modifiers = 0, text) {
  const params = {
    type: text ? 'keyDown' : 'rawKeyDown', key: keyName, code: keyName === ' ' ? 'Space' : keyName,
    windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers,
  };
  if (text) params.text = text;
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', params);
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code: keyName === ' ' ? 'Space' : keyName,
    windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers,
  });
  await settle();
}
const pressTab = (shift = false) => key('Tab', 9, shift ? 8 : 0);
const pressEsc = () => key('Escape', 27);
const pressEnter = () => key('Enter', 13, 0, '\r');
const pressSpace = () => key(' ', 32, 0, ' ');

/* A dialog opened from a focused trigger must hand focus back to that exact
   trigger on close - not to <body>, which is the top of the document. */
async function openAndAudit(label, selector, openerFocus, expectTrapTabs = 6) {
  await evaluate(`window.focusPreview.close()`);
  await settle();
  await openerFocus();
  await evaluate(`window.focusPreview.open(${JSON.stringify(label)})`);
  await settle();

  const present = await evaluate(`window.__fx.exists(${JSON.stringify(selector)})`);
  record(label, '打开后渲染出浮层', present, selector);
  if (!present) return;

  const landedInside = await evaluate(`window.__fx.inside(${JSON.stringify(selector)})`);
  const landedOn = await evaluate('window.__fx.active()');
  record(label, '打开后焦点落在浮层内', landedInside, landedOn);

  const stops = await evaluate(`window.__fx.stops(${JSON.stringify(selector)})`);
  record(label, '浮层内 Tab 停靠点', Array.isArray(stops) && stops.length > 0, `${stops ? stops.length : 0} 个`);

  if (stops.length > 0) {
    /* Walk the real Tab order and read the ring on each stop, naming the ones
       that paint nothing - "6/8 have a ring" is only actionable once you know
       which two do not. */
    const seen = [];
    for (let i = 0; i < Math.min(stops.length, 8); i += 1) {
      const ring = await evaluate('window.__fx.ring()');
      seen.push({ ring, name: await evaluate('window.__fx.active()') });
      await pressTab();
    }
    const painted = seen.filter((s) => s.ring.painted);
    const worst = painted.length ? Math.min(...painted.map((s) => s.ring.ratio)) : 0;
    const ringless = seen.filter((s) => !s.ring.painted).map((s) => s.name);
    record(label, '控件有可见焦点环', ringless.length === 0,
      `${painted.length}/${seen.length} 有环，最低对比 ${worst}:1${ringless.length ? `；无环：${ringless.join(' / ')}` : ''}`);
    record(label, '焦点环对比度 ≥ 3:1', painted.length > 0 && worst >= 3, worst ? `${worst}:1` : '无环');
  }

  let escaped = false;
  for (let i = 0; i < expectTrapTabs; i += 1) {
    await pressTab();
    if (!(await evaluate(`window.__fx.inside(${JSON.stringify(selector)})`))) { escaped = true; break; }
  }
  record(label, `Tab ×${expectTrapTabs} 未逃出浮层`, !escaped,
    escaped ? `逃到 ${await evaluate('window.__fx.active()')}` : '仍在浮层内');

  let backEscaped = false;
  for (let i = 0; i < expectTrapTabs; i += 1) {
    await pressTab(true);
    if (!(await evaluate(`window.__fx.inside(${JSON.stringify(selector)})`))) { backEscaped = true; break; }
  }
  record(label, `Shift+Tab ×${expectTrapTabs} 未逃出浮层`, !backEscaped,
    backEscaped ? `逃到 ${await evaluate('window.__fx.active()')}` : '仍在浮层内');

  await pressEsc();
  const closed = !(await evaluate(`window.__fx.exists(${JSON.stringify(selector)})`));
  record(label, 'Esc 关闭', closed, closed ? '已关闭' : '仍开着');
  if (!closed) return;

  const restored = await evaluate('document.activeElement && document.activeElement.id');
  record(label, '关闭后焦点回到触发者', restored === 'opener', `activeElement#${restored || '(无)'}`);
}

app.whenReady().then(async () => {
  try {
    const { createServer } = require('vite');
    server = await createServer({
      root,
      cacheDir: path.join(output, 'vite'),
      plugins: [{
        name: 'focus-review',
        configureServer(vite) {
          vite.middlewares.use('/__focus', async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html; charset=utf-8');
              response.end(await vite.transformIndexHtml('/__focus',
                '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>'
                + '<body><div id="root"></div><script type="module" src="/scripts/focus-preview.tsx"></script></body></html>'));
            } catch (error) { next(error); }
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
      clearScreen: false,
    });
    await server.listen();

    win = new BrowserWindow({
      show: false, width: 1280, height: 900, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, offscreen: true, partition: 'focus-review',
      },
    });
    const consoleErrors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) consoleErrors.push(message); });

    await win.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__focus`);
    await win.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate('document.documentElement.dataset.focusPreviewReady === "true"')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (await evaluate('document.documentElement.dataset.focusPreviewReady') !== 'true') {
      throw new Error(`fixture never became ready${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
    }

    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await evaluate(INSTRUMENT);

    /* ── 0. instrument self-test ─────────────────────────────────────────── */
    const selfTest = await evaluate('window.__fx.selfTest()');
    record('仪器', '能区分「有环 / 无环」', selfTest.nonePainted === false && selfTest.ringPainted === true,
      `outline:none→painted=${selfTest.nonePainted}，2px 环→painted=${selfTest.ringPainted}`);
    record('仪器', '页面有焦点（:focus-visible 可成立）', await evaluate('document.hasFocus()'), String(await evaluate('document.hasFocus()')));

    /* ── 1. composer: the app's main input ───────────────────────────────── */
    await evaluate('document.getElementById("opener").focus()');
    await settle();
    const composerStops = await evaluate(`window.__fx.stops('.composer')`);
    record('输入区', 'Composer 可 Tab 到', Array.isArray(composerStops) && composerStops.length > 0,
      `${composerStops ? composerStops.length : 0} 个停靠点`);
    let reachedTextarea = false;
    for (let i = 0; i < 30; i += 1) {
      await pressTab();
      const tag = await evaluate('document.activeElement && document.activeElement.tagName');
      if (tag === 'TEXTAREA') { reachedTextarea = true; break; }
    }
    record('输入区', 'Tab 能到会话输入框', reachedTextarea, await evaluate('window.__fx.active()'));
    if (reachedTextarea) {
      const ring = await evaluate('window.__fx.ring()');
      record('输入区', '会话输入框有可见焦点环', ring.painted === true,
        ring.painted ? `${ring.width}px ${ring.style} ${ring.color} offset=${ring.offset} ${ring.ratio}:1` : '无环');
      record('输入区', '输入框环对比度 ≥ 3:1', ring.painted && ring.ratio >= 3, ring.painted ? `${ring.ratio}:1` : '无环');
    }

    /* ── 2. dialogs + overlays: trap / Esc / restore ─────────────────────── */
    const focusOpener = () => evaluate('window.__fx.focusIds("opener")');
    await openAndAudit('confirm', '.confirm-dialog', focusOpener);
    await openAndAudit('approval', 'section.approval-modal[aria-labelledby^="approval-title-"]', focusOpener);
    await openAndAudit('guard', 'section.approval-modal[aria-labelledby="guard-confirm-title"]', focusOpener);
    await openAndAudit('tag', '.tag-dialog', focusOpener);
    await openAndAudit('help', '.help-overlay', focusOpener);
    await openAndAudit('cmd', '.cmd-panel', focusOpener);
    await openAndAudit('qopen', '.qopen-box', focusOpener);

    /* ── 3. Enter activation inside a dialog ─────────────────────────────── */
    await evaluate('window.focusPreview.close()');
    await settle();
    await focusOpener();
    await evaluate('window.focusPreview.open("confirm")');
    await settle();
    await pressEnter();
    const confirmClosed = !(await evaluate('window.__fx.exists(".confirm-dialog")'));
    record('confirm', 'Enter 激活初始焦点按钮', confirmClosed, confirmClosed ? '对话框关闭' : '仍在');

    /* ── 3b. composer popover menus ────────────────────────────────────────
       A menu button can be opened from the keyboard. The question is whether
       the menu it opens is then reachable without a mouse: the menus render
       BEFORE the composer bar in DOM order, so a Tab from the trigger moves
       forward, away from them. */
    await evaluate('window.focusPreview.close()');
    await settle();
    const openedMenu = await evaluate(`(() => {
      const trigger = document.querySelector('.composer-access');
      if (!trigger) return false;
      trigger.focus();
      return true;
    })()`);
    if (openedMenu) {
      await pressEnter();
      await settle();
      const menuSelector = '.thinking-menu[aria-label="审批模式"]';
      const menuOpen = await evaluate(`window.__fx.exists(${JSON.stringify(menuSelector)})`);
      record('菜单', '键盘可以打开审批模式菜单', menuOpen, menuOpen ? '已打开' : '未打开');
      if (menuOpen) {
        const focusInMenu = await evaluate(`window.__fx.inside(${JSON.stringify(menuSelector)})`);
        record('菜单', '打开后焦点移入菜单', focusInMenu, await evaluate('window.__fx.active()'));
        await pressTab();
        const afterTab = await evaluate(`window.__fx.inside(${JSON.stringify(menuSelector)})`);
        record('菜单', 'Tab 一次能进入菜单项', afterTab, await evaluate('window.__fx.active()'));
        const menuStops = await evaluate(`window.__fx.stops(${JSON.stringify(menuSelector)})`);
        record('菜单', '菜单项可 Tab 到', Array.isArray(menuStops) && menuStops.length > 0, `${menuStops ? menuStops.length : 0} 个停靠点`);
        const ring = await evaluate('window.__fx.ring()');
        record('菜单', '菜单项有可见焦点环', ring.painted === true,
          ring.painted ? `${ring.width}px ${ring.style} ${ring.color} ${ring.ratio}:1` : '无环');
        await pressEsc();
        const menuShut = !(await evaluate(`window.__fx.exists(${JSON.stringify(menuSelector)})`));
        record('菜单', 'Esc 关闭菜单', menuShut, menuShut ? '已关闭' : '仍开着');
        const backOnTrigger = await evaluate(`(() => { const el = document.activeElement; return !!el && (el.className || '').split(' ').includes('composer-access'); })()`);
        record('菜单', '关闭后焦点回到触发按钮', backOnTrigger, await evaluate('window.__fx.active()'));
      }
    }

    /* ── 4. mention picker, opened the way a user opens it ───────────────── */
    await evaluate('window.focusPreview.close()');
    await settle();
    await evaluate('document.getElementById("opener").focus()');
    let typed = false;
    for (let i = 0; i < 30; i += 1) {
      await pressTab();
      if ((await evaluate('document.activeElement && document.activeElement.tagName')) === 'TEXTAREA') { typed = true; break; }
    }
    if (typed) {
      await key('@', 50, 0, '@');
      await new Promise((resolve) => setTimeout(resolve, 350));
      const mentionOpen = await evaluate('window.__fx.exists(".mention-picker")');
      record('mention', '输入 @ 打开引用选择器', mentionOpen, mentionOpen ? '已打开' : '未打开');
      if (mentionOpen) {
        const inside = await evaluate('window.__fx.inside(".mention-picker")');
        record('mention', '打开后焦点在浮层内', inside, await evaluate('window.__fx.active()'));
        let out = false;
        for (let i = 0; i < 6; i += 1) {
          await pressTab();
          if (!(await evaluate('window.__fx.inside(".mention-picker")'))) { out = true; break; }
        }
        record('mention', 'Tab ×6 未逃出浮层', !out, out ? `逃到 ${await evaluate('window.__fx.active()')}` : '仍在浮层内');
        await pressEsc();
        const shut = !(await evaluate('window.__fx.exists(".mention-picker")'));
        record('mention', 'Esc 关闭', shut, shut ? '已关闭' : '仍开着');
        record('mention', '关闭后焦点回到输入框', await evaluate('document.activeElement && document.activeElement.tagName') === 'TEXTAREA',
          await evaluate('window.__fx.active()'));
      }
    }

    /* ── 4b. mention picker URL field must survive its own re-render ────────
       The container focuses itself from an inline ref callback, which React
       re-invokes on every render - so every keystroke would yank focus back
       out of the URL input. Typing two characters is the whole test. */
    await evaluate('window.focusPreview.close()');
    await settle();
    await evaluate('document.getElementById("opener").focus()');
    for (let i = 0; i < 30; i += 1) {
      await pressTab();
      if ((await evaluate('document.activeElement && document.activeElement.tagName')) === 'TEXTAREA') break;
    }
    await key('@', 50, 0, '@');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const reachedUrlTab = await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.mention-tab')].find((b) => b.textContent.includes('URL'));
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    if (reachedUrlTab) {
      await settle();
      const inputFocused = await evaluate(`(() => { const i = document.querySelector('.mention-url-input'); if (!i) return false; i.focus(); return document.activeElement === i; })()`);
      if (inputFocused) {
        await key('a', 65, 0, 'a');
        await key('b', 66, 0, 'b');
        const stillThere = await evaluate(`(() => { const i = document.querySelector('.mention-url-input'); return !!i && document.activeElement === i; })()`);
        const value = await evaluate(`(document.querySelector('.mention-url-input') || {}).value || ''`);
        record('mention', 'URL 输入框输入时不丢焦点', stillThere && value === 'ab', `activeElement 是输入框=${stillThere}，值="${value}"`);
      }
    }

    /* ── 5. slash menu ───────────────────────────────────────────────────── */
    await evaluate('window.focusPreview.close()');
    await settle();
    /* Reset the composer to a clean slate first: the mention picker from the
       step above is still mounted, and its URL field is the focused element.
       Leaving it open would make the slash menu capture a doomed input as its
       "opener", which is a fixture artefact, not app behaviour. */
    await evaluate(`(() => {
      const t = document.querySelector('.composer textarea');
      if (!t) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      t.focus();
      setter.call(t, '');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await evaluate(`(() => { const t = document.querySelector('.composer textarea'); if (!t) return false; t.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, '/'); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const slashOpen = await evaluate('window.__fx.exists(".slash-menu")');
    record('slash', '输入 / 打开斜杠命令菜单', slashOpen, slashOpen ? '已打开' : '未打开');
    if (slashOpen) {
      record('slash', '打开后焦点在菜单内', await evaluate('window.__fx.inside(".slash-menu")'), await evaluate('window.__fx.active()'));
      let out = false;
      for (let i = 0; i < 6; i += 1) {
        await pressTab();
        if (!(await evaluate('window.__fx.inside(".slash-menu")'))) { out = true; break; }
      }
      record('slash', 'Tab ×6 未逃出菜单', !out, out ? `逃到 ${await evaluate('window.__fx.active()')}` : '仍在菜单内');
      await pressEsc();
      let shut = !(await evaluate('window.__fx.exists(".slash-menu")'));
      // A typed query makes the menu clear the search on the first Escape
      // (deliberate: the search field has its own clear affordance), so press
      // again rather than declaring the overlay stuck.
      if (!shut) { await pressEsc(); shut = !(await evaluate('window.__fx.exists(".slash-menu")')); }
      record('slash', 'Esc 关闭', shut, shut ? '已关闭' : '仍开着');
      if (shut) {
        const back = await evaluate('document.activeElement && document.activeElement.tagName');
        record('slash', '关闭后焦点回到输入框', back === 'TEXTAREA', await evaluate('window.__fx.active()'));
      }
    }

    win.webContents.debugger.detach();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    code = 1;
  } finally {
    const failures = results.filter((row) => !row.pass);
    const width = Math.max(...results.map((row) => row.surface.length)) + 2;
    const lines = [`${'表面'.padEnd(width)}${'检查'.padEnd(30)}结果   细节`];
    for (const row of results) {
      lines.push(`${row.surface.padEnd(width)}${row.check.padEnd(30)}${row.pass ? 'PASS' : 'FAIL'}   ${row.detail}`);
    }
    console.log(lines.join('\n'));
    console.log(`\nSUMMARY ${results.length - failures.length}/${results.length} PASS`);
    if (failures.length) console.log('FAILED:\n' + failures.map((f) => `  - ${f.surface} · ${f.check} · ${f.detail}`).join('\n'));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    if (failures.length) code = 1;
    try { await server?.close(); } catch { /* server already gone */ }
    app.exit(code);
  }
});

setTimeout(() => { console.error('probe timed out'); app.exit(1); }, 180000).unref();
