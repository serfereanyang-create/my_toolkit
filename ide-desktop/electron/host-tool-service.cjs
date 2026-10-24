/*
 * The desktop side of the hidden-browser RPC.
 *
 * The CLI's `background_browser_*` tools do not run in the CLI process: the CLI
 * sends `host_tool_request` over its stdin/stdout bridge and the desktop
 * performs the operation. This module is the desktop half of that pair.
 *
 * It lives here rather than inline in main.cjs for the usual reason — main.cjs
 * cannot be `require`d under `node --test` (it pulls in the `electron`
 * module), so logic left in it is logic that cannot be tested. The two halves
 * of the RPC were each covered (cli/tests/host-tool-broker.test.ts for the
 * asking side, scripts/background-browser-smoke.cjs for the doing side) while
 * the wiring between them was not; this is that wiring, and it is now covered
 * by tests/host-tool-service.test.cjs.
 */

/** Every tool this host serves. Anything else is refused, not ignored. */
const BACKGROUND_BROWSER_PREFIX = 'background_browser_';
const BACKGROUND_NATIVE_PREFIX = 'background_native_';

/**
 * Serve `host_tool_request` events from one child process.
 *
 * The request is answered under the session *that bridge* announced, never a
 * caller-supplied id: a hidden page belongs to the conversation that asked for
 * it, so one agent can never inspect or drive another's page. The reply goes
 * back over the same child's stdin.
 *
 * Every failure is answered — an unknown capability, a missing browser service
 * and a thrown error all produce a reply. Silence is the one outcome that must
 * not happen: the CLI is holding the request open against a deadline, and no
 * answer means the model waits out the full timeout to learn nothing.
 *
 * @param bridgeInstance the CLI child bridge to serve
 * @param deps.backgroundBrowser the hidden-browser service, or undefined in a
 *   build without one — the reason `!backgroundBrowser` is a refusal, not a throw
 * @param deps.workspaceRoot getter, read per request: the workspace can switch
 *   under a long-lived child
 * @param deps.sessionOf the session a bridge announced; falls back to the
 *   instance's own `sessionId` for a child that has not announced one yet
 */
function serveHostToolRequests(bridgeInstance, { backgroundBrowser, backgroundApp, backgroundNative, workspaceRoot, sessionOf }) {
  const active = new Map();
  const cancelPending = async () => {
    const requests = [...active.values()];
    for (const request of requests) request.controller.abort(new Error('已取消当前宿主操作。'));
    await Promise.all(requests.map(request => request.pending));
  };
  bridgeInstance.on('event', event => { if (event?.type === 'agent_offline') void cancelPending(); });
  bridgeInstance.on('host_tool_cancel', (request) => {
    if (!Array.isArray(request?.requestIds)) return;
    for (const requestId of request.requestIds) active.get(requestId)?.controller.abort(new Error('已取消当前宿主操作。'));
  });
  bridgeInstance.on('host_tool_request', (request) => {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    // Without an id there is nothing to correlate a reply to, so there is no
    // reply to give. Not a failure worth reporting anywhere: the CLI only omits
    // it on a malformed write, and it drops its own pending request meanwhile.
    if (!requestId) return;
    if (active.has(requestId)) return;

    const ownerSession = String(sessionOf?.(bridgeInstance) || bridgeInstance.sessionId || '');
    const tool = String(request.tool ?? '');
    const reply = (result) => {
      void bridgeInstance.sendHostToolResponse(requestId, result).catch(() => undefined);
    };

    // An unknown capability is refused rather than silently ignored, so the
    // CLI gets a definitive answer instead of waiting out its timeout.
    const service = tool.startsWith(BACKGROUND_BROWSER_PREFIX) ? backgroundBrowser : tool.startsWith('background_app_') ? backgroundApp : tool.startsWith(BACKGROUND_NATIVE_PREFIX) ? backgroundNative : undefined;
    if (!tool.startsWith(BACKGROUND_BROWSER_PREFIX) && !tool.startsWith('background_app_') && !tool.startsWith(BACKGROUND_NATIVE_PREFIX)) {
      reply({ ok: false, output: `桌面端不支持该宿主能力：${tool}` });
      return;
    }
    if (!service) {
      reply({ ok: false, output: tool.startsWith('background_app_') ? '后台应用不可用。' : tool.startsWith(BACKGROUND_NATIVE_PREFIX) ? '原生窗口后台截图不可用。' : '后台浏览器不可用。' });
      return;
    }
    const controller = new AbortController();
    let root;
    try { root = workspaceRoot(); } catch (error) { reply({ ok: false, output: `无法读取工作区：${error instanceof Error ? error.message : String(error)}` }); return; }
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return service.execute({
        sessionId: ownerSession,
        workspaceRoot: root,
        tool,
        input: request.input ?? {},
        signal: controller.signal,
      });
    })
      .then(result => { if (!controller.signal.aborted) reply(result); })
      .catch((error) => {
        // `execute` reports its own failures as `{ok:false}`, so reaching here
        // means the broker itself broke. Still answer.
        if (!controller.signal.aborted) reply({ ok: false, output: `后台能力执行失败：${error instanceof Error ? error.message : String(error)}` });
      }).finally(() => active.delete(requestId));
    active.set(requestId, { controller, pending });
  });
  return { cancelPending };
}

module.exports = { serveHostToolRequests, BACKGROUND_BROWSER_PREFIX, BACKGROUND_NATIVE_PREFIX };
