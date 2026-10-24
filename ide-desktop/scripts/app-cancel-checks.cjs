'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

module.exports = async function runCancellationChecks(context) {
  const { evaluate, click, waitFor, capture, check, fixture, ownedDirectory, reload, settle, sendKey } = context;
  ownedDirectory('profile');
  const output = path.join(__dirname, '..', 'out', 'interrupt-review', 'app'); fs.mkdirSync(output, { recursive: true });
  const original = await evaluate('window.zcodeDesktop.settings.get()');
  let requests = 0; let streamClosed = false;
  const prompts = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => {
      requests += 1;
      try {
        const parsed = JSON.parse(body);
        const content = parsed.messages?.filter(message => message.role === 'user').at(-1)?.content;
        prompts.push(Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('') : content);
      } catch { prompts.push('unparsed'); }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests === 1) {
        response.write('data: {"choices":[{"delta":{"content":"partial-before-stop"}}]}\n\n');
        response.once('close', () => { streamClosed = true; });
      } else response.end(`data: {"choices":[{"delta":{"content":"fixture-reply-${requests}"}}]}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let sessionId;
  const input = 'textarea[aria-label="输入任务或问题"]';
  const submit = async (text, queue = false) => {
    await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(input)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    if (queue) {
      await click(input);
      await sendKey({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sendKey({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    } else await click('button[aria-label="发送消息"]');
    await settle();
  };
  const openSession = async id => {
    await waitFor(`!!document.querySelector('[data-session-id="${id}"] .rail-convo')`, 'saved cancelled conversation');
    await click(`[data-session-id="${id}"] .rail-convo`);
    await waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 'restored composer');
  };
  try {
    const provider = { id: 'interrupt-fixture', type: 'custom', label: 'Cancellation fixture', apiFormat: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }] };
    await evaluate(`window.zcodeDesktop.secrets.setApiKey('interrupt-fixture', 'test-only')`);
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...original.preferences, requestTimeoutMs: 60000, 'gen.sendShortcut': 'enter', 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail-primary-new")', 'cancellation fixture workspace');
    const previous = await evaluate(`window.zcodeDesktop.messageQueue.load(${JSON.stringify(fixture)})`);
    fs.writeFileSync(path.join(output, 'queue-before.json'), JSON.stringify(previous, null, 2));
    await evaluate(`window.zcodeDesktop.messageQueue.save(${JSON.stringify(fixture)}, { messages: [], pausedSessions: [] })`);
    await reload();
    await waitFor('!!document.querySelector(".rail-primary-new")', 'cleared cancellation fixture');
    await evaluate('window.interruptUiEvents = []; window.interruptUiUnsubscribe = window.zcodeDesktop.agent.onEvent(event => { if (["bridge_ready","turn_done","cancel_ack","agent_offline","error"].includes(event.type)) window.interruptUiEvents.push(event); }); undefined');
    await click('.rail-primary-new');
    await waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 'chat composer');
    const stopped = await check('CANCEL App stops a real model stream without disconnecting its conversation', async () => {
      await submit('Reply briefly while cancellation is inspected');
      await waitFor('document.body.textContent.includes("partial-before-stop")', 'actual streamed model text');
      sessionId = await evaluate('window.interruptUiEvents.find(event => event.type === "bridge_ready")?.sessionId');
      assert.ok(sessionId);
      await reload(); await waitFor('!!document.querySelector(".rail")', 'reload during active model');
      await evaluate('window.interruptUiEvents = []; window.interruptUiUnsubscribe = window.zcodeDesktop.agent.onEvent(event => { if (["bridge_ready","turn_done","cancel_ack","agent_offline","error"].includes(event.type)) window.interruptUiEvents.push(event); }); undefined');
      await openSession(sessionId);
      await waitFor('!!document.querySelector(".composer-stop")', 'running state restored from live bridge');
      assert.equal(requests, 1);
      await submit('queued-first-marker', true); await submit('queued-second-marker', true);
      await waitFor('document.querySelectorAll(".msg-queue-item").length === 2', 'two queued messages');
      await click('button[aria-label="停止当前任务"]');
      await waitFor('!!document.querySelector(".msg-queue-paused") && !document.querySelector(".composer-stop")', 'cancelled and paused conversation');
      const events = await evaluate('window.interruptUiEvents');
      const done = events.find(event => event.type === 'turn_done' && event.status === 'cancelled');
      assert.ok(done, JSON.stringify(events)); sessionId = done.sessionId;
      await waitFor('document.body.textContent.includes("本轮已停止")', 'cancelled reply marker');
      assert.equal(events.some(event => event.type === 'agent_offline' && event.sessionId === sessionId), false);
      assert.equal(events.some(event => event.type === 'error'), false);
      assert.equal(requests, 1);
      await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(streamClosed, true);
      await capture('cancel-paused-queue');
    });
    assert.equal(stopped, true, 'actual App cancellation gate');
    const restored = await check('CANCEL Paused messages survive a real renderer reload with no automatic request', async () => {
      await waitFor(`(async () => (await window.zcodeDesktop.messageQueue.load(${JSON.stringify(fixture)})).messages.length === 2)()`, 'queue reaches durable storage');
      await reload(); await waitFor('!!document.querySelector(".rail")', 'reloaded cancellation workspace');
      await openSession(sessionId);
      await waitFor('document.querySelectorAll(".msg-queue-item").length === 2 && !!document.querySelector(".msg-queue-paused")', 'durable paused queue');
      assert.equal(requests, 1);
      const saved = await evaluate(`window.zcodeDesktop.sessions.load(${JSON.stringify(sessionId)})`);
      assert.ok(saved.messages.some(message => message.interrupted && message.content.includes('partial-before-stop')));
      await waitFor('document.body.textContent.includes("partial-before-stop") && document.body.textContent.includes("本轮已停止")', 'saved interrupted reply');
      await capture('cancel-queue-restored');
    });
    assert.equal(restored, true, 'durable queue restore gate');
    await check('CANCEL Continue queue sends its messages exactly once and in order', async () => {
      await click('.msg-queue-paused button');
      await waitFor('document.body.textContent.includes("fixture-reply-3") && !document.querySelector(".msg-queue-item")', 'resumed queue drains');
      assert.equal(requests, 3);
      assert.deepEqual(prompts.slice(1), ['queued-first-marker', 'queued-second-marker']);
      await waitFor(`(async () => (await window.zcodeDesktop.messageQueue.load(${JSON.stringify(fixture)})).messages.length === 0)()`, 'consumed queue persists empty');
      await capture('cancel-queue-resumed');
    });
    fs.writeFileSync(path.join(output, 'events.json'), JSON.stringify(await evaluate('window.interruptUiEvents || []'), null, 2));
    fs.writeFileSync(path.join(output, 'server.json'), JSON.stringify({ requests, streamClosed, prompts, sessionId }, null, 2));
  } finally {
    if (sessionId) await evaluate(`window.zcodeDesktop.agent.cancel(${JSON.stringify(sessionId)})`).catch(() => undefined);
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
};
