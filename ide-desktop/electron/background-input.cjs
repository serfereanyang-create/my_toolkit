'use strict';

const MODIFIERS = { Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8, Alt: 1 };
const KEYS = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Insert: ['Insert', 45],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32, ' '],
};

function parseKeyChord(chord) {
  if (typeof chord !== 'string' || !chord || chord.length > 128) throw new Error('无效的后台按键。');
  const parts = chord.split('+');
  const base = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const modifier = Object.hasOwn(MODIFIERS, part) ? MODIFIERS[part] : 0;
    if (!modifier || (modifiers & modifier)) throw new Error('无效或重复的快捷键修饰符。');
    modifiers |= modifier;
  }
  if (!base) throw new Error('缺少快捷键的按键。');
  let code;
  let key = base;
  let virtualKey;
  let text;
  if (Object.hasOwn(KEYS, base)) {
    [code, virtualKey, text] = KEYS[base];
    if (base === 'Space') key = ' ';
  } else if (/^[A-Za-z]$/.test(base)) {
    code = `Key${base.toUpperCase()}`;
    virtualKey = base.toUpperCase().charCodeAt(0);
    key = modifiers & 8 ? base.toUpperCase() : modifiers & 7 ? base.toLowerCase() : base;
    text = key;
  } else if (/^[0-9]$/.test(base)) {
    code = `Digit${base}`;
    virtualKey = base.charCodeAt(0);
    text = base;
  } else if (/^F(?:[1-9]|1[0-2])$/.test(base)) {
    code = base;
    virtualKey = 111 + Number(base.slice(1));
  } else throw new Error('不支持的按键；文字、中文与标点请使用 background_app_type。');
  return { key, code, modifiers, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, ...(text && !(modifiers & 7) ? { text, unmodifiedText: text } : {}) };
}

async function withDebugger(contents, callback) {
  const owned = !contents.debugger.isAttached();
  if (owned) contents.debugger.attach('1.3');
  try { return await callback((method, parameters) => contents.debugger.sendCommand(method, parameters)); }
  finally {
    if (owned && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

async function settle(contents) {
  if (contents.isDestroyed()) return;
  let navigated;
  const navigation = new Promise(resolve => { navigated = resolve; contents.once('did-start-navigation', navigated); });
  try { await Promise.race([contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'), navigation]); }
  finally { contents.removeListener('did-start-navigation', navigated); }
}

async function withRenderer(contents, callback) {
  if (contents.isDestroyed()) throw new Error('目标窗口已关闭，请调用 background_app_windows 刷新窗口列表。');
  let destroyed;
  let crashed;
  const ended = new Promise((_resolve, reject) => {
    destroyed = () => reject(new Error('目标窗口已关闭，请调用 background_app_windows 刷新窗口列表。'));
    crashed = () => reject(new Error('目标窗口的渲染进程已退出，请刷新窗口列表或重新打开应用。'));
    contents.once('destroyed', destroyed);
    contents.once('render-process-gone', crashed);
  });
  try { return await Promise.race([Promise.resolve().then(callback), ended]); }
  finally { contents.removeListener('destroyed', destroyed); contents.removeListener('render-process-gone', crashed); }
}

async function focusSelector(contents, selector, editable) {
  const result = await contents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(selector ?? '')};
    const element = selector ? document.querySelector(selector) : document.activeElement;
    if (!element) return { error: '未找到目标元素' };
    if (selector) { element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); element.focus({ preventScroll: true }); }
    if (selector && document.activeElement !== element && !element.contains(document.activeElement)) return { error: '目标元素无法获得页面焦点' };
    const target = document.activeElement;
    if (${editable} && (!target || !(target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && ['text','search','email','tel','url','password','number'].includes(target.type))) || target.disabled || target.readOnly)) return { error: '当前没有可输入的编辑框，请先点击输入位置或指定 selector' };
    return { ok: true };
  })()`);
  if (result.error) throw new Error(result.error);
}

async function clickRenderer(win, input) {
  const contents = win.webContents;
  let point;
  if (typeof input.selector === 'string') {
    const result = await contents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(input.selector)});
      if (!element || element.disabled) return { error: '未找到可点击的目标元素' };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const bounds = element.getBoundingClientRect();
      const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      if (right <= left || bottom <= top) return { error: '目标元素不在可点击区域' };
      const pointX = (left + right) / 2, pointY = (top + bottom) / 2;
      const front = document.elementFromPoint(pointX, pointY);
      if (front !== element && !element.contains(front)) return { error: '目标元素被其他界面遮挡，请先检查或截图' };
      return { x: pointX, y: pointY };
    })()`);
    if (result.error) throw new Error(result.error);
    point = { x: result.x, y: result.y };
  } else {
    const frame = await contents.capturePage();
    const { width, height } = frame.getSize();
    if (frame.isEmpty() || input.x >= width || input.y >= height) throw new Error('点击坐标超出当前截图范围，请重新截图。');
    const viewport = await contents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
    point = { x: input.x * viewport.width / width, y: input.y * viewport.height / height };
  }
  await withDebugger(contents, async send => {
    const button = input.button ?? 'left';
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    for (let count = 1; count <= (input.double ? 2 : 1); count += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: count, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: count, ...point });
    }
  });
  await settle(contents);
  return { ok: true, point };
}

async function keyRenderer(win, input) {
  const contents = win.webContents;
  const key = parseKeyChord(input.key);
  if (input.selector) await focusSelector(contents, input.selector, false);
  await withDebugger(contents, async send => {
    const held = [];
    let modifiers = 0;
    try {
      for (const modifier of [{ bit: 1, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 }, { bit: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 }, { bit: 4, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 }, { bit: 8, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }]) {
        if (!(key.modifiers & modifier.bit)) continue;
        modifiers |= modifier.bit;
        const { bit: _bit, ...event } = modifier;
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event, modifiers });
        held.push(modifier);
      }
      await send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...key });
      const { text: _text, unmodifiedText: _unmodifiedText, ...released } = key;
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...released });
    } finally {
      for (const modifier of held.reverse()) {
        modifiers &= ~modifier.bit;
        const { bit: _bit, ...event } = modifier;
        if (!contents.isDestroyed()) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event, modifiers });
      }
    }
  });
  await settle(contents);
  return { ok: true, key: input.key };
}

async function typeRenderer(win, input) {
  const contents = win.webContents;
  await focusSelector(contents, input.selector, true);
  await withDebugger(contents, send => send('Input.insertText', { text: input.text }));
  await settle(contents);
  return { ok: true, characters: Array.from(input.text).length };
}

module.exports = { parseKeyChord, clickRenderer, keyRenderer, typeRenderer, withRenderer };
