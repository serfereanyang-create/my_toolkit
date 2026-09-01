const { app, BrowserWindow, Menu, safeStorage, protocol } = require('electron');
const path = require('node:path');
const { automationBus } = require('./automation.cjs');

// The renderer draws its own minimal top bar; drop Electron's native
// File/Edit/View/Window/Help application menu.
Menu.setApplicationMenu(null);
const { createWorkspaceService } = require('./workspace.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { createSecretStore } = require('./secret-store.cjs');
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

function createAgentManager({ mainWindow, workspace, settings, secrets }) {
  let bridge;

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
      confirmPlan: config.preferences?.taskExecutionMode === 'auto',
      resumeSessionId: resumeSessionId || undefined,
    });
    bridge.on('event', (event) => {
      mainWindow.webContents.send('agent.event', event);
      if (event.type === 'automation_done') {
        // Bug-12 fix: use the dedicated automationBus instead of mainWindow.emit()
        // so the handler in automation.cjs survives window recreation.
        automationBus.emit('automation.done', event);
      }
    });
    bridge.start();
    return { ok: true };
  }

  return {
    start(resumeSessionId) {
      return start(resumeSessionId);
    },
    taskBoardAction(action, taskId) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.taskBoardAction(action, taskId);
      return { ok: true };
    },
    async prompt(text, files, toolScope) {
      // Recover from a bridge that failed during startup or exited before the
      // renderer sent its first prompt. The old synchronous throw forced the
      // user to resend the message manually.
      if (!bridge || !bridge.child) await start();
      if (!bridge || !bridge.child) throw new Error('Agent bridge failed to start');
      bridge.prompt(text, files, toolScope);
      return { ok: true };
    },
    async automationTask(taskId, goal) {
      if (!bridge) await start();
      bridge.automationTask(taskId, goal);
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
    approve(requestId, decision) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.approve(requestId, decision);
      return { ok: true };
    },
    undo(checkpointIds) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.undo(Array.isArray(checkpointIds) ? checkpointIds : []);
      return { ok: true };
    },
    cancel() {
      if (bridge) bridge.cancel();
      return { ok: true };
    },
    async restart() {
      if (bridge) bridge.restart();
      else await start();
      return { ok: true };
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
    backgroundColor: '#111318',
    icon: path.join(__dirname, '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
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
  });
  registerIpc({ mainWindow, workspace, settings, secrets, connectivity, usage, automation, agentManager, terminalManager, previewService, previewRuntime, ensureFimServer, ensureCompletionService, ensureLanguageServer });

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
