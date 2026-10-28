/**
 * preview-service.cjs
 * Manages an Electron WebContentsView that shows web pages and PDFs in the
 * right-side preview pane. The view has no preload, sandbox: true, and an
 * ephemeral session — it cannot access window.zcodeDesktop.
 */
'use strict';
const path = require('node:path');
const { WebContentsView, session, shell } = require('electron');
const { handlePreviewProtocol } = require('./preview-protocol.cjs');

class PreviewService {
  constructor(mainWindow) {
    this._win     = mainWindow;
    this._view    = null;
    this._partition = null;
    this._tokenRegistry = new Map();
    // Static preview servers require a per-server capability header. Keep the
    // mapping in the isolated preview session rather than putting tokens in
    // URLs, where they could leak through history or referrers.
    this._runtimeTokens = new Map(); // loopback port → token
    this._bounds  = { x: 0, y: 0, width: 0, height: 0 };
    this._visible = false;
    this._stateListeners = [];
    this._mode = 'preview'; // 'preview' | 'browser'
  }

  /** Register a file token so the custom protocol can validate requests. */
  registerToken(token, entry) { this._tokenRegistry.set(token, entry); }
  revokeToken(token) {
    this._tokenRegistry.delete(token);
    for (const [port, serverToken] of this._runtimeTokens) {
      if (serverToken === token) this._runtimeTokens.delete(port);
    }
  }
  /** Drop every registered capability; used when the workspace changes. */
  revokeAllTokens() {
    this._tokenRegistry.clear();
    this._runtimeTokens.clear();
  }

  /**
   * Inject the capability header only for requests to the currently displayed
   * local preview server. Electron's webRequest API runs in the isolated
   * session, so renderer pages cannot forge or observe this header.
   */
  registerRuntimeToken(port, token) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token) {
      throw new Error('Invalid preview runtime capability');
    }
    this._runtimeTokens.set(port, token);
  }

  revokeRuntimeToken(token) {
    for (const [port, serverToken] of this._runtimeTokens) {
      if (serverToken === token) this._runtimeTokens.delete(port);
    }
  }

  validateToken(token, expected = {}) {
    if (typeof token !== 'string' || !token) return false;
    const entry = this._tokenRegistry.get(token);
    if (!entry || typeof entry !== 'object') return false;
    const samePath = (left, right) => {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      const a = path.resolve(left);
      const b = path.resolve(right);
      return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    };
    if (expected.workspaceRoot !== undefined && !samePath(entry.workspaceRoot, expected.workspaceRoot)) return false;
    if (expected.kind !== undefined && entry.kind !== expected.kind) return false;
    if (expected.absolutePath !== undefined && !samePath(entry.absolutePath, expected.absolutePath)) return false;
    return true;
  }

  getTokenEntry(token) { return this._tokenRegistry.get(token) || null; }

  _onState(state) { for (const fn of this._stateListeners) fn(state); }

  _navigationState() {
    const history = this._view?.webContents.navigationHistory;
    return {
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
    };
  }

  onState(fn) {
    this._stateListeners.push(fn);
    return () => { this._stateListeners = this._stateListeners.filter((f) => f !== fn); };
  }

  _createView() {
    if (this._view) return;

    // Each view gets its own isolated in-memory session
    const partitionName = `preview-${Date.now()}`;
    this._partition = partitionName;
    const ses = session.fromPartition(`memory:${partitionName}`, { cache: false });

    // Attach the custom protocol handler to this session
    handlePreviewProtocol(ses, this._tokenRegistry);

    // Add the capability header only for registered loopback preview ports.
    // Header details are never exposed to the renderer page.
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1:*/*'] }, (details, callback) => {
      try {
        const u = new URL(details.url);
        const port = Number(u.port || 80);
        const token = this._runtimeTokens.get(port);
        if (token) details.requestHeaders['X-Preview-Token'] = token;
      } catch { /* malformed request; leave it unchanged */ }
      callback({ requestHeaders: details.requestHeaders });
    });
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    // Block downloads
    ses.on('will-download', (e) => e.preventDefault());

    this._view = new WebContentsView({
      webPreferences: {
        nodeIntegration:    false,
        contextIsolation:   true,
        sandbox:            true,
        webviewTag:         false,
        preload:            undefined,
        partition:          `memory:${partitionName}`,
      },
    });
    const wc = this._view.webContents;

    // Navigation policy — re-evaluated on every navigation so mode changes take effect
    const shouldAllowUrl = (url) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'yoycode-preview:') return true;
        if (this._mode === 'browser') {
          // Browser panel: allow all http/https
          return u.protocol === 'http:' || u.protocol === 'https:';
        }
        // Preview panel: only loopback with matching port
        return u.hostname === '127.0.0.1' &&
          (u.protocol === 'http:' || u.protocol === 'https:') &&
          (!this._allowedPort || u.port === String(this._allowedPort));
      } catch { return false; }
    };

    wc.on('will-navigate', (e, url) => {
      if (!shouldAllowUrl(url)) {
        e.preventDefault();
        if (this._mode === 'browser') {
          // In browser mode: load the URL directly (handles redirects from http→https etc.)
          setImmediate(() => wc.loadURL(url).catch(() => {}));
        } else {
          this._onState({ externalLinkRequest: url });
        }
      }
    });

    // Suppress subframe navigation (ads, iframes navigating to different origins)
    wc.on('will-frame-navigate', (e) => {
      if (e.frame !== wc.mainFrame) e.preventDefault();
    });

    // target="_blank" and window.open() — load inline in browser mode, block in preview
    wc.setWindowOpenHandler(({ url }) => {
      if (this._mode === 'browser') {
        try {
          const u = new URL(url);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            setImmediate(() => wc.loadURL(url).catch(() => {}));
          }
        } catch { /* ignore */ }
      } else {
        this._onState({ externalLinkRequest: url });
      }
      return { action: 'deny' };
    });

    wc.on('did-start-loading', () => this._onState({ loading: true }));
    wc.on('did-stop-loading',  () => this._onState({ loading: false, url: wc.getURL(), title: wc.getTitle(), ...this._navigationState() }));
    wc.on('did-fail-load', (_e, code, desc) => this._onState({ loading: false, error: desc || String(code) }));
    wc.on('page-title-updated', (_e, title) => this._onState({ title }));
    wc.on('did-navigate', (_e, url) => this._onState({ url, ...this._navigationState() }));
    wc.on('did-navigate-in-page', (_e, url) => this._onState({ url, ...this._navigationState() }));

    this._win.contentView.addChildView(this._view);
  }

  _currentOrigin() {
    if (!this._view) return null;
    try { const u = new URL(this._view.webContents.getURL()); return u.origin; } catch { return null; }
  }

  _isAllowedUrl(url) {
    try {
      const u = new URL(url);
      // Allow yoycode-preview:// scheme
      if (u.protocol === 'yoycode-preview:') return true;
      // Browser mode (allowedPort === 'browser'): allow all http/https navigation
      if (this._allowedPort === 'browser') {
        return u.protocol === 'http:' || u.protocol === 'https:';
      }
      // Preview mode: only allow loopback with matching port
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return u.hostname === '127.0.0.1' && (!this._allowedPort || u.port === String(this._allowedPort));
      }
      return false;
    } catch { return false; }
  }

  _offerExternal(url) {
    // In browser mode: navigate directly instead of offering external
    if (this._mode === 'browser') {
      this._view?.webContents.loadURL(url).catch(() => {});
      return;
    }
    this._onState({ externalLinkRequest: url });
  }

  setBounds(rect) {
    this._bounds = rect;
    if (this._view && this._visible) this._view.setBounds(rect);
  }

  show() {
    this._visible = true;
    this._createView();
    this._view.setBounds(this._bounds);
  }

  hide() {
    this._visible = false;
    if (this._view) this._view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  /**
   * Load a URL (yoycode-preview://... or http://127.0.0.1:port/...).
   * allowedPort: if non-null, only that loopback port is allowed for navigation.
   */
  loadUrl(url, allowedPort = null) {
    this._allowedPort = allowedPort;
    // Set mode based on allowedPort sentinel value
    this._mode = (allowedPort === 'browser') ? 'browser' : 'preview';
    this._createView();
    this.show();
    this._view.webContents.loadURL(url).catch((err) => {
      this._onState({ loading: false, error: err.message });
    });
  }

  back()    { this._view?.webContents.goBack(); }
  forward() { this._view?.webContents.goForward(); }
  reload()  { this._view?.webContents.reload(); }

  canGoBack()    { return this._navigationState().canGoBack; }
  canGoForward() { return this._navigationState().canGoForward; }

  openExternal(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url);
    } catch { /* ignore */ }
  }

  dispose() {
    if (this._view) {
      try { this._win.contentView.removeChildView(this._view); } catch { /* ignore */ }
      try { this._view.webContents.destroy(); } catch { /* ignore */ }
      this._view = null;
    }
    this._tokenRegistry.clear();
    this._runtimeTokens.clear();
    this._stateListeners = [];
    this._visible = false;
  }
}

function createPreviewService(mainWindow) {
  return new PreviewService(mainWindow);
}

module.exports = { createPreviewService };
