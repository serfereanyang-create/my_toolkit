const { dialog, ipcMain, shell, clipboard } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describeFile, inspectProject } = require('./preview-policy.cjs');
const git = require('./git.cjs');
const { syncPersonaFile } = require('./persona.cjs');

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function registerIpc({ mainWindow, workspace, settings, secrets, connectivity, usage, automation, agentManager, terminalManager, previewService, previewRuntime, ensureFimServer, ensureCompletionService, ensureLanguageServer }) {
  async function materializePersona(root) {
    try {
      const config = await settings.get();
      await syncPersonaFile(root, config.preferences);
    } catch {
      // Best-effort; never block workspace switches.
    }
  }

  ipcMain.handle('workspace.open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const root = workspace.setRoot(result.filePaths[0]);
    await settings.addRecentWorkspace(root);
    await automation.setWorkspace(root);
    await materializePersona(root);
    return { canceled: false, root };
  });

  // Auto-restore on startup: reopen the most recent workspace that still exists
  // so the app lands straight in a project instead of forcing a folder picker.
  // Falls back to the user's home directory on first run or if history is stale.
  ipcMain.handle('workspace.restore', async () => {
    const config = await settings.get();
    const recents = Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [];
    for (const candidate of recents) {
      if (typeof candidate === 'string' && await isDirectory(candidate)) {
        const root = workspace.setRoot(candidate);
        await automation.setWorkspace(root);
        await materializePersona(root);
        return { root, restored: true };
      }
    }
    const home = os.homedir();
    const root = workspace.setRoot(home);
    await settings.addRecentWorkspace(root);
    await automation.setWorkspace(root);
    await materializePersona(root);
    return { root, restored: false };
  });

  ipcMain.handle('workspace.setRoot', async (_event, root) => {
    const resolved = workspace.setRoot(root);
    await settings.addRecentWorkspace(resolved);
    await automation.setWorkspace(resolved);
    await materializePersona(resolved);
    return { root: resolved };
  });

  ipcMain.handle('workspace.getTree', async (_event, relativePath) => await workspace.tree(relativePath || '.'));
  ipcMain.handle('sessions.list', async () => await workspace.listSessions());
  ipcMain.handle('sessions.listArchived', async () => await workspace.listArchivedSessions());
  ipcMain.handle('sessions.load', async (_event, id) => await workspace.loadSession(id));
  ipcMain.handle('sessions.delete', async (_event, id) => await workspace.deleteSession(id));
  ipcMain.handle('sessions.rename', async (_event, id, title) => await workspace.renameSession(id, title));
  ipcMain.handle('sessions.pin', async (_event, id, pinned) => await workspace.pinSession(id, pinned));
  ipcMain.handle('sessions.archive', async (_event, id, archived) => await workspace.archiveSession(id, archived));
  ipcMain.handle('sessions.reveal', async (_event, id) => {
    shell.showItemInFolder(workspace.sessionAbsolutePath(id));
    return { ok: true };
  });
  ipcMain.handle('fs.read', async (_event, relativePath) => await workspace.readFile(relativePath));
  ipcMain.handle('fs.write', async (_event, relativePath, content) => await workspace.writeFile(relativePath, content));
  
  // Save pasted image — store inside the current workspace so the agent can
  // read it with a workspace-relative path. Falls back to os.tmpdir() if no
  // workspace is open yet.
  ipcMain.handle('fs.saveTempImage', async (_event, filename, base64Data) => {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      // Prefer workspace/.aicode/paste/ so the CLI can resolve it as a
      // workspace-relative path. Fall back to os.tmpdir() if no workspace.
      const wsRoot = workspace.getRoot ? workspace.getRoot() : null;
      let dir;
      if (wsRoot) {
        dir = path.join(wsRoot, '.aicode', 'paste');
      } else {
        dir = path.join(os.tmpdir(), 'cc-desktop-paste');
      }
      await fs.mkdir(dir, { recursive: true });
      const imagePath = path.join(dir, filename);
      await fs.writeFile(imagePath, buffer);
      return imagePath;
    } catch (error) {
      throw new Error(`Failed to save temp image: ${error.message}`);
    }
  });
  
  // Browser extension detection: scan Chrome/Edge profile extension folders
  // for a YOYcode extension so the computer-control page shows a real state.
  ipcMain.handle('computer.detectBrowserExtension', async () => {
    const home = os.homedir();
    const targets = [
      { browser: 'chrome', root: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data') },
      { browser: 'edge', root: path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data') },
    ];
    const found = [];
    for (const { browser, root } of targets) {
      let profiles = ['Default'];
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        profiles = entries.filter((e) => e.isDirectory() && /^(Default|Profile \d+)$/i.test(e.name)).map((e) => e.name);
        if (profiles.length === 0) profiles = ['Default'];
      } catch { /* browser not installed */ continue; }
      for (const profile of profiles) {
        const extRoot = path.join(root, profile, 'Extensions');
        let ids = [];
        try { ids = await fs.readdir(extRoot); } catch { continue; }
        for (const id of ids) {
          let versions = [];
          try { versions = await fs.readdir(path.join(extRoot, id)); } catch { continue; }
          for (const version of versions) {
            try {
              const manifestPath = path.join(extRoot, id, version, 'manifest.json');
              const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
              const name = String(manifest.name ?? '');
              if (/yoycode/i.test(name)) { found.push({ browser, extensionId: id, name }); }
            } catch { /* unreadable manifest */ }
          }
        }
      }
    }
    return { installed: found.length > 0, extensions: found };
  });

  // Editor API - work with absolute paths for files that may be outside workspace
  ipcMain.handle('editor.readFile', async (_event, absolutePath) => {
    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      return { ok: true, content };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('editor.saveFile', async (_event, absolutePath, content) => {
    try {
      await fs.writeFile(absolutePath, content, 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Watch one file for external modifications (agent writes, git ops).
  // Polling mtime beats fs.watch here: one watcher per OPEN editor tab only,
  // no recursive native watcher spam, and it works identically on Windows.
  const fileWatchers = new Map();
  ipcMain.handle('editor.watchFile', async (_event, absolutePath) => {
    if (fileWatchers.has(absolutePath)) return { ok: true, alreadyWatching: true };
    let lastMtime = 0;
    let lastSize = -1;
    try {
      const stat = await fs.stat(absolutePath);
      lastMtime = stat.mtimeMs;
      lastSize = stat.size;
    } catch { return { ok: false, error: 'file not found' }; }
    const timer = setInterval(async () => {
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.mtimeMs !== lastMtime || stat.size !== lastSize) {
          lastMtime = stat.mtimeMs;
          lastSize = stat.size;
          const mainWindowRef = mainWindow;
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send('editor.fileChanged', { path: absolutePath });
          }
        }
      } catch {
        // File deleted — notify once then keep polling in case it returns.
      }
    }, 1200);
    fileWatchers.set(absolutePath, timer);
    return { ok: true };
  });

  ipcMain.handle('editor.unwatchFile', async (_event, absolutePath) => {
    const timer = fileWatchers.get(absolutePath);
    if (timer) { clearInterval(timer); fileWatchers.delete(absolutePath); }
    return { ok: true };
  });

  // Conflict guard: compare on-disk mtime with what the editor last saw, so a
  // save can refuse to clobber agent changes made after the file was opened.
  ipcMain.handle('editor.stat', async (_event, absolutePath) => {
    try {
      const stat = await fs.stat(absolutePath);
      return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  
  ipcMain.handle('settings.get', async () => await settings.get());
  // Persist settings, then re-materialize persona.md so Personalize/Git prefs
  // reach the agent on the next turn without requiring an agent restart.
  ipcMain.handle('settings.set', async (_event, next) => {
    const merged = await settings.set(next);
    try {
      await syncPersonaFile(workspace.getRoot(), merged.preferences);
    } catch {
      // Persona sync is best-effort; never block settings writes.
    }
    return merged;
  });
  ipcMain.handle('secrets.setApiKey', async (_event, providerId, apiKey) => await secrets.setApiKey(providerId, apiKey));
  ipcMain.handle('secrets.hasApiKey', async (_event, providerId) => await secrets.hasApiKey(providerId));
  // Connectivity test: resolve the provider config and its stored key on the
  // main process (the key never crosses back to the renderer) and send one
  // minimal request to the real endpoint using the CLI's wire format.
  ipcMain.handle('connectivity.test', async (_event, providerId) => {
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === providerId);
    if (!providerConfig) return { ok: false, message: '未找到供应商配置' };
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    return await connectivity.test({ providerConfig, apiKey });
  });
  // Real token-usage statistics aggregated from the CLI's usage ledger.
  ipcMain.handle('usage.summary', async (_event, days) => usage.summary(days === 90 ? 90 : days === 30 ? 30 : 7));
  ipcMain.handle('usage.hourly', async (_event, hours) => usage.hourly(hours === 48 ? 48 : hours === 36 ? 36 : 24));
  ipcMain.handle('usage.records', async (_event, hours, offset, limit) => 
    usage.records(
      hours === 48 ? 48 : hours === 36 ? 36 : 24,
      typeof offset === 'number' ? offset : 0,
      typeof limit === 'number' ? limit : 20
    )
  );
  // Real prompt-cache hit-rate prediction from historical ledger data (same model).
  ipcMain.handle('usage.cachePrediction', async (_event, model) =>
    usage.cachePrediction(typeof model === 'string' ? model : undefined));
  ipcMain.handle('agent.start', async (_event, resumeSessionId) => await agentManager.start(resumeSessionId));
  ipcMain.handle('agent.prompt', async (_event, text, files, toolScope) => agentManager.prompt(text, files, toolScope));
  ipcMain.handle('agent.taskBoardAction', async (_event, action, taskId) => agentManager.taskBoardAction(action, taskId));
  ipcMain.handle('agent.setEffort', async (_event, reasoningEffort) => agentManager.setEffort(reasoningEffort));
  ipcMain.handle('agent.setToolScope', async (_event, toolScope) => agentManager.setToolScope(toolScope));
  ipcMain.handle('agent.cancel', async () => agentManager.cancel());
  ipcMain.handle('agent.restart', async () => await agentManager.restart());
  ipcMain.handle('agent.approve', async (_event, requestId, decision) => agentManager.approve(requestId, decision));
  // preload sends: ipcRenderer.invoke('agent.undo', checkpointIds) — one arg only.
  // The old handler had a spurious leading 'turnId' param that swallowed the array,
  // leaving checkpointIds=undefined so the CLI always received an empty list.
  ipcMain.handle('agent.undo', async (_event, checkpointIds) => agentManager.undo(Array.isArray(checkpointIds) ? checkpointIds : []));

  // AI code completion and editing
  ipcMain.handle('ai.complete', async (_event, request) => {
    const { filePath, language, prefix, suffix, cursorLine, cursorColumn, triggerKind } = request;
    
    try {
      const service = await ensureCompletionService();
      
      // 构造补全提示词
      const prompt = `You are a code completion AI. Complete the code at the cursor position.

File: ${filePath}
Language: ${language}
Trigger: ${triggerKind}

Code before cursor (last 2000 chars):
\`\`\`${language}
${prefix}
\`\`\`

Code after cursor (next 500 chars):
\`\`\`${language}
${suffix}
\`\`\`

Instructions:
- Provide ONLY the completion text that should be inserted at the cursor
- DO NOT include any explanation, markdown, or code fences
- DO NOT repeat the prefix or suffix
- Keep the completion concise and relevant
- Match the existing code style and indentation

Completion:`;

      console.log('[ai.complete] Requesting completion:', { 
        filePath, 
        cursorLine, 
        cursorColumn, 
        triggerKind,
        prefixLength: prefix.length,
        suffixLength: suffix.length
      });

      const result = await service.complete(prompt, { maxTokens: 256 });
      
      if (result && result.text) {
        console.log('[ai.complete] Success:', { 
          textLength: result.text.length, 
          model: result.model 
        });
        
        return {
          id: `completion-${Date.now()}`,
          text: result.text,
          range: {
            start: { line: cursorLine, column: cursorColumn },
            end: { line: cursorLine, column: cursorColumn }
          },
          confidence: 0.8
        };
      }
      
      console.log('[ai.complete] No completion returned');
      return null;
    } catch (err) {
      console.error('[ai.complete] Error:', err.message);
      return null;
    }
  });

  ipcMain.handle('ai.edit', async (_event, selection, instruction, context) => {
    const { filePath, language } = context || {};
    
    try {
      const service = await ensureCompletionService();
      
      // 构造编辑提示词
      const prompt = `You are a code editing AI. Edit the selected code according to the user's instruction.

File: ${filePath || 'unknown'}
Language: ${language || 'text'}

Selected code:
\`\`\`${language || 'text'}
${selection}
\`\`\`

User instruction: ${instruction}

Instructions:
- Provide ONLY the edited code that should replace the selection
- DO NOT include any explanation, markdown, or code fences
- DO NOT add comments about what you changed
- Preserve the original indentation style
- Match the existing code style and conventions
- Make minimal changes to achieve the goal

Edited code:`;

      console.log('[ai.edit] Requesting edit:', { 
        filePath, 
        instruction,
        selectionLength: selection.length
      });

      const result = await service.complete(prompt, { maxTokens: 1024 });
      
      if (result && result.text) {
        console.log('[ai.edit] Success:', { 
          originalLength: selection.length,
          editedLength: result.text.length,
          model: result.model 
        });
        
        return result.text;
      }
      
      console.log('[ai.edit] No edit returned');
      return null;
    } catch (err) {
      console.error('[ai.edit] Error:', err.message);
      return null;
    }
  });

  ipcMain.handle('automation.list', async () => await automation.list());
  ipcMain.handle('automation.get', async (_event, taskId) => await automation.get(taskId));
  ipcMain.handle('automation.create', async (_event, input) => await automation.create(input));
  ipcMain.handle('automation.update', async (_event, taskId, updates) => await automation.update(taskId, updates));
  ipcMain.handle('automation.delete', async (_event, taskId) => await automation.delete(taskId));
  ipcMain.handle('automation.start', async (_event, taskId) => await automation.start(taskId));
  ipcMain.handle('automation.stop', async (_event, taskId) => await automation.stop(taskId));
  ipcMain.handle('automation.run', async (_event, taskId) => await automation.run(taskId));
  ipcMain.handle('automation.history', async (_event, taskId, limit) => await automation.history(taskId, limit));
  ipcMain.handle('automation.active', async () => automation.active());

  ipcMain.handle('terminal.create', async (_event, options) => terminalManager.create(options || {}));
  ipcMain.handle('terminal.write', async (_event, id, data) => terminalManager.write(id, data));
  ipcMain.handle('terminal.resize', async (_event, id, cols, rows) => terminalManager.resize(id, cols, rows));
  ipcMain.handle('terminal.kill', async (_event, id) => terminalManager.kill(id));

  ipcMain.handle('window.minimize', async () => { mainWindow.minimize(); return { ok: true }; });
  ipcMain.handle('window.toggleMaximize', async () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window.close', async () => { mainWindow.close(); return { ok: true }; });

  ipcMain.handle('clipboard.write', async (_event, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  // ── Preview IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle('preview.describe', async (_event, relativePath) => {
    const root = workspace.getRoot();
    const abs  = path.resolve(root, relativePath);
    const desc = await describeFile(abs, root);
    // Register token so the custom protocol can validate requests
    if (previewService) {
      previewService.registerToken(desc.token, { workspaceRoot: root, kind: desc.kind, absolutePath: desc.absolutePath });
    }
    return desc;
  });

  ipcMain.handle('preview.inspectProject', async (_event, relativePath) => {
    const root = workspace.getRoot();
    const abs  = path.resolve(root, relativePath);
    const info = await inspectProject(abs, root);
    if (info && previewService) {
      previewService.registerToken(info.token, { workspaceRoot: root, kind: 'web', absolutePath: info.absolutePath });
    }
    return info;
  });

  ipcMain.handle('preview.startStatic', async (_event, relativePath, token) => {
    const root = workspace.getRoot();
    const abs  = path.resolve(root, relativePath);
    if (!previewRuntime) return { ok: false, error: 'Preview runtime unavailable' };
    return previewRuntime.startStatic(abs, token);
  });

  ipcMain.handle('preview.startDevServer', async (_event, relativePath, script, pkgManager, token) => {
    const root = workspace.getRoot();
    const abs  = path.resolve(root, relativePath);
    if (!previewRuntime) return { ok: false, error: 'Preview runtime unavailable' };
    return previewRuntime.startDevServer(abs, script, pkgManager, token);
  });

  ipcMain.handle('preview.stopPreview', async (_event, token) => {
    if (previewRuntime) await previewRuntime.stopPreview(token);
    if (previewService) previewService.revokeToken(token);
    return { ok: true };
  });

  ipcMain.handle('preview.installDeps', async (_event, relativePath, pkgManager) => {
    const root = workspace.getRoot();
    const abs  = path.resolve(root, relativePath);
    const pm   = ['npm', 'pnpm', 'yarn'].includes(pkgManager) ? pkgManager : 'npm';
    // Show native confirmation before running any install command
    const { response } = await dialog.showMessageBox(mainWindow, {
      type:    'question',
      title:   '安装项目依赖',
      message: `在以下目录安装依赖？\n\n${abs}`,
      detail:  `将执行：${pm} install\n\n这会联网下载第三方软件包。`,
      buttons: ['安装', '取消'],
      defaultId: 0,
      cancelId:  1,
    });
    if (response !== 0) return { ok: false, canceled: true };
    const { spawn: spawnSync } = require('node:child_process');
    const child = spawnSync(pm, ['install'], { cwd: abs, shell: false, stdio: 'pipe', windowsHide: true });
    const logs = [];
    child.stdout?.on('data', (d) => { logs.push(d.toString()); mainWindow.webContents.send('preview.log', { token: 'install', line: d.toString().trim() }); });
    child.stderr?.on('data', (d) => { logs.push(d.toString()); mainWindow.webContents.send('preview.log', { token: 'install', line: d.toString().trim() }); });
    await new Promise((resolve) => child.on('exit', resolve));
    return { ok: child.exitCode === 0, exitCode: child.exitCode };
  });

  ipcMain.handle('preview.setBounds', (_event, bounds) => {
    if (previewService) previewService.setBounds(bounds);
    return { ok: true };
  });

  ipcMain.handle('preview.show', (_event, url, allowedPort) => {
    if (previewService) previewService.loadUrl(url, allowedPort ?? null);
    return { ok: true };
  });

  ipcMain.handle('preview.hide', () => {
    if (previewService) previewService.hide();
    return { ok: true };
  });

  ipcMain.handle('preview.back',    () => { previewService?.back();    return { ok: true }; });
  ipcMain.handle('preview.forward', () => { previewService?.forward(); return { ok: true }; });
  ipcMain.handle('preview.reload',  () => { previewService?.reload();  return { ok: true }; });
  ipcMain.handle('preview.canNavigate', () => ({
    canGoBack:    previewService?.canGoBack()    ?? false,
    canGoForward: previewService?.canGoForward() ?? false,
  }));

  ipcMain.handle('preview.openExternal', (_event, url) => {
    previewService?.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('preview.readDocx', async (_event, relativePath, token) => {
    const root = workspace.getRoot();
    const abs  = path.resolve(root, relativePath);
    // Re-use policy validation (token was registered on describe)
    const { assertInsideRoot } = require('./preview-policy.cjs');
    const fsSync = require('node:fs');
    let real;
    try { real = fsSync.realpathSync(abs); } catch { return { ok: false, error: 'File not found' }; }
    try { assertInsideRoot(real, workspace.getRoot()); } catch (e) { return { ok: false, error: e.message }; }
    const stat = fsSync.statSync(real);
    if (stat.size > 20 * 1024 * 1024) return { ok: false, error: 'File too large for inline rendering' };
    const buf = fsSync.readFileSync(real);
    return { ok: true, buffer: buf.buffer, byteOffset: buf.byteOffset, byteLength: buf.byteLength };
  });

  // ── Navigation / @-mention search ─────────────────────────────────────────
  ipcMain.handle('nav.symbols', async (_event, pattern) => {
    const root = workspace.getRoot();
    if (!root) return [];
    const indexPath = path.join(root, '.aicode', 'nav', 'index.json');
    try {
      const raw = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      const lower = String(pattern || '').toLowerCase();
      const hits = [];
      for (const file of (raw.files || [])) {
        for (const sym of (file.symbols || [])) {
          if (!lower || sym.name.toLowerCase().includes(lower)) {
            hits.push({ name: sym.name, kind: sym.kind, path: sym.path, line: sym.line });
            if (hits.length >= 40) break;
          }
        }
        if (hits.length >= 40) break;
      }
      return hits;
    } catch { return []; }
  });

  ipcMain.handle('nav.fileSearch', async (_event, pattern) => {
    const root = workspace.getRoot();
    if (!root) return [];
    const lower = String(pattern || '').toLowerCase();
    const results = [];
    const SKIP = new Set(['.git', 'node_modules', 'dist', '.aicode', 'build', '.next', 'coverage']);
    async function walk(dir, depth) {
      if (depth > 5 || results.length >= 60) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (!lower || entry.name.toLowerCase().includes(lower) || rel.toLowerCase().includes(lower)) {
          results.push({ name: entry.name, path: rel, type: entry.isDirectory() ? 'directory' : 'file' });
        }
        if (entry.isDirectory()) await walk(abs, depth + 1);
        if (results.length >= 60) break;
      }
    }
    await walk(root, 0);
    return results;
  });

  ipcMain.handle('nav.readSymbolContext', async (_event, filePath, line) => {
    const root = workspace.getRoot();
    if (!root) return null;
    try {
      const abs = path.resolve(root, filePath);
      const { assertInsideRoot } = require('./preview-policy.cjs');
      assertInsideRoot(abs, root);
      const content = await fs.readFile(abs, 'utf8');
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, (line || 1) - 3);
      const end   = Math.min(lines.length, (line || 1) + 25);
      return { path: filePath, line, context: lines.slice(start, end).join('\n'), startLine: start + 1 };
    } catch { return null; }
  });

  // ── FIM / Tab autocomplete ─────────────────────────────────────────────────
  ipcMain.handle('fim.complete', async (_event, req) => {
    try {
      if (!ensureFimServer) return { ok: false, error: 'FIM not configured' };
      const srv = await ensureFimServer();
      const result = await srv.complete(req);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('fim.configure', async (_event, opts) => {
    try {
      if (!ensureFimServer) return { ok: false };
      const srv = await ensureFimServer();
      srv.configure(opts);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Language intelligence (hover / go-to-def / find-refs / completions) ────
  ipcMain.handle('language.hover', async (_event, req) => {
    try {
      if (!ensureLanguageServer) return { ok: false, error: 'Language server not configured' };
      const srv = await ensureLanguageServer();
      const result = await srv.query('hover', req);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('language.definition', async (_event, req) => {
    try {
      if (!ensureLanguageServer) return { ok: false, error: 'Language server not configured' };
      const srv = await ensureLanguageServer();
      const result = await srv.query('definition', req);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('language.references', async (_event, req) => {
    try {
      if (!ensureLanguageServer) return { ok: false, error: 'Language server not configured' };
      const srv = await ensureLanguageServer();
      const result = await srv.query('references', req);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('language.completions', async (_event, req) => {
    try {
      if (!ensureLanguageServer) return { ok: false, error: 'Language server not configured' };
      const srv = await ensureLanguageServer();
      const result = await srv.query('completions', req);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Git IPC ───────────────────────────────────────────────────────────────
  ipcMain.handle('git.status',        async () => git.getStatus(workspace.getRoot()));
  ipcMain.handle('git.branches',      async () => git.getBranches(workspace.getRoot()));
  ipcMain.handle('git.log',           async (_e, n) => git.getLog(workspace.getRoot(), n));
  ipcMain.handle('git.diff',          async (_e, staged) => git.getDiff(workspace.getRoot(), staged));
  // Inline editor highlights: current-file changed line ranges from git diff.
  ipcMain.handle('git.fileChangeRanges', async (_e, filePath) => git.getFileChangeRanges(workspace.getRoot(), filePath));
  ipcMain.handle('git.stage',         async (_e, paths) => git.stage(workspace.getRoot(), paths));
  ipcMain.handle('git.unstage',       async (_e, paths) => git.unstage(workspace.getRoot(), paths));
  ipcMain.handle('git.discard',       async (_e, paths) => git.discardChanges(workspace.getRoot(), paths));
  ipcMain.handle('git.commit',        async (_e, message) => git.commit(workspace.getRoot(), message));
  ipcMain.handle('git.push',          async (_e, remote, branch, force) => git.push(workspace.getRoot(), remote, branch, force));
  ipcMain.handle('git.pull',          async (_e, remote, branch) => git.pull(workspace.getRoot(), remote, branch));
  ipcMain.handle('git.checkout',      async (_e, branch) => git.checkout(workspace.getRoot(), branch));
  ipcMain.handle('git.createBranch',  async (_e, name) => git.createBranch(workspace.getRoot(), name));
  ipcMain.handle('git.deleteBranch',  async (_e, name, force) => git.deleteBranch(workspace.getRoot(), name, force));
  ipcMain.handle('git.createPr',      async (_e, opts) => git.createPr(workspace.getRoot(), opts || {}));
}

module.exports = { registerIpc };
