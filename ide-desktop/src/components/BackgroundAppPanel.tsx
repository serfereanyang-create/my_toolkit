import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Camera, Keyboard, Loader2, Play, RefreshCw, Square, Type } from 'lucide-react';
import { desktop } from '../lib/ipc';

export function BackgroundAppPanel() {
  const [project, setProject] = useState('.');
  const [appId, setAppId] = useState('');
  const [selector, setSelector] = useState('');
  const [value, setValue] = useState('');
  const [key, setKey] = useState('Control+A');
  const [windowId, setWindowId] = useState<number>();
  const [windows, setWindows] = useState<Array<{ windowId: number; title: string; loading?: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('选择已构建的工作区 Electron 项目，即可后台运行并截取真实界面。');
  const [image, setImage] = useState('');
  const version = useRef(0);
  const running = useRef(false);
  useEffect(() => () => { version.current += 1; void desktop.backgroundApp.close().catch(() => {}); }, []);

  async function run(operation: string, extra: Record<string, unknown> = {}) {
    if (running.current) return;
    running.current = true;
    const request = ++version.current;
    setBusy(true);
    try {
      const result = await desktop.backgroundApp.execute(`background_app_${operation}`, operation === 'open' ? { path: project.trim() } : { appId, ...(!['close', 'windows'].includes(operation) && windowId ? { windowId } : {}), ...extra });
      if (request !== version.current) return;
      setOutput(result.output);
      if (!result.ok) return;
      if (typeof result.data?.appId === 'string') setAppId(result.data.appId);
      if (Array.isArray(result.data?.windows)) {
        const currentWindows = result.data.windows.filter((item): item is { windowId: number; title: string; loading?: boolean } => typeof item?.windowId === 'number' && typeof item?.title === 'string');
        setWindows(currentWindows);
        const selected = typeof result.data?.windowId === 'number' ? result.data.windowId : currentWindows.some(win => win.windowId === windowId) ? windowId : (currentWindows.find(win => !win.loading) ?? currentWindows[0])?.windowId;
        if (selected !== windowId) setImage('');
        setWindowId(selected);
        if (operation === 'windows') setOutput(`已刷新，当前有 ${currentWindows.length} 个应用窗口。`);
      }
      if (result.data?.computerImage) setImage(`data:${result.data.computerImage.mediaType};base64,${result.data.computerImage.data}`);
      if (operation === 'close') { setAppId(''); setWindowId(undefined); setWindows([]); }
      if (operation === 'open') setImage('');
      if (['click', 'key', 'type'].includes(operation)) {
        const screenshot = await desktop.backgroundApp.execute('background_app_screenshot', { appId, ...(windowId ? { windowId } : {}) });
        if (request !== version.current) return;
        if (screenshot.ok && screenshot.data?.computerImage) {
          setImage(`data:${screenshot.data.computerImage.mediaType};base64,${screenshot.data.computerImage.data}`);
          setOutput(screenshot.output);
        } else setOutput(`${result.output}\n截图未更新：${screenshot.output}`);
      }
    } catch (error) { if (request === version.current) setOutput(`后台应用操作失败：${String(error)}`); }
    finally { running.current = false; if (request === version.current) setBusy(false); }
  }

  function clickPreview(event: MouseEvent<HTMLButtonElement>) {
    const preview = event.currentTarget.querySelector('img');
    if (!preview || busy || !preview.naturalWidth || !preview.naturalHeight) return;
    const bounds = preview.getBoundingClientRect();
    const scale = Math.min(preview.clientWidth / preview.naturalWidth, preview.clientHeight / preview.naturalHeight);
    const drawnWidth = preview.naturalWidth * scale;
    const drawnHeight = preview.naturalHeight * scale;
    const originX = bounds.left + preview.clientLeft + (preview.clientWidth - drawnWidth) / 2;
    const originY = bounds.top + preview.clientTop + (preview.clientHeight - drawnHeight) / 2;
    const pointX = event.detail === 0 ? preview.naturalWidth / 2 : (event.clientX - originX) / scale;
    const pointY = event.detail === 0 ? preview.naturalHeight / 2 : (event.clientY - originY) / scale;
    if (pointX < 0 || pointY < 0 || pointX >= preview.naturalWidth || pointY >= preview.naturalHeight) return;
    void run('click', { x: Math.floor(pointX), y: Math.floor(pointY) });
  }

  return <section className="settings-group background-browser-panel" aria-label="后台应用工作台">
    <h3 className="settings-group-heading">后台应用工作台</h3>
    <p className="background-browser-note">真实运行已构建的 Electron 项目，支持 CommonJS 与 ESM 入口。保留界面、预加载与 IPC，隐藏渲染，不弹窗、不抢焦点。使用独立应用数据目录；会执行项目代码。</p>
    <div className="settings-card">
      <div className="background-browser-input-row">
        <label><span>工作区项目目录</span><input className="settings-text-field" value={project} onChange={event => setProject(event.target.value)} placeholder=". 或 ide-desktop" disabled={busy || !!appId} /></label>
        <button type="button" className="settings-action-btn" disabled={busy || !!appId || !project.trim()} onClick={() => void run('open')}><Play size={14} />后台运行</button>
      </div>
      {appId && <div className="background-browser-input-row"><label><span>应用窗口</span><select className="settings-text-field" value={windowId ?? ''} onChange={event => { setWindowId(Number(event.target.value)); setImage(''); setOutput('已切换窗口，请重新检查界面或截图。'); }} disabled={busy || windows.length === 0}>{windows.length === 0 && <option value="">暂无窗口</option>}{windows.map(win => <option key={win.windowId} value={win.windowId}>{win.title || `窗口 ${win.windowId}`}{win.loading ? ' · 加载中' : ''}</option>)}</select></label><button type="button" className="settings-action-btn" disabled={busy} onClick={() => void run('windows')}><RefreshCw size={14} />刷新窗口</button></div>}
      <div className="background-browser-input-row">
        <label><span>界面元素选择器</span><input className="settings-text-field" value={selector} onChange={event => setSelector(event.target.value)} placeholder="#submit" disabled={busy} /></label>
        <label><span>填写内容</span><input className="settings-text-field" value={value} onChange={event => setValue(event.target.value)} disabled={busy} /></label>
      </div>
      <div className="background-browser-input-row">
        <label><span>快捷键</span><input className="settings-text-field" value={key} onChange={event => setKey(event.target.value)} placeholder="Control+A、Tab 或 Enter" disabled={busy} /></label>
        <button type="button" className="settings-action-btn" disabled={busy || !appId || !key} onClick={() => void run('key', { key })}><Keyboard size={14} />发送快捷键</button>
        <button type="button" className="settings-action-btn" disabled={busy || !appId || !value} onClick={() => void run('type', { text: value })}><Type size={14} />输入文字</button>
      </div>
      <div className="background-browser-actions">
        <button type="button" className="settings-action-btn" disabled={busy || !appId} onClick={() => void run('inspect')}>检查界面</button>
        <button type="button" className="settings-action-btn" disabled={busy || !appId || !selector} onClick={() => void run('click', { selector })}>点击元素</button>
        <button type="button" className="settings-action-btn" disabled={busy || !appId || !selector} onClick={() => void run('fill', { selector, value })}>填写输入框</button>
        <button type="button" className="settings-action-btn" disabled={busy || !appId} onClick={() => void run('screenshot')}><Camera size={14} />真实应用截图</button>
        <button type="button" className="settings-action-btn" disabled={busy || !appId} onClick={() => void run('close', {})}><Square size={12} />结束应用</button>
        {busy && <Loader2 size={16} className="spin" aria-label="后台应用操作进行中" />}
      </div>
      <p className="background-browser-output" role="status" aria-live="polite">{output}</p>
      {image && <figure className="background-app-preview"><button type="button" className="background-app-preview-button" onClick={clickPreview} disabled={busy || !appId} aria-label="点击后台应用截图中的控件；键盘确认会点击图像中心"><img className="background-browser-shot" src={image} alt="后台真实应用渲染截图" /></button><figcaption>点击图中控件定位，再用文字或快捷键操作；画面会自动更新。</figcaption></figure>}
    </div>
  </section>;
}
