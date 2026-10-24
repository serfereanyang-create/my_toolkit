const { dialog, ipcMain, shell, clipboard, app } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { assertInsideRoot, describeFile, inspectProject, resolveWorkspacePath } = require('./preview-policy.cjs');
const { describePathError } = require('./path-error.cjs');
const { settingsNeedAgentRestart } = require('./settings-restart.cjs');
const { readTextFile, validateTextWrite } = require('./editor-policy.cjs');
const { createFileWatchRegistry } = require('./file-watch-registry.cjs');
const { createDocumentPreviewService } = require('./document-preview.cjs');
const { createQualityGateway } = require('./quality-gateway.cjs');
const { createGuiControlService } = require('./gui-control.cjs');
const git = require('./git.cjs');
const { createCheckpointBackend } = require('./checkpoints.cjs');
const { createFileSearchService } = require('./file-search.cjs');
const { createResourceSampler } = require('./resource-sampler.cjs');
const { createCommandsService } = require('./commands.cjs');
const { exportSessionToFile, defaultExportPath } = require('./export-session.cjs');
const { exportSettingsBundle, importSettingsBundle } = require('./settings-portable.cjs');
const { collectSystemInfo } = require('./system-info.cjs');
const { analyzeSessionsDir, deleteSessionFiles } = require('./session-cleanup.cjs');
const { suggestCommitMessage, collectNumstat } = require('./git-suggest.cjs');
const { listProjectMemories, readProjectMemoryFile } = require('./memory-service.cjs');
const { readGlobalMemory } = require('./memory-global.cjs');
const { prepareMediaPreview } = require('./media-preview.cjs');
const { syncPersonaFile } = require('./persona.cjs');
const { selectWorkspaceCandidate } = require('./workspace-picker.cjs');

function withDeadline(promise, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function registerIpc({ mainWindow, workspace, settings, secrets, connectivity, usage, messageQueues, automation, agentManager, terminalManager, previewService, previewRuntime, backgroundBrowser, backgroundApp, guiControl, ensureFimServer, ensureCompletionService, ensureLanguageServer, snippets, bookmarks, fileHistory, notes, sessionTags, keybindings, subagentRuns }) {
  const queueScopes = new Set();
  const queueRoot = root => { if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('需要绝对工作区路径。'); return path.resolve(root); };
  ipcMain.handle('messageQueue.load', async (_event, root) => {
    const requested = queueRoot(root);
    if (requested !== queueRoot(workspace.getRoot())) throw new Error('消息队列工作区已变化。');
    const state = await messageQueues.load(requested);
    queueScopes.add(requested);
    return state;
  });
  ipcMain.handle('messageQueue.save', async (_event, root, state) => {
    const requested = queueRoot(root);
    if (!queueScopes.has(requested)) throw new Error('未授权的消息队列工作区。');
    await messageQueues.save(requested, state);
    return { ok: true };
  });
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
    await activateWorkspace();
    const root = workspace.setRoot(result.filePaths[0]);
    await settings.addRecentWorkspace(root);
    await automation.setWorkspace(root);
    await materializePersona(root);
    return { canceled: false, root };
  });

  // Auto-restore on startup: reopen the most recent *project* workspace that
  // still exists (git repo or manifest) so the app lands straight into a
  // project. A bare folder only wins if it is not the home directory; when
  // nothing usable is found we return root:null and the renderer prompts the
  // folder picker — rooting at the home directory silently crippled every
  // git_*/workspace_* tool (audited 2026-09-13).
  ipcMain.handle('workspace.restore', async () => {
    const config = await settings.get();
    const recents = Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [];
    const pick = await selectWorkspaceCandidate({ recents, home: os.homedir() });
    if (!pick.root) return { root: null, restored: false, reason: pick.reason };
    const root = workspace.setRoot(pick.root);
    await automation.setWorkspace(root);
    await materializePersona(root);
    return { root, restored: true };
  });

  ipcMain.handle('workspace.setRoot', async (_event, root) => {
    await activateWorkspace();
    const resolved = workspace.setRoot(root);
    await settings.addRecentWorkspace(resolved);
    await automation.setWorkspace(resolved);
    await materializePersona(resolved);
    return { root: resolved };
  });

  /**
   * Coordinate resources bound to the previous workspace before the new root
   * takes over. Preview servers/tokens must die with their workspace (they
   * only serve files under the old root), and the agent runtime is
   * workspace-bound too (sessions, git safety, tool paths), so it restarts
   * against the new root. The restart is not awaited: it takes seconds and
   * the renderer picks the fresh bridge_ready/session up asynchronously.
   */
  async function activateWorkspace() {
    await automation.disposeAll();
    await agentManager.switchWorkspace();
    await backgroundBrowser?.disposeAll();
    await backgroundApp?.disposeAll();
    await previewRuntime?.stopAll();
    previewService?.revokeAllTokens?.();
    previewService?.hide();
  }


  ipcMain.handle('workspace.getTree', async (_event, relativePath) => await workspace.tree(relativePath || '.'));
  // Reveal one workspace file in the OS file manager. Deliberately not a
  // general openPath: a downloaded file is untrusted, so it is shown in its
  // folder rather than handed to whatever handler the OS registered for its
  // extension. resolveWorkspacePath refuses anything outside the root.
  ipcMain.handle('workspace.reveal', async (_event, relativePath) => {
    try {
      const target = await resolveEditorPath(relativePath);
      await fs.access(target);
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  ipcMain.handle('sessions.list', async () => await workspace.listSessions());
  ipcMain.handle('sessions.listArchived', async () => await workspace.listArchivedSessions());
  ipcMain.handle('sessions.load', async (_event, id) => await workspace.loadSession(id));
  ipcMain.handle('sessions.delete', async (_event, id) => await workspace.deleteSession(id));
  ipcMain.handle('sessions.fork', async (_event, id) => await workspace.forkSession(id));
  ipcMain.handle('sessions.rename', async (_event, id, title) => await workspace.renameSession(id, title));
  ipcMain.handle('sessions.pin', async (_event, id, pinned) => await workspace.pinSession(id, pinned));
  ipcMain.handle('sessions.archive', async (_event, id, archived) => await workspace.archiveSession(id, archived));
  ipcMain.handle('sessions.reveal', async (_event, id) => {
    shell.showItemInFolder(workspace.sessionAbsolutePath(id));
    return { ok: true };
  });

  // Workspace checkpoints (ported from zcode's gitCheckpointService): hidden
  // git refs + three-way restore with conflict detection. All operations are
  // scoped to the currently open workspace root.
  const checkpointBackend = createCheckpointBackend({
    storeRootDir: path.join(app.getPath('userData'), 'checkpoints'),
  });
  function requireWorkspaceRoot() {
    const root = workspace.getRoot && workspace.getRoot();
    if (!root) throw new Error('No workspace is open.');
    return root;
  }
  ipcMain.handle('checkpoints.create', async () => {
    const meta = await checkpointBackend.createCheckpoint({ workspacePath: requireWorkspaceRoot() });
    return { ok: true, meta };
  });
  ipcMain.handle('checkpoints.list', async () => {
    const metas = await checkpointBackend.listCheckpoints({ workspacePath: requireWorkspaceRoot() });
    return { ok: true, metas };
  });
  ipcMain.handle('checkpoints.diff', async (_event, fromCheckpointId, toCheckpointId) => {
    const diff = await checkpointBackend.diffCheckpoints({ workspacePath: requireWorkspaceRoot(), fromCheckpointId, toCheckpointId });
    return { ok: true, diff };
  });
  ipcMain.handle('checkpoints.restore', async (_event, fromCheckpointId, toCheckpointId, force) => {
    const result = await checkpointBackend.restoreBetweenCheckpoints({
      workspacePath: requireWorkspaceRoot(),
      fromCheckpointId,
      toCheckpointId,
      force: force === true,
    });
    return { ok: true, result };
  });
  ipcMain.handle('checkpoints.delete', async (_event, checkpointId) => {
    await checkpointBackend.deleteCheckpoint({ workspacePath: requireWorkspaceRoot(), checkpointId });
    return { ok: true };
  });

  // Fuzzy file quickpick search (ported from zcode's workspaceFileSearch).
  // Index is cached for 2s per workspace root; invalidate on writes below.
  const fileSearchService = createFileSearchService();
  ipcMain.handle('files.search', async (_event, query, limit) => {
    const root = requireWorkspaceRoot();
    const files = await fileSearchService.search({ rootPath: root, query, limit });
    return { ok: true, files };
  });

  // Resource sampling for the agent bridge process tree (zcode
  // processResourceSampler): whole-machine-normalized CPU% + RSS.
  const resourceSampler = createResourceSampler({ rootPid: process.pid });
  ipcMain.handle('resources.sample', async () => {
    const usage = await resourceSampler.sample();
    return { ok: true, usage };
  });

  // Custom slash commands (zcode commandFileParser): markdown files with
  // frontmatter in userData/commands plus <workspace>/.zcode/commands.
  function commandsServiceForCurrentRoot() {
    const root = workspace.getRoot ? workspace.getRoot() : null;
    return createCommandsService({
      userCommandsDir: path.join(app.getPath('userData'), 'commands'),
      workspaceCommandsDir: root ? path.join(root, '.zcode', 'commands') : null,
    });
  }
  ipcMain.handle('commands.list', async () => {
    const commands = await commandsServiceForCurrentRoot().listCommands();
    return { ok: true, commands };
  });
  ipcMain.handle('commands.save', async (_event, name, config) => {
    const result = await commandsServiceForCurrentRoot().saveCommand({ name, ...config });
    return { ok: true, ...result };
  });
  ipcMain.handle('commands.delete', async (_event, name) => {
    await commandsServiceForCurrentRoot().deleteCommand({ name });
    return { ok: true };
  });

  // Markdown session export (zcode conversation-share formatter semantics).
  ipcMain.handle('sessions.export', async (_event, id) => {
    const record = await workspace.loadSession(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    const outPath = defaultExportPath(workspace.getRoot ? workspace.getRoot() : null, id);
    const formatted = await exportSessionToFile(record, outPath);
    return { ok: true, path: outPath, sha256: formatted.markdownSha256, messageCount: formatted.messageCount, unsupportedKinds: formatted.unsupportedKinds };
  });

  // Model trajectory: the per-call record the CLI writes next to each session
  // (<id>.trajectory.jsonl). Read through the same resolver the CLI uses, so
  // the viewer can never disagree with what was actually sent.
  ipcMain.handle('sessions.trajectory', async (_event, id) => {
    const safeId = typeof id === 'string' ? id : '';
    if (!safeId) return { ok: false, error: '缺少会话 ID' };
    try {
      const { readTrajectoryRecords } = await import(
        pathToFileURL(path.join(__dirname, '..', '..', 'cli', 'dist', 'src', 'session', 'modelTrajectory.js')).href
      );
      const sessionPath = workspace.sessionAbsolutePath(safeId);
      const records = readTrajectoryRecords(sessionPath);
      return { ok: true, records };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Portable settings (zcode settings-sync semantics): keys never leave the
  // machine; import matches providers by id and keeps local API keys.
  ipcMain.handle('settings.exportBundle', async () => {
    const settings = await settings.get();
    return { ok: true, bundle: exportSettingsBundle(settings) };
  });
  ipcMain.handle('settings.importBundle', async (_event, bundle) => {
    const current = await settings.get();
    const { settings: merged, report } = importSettingsBundle(bundle, current);
    await settings.set(merged);
    return { ok: true, report };
  });

  // Diagnostics snapshot (zcode systemService) for the settings "关于" panel.
  ipcMain.handle('system.info', async () => {
    const info = await collectSystemInfo({
      electronVersion: process.versions.electron ?? null,
      driveLetter: process.platform === 'win32' ? 'C:' : undefined,
    });
    return { ok: true, info };
  });

  // Empty-session cleanup backend (user-approved plan): analyze is read-only;
  // deletion requires explicit ids and re-validates every candidate at delete
  // time, so numbers shown to the user can never go stale dangerously.
  ipcMain.handle('sessions.analyzeCleanup', async (_event, dirs) => {
    const targetDirs = Array.isArray(dirs) && dirs.length > 0
      ? dirs
      : [workspace.sessionsDir?.() ?? path.join(os.homedir(), '.aicode', 'sessions')];
    const analyses = [];
    for (const dir of targetDirs) {
      analyses.push(await analyzeSessionsDir(dir));
    }
    return { ok: true, analyses };
  });
  ipcMain.handle('sessions.cleanupDelete', async (_event, dir, ids) => {
    if (!Array.isArray(ids)) throw new Error('cleanupDelete expects an array of session ids');
    const result = await deleteSessionFiles(dir, ids);
    return { ok: true, ...result };
  });

  // Commit message suggestion: whole change set narrowed to files the session
  // actually touched (when a sessionId is given), then the heuristic
  // conventional-commit generator runs on the scoped set.
  ipcMain.handle('git.suggestCommitMessage', async (_event, sessionId) => {
    const root = requireWorkspaceRoot();
    const [status, numstat] = await Promise.all([git.getStatus(root), collectNumstat(root)]);
    if (!status.ok) throw new Error(status.error || 'git status failed');
    let toolCalls = [];
    if (sessionId) {
      const record = await workspace.loadSession(sessionId);
      toolCalls = record?.toolCalls ?? [];
    }
    const message = suggestCommitMessage({
      status,
      numstat,
      toolCalls,
      workspacePath: root,
      repoRoot: root,
      workspaceInRepoPath: '.',
    });
    return { ok: true, message };
  });

  // Project memory browser: read-only view of the SAME store the CLI writes
  // (~/.zcode/cli/memories/projects/<id>/MEMORY.md + memory/*.md).
  const memoriesRoot = path.join(os.homedir(), '.zcode', 'cli', 'memories', 'projects');
  ipcMain.handle('memory.listProjects', async () => {
    const projects = await listProjectMemories(memoriesRoot);
    return { ok: true, projects };
  });
  ipcMain.handle('memory.read', async (_event, workspaceId, fileName) => {
    const file = await readProjectMemoryFile({ memoriesRoot, workspaceId, fileName });
    return { ok: true, ...file };
  });
  // Global memory: one record of every file ever edited, across every project
  // and every session. Read-only — the CLI writes the ledger.
  ipcMain.handle('memory.global', async () => await readGlobalMemory());

  // Audio/video preview preparation (zcode media-preview). Paths are confined
  // to the workspace like every other fs handler.
  ipcMain.handle('media.prepare', async (_event, relativePath, expectedKind) => {
    const root = requireWorkspaceRoot();
    // resolveWorkspacePath is async and already enforces containment, so
    // awaiting it IS the check. It used to be called without await and with its
    // arguments swapped, which made every call throw a TypeError about a
    // non-string path and left the real rejection unhandled in the main process.
    const { path: absolutePath } = await resolveWorkspacePath(relativePath, root);
    const preparation = await prepareMediaPreview({ filePath: absolutePath, expectedKind });
    return { ok: true, preparation };
  });
  /**
   * 新标签页的「打开 PDF / 演示文稿 / …」共用这一个选择框。
   *
   * 只有 `openFile`（一次一个文件、只读），过滤器和标题都按白名单清洗——
   * 渲染进程传来的东西不能直接塞进 Electron 的 dialog 选项。起始目录永远是
   * 当前工作区根，返回值是操作系统给的绝对路径；换成工作区相对路径、越界拒绝
   * 由渲染进程那一侧做，这里只保证「选的是个存在且可读的文件」。
   */
  ipcMain.handle('files.pick', async (_event, options) => {
    const input = options && typeof options === 'object' ? options : {};
    const title = typeof input.title === 'string' && input.title.trim()
      ? input.title.trim().slice(0, 120)
      : '选择文件';

    const filters = [];
    if (Array.isArray(input.filters)) {
      for (const entry of input.filters.slice(0, 8)) {
        if (!entry || typeof entry !== 'object') continue;
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 60) : '文件';
        const extensions = Array.isArray(entry.extensions)
          ? entry.extensions
              .filter((ext) => typeof ext === 'string')
              .map((ext) => ext.replace(/^\./, '').trim().toLowerCase())
              .filter((ext) => /^[a-z0-9]{1,10}$/.test(ext))
              .slice(0, 24)
          : [];
        if (extensions.length > 0) filters.push({ name, extensions });
      }
    }

    // 起始目录锁在工作区根：不读渲染进程给的 defaultPath，否则那个参数就成了
    // 「让用户在任意目录里挑文件」的后门。
    const root = workspace.getRoot();
    const picked = await dialog.showOpenDialog(mainWindow, {
      title,
      properties: ['openFile'],
      filters: filters.length > 0 ? filters : undefined,
      defaultPath: root || undefined,
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };

    const source = picked.filePaths[0];
    const stat = await fs.stat(source).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, error: '无法读取所选文件' };
    return { ok: true, path: source };
  });

  ipcMain.handle('fs.read', async (_event, relativePath) => await workspace.readFile(relativePath));
  ipcMain.handle('fs.write', async (_event, relativePath, content) => await workspace.writeFile(relativePath, content));
  
  // Save pasted image — store inside the current workspace so the agent can
  // read it with a workspace-relative path. Falls back to os.tmpdir() if no
  // workspace is open yet.
  ipcMain.handle('fs.saveTempImage', async (_event, filename, base64Data) => {
    try {
      if (typeof filename !== 'string' || path.basename(filename) !== filename || !/^[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp)$/i.test(filename)) {
        throw new Error('Invalid temporary image filename');
      }
      if (typeof base64Data !== 'string' || base64Data.length === 0 || base64Data.length > 32 * 1024 * 1024) {
        throw new Error('Temporary image data exceeds the allowed size');
      }
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length > 24 * 1024 * 1024) throw new Error('Temporary image exceeds the allowed size');
      // Prefer workspace/.aicode/paste/ so the CLI can resolve it as a
      // workspace-relative path. Fall back to os.tmpdir() if no workspace.
      const wsRoot = workspace.getRoot ? workspace.getRoot() : null;
      const dir = wsRoot ? path.join(wsRoot, '.aicode', 'paste') : path.join(os.tmpdir(), 'cc-desktop-paste');
      await fs.mkdir(dir, { recursive: true });
      const imagePath = path.join(dir, filename);
      await fs.writeFile(imagePath, buffer, { flag: 'wx' }).catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        await fs.writeFile(imagePath, buffer);
      });
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

  // Editor API uses workspace-relative paths; canonicalization prevents symlink/junction escapes.
  async function resolveEditorPath(relativePath, options = {}) {
    const root = workspace.getRoot();
    return (await resolveWorkspacePath(relativePath, root, options)).path;
  }

  /*
   * Path errors are normalised by electron/path-error.cjs so the rule is unit
   * testable without Electron. A missing file is an ordinary outcome here — the
   * renderer can hold a stale path — and the raw ENOENT used to carry an
   * absolute filesystem path into the UI.
   */

  ipcMain.handle('editor.readFile', async (_event, relativePath) => {
    try {
      const target = await resolveEditorPath(relativePath);
      const content = await readTextFile(target);
      return { ok: true, content };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  ipcMain.handle('editor.saveFile', async (_event, relativePath, content) => {
    try {
      if (typeof content !== 'string' || content.length > 20 * 1024 * 1024) throw new Error('File content exceeds the allowed size');
      const target = await resolveEditorPath(relativePath, { mustExist: false });
      await validateTextWrite(target, content);
      // Iteration 7: capture the on-disk bytes *before* overwriting them so
      // the timeline can step back through manual saves. Best-effort: a
      // history failure must never block the save itself.
      try {
        const previous = await fs.readFile(target, 'utf-8').catch(() => null);
        if (previous !== null) await fileHistory.recordSave(target, previous, content);
      } catch { /* history is advisory */ }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });

  // Watch one file for external modifications (agent writes, git ops).
  //
  // Polling mtime beats fs.watch here: one watcher per CONSUMER only, no
  // recursive native watcher spam, and it works identically on Windows. The
  // registry refcounts by path, because the editor tab and a preview pane may
  // both want the same file and neither may cancel the other's notifications.
  const fileWatchers = createFileWatchRegistry({
    stat: async (absolutePath) => await fs.stat(absolutePath),
    onChange: (absolutePath) => {
      const mainWindowRef = mainWindow;
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('editor.fileChanged', { path: absolutePath });
      }
    },
  });
  ipcMain.handle('editor.watchFile', async (_event, relativePath) => {
    let absolutePath;
    try { absolutePath = await resolveEditorPath(relativePath); } catch (error) { return { ok: false, error: describePathError(error) }; }
    return await fileWatchers.watch(absolutePath);
  });

  ipcMain.handle('editor.unwatchFile', async (_event, relativePath) => {
    let absolutePath;
    try { absolutePath = await resolveEditorPath(relativePath); } catch { return { ok: true }; }
    return fileWatchers.unwatch(absolutePath);
  });

  // Conflict guard: compare on-disk mtime with what the editor last saw, so a
  // save can refuse to clobber agent changes made after the file was opened.
  ipcMain.handle('editor.stat', async (_event, relativePath) => {
    try {
      const target = await resolveEditorPath(relativePath);
      const stat = await fs.stat(target);
      return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  
  ipcMain.handle('settings.get', async () => await settings.get());
  // Persist settings, then re-materialize persona.md so Personalize/Git prefs
  // reach the agent on the next turn without requiring an agent restart.
  ipcMain.handle('settings.set', async (_event, next) => {
    const previous = await settings.get();
    const merged = await settings.set(next);
    // The approval mode is baked into the CLI child at spawn time; switching
    // it mid-session must invalidate the live bridge so the next prompt
    // re-starts with the new mode (otherwise "变更前确认" silently stays auto).
    // Auto-review travels the same way (--auto-review), so it needs the same
    // treatment or the toggle would silently do nothing until an app restart.
    //
    // The provider is spawn-time too (--provider / --model / --base-url), so a
    // live child kept answering with the previous model after the user switched
    // suppliers in settings: the new config was saved, the next prompt still ran
    // on the old one until the app was restarted.
    // Provider edits count too: the child is launched with --provider/--model/
    // --base-url, so saving a supplier change has to reach a fresh process.
    if (settingsNeedAgentRestart(previous, merged)) {
      await agentManager.invalidate();
    }
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
  // Real token-usage statistics aggregated from the CLI's usage ledger. The
  // store's async methods use mtime caching and fs/promises so a large ledger
  // does not synchronously block the Electron main process. The sync fallback
  // keeps this registration compatible with lightweight injected stores.
  const usageCall = (asyncName, syncName, ...args) => typeof usage[asyncName] === 'function'
    ? usage[asyncName](...args)
    : Promise.resolve().then(() => usage[syncName](...args));
  ipcMain.handle('usage.summary', async (_event, days) => usageCall('summaryAsync', 'summary', days === 90 ? 90 : days === 30 ? 30 : 7));
  ipcMain.handle('usage.hourly', async (_event, hours) => usageCall('hourlyAsync', 'hourly', hours === 48 ? 48 : hours === 36 ? 36 : 24));
  ipcMain.handle('usage.records', async (_event, hours, offset, limit) =>
    usageCall(
      'recordsAsync',
      'records',
      hours === 48 ? 48 : hours === 36 ? 36 : 24,
      typeof offset === 'number' ? offset : 0,
      typeof limit === 'number' ? limit : 20
    )
  );
  // Real prompt-cache hit-rate prediction from historical ledger data (same model).
  ipcMain.handle('usage.cachePrediction', async (_event, model) =>
    usageCall('cachePredictionAsync', 'cachePrediction', typeof model === 'string' ? model : undefined));
  // Full-window CSV export (iteration 21): pull every record in the window
  // (single big page) and serialise RFC-4180 style with a UTF-8 BOM so Excel
  // opens Chinese provider/model names correctly.
  ipcMain.handle('usage.exportCsv', async (_event, hours) => {
    const { usageToCsv } = require('./usage-csv.cjs');
    const h = hours === 48 ? 48 : hours === 36 ? 36 : 24;
    const all = await usageCall('recordsAsync', 'records', h, 0, 100000);
    return { csv: usageToCsv(all.records ?? [], { bom: true }), count: all.records?.length ?? 0 };
  });
  // Every agent call carries the session it targets. With one CLI child per
  // session, an un-addressed call would reach whichever bridge happened to be
  // the only one — correct by luck in a single-conversation app, wrong the
  // moment a second conversation is running.
  ipcMain.handle('agent.start', async (_event, resumeSessionId) => await agentManager.start(resumeSessionId));
  ipcMain.handle('agent.prompt', async (_event, text, files, toolScope, sessionId) => agentManager.prompt(text, files, toolScope, sessionId));
  ipcMain.handle('agent.taskBoardAction', async (_event, action, taskId, sessionId) => agentManager.taskBoardAction(action, taskId, sessionId));
  ipcMain.handle('agent.setEffort', async (_event, reasoningEffort, sessionId) => agentManager.setEffort(reasoningEffort, sessionId));
  ipcMain.handle('agent.setToolScope', async (_event, toolScope, sessionId) => agentManager.setToolScope(toolScope, sessionId));
  ipcMain.handle('agent.cancel', async (_event, sessionId) => agentManager.cancel(sessionId));
  // Respawn the child so changed spawn-time settings (provider, model,
  // approval, background-browser flags) actually take effect. Distinct from
  // `agent.start`, which reuses a live bridge on purpose.
  ipcMain.handle('agent.restart', async (_event, resumeSessionId) => await agentManager.restartSession(resumeSessionId));
  ipcMain.handle('agent.guardConfirmation', async (_event, requestId, selectedLabel, sessionId) => {
    if (typeof requestId !== 'string' || typeof selectedLabel !== 'string' || typeof sessionId !== 'string') throw new Error('Invalid guard response');
    return agentManager.guardConfirmation(requestId, selectedLabel, sessionId);
  });
  ipcMain.handle('backgroundApp.execute', async (_event, tool, input) => {
    if (!backgroundApp) return { ok: false, output: '后台应用不可用。' };
    return backgroundApp.execute({ sessionId: 'manual-background-app', workspaceRoot: workspace.getRoot(), tool, input });
  });
  ipcMain.handle('backgroundApp.close', async () => {
    await backgroundApp?.closeSession('manual-background-app');
    return { ok: true };
  });
  ipcMain.handle('backgroundBrowser.execute', async (_event, tool, input, sessionId) => {
    if (!backgroundBrowser) return { ok: false, output: '后台浏览器不可用。' };
    const id = typeof sessionId === 'string' && sessionId ? sessionId : 'manual-background';
    return backgroundBrowser.execute({ sessionId: id, workspaceRoot: workspace.getRoot(), tool, input });
  });
  ipcMain.handle('backgroundBrowser.close', async (_event, sessionId) => {
    // Closes every hidden page this conversation opened. The per-page close is
    // the `background_browser_close` tool, which the panel sends through
    // execute() with a browserId.
    await backgroundBrowser?.closeSession(typeof sessionId === 'string' && sessionId ? sessionId : 'manual-background');
    return { ok: true };
  });
  ipcMain.handle('backgroundBrowser.status', async () => ({ sessions: backgroundBrowser?.status() ?? [] }));
  ipcMain.handle('agent.stopSession', async (_event, sessionId) => await agentManager.stopSession(sessionId));
  ipcMain.handle('agent.approve', async (_event, requestId, decision, sessionId) => agentManager.approve(requestId, decision, sessionId));
  // preload sends: ipcRenderer.invoke('agent.undo', checkpointIds, undoId).
  // undoId lets the renderer match the CLI's authoritative undo_done event
  // back to the turn card that requested the revert.
  ipcMain.handle('agent.undo', async (_event, checkpointIds, undoId, sessionId) => agentManager.undo(Array.isArray(checkpointIds) ? checkpointIds : [], undoId, sessionId));

  // ── Side chat: independent bridge/session, write-denied assistant ─────────
  ipcMain.handle('sidechat.prompt', async (_event, text) => agentManager.sideChatPrompt(text));
  ipcMain.handle('sidechat.cancel', async () => agentManager.sideChatCancel());
  ipcMain.handle('sidechat.reset', async () => agentManager.sideChatReset());

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

  // ── Quality tool gateway (read-only CLI analysis tools) ────────────────────
  const qualityGateway = createQualityGateway({ cliRoot: path.resolve(__dirname, '..', '..', 'cli') });
  ipcMain.handle('quality.invoke', async (_event, toolName, input, revision) => {
    // The gateway allowlists read-risk tools and the CLI re-checks the risk
    // boundary; the workspace is always the one active in this window.
    return qualityGateway.invoke(toolName, input, workspace.getRoot(), typeof revision === 'string' ? revision : undefined);
  });
  ipcMain.handle('quality.listTools', async () => ({ ok: true, tools: qualityGateway.listTools() }));
  ipcMain.handle('quality.latest', async (_event, toolName) => qualityGateway.latest(toolName, workspace.getRoot()));
  ipcMain.handle('quality.history', async (_event, toolName, limit) => ({
    ok: true,
    records: await qualityGateway.history(toolName, workspace.getRoot(), typeof limit === 'number' ? limit : 20),
  }));

  // ── GUI control (the 电脑操控 sidebar panel) ───────────────────────────────
  // This is the one place the desktop drives the user's real windows without a
  // conversation in the middle, so it is reachable ONLY from the panel: the
  // renderer never sees a generic "run any tool" channel, and the service
  // allowlists the nine computer_* tools. The CLI path it spawns re-validates
  // every input through the tool's own validate().
  ipcMain.handle('guiControl.status', async () => guiControl.status());
  ipcMain.handle('guiControl.invoke', async (_event, tool, input) => guiControl.invoke(tool, input));

  // Real packaged version for Help / What's New content selection.
  ipcMain.handle('app.version', () => ({ version: app.getVersion() }));

  // ── Appearance: custom background image ────────────────────────────────────
  // The chosen file is COPIED into userData/backgrounds rather than referenced
  // in place, so the preference survives the user moving or deleting the
  // original. Only the copy is ever read back, which also keeps the renderer
  // from pointing at an arbitrary path on disk.
  const backgroundDir = path.join(app.getPath('userData'), 'backgrounds');
  const BACKGROUND_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
  // 16 MB: large enough for a 4K photo, small enough that a mistaken pick
  // (a video, an ISO) is rejected before it is copied or encoded.
  const BACKGROUND_MAX_BYTES = 16 * 1024 * 1024;

  async function readBackgroundFile() {
    let entries;
    try {
      entries = await fs.readdir(backgroundDir);
    } catch {
      return null;
    }
    const name = entries.find((entry) => BACKGROUND_EXTS.has(path.extname(entry).toLowerCase()));
    if (!name) return null;
    const file = path.join(backgroundDir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    return { file, ext: path.extname(name).toLowerCase(), mtimeMs: stat.mtimeMs };
  }

  ipcMain.handle('appearance.pickBackground', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };

    const source = picked.filePaths[0];
    const ext = path.extname(source).toLowerCase();
    if (!BACKGROUND_EXTS.has(ext)) return { ok: false, error: `不支持的图片格式：${ext || '(无扩展名)'}` };
    const stat = await fs.stat(source).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, error: '无法读取所选文件' };
    if (stat.size > BACKGROUND_MAX_BYTES) {
      return { ok: false, error: `图片过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），请选择小于 16 MB 的图片` };
    }

    // Replace any previous background: one active image, no orphan accumulation.
    await fs.rm(backgroundDir, { recursive: true, force: true });
    await fs.mkdir(backgroundDir, { recursive: true });
    await fs.copyFile(source, path.join(backgroundDir, `background${ext}`));
    const stored = await readBackgroundFile();
    if (!stored) return { ok: false, error: '背景图片保存失败' };
    return { ok: true, version: stored.mtimeMs };
  });

  ipcMain.handle('appearance.readBackground', async () => {
    const stored = await readBackgroundFile();
    if (!stored) return { ok: false };
    try {
      const bytes = await fs.readFile(stored.file);
      const mime = stored.ext === '.jpg' || stored.ext === '.jpeg' ? 'image/jpeg'
        : stored.ext === '.svg' ? 'image/svg+xml'
        : `image/${stored.ext.slice(1)}`;
      return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, version: stored.mtimeMs };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('appearance.clearBackground', async () => {
    await fs.rm(backgroundDir, { recursive: true, force: true });
    return { ok: true };
  });

  ipcMain.handle('terminal.create', async (_event, options) => {
    // The renderer supplies `cwd`, which used to be handed straight to spawn —
    // so a compromised renderer could open a shell in any directory on the
    // machine (or fall back to the user's home directory). Confine it to the
    // active workspace; the terminal still gets full freedom INSIDE the root,
    // so `cd node_modules` keeps working.
    const requested = options && typeof options.cwd === 'string' ? options.cwd : undefined;
    const root = workspace.getRoot();
    let cwd;
    if (!requested) {
      cwd = root;
    } else {
      const resolved = path.resolve(root, requested);
      try {
        assertInsideRoot(resolved, root, { allowRoot: true, rejectBlocked: false });
        cwd = resolved;
      } catch {
        cwd = root;
      }
    }
    return terminalManager.create({ ...(options || {}), cwd });
  });
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
    const { path: abs } = await resolveWorkspacePath(relativePath, root);
    const desc = await describeFile(abs, root);
    // Register token so the custom protocol can validate requests
    if (previewService) {
      previewService.registerToken(desc.token, { workspaceRoot: root, kind: desc.kind, absolutePath: desc.absolutePath });
    }
    return desc;
  });

  ipcMain.handle('preview.inspectProject', async (_event, relativePath) => {
    const root = workspace.getRoot();
    const { path: abs } = await resolveWorkspacePath(relativePath, root, { allowRoot: true });
    const info = await inspectProject(abs, root);
    if (info && previewService) {
      previewService.registerToken(info.token, { workspaceRoot: root, kind: 'web', absolutePath: info.absolutePath });
    }
    return info;
  });

  ipcMain.handle('preview.startStatic', async (_event, relativePath, token) => {
    const root = workspace.getRoot();
    const { path: abs } = await resolveWorkspacePath(relativePath, root, { allowRoot: true });
    if (!previewRuntime) return { ok: false, error: 'Preview runtime unavailable' };
    if (!previewService?.validateToken?.(token, { workspaceRoot: root, kind: 'web', absolutePath: abs })) {
      return { ok: false, error: 'Invalid preview token' };
    }
    const result = await previewRuntime.startStatic(abs, token);
    if (result.ok && result.port) previewService?.registerRuntimeToken?.(result.port, token);
    return result;
  });

  ipcMain.handle('preview.startDevServer', async (_event, relativePath, script, pkgManager, token) => {
    const root = workspace.getRoot();
    const { path: abs } = await resolveWorkspacePath(relativePath, root, { allowRoot: true });
    if (!previewRuntime) return { ok: false, error: 'Preview runtime unavailable' };
    if (!previewService?.validateToken?.(token, { workspaceRoot: root, kind: 'web', absolutePath: abs })) {
      return { ok: false, error: 'Invalid preview token' };
    }
    const result = await previewRuntime.startDevServer(abs, script, pkgManager, token);
    if (result.ok && result.port) previewService?.registerRuntimeToken?.(result.port, token);
    return result;
  });

  ipcMain.handle('preview.stopPreview', async (_event, token) => {
    if (previewRuntime) await previewRuntime.stopPreview(token);
    if (previewService) previewService.revokeToken(token);
    return { ok: true };
  });

  ipcMain.handle('preview.installDeps', async (_event, relativePath, pkgManager) => {
    const root = workspace.getRoot();
    const { path: abs } = await resolveWorkspacePath(relativePath, root, { allowRoot: true });
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
    const { spawn } = require('node:child_process');
    const child = spawn(pm, ['install'], { cwd: abs, shell: false, stdio: 'pipe', windowsHide: true });
    const logs = [];
    const appendLog = (data) => {
      logs.push(String(data));
      if (logs.length > 200) logs.shift();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview.log', { token: 'install', line: String(data).trim() });
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code) => resolveExit(code));
    });
    return { ok: exitCode === 0, exitCode };
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

  // Office documents (docx/xlsx/pptx) for the preview panes. The token check,
  // the containment check, the extension check and the size cap all live in
  // electron/document-preview.cjs, where they are unit tested — the docx handler
  // that used to sit here had them inline, in a file `node --test` cannot even
  // require.
  const documentPreview = createDocumentPreviewService({
    validateToken: (token, expectation) => previewService?.validateToken?.(token, expectation) === true,
    workspaceRoot: () => workspace.getRoot(),
    assertInsideRoot,
    resolveAbsolutePath: async (relativePath) => {
      try {
        return (await resolveWorkspacePath(relativePath, workspace.getRoot())).path;
      } catch (error) {
        throw new Error(describePathError(error));
      }
    },
  });

  ipcMain.handle('preview.readDocx', async (_event, relativePath, token) => await documentPreview.read('docx', relativePath, token));
  ipcMain.handle('preview.readXlsx', async (_event, relativePath, token) => await documentPreview.read('xlsx', relativePath, token));
  ipcMain.handle('preview.readPptx', async (_event, relativePath, token) => await documentPreview.read('pptx', relativePath, token));

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

  // ── Workspace full-text search (iteration 3) ─────────────────────────────
  // The renderer must never be left on "搜索中…": the engine already budgets
  // its own scan, and this outer deadline covers a wedged fs call so the UI
  // always receives a (possibly partial) answer.
  ipcMain.handle('search.text', async (_event, query, options) => {
    const root = workspace.getRoot();
    if (!root) return { results: [], filesScanned: 0, truncated: false, elapsedMs: 0, error: '没有打开工作区' };
    const opts = options || {};
    const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 15000;
    const deadlineMs = Math.min(Math.max(budgetMs + 10000, 15000), 180000);
    try {
      const { searchWorkspaceText } = require('./workspace-search.cjs');
      const search = searchWorkspaceText(root, (rel) => workspace.resolveInside(rel), query, opts);
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), deadlineMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const result = await Promise.race([search, timeout]);
      if (result) return result;
      return {
        results: [],
        filesScanned: 0,
        truncated: true,
        scanWarning: `搜索超过 ${deadlineMs} ms 仍未完成，已返回空结果；请缩小搜索范围或指定目录。`,
        elapsedMs: deadlineMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { results: [], filesScanned: 0, truncated: false, elapsedMs: 0, error: message };
    }
  });

  // ── Quick-open file index (iteration 17) ─────────────────────────────────
  // One lazily-built index per workspace root; cached in-process with a TTL so
  // Ctrl+P can fuzzy over the whole tree without touching disk per keystroke.
  let qopen = null; // { root, index }
  ipcMain.handle('quickopen.index', async (_event, force) => {
    const root = workspace.getRoot();
    if (!root) return { files: [], truncated: false, elapsedMs: 0, cached: false, error: '没有打开工作区' };
    try {
      const { createQuickOpenIndex } = require('./quick-open.cjs');
      if (!qopen || qopen.root !== root) qopen = { root, index: createQuickOpenIndex(root, (rel) => workspace.resolveInside(rel)) };
      return await qopen.index.get(Boolean(force));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { files: [], truncated: false, elapsedMs: 0, cached: false, error: message };
    }
  });

  // ── Code snippets library (iteration 4) ──────────────────────────────────
  ipcMain.handle('snippets.list', async () => snippets.list());
  ipcMain.handle('snippets.search', async (_event, query) => snippets.search(query));
  ipcMain.handle('snippets.create', async (_event, input) => snippets.create(input));
  ipcMain.handle('snippets.update', async (_event, id, patch) => snippets.update(id, patch));
  ipcMain.handle('snippets.remove', async (_event, id) => snippets.remove(id));
  ipcMain.handle('snippets.touch', async (_event, id) => snippets.touch(id));
  ipcMain.handle('snippets.export', async () => snippets.exportAll());
  ipcMain.handle('snippets.import', async (_event, rawJson) => {
    let parsed;
    try {
      parsed = JSON.parse(String(rawJson));
    } catch {
      throw new Error('导入失败：不是合法的 JSON');
    }
    return snippets.replaceAll(parsed);
  });

  // ── Line bookmarks (iteration 6) ─────────────────────────────────────────
  ipcMain.handle('bookmarks.listAll', async () => bookmarks.listAll());
  ipcMain.handle('bookmarks.listFor', async (_event, relPath) => bookmarks.listFor(relPath));
  ipcMain.handle('bookmarks.toggle', async (_event, relPath, line, anchor) => bookmarks.toggle(relPath, line, anchor));
  ipcMain.handle('bookmarks.annotate', async (_event, relPath, line, note) => bookmarks.annotate(relPath, line, note));
  ipcMain.handle('bookmarks.move', async (_event, relPath, fromLine, toLine) => bookmarks.move(relPath, fromLine, toLine));
  ipcMain.handle('bookmarks.remove', async (_event, relPath, line) => bookmarks.remove(relPath, line));
  ipcMain.handle('bookmarks.clearFile', async (_event, relPath) => bookmarks.clearFile(relPath));

  // ── Session tags (iteration 18) ──────────────────────────────────────────
  ipcMain.handle('tags.listAll', async () => sessionTags.listAll());
  ipcMain.handle('tags.set', async (_event, sessionId, tags) => sessionTags.setTags(sessionId, tags));
  ipcMain.handle('tags.toggle', async (_event, sessionId, tag) => sessionTags.toggleTag(sessionId, tag));
  ipcMain.handle('tags.remove', async (_event, sessionId) => sessionTags.remove(sessionId));

  // ── Subagent directory ───────────────────────────────────────────────────
  // `running` vs `finished` is decided here, not in the renderer: only the
  // main process knows which sessions still have a live bridge.
  ipcMain.handle('subagents.list', async (_event, sessionId) => {
    const live = new Set(agentManager.liveSessions());
    return await subagentRuns.listGrouped(sessionId, live);
  });
  ipcMain.handle('subagents.remove', async (_event, sessionId) => subagentRuns.remove(sessionId));

  // ── User keybindings (iteration 19) ──────────────────────────────────────
  ipcMain.handle('keybindings.get', async () => keybindings.getAll());
  ipcMain.handle('keybindings.set', async (_event, actionId, chord) => keybindings.setOne(actionId, chord));

  // ── Plugin registry (iteration 20) ───────────────────────────────────────
  ipcMain.handle('plugins.catalog', async () => {
    const { catalog } = require('./plugin-registry.cjs');
    return catalog();
  });
  ipcMain.handle('plugins.status', async () => {
    const { status } = require('./plugin-registry.cjs');
    return status(workspace.getRoot());
  });

  // ── File save history timeline (iteration 7) ─────────────────────────────
  ipcMain.handle('history.list', async (_event, relativePath) => {
    try {
      const target = await resolveEditorPath(relativePath);
      return await fileHistory.list(target);
    } catch {
      return [];
    }
  });
  ipcMain.handle('history.read', async (_event, relativePath, snapshotId) => {
    try {
      const target = await resolveEditorPath(relativePath);
      const content = await fileHistory.read(target, snapshotId);
      return content === null ? { ok: false, error: '快照不存在或已清理' } : { ok: true, content };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  ipcMain.handle('history.restore', async (_event, relativePath, snapshotId) => {
    try {
      const target = await resolveEditorPath(relativePath);
      // The snapshot is text, but the file on disk may not be any more (the
      // agent replaced it with a build artifact, say). Restoring would then
      // overwrite binary bytes with text and destroy the file — the same guard
      // editor.saveFile applies, for the same reason.
      await validateTextWrite(target, '');
      const content = await fileHistory.read(target, snapshotId);
      if (content === null) return { ok: false, error: '快照不存在或已清理' };
      // Restoring overwrites current bytes — snapshot them first (the same
      // guarantee editor saves get), so undo-the-undo stays possible.
      const current = await fs.readFile(target, 'utf-8').catch(() => null);
      if (current !== null) await fileHistory.recordSave(target, current, content).catch(() => undefined);
      await fs.writeFile(target, content, 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  ipcMain.handle('history.remove', async (_event, relativePath, snapshotId) => {
    try {
      const target = await resolveEditorPath(relativePath);
      await fileHistory.remove(target, snapshotId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  ipcMain.handle('history.clear', async (_event, relativePath) => {
    try {
      const target = await resolveEditorPath(relativePath);
      return await fileHistory.clear(target);
    } catch (error) {
      return { ok: false, error: describePathError(error) };
    }
  });
  ipcMain.handle('history.tracked', async () => fileHistory.listTracked());

  // ── Workspace code census (iteration 9) ──────────────────────────────────
  ipcMain.handle('stats.census', async (_event, options) => {
    const root = workspace.getRoot();
    if (!root) return { error: '没有打开工作区', totalFiles: 0 };
    try {
      const { scanWorkspaceStats } = require('./workspace-stats.cjs');
      const scan = scanWorkspaceStats(root, (rel) => workspace.resolveInside(rel), {
        path: typeof options?.path === 'string' ? options.path : undefined,
      });
      return await withDeadline(scan, 30_000, '代码普查超过 30 秒仍未完成，请缩小工作区后重试。');
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), totalFiles: 0 };
    }
  });

  // ── Session notes sidecar (iteration 10) ─────────────────────────────────
  ipcMain.handle('notes.list', async (_event, sessionId) => notes.list(sessionId));
  ipcMain.handle('notes.add', async (_event, sessionId, input) => notes.add(sessionId, input));
  ipcMain.handle('notes.update', async (_event, sessionId, noteId, patch) => notes.update(sessionId, noteId, patch));
  ipcMain.handle('notes.remove', async (_event, sessionId, noteId) => notes.remove(sessionId, noteId));
  ipcMain.handle('notes.clear', async (_event, sessionId) => notes.clear(sessionId));
  ipcMain.handle('notes.summary', async () => notes.summary());

  // ── Cross-session transcript search (iteration 16) ───────────────────────
  ipcMain.handle('search.sessions', async (_event, query, options) => {
    const root = workspace.getRoot();
    if (!root) return { results: [], sessionsScanned: 0, elapsedMs: 0, error: '没有打开工作区' };
    try {
      const { searchSessions } = require('./session-search.cjs');
      return await searchSessions(workspace.resolveInside('.aicode/sessions'), query, options || {});
    } catch (error) {
      return { results: [], sessionsScanned: 0, elapsedMs: 0, error: error instanceof Error ? error.message : String(error) };
    }
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
  // `git init` for a folder that has never been a repository. Never stages or
  // commits anything — it only creates .git.
  ipcMain.handle('git.init',          async (_e, options) => git.initRepo(workspace.getRoot(), options || {}));
  ipcMain.handle('git.branches',      async () => git.getBranches(workspace.getRoot()));
  ipcMain.handle('git.log',           async (_e, n) => git.getLog(workspace.getRoot(), n));
  // Commit DAG with parents, for the graph view (git log --graph is ASCII).
  ipcMain.handle('git.graph',         async (_e, n) => git.getGraph(workspace.getRoot(), n));
  ipcMain.handle('git.diff',          async (_e, staged) => git.getDiff(workspace.getRoot(), staged));
  // Line-level change totals (+N −M) for the Git tools card.
  ipcMain.handle('git.diffStats',     async () => git.getDiffStats(workspace.getRoot()));
  // Per-file +N −M for the review list.
  ipcMain.handle('git.fileStats',     async () => git.getFileStats(workspace.getRoot()));
  // Drill-down: one file's diff, and one commit's detail.
  ipcMain.handle('git.fileDiff',      async (_e, filePath, staged, ref) => git.getFileDiff(workspace.getRoot(), filePath, staged === true, ref));
  ipcMain.handle('git.commitDetail',  async (_e, ref) => git.getCommitDetail(workspace.getRoot(), ref));
  // Inline editor highlights: current-file changed line ranges from git diff.
  ipcMain.handle('git.fileChangeRanges', async (_e, filePath) => git.getFileChangeRanges(workspace.getRoot(), filePath));
  ipcMain.handle('git.stage',         async (_e, paths) => git.stage(workspace.getRoot(), paths));
  ipcMain.handle('git.unstage',       async (_e, paths) => git.unstage(workspace.getRoot(), paths));
  ipcMain.handle('git.discard',       async (_e, paths) => git.discardChanges(workspace.getRoot(), paths));
  ipcMain.handle('git.commit',        async (_e, message) => git.commit(workspace.getRoot(), message));
  ipcMain.handle('git.push',          async (_e, remote, branch, force, setUpstream) => git.push(workspace.getRoot(), remote, branch, force, setUpstream));
  ipcMain.handle('git.pull',          async (_e, remote, branch, strategy) => git.pull(workspace.getRoot(), remote, branch, strategy));
  ipcMain.handle('git.checkout',      async (_e, branch) => git.checkout(workspace.getRoot(), branch));
  ipcMain.handle('git.createBranch',  async (_e, name) => git.createBranch(workspace.getRoot(), name));
  ipcMain.handle('git.deleteBranch',  async (_e, name, force) => git.deleteBranch(workspace.getRoot(), name, force));
  ipcMain.handle('git.createPr',      async (_e, opts) => git.createPr(workspace.getRoot(), opts || {}));
}

module.exports = { registerIpc };
