const { app, BrowserWindow, Menu, Notification, safeStorage, protocol, nativeImage, shell } = require('electron');

/**
 * 启动计时（只在 YOYCODE_STARTUP_FILE 指了文件时才写，生产路径一行日志都不多）。
 * 主进程的时间去哪了，光看渲染进程的 navigation timing 是看不见的：
 * require 全部模块、建窗口、同步构造服务各花了多少，只能在这里打点。
 */
const startupT0 = Date.now();
function startupMark(name) {
  const file = process.env.YOYCODE_STARTUP_FILE;
  if (!file) return;
  try { require('node:fs').appendFileSync(file, `${name} ${Date.now() - startupT0}
`); } catch { /* 计时不该影响启动 */ }
}
const path = require('node:path');
const fs = require('node:fs');
const { automationBus, automationSessionDir, unattendedApprovalDecision } = require('./automation.cjs');

// Windows shows toast notifications only when the app has a stable
// AppUserModelId; without it the Electron default is silently dropped.
if (process.platform === 'win32') app.setAppUserModelId('com.yoycode.desktop');

// The renderer draws its own minimal top bar; drop Electron's native
// File/Edit/View/Window/Help application menu.
Menu.setApplicationMenu(null);
const { createWorkspaceService } = require('./workspace.cjs');
const { BridgeRegistry } = require('./bridge-registry.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { createSecretStore } = require('./secret-store.cjs');
const { createSnippetsStore } = require('./snippets-store.cjs');
const { createBookmarkStore } = require('./bookmarks-store.cjs');
const { createFileHistoryStore } = require('./file-history.cjs');
const { createSessionNotesStore } = require('./session-notes.cjs');
const { createSessionTagsStore } = require('./session-tags.cjs');
const { createSubagentRunStore } = require('./subagent-runs.cjs');
const { createKeybindingsStore } = require('./keybindings-store.cjs');
const { registerIpc } = require('./ipc.cjs');
const { AgentBridge } = require('./agent-bridge.cjs');
const { TerminalManager } = require('./terminal.cjs');
const { syncPersonaFile } = require('./persona.cjs');
const { cliProviderName, resolveBaseUrl } = require('./provider-map.cjs');
const { isExternalWebUrl } = require('./external-links.cjs');
const { testProviderConnection } = require('./connectivity.cjs');
const { createUsageStore } = require('./usage-store.cjs');
const { MessageQueueStore } = require('./message-queue-store.cjs');
const { createAutomationService } = require('./automation.cjs');
const { registerSchemePrivileges } = require('./preview-protocol.cjs');
const { createPreviewService } = require('./preview-service.cjs');
const { createPreviewRuntime } = require('./preview-runtime.cjs');
const { createBackgroundBrowserService } = require('./background-browser.cjs');
const { BackgroundAppService } = require('./background-app.cjs');
const { createGuiControlService } = require('./gui-control.cjs');
const { serveHostToolRequests } = require('./host-tool-service.cjs');
const { createFimServer } = require('./fim-server.cjs');
const { createLanguageServer } = require('./language-server.cjs');
const { CompletionService } = require('./completion-service.cjs');
startupMark('modules-required');

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
  if ((event.type === 'turn_done' && event.status === 'cancelled') || (event.type === 'agent_offline' && event.expected === true)) return;
  const rules = {
    approval_needed: { title: '需要确认执行', body: `工具 ${String(event.tool || '')} 等待你的批准`, pref: 'permission' },
    turn_done: { title: '任务完成', body: '智能体已完成本轮工作', pref: 'turn' },
    error: { title: '执行出错', body: String(event.message || '智能体报告了一个错误'), pref: 'turn' },
    agent_offline: { title: '连接断开', body: '智能体已离线，下次提问时会自动重连', pref: 'turn' },
  };
  const rule = rules[event.type];
  if (!rule) return;
  // `turn_done` with status ok only means the loop ended without an error. A
  // turn that replied but ran no tools (answered a question, declined a
  // request) must not be announced as 任务完成 — the user asked for something
  // and nothing happened.
  if (event.type === 'turn_done' && event.status !== 'error' && event.producedActivity === false) {
    rule.title = '本轮已回复';
    rule.body = '未执行任何操作（只做了回复）';
  } else if (event.type === 'turn_done' && event.status === 'error') {
    rule.title = '本轮执行失败';
    rule.body = typeof event.reason === 'string' && event.reason.trim()
      ? event.reason.trim().slice(0, 200)
      : 'CLI 没有返回失败原因';
  }

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

function createAgentManager({ mainWindow, workspace, settings, secrets, subagentRuns, backgroundBrowser, backgroundApp, backgroundNative }) {
  /**
   * One CLI child per session, not one for the whole app.
   *
   * This used to be a single `bridge`, and `startNow` disposed it before
   * spawning the next — so opening another conversation killed the running
   * task, and the UI had to warn about it. A second bridge was already proven
   * to work (see `sideBridge` below), so the constraint was this variable, not
   * the process layer.
   */
  const registry = new BridgeRegistry();
  let lifecycleQueue = Promise.resolve();

  function enqueueLifecycle(task) {
    const run = lifecycleQueue.then(task);
    lifecycleQueue = run.catch(() => undefined);
    return run;
  }
  /**
   * Session ids whose bridge is currently up. The 子智能体目录 uses this to
   * tell a genuinely running subagent from one whose bridge died mid-flight:
   * a stale "running" row would be a lie.
   *
   * `bridge_ready` names the session; `agent_offline` does not, so each bridge
   * instance remembers the session it announced and clears it when that same
   * bridge reports offline (crash, cancel, or shutdown).
   */
  const liveSessions = new Set();
  const hostServices = new WeakMap();
  const sessionOfBridge = new WeakMap();
  /**
   * @param track whether this bridge is a *user* conversation.
   *
   * The bridge→session mapping is always recorded, because it is what stamps
   * session ids onto the CLI's id-less streaming events and what scopes a
   * hidden-browser request to its owner. Only a user conversation additionally
   * joins `liveSessions` and the registry: the automation child must be
   * reachable by neither, or it would show up as a session the user can open
   * and disposeAllBridges would tear it down mid-run.
   */
  function trackSessionLifecycle(bridgeInstance, event, track) {
    if (!event || !bridgeInstance) return;
    if (event.type === 'bridge_ready' && event.sessionId) {
      const id = String(event.sessionId);
      sessionOfBridge.set(bridgeInstance, id);
      if (!track) return;
      liveSessions.add(id);
      // Adopt the bridge under its real session id. `startNow` could not know
      // it before the child announced it (a resumed session keeps its id, a
      // fresh one gets a new id).
      registry.adopt(bridgeInstance, id);
    } else if (event.type === 'agent_offline') {
      const id = sessionOfBridge.get(bridgeInstance);
      if (id) {
        // The mapping itself is kept: it is how a late event — a `turn_done`
        // racing the disconnect — still gets attributed, and an unattributed
        // one leaves a turn card spinning. The WeakMap entry goes with the
        // bridge instance, so holding it costs nothing.
        if (!track) return;
        liveSessions.delete(id);
        registry.removeBridge(bridgeInstance);
      }
    }
  }

  /**
   * The bridge for a session, or the sole running one when no id is given.
   *
   * A caller that names no session gets the only live bridge — that is the
   * pre-existing single-session behaviour, kept so an un-updated caller keeps
   * working instead of silently addressing the wrong conversation.
   */
  function bridgeFor(sessionId) {
    return registry.get(sessionId);
  }

  /**
   * Answer `background_browser_*` RPCs from one child.
   *
   * The wiring lives in `host-tool-service.cjs` so it can be tested — see that
   * module for why the session is taken from the bridge rather than the request.
   * Both call sites (the user bridge and the automation bridge) go through here,
   * so the two cannot drift on which session owns a hidden page.
   */
  function serveHostToolRequestsFor(bridgeInstance) {
    hostServices.set(bridgeInstance, serveHostToolRequests(bridgeInstance, {
      backgroundBrowser,
      backgroundApp,
      backgroundNative,
      workspaceRoot: () => workspace.getRoot(),
      sessionOf: (bridge) => sessionOfBridge.get(bridge),
    }));
  }

  /**
   * Forward one child's events to the window.
   *
   * `background` marks a stream that must never be folded into the conversation
   * on screen — the automation agent runs unattended and its transcript belongs
   * to no chat the user is reading.
   */
  function attachEventStream(bridgeInstance, { background = false, track = true } = {}) {
    bridgeInstance.on('event', (event) => {
      // Subagent runs are persisted so the 子智能体目录 survives a reload.
      // Recording is fire-and-forget: a sidecar write failure must never
      // stall the event stream the conversation depends on.
      if (event && (event.type === 'subagent_started' || event.type === 'subagent_done')) {
        void Promise.resolve(
          subagentRuns.record({ ...event, phase: event.type === 'subagent_done' ? 'done' : 'started' }),
        ).catch(() => undefined);
      }
      // Track which sessions have a live bridge, so a run whose bridge died
      // mid-flight is not reported as still running. Must run before the send
      // so the stamped session id is available.
      trackSessionLifecycle(bridgeInstance, event, track);
      const sessionId = sessionOfBridge.get(bridgeInstance);
      // Stamp every event with the session it came from. The CLI's streaming
      // events (turn_start, tool_start, assistant_delta) carry no session id of
      // their own, and with several bridges on one channel the renderer cannot
      // otherwise tell whose turn a step belongs to.
      const stamped = sessionId ? { ...event, sessionId: event.sessionId ?? sessionId } : event;
      const outgoing = background ? { ...stamped, background: true } : stamped;
      // The window may be closing while the child is still draining events.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent.event', outgoing);
      notifyKeyState(outgoing, mainWindow, settings);
      if (event.type === 'automation_done') {
        // Bug-12 fix: use the dedicated automationBus instead of mainWindow.emit()
        // so the handler in automation.cjs survives window recreation.
        automationBus.emit('automation.done', event);
      }
      /**
       * A dead automation child is not a completion, so it needs its own signal.
       *
       * Nothing else can tell the service: `automation_done` comes from the child
       * itself, and a child that died never sends one. Without this the run sat in
       * `running` — answering every later trigger `busy` — until the one-hour
       * watchdog. Reported before the offline flag is read for anything else, and
       * only for the bridge that owns the run.
       */
      if (background && event.type === 'agent_offline') {
        automationBus.emit('automation.bridge_gone', {
          sessionId,
          reason: `自动化子进程已退出（code ${event.code ?? 'unknown'}）`,
        });
      }
    });
  }

  async function startNow(resumeSessionId) {
    // Reuse the live bridge when this session already has one. Restarting it
    // would kill a turn that is still running — the exact behaviour that made
    // switching conversations destructive.
    if (resumeSessionId) {
      const existing = registry.get(resumeSessionId);
      if (existing && existing.child) return { ok: true, reused: true, sessionId: resumeSessionId, running: existing.isRunning(), taskBoard: existing.taskBoard };
      if (existing && [...existing.processes.values()].some(record => !record.exited)) throw new Error('旧执行进程尚未结束，未启动第二个执行进程。');
    }

    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
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
    const capturedBridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      sessionDir: path.join(workspace.getRoot(), '.aicode', 'sessions'),
      provider,
      model: providerConfig.model,
      requestTimeoutMs: config.preferences?.requestTimeoutMs,
      baseUrl,
      apiKey,
      customProvider: providerConfig.type === 'custom',
      // "任意应用" is ON unless explicitly turned off — the same rule the
      // settings page and the persona text use. Reading it as `=== true` meant
      // a profile that never touched the toggle (the common case) launched the
      // CLI without --computer-any-app, so the agent could never wake native
      // computer control on its own even in 完全访问 mode.
      computerAnyApp: config.preferences?.computerAnyApp !== false,
      allowedApps: Array.isArray(config.preferences?.computerAllowedApps) ? config.preferences.computerAllowedApps : [],
      excelAutomation: config.preferences?.computerExcel === true,
      approval: config.approval,
      reasoningEffort,
      toolScope,
      contextWindowTokens: contextWindowForModel(providerConfig),
      confirmPlan: config.preferences?.taskExecutionMode === 'auto',
      autoReview: config.preferences?.autoReview === true,
      delegation: config.preferences?.delegation,
      // The hidden browser is always offered; `background-browser-only` is what
      // additionally forbids falling back to native computer_* control. Default
      // (and the recommended setting) is background-only, so a web task can
      // never quietly start driving the real mouse and keyboard.
      backgroundBrowser: true,
      backgroundBrowserOnly: config.preferences?.computerExecutionMode !== 'desktop',
      resumeSessionId: resumeSessionId || undefined,
    });
    registry.addPending(capturedBridge);
    serveHostToolRequestsFor(capturedBridge);
    attachEventStream(capturedBridge);
    // Do not report startup complete until the CLI has emitted bridge_ready;
    // otherwise the first prompt can race the child process initialization.
    // The ready promise carries the session id the child announced, so the
    // caller learns which conversation it just opened (a resumed session keeps
    // its id, a fresh one is assigned here).
    const ready = await capturedBridge.start();
    // If bridge_ready never arrived the bridge is not adopted; keep it out of
    // the registry so a later start() does not reuse a dead child.
    if (resumeSessionId && registry.get(resumeSessionId) === undefined) {
      registry.adopt(capturedBridge, resumeSessionId);
    }
    // The renderer binds the returned id before its first prompt; returning
    // without one left `agent/bind` undefined and every later event unattributable.
    const sessionId = ready?.sessionId || capturedBridge.sessionId || resumeSessionId || undefined;
    return { ok: true, ...(sessionId ? { sessionId } : {}), taskBoard: capturedBridge.taskBoard };
  }

  function start(resumeSessionId) {
    return enqueueLifecycle(() => startNow(resumeSessionId));
  }

  // ── Side chat: an independent bridge with its own session ──────────────────
  // Runs alongside the main conversation instead of sharing it. Writes are
  // auto-denied (approval: 'deny'), so the side agent is a read-only assistant
  // that can inspect the workspace while the main agent is editing.
  let sideBridge;

  /**
   * Drop the side session, awaiting the child rather than merely forgetting it.
   * An un-awaited dispose would leave the old child holding the previous
   * workspace root open while the new workspace is already in use.
   */
  async function dropSideChat() {
    if (!sideBridge) return { ok: true };
    const stopping = sideBridge;
    sideBridge = undefined;
    await stopping.dispose();
    return { ok: true };
  }

  async function startSideChat() {
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
    // Replace any existing side child through the same awaited path, so its
    // process is gone before the replacement opens the same session scope.
    await dropSideChat();
    sideBridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      // Separate session scope so side conversations never appear in (or get
      // resumed by) the main session list.
      sessionDir: path.join(workspace.getRoot(), '.aicode', 'sessions-side'),
      provider: cliProviderName(providerConfig),
      model: providerConfig.model,
      requestTimeoutMs: config.preferences?.requestTimeoutMs,
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

  // ── Automation: one long-lived child, separate from every conversation ─────
  // A scheduled task runs unattended and may run for an hour. Sharing the user's
  // conversation child would make the run visible in the chat transcript, let
  // the user's own 停止 button kill it, and — worse — queue it behind whatever
  // turn is already running (`automation_task` answers `busy` and drops the
  // run). Its own child also keeps its own session file, so a scheduled run no
  // longer appends to the conversation the user is reading.
  let automationBridge;

  /** The automation child, started on first use. */
  async function startAutomationBridge() {
    if (automationBridge && automationBridge.child) return automationBridge;
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
    // The run is unattended, so an approval mode that needs a person cannot be
    // honoured here. Refuse with a reason instead of silently promoting the
    // mode: `auto` widens the writable scope to the whole machine, which is not
    // a decision to make on the user's behalf.
    const approvalDecision = unattendedApprovalDecision(config.approval);
    if (!approvalDecision.ok) throw new Error(approvalDecision.reason);
    const bridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      sessionDir: automationSessionDir(workspace.getRoot()),
      provider: cliProviderName(providerConfig),
      model: providerConfig.model,
      requestTimeoutMs: config.preferences?.requestTimeoutMs,
      baseUrl: resolveBaseUrl(providerConfig),
      apiKey,
      customProvider: providerConfig.type === 'custom',
      approval: approvalDecision.approval,
      contextWindowTokens: contextWindowForModel(providerConfig),
      // The board is the point of an automation run: create it and execute it,
      // without waiting for a confirmation nobody is there to give.
      confirmPlan: true,
      backgroundBrowser: true,
      backgroundBrowserOnly: config.preferences?.computerExecutionMode !== 'desktop',
    });
    serveHostToolRequestsFor(bridge);
    // `track: false`: the run is marked `background` so the renderer never folds
    // it into the visible chat, and it stays out of the session registry so a
    // workspace switch does not tear it down mid-run (automation.disposeAll
    // stops the run itself, through this bridge's own dispose).
    attachEventStream(bridge, { background: true, track: false });
    automationBridge = bridge;
    try {
      await bridge.start();
    } catch (error) {
      // A child that never came up must not be cached, or every later run would
      // reuse this dead one instead of retrying the spawn.
      if (automationBridge === bridge) automationBridge = undefined;
      throw error;
    }
    return bridge;
  }

  /** Stop the automation child. The next run starts a fresh one. */
  async function stopAutomationBridge() {
    if (!automationBridge) return { ok: true };
    const stopping = automationBridge;
    automationBridge = undefined;
    await stopping.dispose();
    return { ok: true };
  }

  return {
    start(resumeSessionId) {
      return start(resumeSessionId);
    },
    /** Session ids with a live bridge — the directory's running/finished split. */
    liveSessions() {
      return [...liveSessions];
    },
    async taskBoardAction(action, taskId, sessionId) {
      const target = bridgeFor(sessionId);
      if (!target) throw new Error('Agent is not started');
      if (action === 'pause' && target.isRunning()) {
        const [result] = await Promise.all([target.interrupt(), hostServices.get(target)?.cancelPending()]);
        return { ok: true, ...result };
      }
      await target.taskBoardAction(action, taskId);
      return { ok: true };
    },
    async prompt(text, files, toolScope, sessionId) {
      // Recover from a bridge that failed during startup or exited before the
      // renderer sent its first prompt. The old synchronous throw forced the
      // user to resend the message manually.
      let target = bridgeFor(sessionId);
      if (!target || !target.child) {
        await start(sessionId);
        target = bridgeFor(sessionId);
      }
      if (!target || !target.child) throw new Error('Agent bridge failed to start');
      await target.prompt(text, files, toolScope);
      return { ok: true };
    },
    /**
     * Run one scheduled task on the automation child.
     *
     * `sessionId` is ignored on purpose: a run must never be dispatched into a
     * user conversation, whatever id a caller passes. The hidden `/plan
     * confirm` machinery it drives writes its own session file under
     * sessions-automation.
     */
    async automationTask(taskId, goal) {
      const target = await startAutomationBridge();
      await target.automationTask(taskId, goal);
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
    async sideChatCancel() {
      if (!sideBridge) return { ok: true, mode: 'idle' };
      const [result] = await Promise.all([sideBridge.interrupt(), hostServices.get(sideBridge)?.cancelPending()]);
      return { ok: true, ...result };
    },
    /** Drop the side session so the next prompt starts a fresh conversation. */
    sideChatReset() {
      return dropSideChat();
    },
    /**
     * Workspace switch: the side agent is workspace-bound like the main one, so
     * it is torn down with the rest and re-created lazily on the next prompt.
     */
    sideChatRestart() {
      return dropSideChat();
    },
    setEffort(reasoningEffort, sessionId) {
      const normalized = normalizeEffort(reasoningEffort);
      // Update the live child if running; otherwise it takes effect at next start.
      const target = bridgeFor(sessionId);
      if (target) target.setEffort(normalized);
      return { ok: true, reasoningEffort: normalized };
    },
    setToolScope(toolScope, sessionId) {
      const normalized = normalizeToolScope(toolScope);
      const target = bridgeFor(sessionId);
      if (target) target.setToolScope(normalized);
      return { ok: true, toolScope: normalized };
    },
    async approve(requestId, decision, sessionId) {
      const target = bridgeFor(sessionId);
      if (!target) throw new Error('Agent is not started');
      await target.approve(requestId, decision);
      return { ok: true };
    },
    async undo(checkpointIds, undoId, sessionId) {
      const target = bridgeFor(sessionId);
      if (!target) throw new Error('Agent is not started');
      await target.undo(Array.isArray(checkpointIds) ? checkpointIds : [], undoId);
      return { ok: true };
    },
    async cancel(sessionId) {
      const target = bridgeFor(sessionId) || (sessionId ? registry.all().find(candidate => !candidate.ready && candidate.resumeSessionId === sessionId) : undefined);
      if (!target) return { ok: true, mode: 'idle' };
      const [result] = await Promise.all([target.interrupt(), hostServices.get(target)?.cancelPending()]);
      return { ok: true, ...result };
    },
    /**
     * Ensure a live bridge for a session. Reuses one that is already up, so
     * opening a conversation whose task is still running does NOT restart it.
     * To apply changed settings, use `restartSession`.
     */
    async restart(resumeSessionId) {
      return start(resumeSessionId);
    },
    /**
     * Respawn one session's child under its CURRENT settings.
     *
     * `start()` deliberately reuses a live bridge, which is right for opening a
     * conversation and wrong here: provider, model, approval mode and the
     * background-browser flags are all baked into the CLI child at spawn time,
     * so switching a model would otherwise send the next turn to the old one.
     *
     * The old child is disposed and a NEW bridge is built by `startNow`, which
     * re-reads settings. Resuming the same bridge instance would not do: its
     * argv was captured at construction, so it would respawn with the same model
     * and report it back as if the switch had worked.
     */
    async restartSession(sessionId) {
      const target = sessionId ? registry.get(String(sessionId)) : bridgeFor(undefined);
      if (!target) return start(sessionId);
      // The session keeps its id — the replacement child resumes it, so the
      // transcript and the on-disk file are the same conversation.
      const id = sessionId ?? registry.sessionOf(target);
      await enqueueLifecycle(async () => {
        registry.removeBridge(target);
        if (id) liveSessions.delete(String(id));
        await target.dispose().catch(() => undefined);
      });
      return start(id);
    },
    /** Close one session's bridge, leaving the others running. */
    async stopSession(sessionId) {
      const target = registry.remove(sessionId);
      // The conversation's hidden pages belong to it; leaving them open would
      // keep an offscreen window (and its memory session) alive forever.
      if (sessionId) void backgroundBrowser?.closeSession(String(sessionId));
      if (sessionId) void backgroundApp?.closeSession(String(sessionId));
      if (target) await target.dispose();
      return { ok: true };
    },
    /**
     * Drop every live bridge without starting a new one. The approval mode and
     * auto-review are baked into the CLI child at spawn time, so changing them
     * in settings must invalidate the running children; the next prompt lazily
     * re-starts with the new settings (prompt() already recovers).
     */
    async invalidate() {
      return disposeAllBridges();
    },
    /**
     * A new workspace root: every child was spawned against the old one, so it
     * holds the wrong session dir, git safety root and tool paths. Tear them all
     * down and start nothing here — the renderer asks for a session when it is
     * ready, and `prompt()` lazily re-starts. Both the side agent and the
     * subagent directory are workspace-bound too, so neither may survive.
     */
    async switchWorkspace() {
      // `dropSideChat`, not `sideChatRestart()`: this object literal's methods
      // are not in scope as bare identifiers, so calling the sibling method
      // threw `ReferenceError: sideChatRestart is not defined` and the whole
      // workspace switch failed. `sideChatRestart` is itself a thin alias for
      // this same function.
      await dropSideChat();
      await stopAutomationBridge();
      return disposeAllBridges();
    },
    async dispose() {
      await disposeAllBridges();
      if (sideBridge) await sideBridge.dispose();
      await stopAutomationBridge();
    },
  };

  /**
   * Tear down every live child, leaving the registry empty and the live-session
   * set honest. Bridges are disposed concurrently: they are independent
   * processes, and awaiting them in series would make a workspace switch take
   * as long as the sum of their shutdown timeouts.
   */
  async function disposeAllBridges() {
    const all = registry.all();
    registry.clear();
    // A bridge that is gone must stop being reported as running, or the
    // 子智能体目录 keeps showing a row for a child that no longer exists.
    liveSessions.clear();
    await Promise.all(all.map((target) => target.dispose().catch(() => undefined)));
    return { ok: true };
  }
}

/**
 * Window/taskbar icon.
 *
 * Prefers the built PNG (resources/icon-256.png, produced by
 * scripts/build-icons.cjs from resources/icon.svg). Falls back to a valid
 * 16x16 fully-transparent bitmap so a stripped checkout still yields a real
 * image object instead of letting Electron show its default atom.
 */
function loadWindowIcon() {
  const iconPath = path.join(__dirname, '..', 'resources', 'icon-256.png');
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image;
  } catch {
    // fall through to the transparent placeholder
  }
  return nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4), { width: 16, height: 16 });
}

function createWindow() {
  startupMark('create-window:start');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'YOYcode Desktop IDE',
    backgroundColor: '#f8fafc',
    // Windows falls back to the exe's default (Electron atom) icon when the
    // window icon is EMPTY. Point at the built app icon so the title bar and
    // taskbar show the YOYcode mark; keep a valid transparent bitmap as the
    // fallback for a stripped package where resources/ is absent.
    icon: loadWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // The renderer is untrusted: it renders model output, tool output and
      // file contents, any of which can carry a script. Every privilege it has
      // must come from preload.cjs over IPC, so the renderer process itself is
      // confined to Chromium's OS sandbox. preload.cjs only needs contextBridge
      // and ipcRenderer, which sandboxed preloads support.
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // The renderer is a local file:// app. Any attempt to navigate the main
  // window away from it — a stray location assignment, a form with a target,
  // or a remote redirect — would replace the whole IDE with a web page that
  // still has this window's identity. Nothing in the app legitimately does
  // this, so deny it and hand the URL to the OS browser instead.
  //
  // Only http(s) goes to the OS. shell.openExternal launches whatever handler
  // a scheme is registered to, and transcript content (model output, tool
  // output, file names) can put arbitrary links in front of the user: a
  // `file:///` link would open a local file in its default app and a custom
  // scheme would launch the registered program. The window-open handler below
  // already refuses everything but http(s); this path must match it.
  const isAppUrl = (target) => {
    try {
      const url = new URL(target);
      return url.protocol === 'file:' && path.resolve(decodeURIComponent(url.pathname).replace(/^\//, '')) === path.join(__dirname, '..', 'dist', 'index.html');
    } catch {
      return false;
    }
  };
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    if (isExternalWebUrl(target)) shell.openExternal(target, { activate: true }).catch(() => {});
  });
  // Links in the transcript use target="_blank". Left unhandled, Electron
  // opens a bare BrowserWindow with no address bar and no chrome of its own,
  // which reads as part of the IDE while showing arbitrary remote content.
  // Send those to the real browser too, and refuse every other popup shape.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) shell.openExternal(url, { activate: true }).catch(() => {});
    return { action: 'deny' };
  });
  // A renderer that was navigated by a bug must not silently keep running.
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  const workspace = createWorkspaceService();
  const settings = createSettingsStore(app.getPath('userData'));
  const secrets = createSecretStore({ userDataDir: app.getPath('userData'), safeStorage });
  const snippets = createSnippetsStore(app.getPath('userData'));
  const bookmarks = createBookmarkStore(() => workspace.getRoot());
  const fileHistory = createFileHistoryStore(app.getPath('userData'));
  const notes = createSessionNotesStore(app.getPath('userData'));
  const sessionTags = createSessionTagsStore(() => workspace.getRoot());
  const subagentRuns = createSubagentRunStore(() => workspace.getRoot());
  const keybindings = createKeybindingsStore(app.getPath('userData'));
  const connectivity = { test: (args) => testProviderConnection(args) };
  const usage = createUsageStore();
  const messageQueues = new MessageQueueStore(path.join(app.getPath('userData'), 'message-queues'));
  let queueShutdown = 'idle';
  app.on('before-quit', event => {
    if (queueShutdown === 'done') return;
    event.preventDefault();
    if (queueShutdown === 'flushing') return;
    queueShutdown = 'flushing';
    void messageQueues.flush().finally(() => { queueShutdown = 'done'; app.quit(); });
  });
  const backgroundBrowser = createBackgroundBrowserService();
  const backgroundApp = new BackgroundAppService();
  const guiControl = createGuiControlService({ cliRoot: path.resolve(__dirname, '..', '..', 'cli') });
  const backgroundNative = { execute: ({ tool, input, signal }) => guiControl.invoke('computer_window_shot', input, signal) };
  const agentManager = createAgentManager({ mainWindow, workspace, settings, secrets, subagentRuns, backgroundBrowser, backgroundApp, backgroundNative });
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
    // Hidden pages are renderer-backed; a surviving one would hold a live
    // offscreen window (and its memory session) after the UI is gone.
    backgroundBrowser.dispose();
    void backgroundApp.dispose();
  });
  registerIpc({ mainWindow, workspace, settings, secrets, connectivity, usage, messageQueues, automation, agentManager, terminalManager, previewService, previewRuntime, backgroundBrowser, backgroundApp, guiControl, ensureFimServer, ensureCompletionService, ensureLanguageServer, snippets, bookmarks, fileHistory, notes, sessionTags, keybindings, subagentRuns });

  startupMark('services-ready');
  mainWindow.webContents.once('did-finish-load', () => startupMark('renderer-loaded'));
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
