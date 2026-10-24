/**
 * background-browser.cjs
 *
 * The desktop half of the CLI's `background_browser_*` tools.
 *
 * The CLI runs the agent and owns the tool contract (cli/src/tools/backgroundBrowser.ts);
 * this service is the *host* it calls into over the `host_tool_request` /
 * `host_tool_response` RPC. It is deliberately not the visible preview pane:
 * each conversation gets its own hidden page, so a background web task neither
 * steals the user's mouse/keyboard/focus nor disturbs whatever the preview pane
 * is showing.
 *
 * Why a hidden BrowserWindow rather than an unattached WebContentsView: a view
 * that is never added to a window has no display surface, and capturePage()
 * returns an empty 0x0 image for it (verified on Electron 32). An offscreen
 * window — `show: false` plus `offscreen: true` — renders real pixels while
 * staying invisible and unfocused, which is what a screenshot requires. It is
 * never shown, never focused, and destroyed when its conversation ends.
 *
 * Security posture, matching the preview service and the CLI's own gate:
 *   - one in-memory session per page, sandboxed, no preload, no node.
 *   - only http/https URLs, and only workspace-relative .html paths.
 *   - navigation is anchored to the approved origin, re-checked every time, so
 *     a redirect or in-page submit cannot reach an unapproved site.
 *   - downloads, permission prompts and window.open are refused.
 *   - page scripts are built here and run with JSON-encoded arguments; no
 *     caller string is ever concatenated into executable code.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const { BrowserWindow, session } = require('electron');
const { resolveWorkspacePath } = require('./preview-policy.cjs');

const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;
const SCREENSHOT_DIR = path.posix.join('.aicode', 'screenshots');
/** Where downloaded material lands, relative to the workspace. */
const DOWNLOAD_DIR = 'downloads';
/** Hard cap on an inspected snapshot, so a huge page cannot flood the model. */
const DEFAULT_MAX_ELEMENTS = 100;
const MAX_SNAPSHOT_TEXT = 20_000;
/** Default ceiling for one download; override per call. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** Wall-clock budget for one download, including a page fallback fetch. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** How many resolved links inspect returns, so the model can pick a target. */
const MAX_LINKS = 40;

/**
 * One hidden page, owned by one conversation.
 *
 * `sessionId` is the conversation, not the page: a conversation may open
 * several pages, and every page it owns dies with it.
 */
class HiddenPage {
  constructor(win) {
    this.win = win;
    this.url = '';
    this.createdAt = Date.now();
    /**
     * The origins this page may navigate to.
     *
     * It starts with the approved origin and grows only when the agent follows
     * a link. A page that could reach any host on its own would let a searched
     * result redirect the session somewhere the user never approved, so each
     * new origin is added by name (by `navigate`) rather than inferred.
     */
    this.origins = new Set();
    /** Pending download, so a `will-download` fired by a click can be awaited. */
    this.pendingDownload = null;
    this.downloads = [];
  }

  allowOrigin(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') this.origins.add(url.origin);
    } catch { /* an unparsable URL is not an origin */ }
  }

  allows(candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return this.origins.has(url.origin);
    } catch { return false; }
  }

  close() {
    try {
      if (!this.win.isDestroyed()) this.win.destroy();
    } catch { /* already gone */ }
  }
}

class BackgroundBrowserService {
  constructor() {
    /** conversation id → Map<browserId, HiddenPage> */
    this._sessions = new Map();
    this._disposed = false;
  }

  /**
   * Load one page for a conversation.
   *
   * The window is created hidden and offscreen and is never shown, so this
   * cannot raise the app, steal focus, or appear in the user's window list.
   *
   * `downloadRoot` is where a download writes. It is passed per page because
   * the workspace can change under a long-lived service.
   */
  async _createPage(url, downloadRoot, signal) {
    signal?.throwIfAborted();
    const partition = `bg-${crypto.randomBytes(8).toString('hex')}`;
    const ses = session.fromPartition(`memory:${partition}`, { cache: false });
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    const win = new BrowserWindow({
      ...VIEWPORT,
      show: false,
      skipTaskbar: true,
      // Offscreen rendering is what makes a hidden page screenshot-able.
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        preload: undefined,
        partition: `memory:${partition}`,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;

    const page = new HiddenPage(win);
    page.allowOrigin(url);
    page.downloadRoot = downloadRoot;

    // Anchor navigation to the origins this page is allowed to reach. A hidden
    // page that navigated anywhere would silently act on a site the user never
    // approved, so everything outside the set is refused — redirects and
    // in-page form submissions included. Following a searched result is an
    // explicit `navigate`, which adds that origin first.
    wc.on('will-navigate', (event, candidate) => {
      if (!page.allows(candidate)) event.preventDefault();
    });
    wc.on('will-frame-navigate', (event, details) => {
      if (details?.isMainFrame === false) return;
      if (!page.allows(event.url)) event.preventDefault();
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Downloads used to be refused unconditionally, which is what made
    // "open a site, fetch the material it offers, then analyse it" impossible:
    // the agent could read a page but never obtain the file behind a link.
    // A download is now accepted only when this session asked for one, is
    // written under the workspace's downloads/ directory, and is reported back
    // with its real path so pdf_to_text / read_file can open it next.
    ses.on('will-download', (event, item) => {
      // The latch that decides whether this file is wanted outlives the
      // transfer: `pendingDownload` is cleared the moment a transfer starts, so
      // it cannot also answer "is the caller still waiting on this request".
      const pending = page.pendingDownload ?? (page.downloadRequest?.claim() ?? null);
      if (!pending) {
        // An unsolicited download (an advertisement, a tracker probe). Only
        // what the agent explicitly requested is allowed to touch disk.
        event.preventDefault();
        return;
      }
      page.pendingDownload = null;

      const name = uniqueDownloadName(page.downloadRoot, sanitizeDownloadName(item.getFilename(), pending.suggestedName));
      const relative = path.posix.join(DOWNLOAD_DIR, name);
      const target = path.join(page.downloadRoot, DOWNLOAD_DIR, name);
      let settled = false;
      // Answer through the request latch so a completed file, an over-cap
      // cancel and a failure all go through the same one-shot settle. The
      // latch may have been released already (the deadline fired, or the caller
      // gave up), and then the raw resolve is the right fallback — but only if
      // it has not been used before, which `settled` guarantees.
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (page.downloadRequest?.settle) page.downloadRequest.settle(result);
        else pending.resolve(result);
      };

      const cap = pending.maxBytes;
      item.on('updated', (_event, state) => {
        if (state !== 'progressing') return;
        if (item.getReceivedBytes() > cap) {
          try { item.cancel(); } catch { /* already gone */ }
          settle({ ok: false, output: `下载失败：文件超过 ${Math.round(cap / (1024 * 1024))} MB 上限。` });
        }
      });
      item.once('done', (_event, state) => {
        if (state === 'completed') {
          const bytes = item.getReceivedBytes();
          page.downloads.push({ path: relative, url: item.getURL(), bytes });
          settle({
            ok: true,
            output: `已下载 ${name}（${bytes} 字节）到 ${relative}。`,
            data: { path: relative, bytes, filename: name, url: item.getURL(), contentType: item.getMimeType?.() || '' },
          });
          return;
        }
        if (settled) return; // the size cap already answered for this transfer
        // Not settled here: a failed transfer is retried through the page's
        // session by the caller's fallback, which is the only place that can
        // report what the site actually answered. Settling first would hide it
        // behind a bare state name.
        pending.onFailure?.(state);
      });

      item.setSavePath(target);
      // `setSavePath` does not create intermediate directories; without this a
      // first-ever download fails with a bare "failed" state and no explanation.
      fs.mkdir(path.join(page.downloadRoot, DOWNLOAD_DIR), { recursive: true }).catch(() => undefined);
    });

    page.url = url;
    const abort = () => page.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await this._load(wc, url);
      signal?.throwIfAborted();
      page.url = wc.getURL() || url;
      return page;
    } catch (error) { page.close(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  /** Wait for a real load outcome rather than a fixed delay. */
  _load(wc, url) {
    if (wc.isDestroyed()) return Promise.reject(new Error('后台浏览器已关闭。'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`后台浏览器加载超时：${url}`));
      }, NAVIGATION_TIMEOUT_MS);

      const onStop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onFail = (_event, code, description, failedUrl, isMainFrame) => {
        // Subframe failures (an ad iframe, a broken image) must not fail the page.
        if (isMainFrame === false || settled) return;
        settled = true;
        cleanup();
        reject(new Error(`后台浏览器无法加载 ${failedUrl || url}：${description || code}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', onStop);
        wc.removeListener('did-fail-load', onFail);
        wc.removeListener('destroyed', onDestroyed);
      };
      const onDestroyed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('后台浏览器已关闭。'));
      };

      wc.once('did-stop-loading', onStop);
      wc.on('did-fail-load', onFail);
      wc.once('destroyed', onDestroyed);
      wc.loadURL(url).catch((error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  /**
   * Resolve a workspace-relative HTML path to a file URL.
   *
   * Reuses the shared preview policy so the same containment, symlink and
   * blocked-segment rules apply here as everywhere else.
   */
  async _workspaceHtmlUrl(workspaceRoot, relativePath) {
    // Translate the two failures a real user hits into what the field accepts.
    // The raw errno ("ENOENT: no such file or directory, realpath 'C:\…'")
    // named a resolved absolute path the user never typed, and said nothing
    // about the .html requirement the panel note mentions only in passing.
    let resolved;
    try {
      resolved = await resolveWorkspacePath(relativePath, workspaceRoot);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`工作区里没有找到「${relativePath}」。这里填工作区内的 .html 文件（如 index.html）或完整网址（https://…）。`);
      }
      throw error;
    }
    const ext = path.extname(resolved.path).toLowerCase();
    if (ext !== '.html' && ext !== '.htm') {
      throw new Error('后台浏览器只打开工作区内的 .html 或 .htm 网页文件');
    }
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) throw new Error('后台浏览器只能打开网页文件');
    return resolved.path;
  }

  _session(sessionId) {
    let owned = this._sessions.get(sessionId);
    if (!owned) {
      owned = new Map();
      this._sessions.set(sessionId, owned);
    }
    return owned;
  }

  _page(sessionId, browserId) {
    const page = this._sessions.get(sessionId)?.get(String(browserId));
    if (!page) throw new Error('此后台浏览器已关闭或不属于该会话，请重新打开页面');
    return page;
  }

  /** Normalize an open request into a loadable URL. */
  async _resolveOpenTarget(input, workspaceRoot) {
    if (typeof input.url === 'string') {
      let url;
      try { url = new URL(input.url); } catch { throw new Error('后台浏览器收到无效的网址'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('后台浏览器只支持 http/https 网址');
      if (url.username || url.password) throw new Error('后台浏览器网址不能包含凭据');
      return { url: url.toString(), label: url.toString() };
    }
    const htmlPath = await this._workspaceHtmlUrl(workspaceRoot, String(input.path ?? ''));
    const fileUrl = new URL(`file://${htmlPath.replace(/\\/g, '/')}`);
    return { url: fileUrl.toString(), label: String(input.path) };
  }

  async open({ sessionId, workspaceRoot, input, signal }) {
    const target = await this._resolveOpenTarget(input, workspaceRoot);
    signal?.throwIfAborted();
    const browserId = `browser_${crypto.randomBytes(8).toString('hex')}`;
    const page = await this._createPage(target.url, workspaceRoot, signal);
    if (signal?.aborted) { page.close(); signal.throwIfAborted(); }
    page.browserId = browserId;
    this._session(sessionId).set(browserId, page);
    return {
      ok: true,
      output: `已在隐藏浏览器中打开 ${target.label}。browserId 为 ${browserId}，后续操作请带上它。`,
      data: { browserId, url: page.url, hidden: true },
    };
  }

  /**
   * Go to another URL in the same hidden page.
   *
   * This exists because the page is origin-anchored: a search result, a "next
   * page" link or a documentation site's own navigation is a different origin,
   * and `click` would be refused there. The agent names the destination, the
   * new origin is added to this page's allowed set, and the navigation is a
   * deliberate step the user can see in the approval card.
   */
  async navigate({ sessionId, workspaceRoot, input }) {
    const page = this._page(sessionId, input.browserId);
    const target = await this._resolveOpenTarget({ url: input.url }, workspaceRoot);
    page.allowOrigin(target.url);
    await this._load(page.win.webContents, target.url);
    page.url = page.win.webContents.getURL() || target.url;
    return {
      ok: true,
      output: `已导航到 ${page.url}。`,
      data: { browserId: input.browserId, url: page.url, hidden: true },
    };
  }

  /**
   * Fetch a URL and save it into the workspace's downloads/ directory.
   *
   * Two paths, because pages offer files in two ways:
   *
   *   - `background_browser_download` with a `url` goes straight through the
   *     page's own session (same cookies, same session state) by navigating to
   *     it; a response that is a file rather than a page arrives as a
   *     `will-download`.
   *   - `background_browser_click` on a link that *is* a download (a PDF link
   *     with `Content-Disposition: attachment`) triggers `will-download` with
   *     no URL argument at all. That path arms `pendingDownload` first.
   *
   * Both end in the same handler above, so the file lands in one place with one
   * naming scheme and one size cap.
   */
  async download({ sessionId, input }) {
    const page = this._page(sessionId, input.browserId);
    const rawUrl = typeof input.url === 'string' ? input.url : '';
    const target = rawUrl ? new URL(rawUrl) : null;

    if (target) {
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return { ok: false, output: '下载只支持 http/https 地址。' };
      }
      if (target.username || target.password) return { ok: false, output: '下载地址不能包含凭据。' };
      page.allowOrigin(target.toString());
    }

    const maxBytes = Number.isSafeInteger(input.maxBytes) ? input.maxBytes : DEFAULT_MAX_DOWNLOAD_BYTES;
    // A URL download is bounded by wall-clock time, not by "has a file started
    // arriving": a host that never answers would otherwise hold the agent's
    // turn until the host RPC deadline expires with no usable message.
    const downloadTimeoutMs = Number.isSafeInteger(input.timeoutMs) ? input.timeoutMs : DOWNLOAD_TIMEOUT_MS;

    if (!target) {
      // No URL: the file comes from a click the *caller* is about to make.
      // That call cannot be issued from here without re-entering this service,
      // so this only arms the next click and says so.
      page.armedDownload = { maxBytes, suggestedName: typeof input.name === 'string' ? input.name : undefined };
      return {
        ok: true,
        output: '已准备接收下载。现在对页面上的下载链接调用 background_browser_click，文件会保存到工作区 downloads/ 目录，并随点击结果一起返回路径。',
        data: { browserId: input.browserId, armed: true },
      };
    }

    const result = await new Promise((resolve) => {
      const pending = {
        resolve,
        maxBytes,
        suggestedName: typeof input.name === 'string' ? input.name : undefined,
      };
      page.pendingDownload = pending;
      // The download handler clears `pendingDownload` the moment a transfer
      // starts, so a still-installed entry means no download has begun yet.
      const isLive = () => page.pendingDownload === pending;
      // Once a transfer has started, the caller is still waiting on it — the
      // request latch below is what keeps the failure path able to answer.
      const request = {
        claimed: false,
        claim() {
          if (this.claimed || !isLive()) return null;
          this.claimed = true;
          page.downloadRequest = this;
          return pending;
        },
      };
      page.downloadRequest = request;
      // What the transfer actually did, so the fallback below can tell an
      // interruption (retry through the session) from a page answer.
      let downloadState = null;
      pending.onFailure = (state) => {
        downloadState = state || 'failed';
        void fallback(downloadState);
      };
      // The download latch, not `page.pendingDownload`: the handler releases
      // that as soon as the transfer starts, and both a success and a failure
      // must still be able to answer this caller.
      const awaiting = () => page.downloadRequest === request && !request.settled;
      const timer = setTimeout(() => {
        if (!awaiting()) return;
        request.settled = true;
        page.downloadRequest = null;
        page.pendingDownload = null;
        resolve({ ok: false, output: `下载超时：${Math.round(downloadTimeoutMs / 1000)} 秒内没有收到文件。链接可能指向一个网页而不是文件，可先用 navigate 打开它再 inspect。` });
      }, downloadTimeoutMs);
      timer.unref?.();

      const settleOnce = (value) => {
        if (request.settled) return;
        request.settled = true;
        page.downloadRequest = null;
        page.pendingDownload = null;
        clearTimeout(timer);
        resolve(value);
      };
      request.settle = settleOnce;
      const fallback = async (state) => {
        if (request.settled) return;
        try {
          const fetched = await this._fetchIntoDownloads(page, target, maxBytes, pending.suggestedName);
          // When the retry is what failed, say what the download manager saw
          // too — `interrupted` is the site refusing this client, and a reader
          // debugging "why can't it fetch this PDF" needs that distinction.
          const output = fetched.ok || !state || state === 'cancelled'
            ? fetched.output
            : `${fetched.output}（浏览器直接下载也失败了：${state}）`;
          settleOnce({ ...fetched, output });
        } catch (error) {
          settleOnce({ ok: false, output: `下载失败：${error instanceof Error ? error.message : String(error)}` });
        }
      };

      // `downloadURL` starts the transfer on this webContents' session — the
      // same cookies and partition a click would use — without navigating the
      // visible page. Navigating here instead left two failure modes: a
      // download response rejects `loadURL` with ERR_FAILED (so the caller saw
      // an error while the file was actually arriving), and a page response
      // would silently replace the page the agent was reading.
      page.win.webContents.downloadURL(target.toString());
      void (async () => {
        // Most hosts serve a file as a file. A few (Cloudflare-fronted sites do
        // this) treat a programmatic download differently and answer with an
        // HTML challenge; Chromium reports that as `interrupted` with 0 bytes,
        // which says nothing the model can act on. So once the manager has had
        // time to report, retry through the page's own session — which carries
        // whatever cookie the page already holds — and file the bytes here.
        // A completed transfer settles first and never reaches this.
        await new Promise((r) => setTimeout(r, 1500));
        if (request.settled) return;
        await fallback(downloadState);
      })();
    });

    return { ...result, data: { browserId: input.browserId, ...(result.data ?? {}) } };
  }

  /**
   * Save a URL's body with `session.fetch`, which shares the page's cookies.
   *
   * Used only when `downloadURL` produced nothing — the download manager is the
   * primary path because it handles content-disposition, ranges and large files
   * natively. This fallback exists for hosts that treat a programmatic download
   * differently from a page request; it reports an HTML answer as an HTML
   * answer instead of a mysterious failure, because "the site blocked this" and
   * "the link is a web page" lead the model to different next steps.
   */
  async _fetchIntoDownloads(page, target, maxBytes, suggestedName) {
    const response = await page.win.webContents.session.fetch(target.toString(), { redirect: 'follow' });
    if (!response.ok) {
      return { ok: false, output: `下载失败：服务器返回 HTTP ${response.status}。该站点可能拒绝这个请求，可用 navigate 打开页面后手动点击下载链接。` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      return { ok: false, output: `下载失败：文件 ${Math.round(buffer.length / (1024 * 1024))} MB，超过 ${Math.round(maxBytes / (1024 * 1024))} MB 上限。` };
    }
    const contentType = response.headers.get('content-type') || '';
    const disposition = response.headers.get('content-disposition') || '';
    const looksText = /^(text\/html|text\/plain|application\/json|application\/xml)/i.test(contentType);
    if (looksText && buffer.subarray(0, 512).toString('utf8').toLowerCase().includes('<html')) {
      return {
        ok: false,
        output: `该地址返回的是网页而不是文件（HTTP ${response.status}${contentType ? `，${contentType}` : ''}）。站点可能要求先浏览页面再下载，可用 navigate 打开它后点击链接。`,
        data: { browserId: page.browserId, html: true },
      };
    }

    // Name from the disposition when the server sent one, else from the path.
    let requested = suggestedName;
    if (!requested) {
      const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const fromPath = decodeURIComponent(new URL(target.toString()).pathname.split('/').pop() || '');
      requested = fromHeader ? decodeURIComponent(fromHeader) : fromPath;
    }
    const name = uniqueDownloadName(page.downloadRoot, sanitizeDownloadName(requested, suggestedName));
    const relative = path.posix.join(DOWNLOAD_DIR, name);
    await fs.mkdir(path.join(page.downloadRoot, DOWNLOAD_DIR), { recursive: true });
    await fs.writeFile(path.join(page.downloadRoot, DOWNLOAD_DIR, name), buffer);
    page.downloads.push({ path: relative, url: target.toString(), bytes: buffer.length });
    return {
      ok: true,
      output: `已下载 ${name}（${buffer.length} 字节）到 ${relative}。`,
      data: { path: relative, bytes: buffer.length, filename: name, url: target.toString(), contentType },
    };
  }

  async inspect({ sessionId, input }) {
    const page = this._page(sessionId, input.browserId);
    const maxElements = Number.isSafeInteger(input.maxElements) ? input.maxElements : DEFAULT_MAX_ELEMENTS;
    const snapshot = await page.win.webContents.executeJavaScript(buildInspectScript(maxElements), false);
    // Links are read in a second pass so the element snapshot stays the same
    // shape it always was; the model gets the hrefs it needs to follow or
    // download, resolved to absolute URLs by the page itself.
    const links = await page.win.webContents
      .executeJavaScript(buildLinksScript(MAX_LINKS), false)
      .catch(() => []);

    const text = typeof snapshot?.text === 'string' ? snapshot.text : '';
    const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
    const lines = [`页面：${page.url}`, `标题：${snapshot?.title ?? ''}`, '', '可见文本：', text];
    if (elements.length > 0) {
      lines.push('', '可交互元素：');
      for (const element of elements) {
        const name = String(element.name ?? '').slice(0, 120);
        lines.push(`- ${element.tag}${element.type ? `[${element.type}]` : ''} ${element.selector}${name ? ` — ${name}` : ''}`);
      }
      if (snapshot?.truncated) lines.push(`（元素过多，仅列出前 ${elements.length} 个）`);
    }
    if (Array.isArray(links) && links.length > 0) {
      lines.push('', '页面链接（可直接交给 background_browser_navigate 或 background_browser_download）：');
      for (const link of links) {
        const label = String(link.text ?? '').slice(0, 100);
        lines.push(`- ${link.href}${label ? ` — ${label}` : ''}`);
      }
    }
    return {
      ok: true,
      output: lines.join('\n'),
      data: { browserId: input.browserId, url: page.url, hidden: true, elements, links, text },
    };
  }

  async click({ sessionId, input }) {
    const page = this._page(sessionId, input.browserId);
    const selector = String(input.selector);
    const button = typeof input.button === 'string' ? input.button : 'left';
    const double = input.double === true;

    // A click on a link whose response is a file fires `will-download` instead
    // of a navigation. When a download was armed by `background_browser_download`
    // (no url), the handler needs a pending entry to accept it — otherwise it
    // refuses the file as unsolicited and the click silently saves nothing.
    let downloadPromise;
    if (!page.pendingDownload && page.armedDownload) {
      const armed = page.armedDownload;
      page.armedDownload = null;
      downloadPromise = new Promise((resolve) => {
        page.pendingDownload = { resolve, maxBytes: armed.maxBytes, suggestedName: armed.suggestedName };
        const timer = setTimeout(() => {
          if (page.pendingDownload?.resolve !== resolve) return;
          page.pendingDownload = null;
          resolve({ ok: false, output: '点击后 30 秒内没有开始下载：该链接可能只是跳转到另一个网页。' });
        }, NAVIGATION_TIMEOUT_MS);
        timer.unref?.();
      });
    }

    const result = await page.win.webContents.executeJavaScript(buildClickScript(selector, button, double), false);
    if (!result?.ok) {
      // Nothing was clicked, so no file is coming: release the armed download
      // rather than leaving its caller waiting out the deadline.
      if (downloadPromise) releasePendingDownload(page, '点击失败，下载已取消。');
      return { ok: false, output: `点击失败：${result?.reason ?? '元素不存在'}` };
    }

    if (downloadPromise) {
      // Give the browser a moment to start the download; a plain link click
      // still resolves through the race's other branch below and reports as a
      // navigation instead.
      const outcome = await Promise.race([
        downloadPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (outcome) return { ...outcome, data: { browserId: input.browserId, ...(outcome.data ?? {}) } };
      releasePendingDownload(page, '该点击没有触发下载。');
    }

    return { ok: true, output: `已点击 ${selector}${double ? '（双击）' : ''}。`, data: { browserId: input.browserId, url: page.win.webContents.getURL() } };
  }

  async fill({ sessionId, input }) {
    const page = this._page(sessionId, input.browserId);
    const selector = String(input.selector);
    const value = String(input.value);
    const result = await page.win.webContents.executeJavaScript(buildFillScript(selector, value), false);
    if (!result?.ok) return { ok: false, output: `填写失败：${result?.reason ?? '元素不存在或不可填写'}` };
    return { ok: true, output: `已填写 ${selector}。`, data: { browserId: input.browserId, url: page.win.webContents.getURL() } };
  }

  async key({ sessionId, input }) {
    const page = this._page(sessionId, input.browserId);
    const key = String(input.key);
    const selector = typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : null;
    // Dispatched into the page's DOM, never to the OS: there is no native
    // keyboard surface here, so a real shortcut cannot be triggered.
    const result = await page.win.webContents.executeJavaScript(buildKeyScript(key, selector), false);
    if (!result?.ok) return { ok: false, output: `按键失败：${result?.reason ?? '无法派发按键'}` };
    return { ok: true, output: `已向页面发送按键 ${key}。`, data: { browserId: input.browserId, url: page.win.webContents.getURL() } };
  }

  async screenshot({ sessionId, input, workspaceRoot }) {
    const page = this._page(sessionId, input.browserId);
    // capturePage() grabs this hidden window's own surface, never the user's screen.
    const image = await page.win.webContents.capturePage();
    if (image.isEmpty()) return { ok: false, output: '截图失败：隐藏页面没有可捕获的内容。' };
    const png = image.toPNG();
    if (!png || png.length === 0) return { ok: false, output: '截图失败：隐藏页面没有可捕获的内容。' };

    // The CLI requires screenshots under workspace .aicode, so the model can be
    // shown the file later without a caller-chosen output path.
    const dir = path.join(workspaceRoot, SCREENSHOT_DIR);
    await fs.mkdir(dir, { recursive: true });
    const name = `bg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
    await fs.writeFile(path.join(dir, name), png);
    const relative = path.posix.join(SCREENSHOT_DIR, name);
    const size = image.getSize();

    return {
      ok: true,
      output: `已截取隐藏页面（${size.width}×${size.height}），保存为 ${relative}。`,
      data: {
        browserId: input.browserId,
        url: page.win.webContents.getURL(),
        hidden: true,
        computerImage: { mediaType: 'image/png', data: png.toString('base64'), path: relative },
      },
    };
  }

  async close({ sessionId, input }) {
    const owned = this._sessions.get(sessionId);
    const browserId = String(input.browserId);
    const page = owned?.get(browserId);
    if (!page) return { ok: true, output: '该后台浏览器已经关闭。' };
    // A download waiting on a click would otherwise hold its caller for the
    // full navigation deadline after its page is gone.
    if (page.pendingDownload) {
      const pending = page.pendingDownload;
      page.pendingDownload = null;
      pending.resolve({ ok: false, output: '随后台浏览器关闭，下载已取消。' });
    }
    owned.delete(browserId);
    if (owned.size === 0) this._sessions.delete(sessionId);
    page.close();
    return { ok: true, output: '已关闭此后台浏览器。', data: { browserId, hidden: true } };
  }

  /**
   * Execute one `background_browser_*` request from the CLI.
   *
   * Every failure is reported as `{ ok: false, output }` rather than thrown, so
   * the model sees a usable reason instead of a broken bridge.
   */
  async execute({ sessionId, workspaceRoot, tool, input, signal }) {
    if (this._disposed) return { ok: false, output: '后台浏览器已随应用退出。' };
    const args = { sessionId: String(sessionId), workspaceRoot, input: input ?? {}, signal };
    const abort = () => { if (tool !== 'background_browser_open' && args.input.browserId) void this.close({ sessionId: args.sessionId, input: { browserId: args.input.browserId } }); };
    try {
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      switch (tool) {
        case 'background_browser_open': return await this.open(args);
        case 'background_browser_navigate': return await this.navigate(args);
        case 'background_browser_inspect': return await this.inspect(args);
        case 'background_browser_click': return await this.click(args);
        case 'background_browser_fill': return await this.fill(args);
        case 'background_browser_key': return await this.key(args);
        case 'background_browser_download': return await this.download(args);
        case 'background_browser_screenshot': return await this.screenshot(args);
        case 'background_browser_close': return await this.close(args);
        default: return { ok: false, output: `后台浏览器不支持该操作：${tool}` };
      }
    } catch (error) {
      return { ok: false, output: `后台浏览器执行失败：${error instanceof Error ? error.message : String(error)}` };
    } finally { signal?.removeEventListener('abort', abort); }
  }

  /** One conversation's pages, for the settings panel's status list. */
  status() {
    const rows = [];
    for (const [sessionId, owned] of this._sessions) {
      for (const [browserId, page] of owned) {
        rows.push({ sessionId, browserId, url: page.url, hidden: true });
      }
    }
    return rows;
  }

  /** Close one conversation's pages; used when that conversation is reset. */
  async closeSession(sessionId) {
    const owned = this._sessions.get(String(sessionId));
    if (!owned) return;
    this._sessions.delete(String(sessionId));
    for (const page of owned.values()) {
      releasePendingDownload(page, '随后台浏览器关闭，下载已取消。');
      page.close();
    }
  }

  /** Every page, for a workspace switch or app shutdown. */
  async disposeAll() {
    const all = [...this._sessions.values()];
    this._sessions.clear();
    for (const owned of all) {
      for (const page of owned.values()) {
        releasePendingDownload(page, '后台浏览器已随应用退出，下载已取消。');
        page.close();
      }
    }
  }

  dispose() {
    this._disposed = true;
    void this.disposeAll();
  }
}

/**
 * A name that does not already exist under `downloads/`.
 *
 * Downloads keep the server's filename so the agent can match a file to the
 * link it came from. The cost of that is collisions: fetching the same paper
 * twice, or two results both named `document.pdf`, used to overwrite the first
 * copy without a word — the agent then analysed whichever arrived last. A
 * numeric suffix keeps both, and the returned path always names the file that
 * was actually written.
 */
function uniqueDownloadName(root, name) {
  const dir = path.join(root, DOWNLOAD_DIR);
  let candidate = name;
  let counter = 1;
  const split = path.parse(name);
  while (fsSync.existsSync(path.join(dir, candidate))) {
    candidate = `${split.name}-${counter}${split.ext}`;
    counter += 1;
    if (counter > 999) {
      candidate = `${split.name}-${Date.now()}${split.ext}`;
      break;
    }
  }
  return candidate;
}

/**
 * Settle a download that is still waiting, so its caller is not left holding
 * an open promise after its page and owner are gone.
 */
function releasePendingDownload(page, message) {
  const pending = page.pendingDownload;
  if (!pending) return;
  page.pendingDownload = null;
  pending.resolve({ ok: false, output: message });
}

/**
 * A filename that is safe to create under downloads/.
 *
 * `getFilename()` is the server's choice of name and is attacker-influenced: a
 * `Content-Disposition` of `../../.aicode/sessions/x.json` would otherwise be
 * written outside the download directory. Only the final path component is
 * kept, traversal segments are dropped, reserved Windows characters are
 * replaced, and an empty result falls back to a generated name.
 */
function sanitizeDownloadName(raw, suggested) {
  const source = String(suggested || raw || '').trim();
  // Strip any directory part — both separators, so a POSIX-style name is also
  // handled when running on Windows and vice versa.
  const base = source.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned;
  return `download-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Every hyperlink on the page, resolved to an absolute URL.
 *
 * The element list from `buildInspectScript` names a link by its text, which is
 * not enough to follow it: the href is what the model must hand to `navigate`
 * or `download`, and a relative href is meaningless without the page's own
 * base. Resolving here (in the page) also picks up `<base href>` correctly.
 */
function buildLinksScript(limit) {
  return `(() => {
    const seen = new Set();
    const links = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      let href;
      try { href = anchor.href; } catch { continue; }
      if (!href || seen.has(href)) continue;
      if (!/^https?:/i.test(href)) continue;
      seen.add(href);
      const text = (anchor.getAttribute('aria-label') || anchor.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160);
      links.push({ href, text });
      if (links.length >= ${Number.isSafeInteger(limit) ? limit : MAX_LINKS}) break;
    }
    return links;
  })()`;
}

/**
 * Build the page-side snapshot script.
 *
 * `maxElements` is the only interpolated value and it is validated as a safe
 * integer before this point; no caller-provided string reaches the code.
 */
function buildInspectScript(maxElements) {
  const limit = Number.isSafeInteger(maxElements) ? maxElements : DEFAULT_MAX_ELEMENTS;
  return `(() => {
    const limit = ${limit};
    const selectorFor = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 4) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
        node = parent;
      }
      return parts.join(' > ');
    };
    const all = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]'));
    const elements = all.slice(0, limit).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      selector: selectorFor(el),
      name: (el.getAttribute('aria-label') || (el.tagName === 'INPUT' && ['password', 'hidden'].includes(el.type) ? '[redacted]' : el.value || el.textContent || '')).trim().replace(/\\s+/g, ' ').slice(0, 120),
    }));
    const body = document.body ? document.body.innerText : '';
    return {
      title: document.title || '',
      url: location.href,
      text: (body || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_SNAPSHOT_TEXT}),
      elements,
      truncated: all.length > limit,
    };
  })()`;
}

function buildClickScript(selector, button, double) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: '未找到匹配元素' };
    el.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window, button: ${JSON.stringify(button)} };
    if (${double ? 'true' : 'false'}) el.dispatchEvent(new MouseEvent('dblclick', opts));
    else el.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true };
  })()`;
}

function buildFillScript(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: '未找到匹配元素' };
    if (el.tagName === 'SELECT') {
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return { ok: false, reason: '元素不是可填写的输入框' };
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
}

function buildKeyScript(key, selector) {
  const target = selector
    ? `document.querySelector(${JSON.stringify(selector)}) || document.activeElement || document.body`
    : 'document.activeElement || document.body';
  return `(() => {
    const target = ${target};
    if (!target) return { ok: false, reason: '页面没有可接收按键的元素' };
    const parts = ${JSON.stringify(key)}.split('+');
    const base = parts.pop();
    const init = { key: base === 'Space' ? ' ' : base, code: base, bubbles: true, cancelable: true,
      ctrlKey: parts.includes('Control') || parts.includes('Ctrl'),
      metaKey: parts.includes('Meta'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true };
  })()`;
}

function createBackgroundBrowserService() {
  return new BackgroundBrowserService();
}

module.exports = {
  createBackgroundBrowserService,
  BackgroundBrowserService,
  // Exported for the unit tests: the page-side scripts are built here, and the
  // guarantee that no caller string reaches executable code lives in them.
  buildInspectScript,
  buildClickScript,
  buildFillScript,
  buildKeyScript,
  buildLinksScript,
  sanitizeDownloadName,
};
