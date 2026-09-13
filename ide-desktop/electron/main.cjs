const { app, BrowserWindow, Menu, Notification, safeStorage, protocol, nativeImage } = require('electron');
const path = require('node:path');
const { automationBus } = require('./automation.cjs');

// Windows shows toast notifications only when the app has a stable
// AppUserModelId; without it the Electron default is silently dropped.
if (process.platform === 'win32') app.setAppUserModelId('com.yoycode.desktop');

// The renderer draws its own minimal top bar; drop Electron's native
// File/Edit/View/Window/Help application menu.
Menu.setApplicationMenu(null);
const { createWorkspaceService } = require('./workspace.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { createSecretStore } = require('./secret-store.cjs');
const { createSnippetsStore } = require('./snippets-store.cjs');
const { createBookmarkStore } = require('./bookmarks-store.cjs');
const { createFileHistoryStore } = require('./file-history.cjs');
const { createSessionNotesStore } = require('./session-notes.cjs');
const { createSessionTagsStore } = require('./session-tags.cjs');
const { createKeybindingsStore } = require('./keybindings-store.cjs');
const { registerIpc } = require('./ipc.cjs');
const { AgentBridge } = require('./agent-bridge.cjs');
const { TerminalManager } = require('./terminal.cjs');
const { syncPersonaFile } = require('./persona.cjs');
const { cliProviderName, resolveBaseUrl } = require('./provider-map.cjs');
const { testProviderConnection } = require('./connectivity.cjs');
const { createUsageStore } = require('./usage-store.cjs');
const { createAutomationService } = require('./automation.cjs');
const { registerSchemePrivileges } = require('./preview-protocol.cjs');
const { createPreviewService } = require('./preview-service.cjs');
const { createPreviewRuntime } = require('./preview-runtime.cjs');
const { createFimServer } = require('./fim-server.cjs');
const { createLanguageServer } = require('./language-server.cjs');
const { CompletionService } = require('./completion-service.cjs');
const sandbox = require('./sandbox.cjs');

// Register custom scheme BEFORE app.ready (required by Electron)
registerSchemePrivileges(protocol);

let mainWindow;

// Clamp any stored/incoming value to a known reasoning tier; unknown → 'auto'.
function normalizeEffort(value) {
  return ['auto', 'off', 'low', 'medium', 'high', 'max'].includes(value) ? value : 'auto';
}

function normalizeToolScope(value) {
  return ['auto', 'compact', 'standard', 'full'].includes(value) ? value : 'auto';
}

// Token size of the active model's context window, taken from the provider's
// model catalog (same source the renderer's context-usage badge uses).
// undefined → the CLI keeps auto-compaction disarmed and /compact stays manual.
function contextWindowForModel(providerConfig) {
  if (!providerConfig || !Array.isArray(providerConfig.models)) return undefined;
  const match = providerConfig.models.find((entry) => entry && entry.id === providerConfig.model);
  const tokens = match && Number(match.contextWindow);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;
}

/*
 * OS-level notification for key task states (approval needed / turn done /
 * error / agent offline). Honors the 常规→通知 preferences:
 *  - gen.turnNotify: 'always' | 'unfocused' (default) | 'never'
 *  - gen.permissionNotify: approval reminders can be switched off entirely
 * When the user is looking at the app, the in-app toasts already cover it.
 * Clicking the notification focuses the window.
 */
async function notifyKeyState(event, window, settingsStore) {
  const rules = {
    approval_needed: { title: '需要确认执行', body: `工具 ${String(event.tool || '')} 等待你的批准`, pref: 'permission' },
    turn_done: { title: '任务完成', body: '智能体已完成本轮工作', pref: 'turn' },
    error: { title: '执行出错', body: String(event.message || '智能体报告了一个错误'), pref: 'turn' },
    agent_offline: { title: '连接断开', body: '智能体已离线，下次提问时会自动重连', pref: 'turn' },
  };
  const rule = rules[event.type];
  if (!rule) return;

  let prefs = {};
  try {
    const config = settingsStore ? await settingsStore.get() : null;
    prefs = (config && config.preferences) || {};
  } catch {
    // Settings unavailable: fall back to the unfocused-only default.
  }
  if (rule.pref === 'permission' && prefs['gen.permissionNotify'] === false) return;
  const background = !window || window.isDestroyed() || window.isMinimized() || !window.isFocused();
  if (rule.pref === 'turn') {
    const mode = typeof prefs['gen.turnNotify'] === 'string' ? prefs['gen.turnNotify'] : 'unfocused';
    if (mode === 'never') return;
    if (mode === 'unfocused' && !background) return;
  } else if (!background) {
    // Approval reminders: background-only as well (the in-app toast covers the
    // focused case; a system banner on top of it would be pure noise).
    return;
  }
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({ title: rule.title, body: rule.body, silent: false });
    notification.on('click', () => {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.focus();
      }
    });
    notification.show();
  } catch {
    // Notification failures (permission, OS policy) must never break the event stream.
  }
}

function createAgentManager({ mainWindow, workspace, settings, secrets }) {
  let bridge;
  // Request ids the sandbox already answered, so a late user click on the
  // (now auto-decided) card can't send a second, conflicting decision.
  const sandboxDecided = new Set();

  /**
   * Run one approval_needed event through the sandbox policy and, when the
   * policy decides, answer the CLI broker directly. The renderer receives the
   * same event annotated with `autoDecision`/`autoReason` so the card renders
   * the outcome plus its cause instead of live buttons.
   */
  async function applySandboxPolicy(activeBridge, event) {
    try {
      const config = await settings.get();
      const prefs = (config && config.preferences) || {};
      const mode = sandbox.normalizeMode(prefs['gen.sandboxMode']);
      if (mode === 'off') return;
      const verdict = sandbox.evaluate(event, { mode, workspaceRoot: workspace.getRoot() });
      if (verdict.decision === 'pass') return;
      const requestId = String(event.requestId || '');
      if (!requestId || sandboxDecided.has(requestId)) return;
      sandboxDecided.add(requestId);
      // Cap the memo so a very long-lived bridge can't grow it unbounded.
      if (sandboxDecided.size > 500) sandboxDecided.clear();
      const decision = verdict.decision === 'allow' ? 'allow_once' : 'deny';
      event.autoDecision = decision;
      event.autoReason = verdict.reason || '';
      await activeBridge.approve(requestId, decision);
      // The annotated approval_needed event (forwarded by the caller after
      // this promise settles) carries the outcome to the renderer; the
      // reducer folds it straight into the card's decided state.
    } catch {
      // Policy/bridge failures must never break the event stream; the CLI
      // approval timeout path already denies unanswered requests.
    }
  }

  async function start(resumeSessionId) {
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
    if (bridge) bridge.dispose();
    // The CLI only knows mock/openai/anthropic wire formats. A custom provider
    // declares which one via apiFormat. Base URL is forced to the official
    // OpenAI endpoint only for the built-in openai provider when empty (never
    // fall through to the CLI's third-party proxy default). See provider-map.
    const provider = cliProviderName(providerConfig);
    const baseUrl = resolveBaseUrl(providerConfig);
    // Materialize the desktop persona (个性化 settings) into the workspace so
    // the CLI picks it up as project context on the next turn.
    await syncPersonaFile(workspace.getRoot(), config.preferences);
    // Reasoning effort tier persists in preferences; default 'off' (no thinking).
    const reasoningEffort = normalizeEffort(config.preferences && config.preferences.reasoningEffort);
    const toolScope = normalizeToolScope(config.preferences && config.preferences.toolScope);
    bridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      sessionDir: path.join(workspace.getRoot(), '.aicode', 'sessions'),
      provider,
      model: providerConfig.model,
      baseUrl,
      apiKey,
      customProvider: providerConfig.type === 'custom',
      computerAnyApp: config.preferences?.computerAnyApp === true,
      allowedApps: Array.isArray(config.preferences?.computerAllowedApps) ? config.preferences.computerAllowedApps : [],
      excelAutomation: config.preferences?.computerExcel === true,
      approval: config.approval,
      reasoningEffort,
      toolScope,
      contextWindowTokens: contextWindowForModel(providerConfig),
      confirmPlan: config.preferences?.taskExecutionMode === 'auto',
      resumeSessionId: resumeSessionId || undefined,
    });
    const forward = (event) => {
      // The window may be closing while the child is still draining events.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent.event', event);
      notifyKeyState(event, mainWindow, settings);
      if (event.type === 'automation_done') {
        // Bug-12 fix: use the dedicated automationBus instead of mainWindow.emit()
        // so the handler in automation.cjs survives window recreation.
        automationBus.emit('automation.done', event);
      }
    };
    bridge.on('event', (event) => {
      // Sandbox interception: before the user ever sees an approval prompt,
      // the policy engine may answer it outright. The annotated event then
      // flows to the renderer so the card shows WHY it was auto-decided.
      // Forwarding must wait for the annotation, or the card would briefly
      // render live buttons and never learn the outcome.
      if (event && event.type === 'approval_needed') {
        void applySandboxPolicy(bridge, event).finally(() => forward(event));
        return;
      }
      forward(event);
    });
    // Do not report startup complete until the CLI has emitted bridge_ready;
    // otherwise the first prompt can race the child process initialization.
    await bridge.start();
    return { ok: true };
  }

  // ── Side chat: an independent bridge with its own session ──────────────────
  // Runs alongside the main conversation instead of sharing it. Writes are
  // auto-denied (approval: 'deny'), so the side agent is a read-only assistant
  // that can inspect the workspace while the main agent is editing.
  let sideBridge;
  async function startSideChat() {
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
    if (sideBridge) sideBridge.dispose();
    sideBridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      // Separate session scope so side conversations never appear in (or get
      // resumed by) the main session list.
      sessionDir: path.join(workspace.getRoot(), '.aicode', 'sessions-side'),
      provider: cliProviderName(providerConfig),
      model: providerConfig.model,
      baseUrl: resolveBaseUrl(providerConfig),
      apiKey,
      approval: 'deny',
      contextWindowTokens: contextWindowForModel(providerConfig),
    });
    sideBridge.on('event', (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sidechat.event', event);
    });
    await sideBridge.start();
  }

  return {
    start(resumeSessionId) {
      return start(resumeSessionId);
    },
    async taskBoardAction(action, taskId) {
      if (!bridge) throw new Error('Agent is not started');
      await bridge.taskBoardAction(action, taskId);
      return { ok: true };
    },
    async prompt(text, files, toolScope) {
      // Recover from a bridge that failed during startup or exited before the
      // renderer sent its first prompt. The old synchronous throw forced the
      // user to resend the message manually.
      if (!bridge || !bridge.child) await start();
      if (!bridge || !bridge.child) throw new Error('Agent bridge failed to start');
      await bridge.prompt(text, files, toolScope);
      return { ok: true };
    },
    async automationTask(taskId, goal) {
      if (!bridge) await start();
      await bridge.automationTask(taskId, goal);
      return { ok: true };
    },
    async sideChatPrompt(text) {
      const normalized = String(text ?? '');
      if (!normalized.trim()) throw new Error('Side chat message is empty');
      if (!sideBridge || !sideBridge.child) await startSideChat();
      if (!sideBridge || !sideBridge.child) throw new Error('Side chat bridge failed to start');
      await sideBridge.prompt(normalized);
      return { ok: true };
    },
    sideChatCancel() {
      if (sideBridge) sideBridge.cancel();
      return { ok: true };
    },
    /** Drop the side session so the next prompt starts a fresh conversation. */
    sideChatReset() {
      if (sideBridge) {
        sideBridge.dispose();
        sideBridge = undefined;
      }
      return { ok: true };
    },
    /** Workspace switch: the side agent is workspace-bound like the main one. */
    sideChatRestart() {
      if (sideBridge) {
        sideBridge.dispose();
        sideBridge = undefined;
      }
      return { ok: true };
    },
    setEffort(reasoningEffort) {
      const normalized = normalizeEffort(reasoningEffort);
      // Update the live child if running; otherwise it takes effect at next start.
      if (bridge) bridge.setEffort(normalized);
      return { ok: true, reasoningEffort: normalized };
    },
    setToolScope(toolScope) {
      const normalized = normalizeToolScope(toolScope);
      if (bridge) bridge.setToolScope(normalized);
      return { ok: true, toolScope: normalized };
    },
    async approve(requestId, decision) {
      if (!bridge) throw new Error('Agent is not started');
      await bridge.approve(requestId, decision);
      return { ok: true };
    },
    async undo(checkpointIds, undoId) {
      if (!bridge) throw new Error('Agent is not started');
      await bridge.undo(Array.isArray(checkpointIds) ? checkpointIds : [], undoId);
      return { ok: true };
    },
    cancel() {
      if (bridge) bridge.cancel();
      return { ok: true };
    },
    async restart() {
      if (bridge) await bridge.restart();
      else await start();
      return { ok: true };
    },
    /**
     * Drop the live bridge without starting a new one. The approval mode is
     * baked into the CLI child at spawn time, so changing it in settings must
     * invalidate the running bridge; the next prompt lazily re-starts with the
     * new mode (prompt() already recovers from a missing bridge).
     */
    invalidate() {
      if (bridge) {
        bridge.dispose();
        bridge = null;
      }
      return { ok: true };
    },
    dispose() {
      if (bridge) bridge.dispose();
      if (sideBridge) sideBridge.dispose();
    },
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'YOYcode Desktop IDE',
    backgroundColor: '#f8fafc',
    // Windows falls back to the exe's default (atom) icon when the window
    // icon is EMPTY, so hand it a real 16x16 fully-transparent bitmap instead
    // — a valid icon that simply renders nothing in the title bar.
    icon: nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4), { width: 16, height: 16 }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  const workspace = createWorkspaceService();
  const settings = createSettingsStore(app.getPath('userData'));
  const secrets = createSecretStore({ userDataDir: app.getPath('userData'), safeStorage });
  const snippets = createSnippetsStore(app.getPath('userData'));
  const bookmarks = createBookmarkStore(() => workspace.getRoot());
  const fileHistory = createFileHistoryStore(app.getPath('userData'));
  const notes = createSessionNotesStore(app.getPath('userData'));
  const sessionTags = createSessionTagsStore(() => workspace.getRoot());
  const keybindings = createKeybindingsStore(app.getPath('userData'));
  const connectivity = { test: (args) => testProviderConnection(args) };
  const usage = createUsageStore();
  const agentManager = createAgentManager({ mainWindow, workspace, settings, secrets });
  const automation = createAutomationService({ workspace, agentManager, mainWindow });
  const terminalManager = new TerminalManager();
  const previewService = createPreviewService(mainWindow);
  const previewRuntime = createPreviewRuntime();
  const cliRoot = path.resolve(__dirname, '..', '..', 'cli');

  // Completion service: lazy init on first request
  let completionService = null;
  async function ensureCompletionService() {
    if (completionService) return completionService;
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id).catch(() => '');
    
    // 使用 Haiku 作为补全模型（更快更便宜）
    const completionModel = config.preferences?.completionModel || 'claude-3-5-haiku-20241022';
    const provider = cliProviderName(providerConfig);
    const baseUrl = resolveBaseUrl(providerConfig);
    
    completionService = new CompletionService({
      provider,
      model: completionModel,
      baseUrl,
      apiKey
    });
    
    return completionService;
  }

  // FIM server: boot lazily when first completion is requested
  let fimServer = null;
  async function ensureFimServer() {
    if (fimServer) return fimServer;
    const config = await settings.get();
    const providerConfig = config.providers?.[config.preferences?.defaultProvider || 'openai'] || {};
    const apiKey = providerConfig.apiKey || process.env.OPENAI_API_KEY || '';
    const fimModel = config.preferences?.fimModel || providerConfig.model;
    const fimProvider = providerConfig.type === 'mock' ? 'openai' : (providerConfig.apiFormat ?? providerConfig.type ?? 'openai');
    fimServer = createFimServer({ cliRoot, provider: fimProvider, apiKey, baseUrl: providerConfig.baseUrl || '', model: fimModel });
    return fimServer;
  }

  // Language server: boot on first hover/definition/references request
  let languageServer = null;
  async function ensureLanguageServer() {
    if (languageServer) return languageServer;
    languageServer = createLanguageServer({ cliRoot });
    return languageServer;
  }

  terminalManager.on('event', (event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('terminal.event', event);
  });

  // Forward preview guest state changes to the renderer
  previewService.onState((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('preview.state', state);
  });

  mainWindow.on('closed', () => {
    terminalManager.disposeAll();
    void automation.disposeAll();
    previewService.dispose();
    void previewRuntime.stopAll();
    if (fimServer) { fimServer.stop(); fimServer = null; }
    if (languageServer) { languageServer.stop(); languageServer = null; }
    // The agent children must not outlive the window: they would keep running
    // turns (and writing to the workspace) with nowhere to send their events.
    agentManager.dispose();
  });
  registerIpc({ mainWindow, workspace, settings, secrets, connectivity, usage, automation, agentManager, terminalManager, previewService, previewRuntime, ensureFimServer, ensureCompletionService, ensureLanguageServer, snippets, bookmarks, fileHistory, notes, sessionTags, keybindings });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const loadPromise = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  loadPromise.catch((error) => {
    console.error('Failed to load the YOYcode window:', error);
    if (!mainWindow.isDestroyed()) mainWindow.show();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
