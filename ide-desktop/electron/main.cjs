const { app, BrowserWindow, Menu, safeStorage } = require('electron');
const path = require('node:path');

// The renderer draws its own minimal top bar; drop Electron's native
// File/Edit/View/Window/Help application menu.
Menu.setApplicationMenu(null);
const { createWorkspaceService } = require('./workspace.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { createSecretStore } = require('./secret-store.cjs');
const { registerIpc } = require('./ipc.cjs');
const { AgentBridge } = require('./agent-bridge.cjs');

let mainWindow;

function createAgentManager({ mainWindow, workspace, settings, secrets }) {
  let bridge;

  async function start() {
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
    if (bridge) bridge.dispose();
    bridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      sessionDir: path.join(workspace.getRoot(), '.aicode', 'sessions'),
      provider: providerConfig.type === 'anthropic' ? 'anthropic' : providerConfig.type === 'mock' ? 'mock' : 'openai',
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      apiKey,
      approval: config.approval,
    });
    bridge.on('event', (event) => mainWindow.webContents.send('agent.event', event));
    bridge.start();
    return { ok: true };
  }

  return {
    start,
    prompt(text) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.prompt(text);
      return { ok: true };
    },
    approve(requestId, decision) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.approve(requestId, decision);
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
    title: 'ZCode Desktop IDE',
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  const workspace = createWorkspaceService();
  const settings = createSettingsStore(app.getPath('userData'));
  const secrets = createSecretStore({ userDataDir: app.getPath('userData'), safeStorage });
  const agentManager = createAgentManager({ mainWindow, workspace, settings, secrets });
  registerIpc({ mainWindow, workspace, settings, secrets, agentManager });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
