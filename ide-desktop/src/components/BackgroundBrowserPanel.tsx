import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Camera, Download, Globe, Square, Loader2 } from 'lucide-react';
import { desktop } from '../lib/ipc';

export function BackgroundBrowserPanel() {
  const [target, setTarget] = useState('index.html');
  const [selector, setSelector] = useState('');
  const [value, setValue] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [browserId, setBrowserId] = useState<string>();
  const [savedPath, setSavedPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('打开工作区内的 HTML 或公开网页，即可在隐藏窗口中检查、下载和截图。');
  const [image, setImage] = useState('');
  const [links, setLinks] = useState<Array<{ href: string; text: string }>>([]);
  const [revealError, setRevealError] = useState('');
  const requestVersion = useRef(0);
  const sessionId = 'manual-background';

  useEffect(() => () => { requestVersion.current += 1; }, []);

  async function reveal(path: string) {
    setRevealError('');
    const result = await desktop.workspace.reveal(path);
    if (!result.ok) setRevealError(result.error ?? '无法在文件夹中显示该文件');
  }

  async function run(tool: string, input: Record<string, unknown>) {
    if (busy) return;
    const version = ++requestVersion.current;
    setBusy(true);
    try {
      const result = await desktop.backgroundBrowser.execute(tool, input, sessionId);
      if (version !== requestVersion.current) return;
      setOutput(result.output);
      if (result.ok && result.data?.browserId) setBrowserId(result.data.browserId);
      if (result.ok && typeof result.data?.path === 'string') setSavedPath(result.data.path);
      // inspect returns the page's resolved links. Showing them turns the panel
      // into something usable without typing selectors: a file offered by the
      // page is one click away from a download.
      if (result.ok && Array.isArray(result.data?.links)) setLinks(result.data.links as Array<{ href: string; text: string }>);
      const shot = result.data?.computerImage;
      if (shot) setImage(`data:${shot.mediaType};base64,${shot.data}`);
      if (tool === 'background_browser_close' && result.ok) { setBrowserId(undefined); setImage(''); }
    } catch (error) {
      if (version === requestVersion.current) setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  // A page is a place you are, not a list of tabs: once one is open, the same
  // address field goes *to* a URL instead of opening a second hidden window.
  // A workspace path still opens a page of its own — navigate is http-only.
  function submitTarget() {
    const trimmed = target.trim();
    if (!trimmed) return;
    const isUrl = /^https?:\/\//i.test(trimmed);
    if (browserId && isUrl) void run('background_browser_navigate', { browserId, url: trimmed });
    else void run('background_browser_open', isUrl ? { url: trimmed } : { path: trimmed });
  }

  return (
    <section className="settings-group background-browser-panel" aria-label="后台网页工作台">
      <h3 className="settings-group-heading">后台网页工作台</h3>
      <p className="background-browser-note">任务使用自己的隐藏浏览器，不拉起 Chrome 或 Edge，不读取你的桌面，也不移动真实鼠标。网页不能访问本地任意文件；登录状态与日常浏览器分开。</p>
      <div className="settings-card">
        <div className="background-browser-input-row">
          <label>
            <span>{browserId ? '转到网址' : '网页或工作区 HTML 路径'}</span>
            <input
              className="settings-text-field"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitTarget(); }}
              placeholder={browserId ? 'https://example.com/next' : 'index.html 或 https://example.com'}
              disabled={busy}
            />
          </label>
          <button type="button" className="settings-action-btn" disabled={busy || !target.trim()} onClick={submitTarget}>
            {browserId ? <><ArrowRight size={14} />转到</> : <><Globe size={14} />后台打开</>}
          </button>
        </div>
        <div className="background-browser-input-row">
          <label>
            <span>下载地址（留空则接收下一次点击触发的下载）</span>
            <input
              className="settings-text-field"
              value={downloadUrl}
              onChange={(event) => setDownloadUrl(event.target.value)}
              placeholder="https://example.com/paper.pdf"
              disabled={busy || !browserId}
            />
          </label>
          <button
            type="button"
            className="settings-action-btn"
            disabled={busy || !browserId}
            onClick={() => void run('background_browser_download', { browserId, ...(downloadUrl.trim() ? { url: downloadUrl.trim() } : {}) })}
          ><Download size={14} />下载到 downloads/</button>
        </div>
        {savedPath && (
          <div className="background-browser-saved" role="status">
            <code>{savedPath}</code>
            <button type="button" className="settings-action-btn" onClick={() => { void reveal(savedPath); }}>在文件夹中显示</button>
            {revealError && <span className="background-browser-reveal-error">{revealError}</span>}
          </div>
        )}
        <div className="background-browser-input-row">
          <label><span>页面元素选择器</span><input className="settings-text-field" value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="#submit 或 input[name=email]" disabled={busy} /></label>
          <label><span>填写内容</span><input className="settings-text-field" value={value} onChange={(event) => setValue(event.target.value)} placeholder="只填写隐藏页面中的输入框" disabled={busy} /></label>
        </div>
        <div className="background-browser-actions">
          <button type="button" className="settings-action-btn" disabled={busy || !browserId} onClick={() => void run('background_browser_inspect', { browserId, ...(selector ? { selector } : {}) })}>检查页面</button>
          <button type="button" className="settings-action-btn" disabled={busy || !browserId || !selector} onClick={() => void run('background_browser_click', { browserId, selector })}>点击元素</button>
          <button type="button" className="settings-action-btn" disabled={busy || !browserId || !selector} onClick={() => void run('background_browser_fill', { browserId, selector, value })}>填写输入框</button>
          <button type="button" className="settings-action-btn" disabled={busy || !browserId} onClick={() => void run('background_browser_screenshot', { browserId })}><Camera size={14} />后台截图</button>
          <button type="button" className="settings-action-btn" disabled={busy || !browserId} onClick={() => void run('background_browser_close', { browserId })}><Square size={12} />结束页面</button>
          {busy && <Loader2 size={16} className="spin" aria-label="后台操作进行中" />}
        </div>
        <p className="background-browser-output" role="status" aria-live="polite">{output}</p>
        {links.length > 0 && (
          <div className="background-browser-links">
            <span className="background-browser-links-label">页面链接</span>
            <ul>
              {links.slice(0, 20).map((link) => {
                // A link that looks like a file is saved; anything else is just
                // somewhere to go. The extension check is a routing hint, not a
                // trust decision — the host decides what the response actually
                // is and reports a page honestly.
                const looksLikeFile = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|epub)(\?|#|$)/i.test(link.href);
                return (
                  <li key={link.href}>
                    <button
                      type="button"
                      className="background-browser-link"
                      disabled={busy}
                      title={link.href}
                      onClick={() => {
                        if (looksLikeFile) void run('background_browser_download', { browserId, url: link.href });
                        else void run('background_browser_navigate', { browserId, url: link.href });
                      }}
                    >
                      <span className="background-browser-link-icon" aria-hidden="true">
                        {looksLikeFile ? <Download size={13} /> : <ArrowUpRight size={13} />}
                      </span>
                      <span className="background-browser-link-text">{link.text.trim() || link.href}</span>
                      <span className="background-browser-link-action">{looksLikeFile ? '下载' : '打开'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {image && <img className="background-browser-shot" src={image} alt="独立隐藏浏览器的截图，不是桌面截图" />}
      </div>
    </section>
  );
}
