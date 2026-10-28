'use strict';
require('./lib/probe-guard.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

module.exports = async function runSendRecoveryChecks(context) {
  const { evaluate, click, waitFor, settle, check, reload, capture, fixture, ownedDirectory } = context;
  const { dialog } = require('electron');
  const original = await evaluate('window.zcodeDesktop.settings.get()');
  const originalPicker = dialog.showOpenDialog;
  const { AgentBridge } = require('../electron/agent-bridge.cjs');
  const originalPrompt = AgentBridge.prototype.prompt;
  const requests = [];
  let faultMode;
  let faultMarker;
  let releaseFault;
  let faultStarted;
  AgentBridge.prototype.prompt = async function(text, ...args) {
    if (faultMode && text.includes(faultMarker)) {
      const mode = faultMode;
      faultMode = undefined;
      faultStarted?.();
      if (mode === 'delayed' || mode === 'delayed-success') await new Promise(resolve => { releaseFault = resolve; });
      if (mode === 'delayed-success') return originalPrompt.call(this, text, ...args);
      throw new Error('Injected unaccepted delivery failure');
    }
    return originalPrompt.call(this, text, ...args);
  };
  const output = path.join(__dirname, '..', 'out', 'send-recovery-review');
  fs.mkdirSync(output, { recursive: true });
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        requests.push(payload.messages.filter(message => message.role === 'user').at(-1));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `SEND_RECOVERY_ACCEPTED_${requests.length}` } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) { response.writeHead(400); response.end(error.message); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = path.join(ownedDirectory('send-recovery-source'), 'send-reference.txt');
  fs.writeFileSync(source, 'SEND_RECOVERY_ATTACHMENT\n');
  const currentText = () => evaluate('document.querySelector(".composer-input-row textarea").value');
  const writeDraft = async text => {
    await evaluate(`(() => {
      const field = document.querySelector('.composer-input-row textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
      field.setSelectionRange(field.value.length, field.value.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
  };
  const addContext = async marker => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    await click('.composer button[aria-label="添加附件"]');
    await waitFor('!!document.querySelector(".file-attachment-card")', 'retry attachment selected');
    await writeDraft(marker + ' @session');
    await waitFor('[...document.querySelectorAll(".mention-item")].some(item => item.textContent.includes("session.ts"))', 'retry file reference');
    await evaluate('[...document.querySelectorAll(".mention-item")].find(item => item.textContent.includes("session.ts")).click()');
    await settle();
  };
  const send = async () => {
    const expected = requests.length + 1;
    await click('button[aria-label="发送消息"]');
    await waitFor(`document.body.textContent.includes('SEND_RECOVERY_ACCEPTED_${expected}') && !document.querySelector('.composer-stop')`, 'fixture receives accepted retry');
  };
  const openSession = async sessionId => {
    const selector = `[data-session-id="${sessionId}"] .rail-convo`;
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 'existing recovery conversation');
    await click(selector);
    await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current') === 'page' && !!document.querySelector('.composer-input-row textarea')`, 'selected recovery conversation');
  };
  const holdSend = async (marker, mode = 'delayed') => {
    faultMode = mode;
    faultMarker = marker;
    const started = new Promise(resolve => { faultStarted = resolve; });
    await click('button[aria-label="发送消息"]');
    let timer;
    try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No live pending delivery')), 3000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const missingProvider = { id: 'send-missing-key-fixture', type: 'custom', label: 'Send missing key fixture', apiFormat: 'openai-chat', baseUrl: 'http://127.0.0.1:1', model: 'fixture', models: [{ id: 'fixture' }] };
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: missingProvider.id, providers: [...original.providers.filter(item => item.id !== missingProvider.id), missingProvider], recentWorkspaces: [fixture], preferences: { ...original.preferences, 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail")', 'send failure fixture workspace');
    await click('.rail-primary-new');
    await waitFor('!!document.querySelector(".composer-input-row textarea")', 'send failure composer');
    await evaluate(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(fixture)})`);
    await settle();
    while (await evaluate('!!document.querySelector(".file-attachment-card .file-remove")')) {
      await evaluate('document.querySelector(".file-attachment-card .file-remove").click()');
      await settle();
    }
    while (await evaluate('!!document.querySelector(".mention-chip-remove")')) {
      await evaluate('document.querySelector(".mention-chip-remove").click()');
      await settle();
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    await click('.composer button[aria-label="添加附件"]');
    await waitFor('!!document.querySelector(".file-attachment-card")', 'selected failure attachment');
    await evaluate(`(() => {
      const field = document.querySelector('.composer-input-row textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'SEND_FAILURE_DRAFT @session');
      field.setSelectionRange(field.value.length, field.value.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor('[...document.querySelectorAll(".mention-item")].some(item => item.textContent.includes("session.ts"))', 'file reference before failed send');
    await evaluate('[...document.querySelectorAll(".mention-item")].find(item => item.textContent.includes("session.ts")).click()');
    await settle();
    const retained = await check('A real agent startup failure retains the original text, attachment and file reference', async () => {
      await click('button[aria-label="发送消息"]');
      await waitFor('document.body.textContent.includes("无法启动对话") && !document.querySelector(".composer-stop")', 'missing credential startup error');
      assert.equal(await evaluate('document.querySelector(".composer-input-row textarea").value'), 'SEND_FAILURE_DRAFT @session.ts');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      assert.equal(await evaluate('document.querySelectorAll(".mention-chip").length'), 1);
    });
    assert.equal(retained, true, 'failed send draft recovery gate');

    const provider = { id: 'send-retry-fixture', type: 'custom', label: 'Send retry fixture', apiFormat: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }] };
    await evaluate('window.zcodeDesktop.secrets.setApiKey("send-retry-fixture", "test-only")');
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...original.preferences, 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".composer-input-row textarea")', 'reloaded failed draft');
    await waitFor('document.querySelector(".composer-input-row textarea").value === "SEND_FAILURE_DRAFT @session.ts"', 'durable failed draft after reload');
    const retried = await check('Correcting startup settings lets the same retained draft deliver its attachment and reference', async () => {
      await send();
      assert.match(JSON.stringify(requests.at(-1)), /SEND_RECOVERY_ATTACHMENT/);
      assert.match(JSON.stringify(requests.at(-1)), /session.ts/);
      assert.equal(await currentText(), '');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card, .mention-chip").length'), 0);
    });
    assert.equal(retried, true, 'startup recovery retry gate');

    await evaluate('window.sendRecoveryEvents = []; window.zcodeDesktop.agent.onEvent(event => { if (event.type === "bridge_ready") window.sendRecoveryEvents.push(event); }); true;');
    let firstSession;
    const assigned = await check('A failed first delivery retains a recoverable draft even after its new session was assigned', async () => {
      await click('.rail-primary-new');
      await addContext('POST_BIND_FAILURE_DRAFT');
      faultMode = 'once';
      faultMarker = 'POST_BIND_FAILURE_DRAFT';
      await click('button[aria-label="发送消息"]');
      await waitFor('document.body.textContent.includes("Injected unaccepted delivery failure") && !document.querySelector(".composer-stop")', 'unaccepted prompt failure after binding');
      assert.equal(await currentText(), 'POST_BIND_FAILURE_DRAFT @session.ts');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      assert.equal(await evaluate('document.querySelectorAll(".mention-chip").length'), 1);
      await capture('unaccepted-send-draft-retained');
      await waitFor(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(fixture)}).then(records => records.some(record => record.sessionId === null && record.text === 'POST_BIND_FAILURE_DRAFT @session.ts'))`, 'new chat recovery copy saved');
      await reload();
      await waitFor('document.querySelector(".composer-input-row textarea")?.value === "POST_BIND_FAILURE_DRAFT @session.ts"', 'unaccepted first delivery restored after reload');
      await evaluate('window.sendRecoveryEvents = []; window.zcodeDesktop.agent.onEvent(event => { if (event.type === "bridge_ready") window.sendRecoveryEvents.push(event); }); true;');
      await send();
      firstSession = await evaluate('window.sendRecoveryEvents.at(-1)?.sessionId');
      assert.ok(firstSession);
      assert.equal(requests.length, 2);
      await waitFor(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(fixture)}).then(records => !records.some(record => record.text === 'POST_BIND_FAILURE_DRAFT @session.ts'))`, 'acknowledged recovery copies removed');
    });
    assert.equal(assigned, true, 'assigned session failure recovery gate');

    const newer = await check('A delayed failure preserves newer typing and parks the original with its attachments in a paused queue', async () => {
      await addContext('ORIGINAL_UNACCEPTED_MESSAGE');
      await holdSend('ORIGINAL_UNACCEPTED_MESSAGE');
      await writeDraft('NEWER_UNSENT_DRAFT');
      releaseFault();
      releaseFault = undefined;
      await waitFor('!!document.querySelector(".msg-queue-paused") && document.querySelectorAll(".msg-queue-item").length === 1 && !document.querySelector(".composer-stop")', 'failed original retained in paused queue');
      assert.equal(await currentText(), 'NEWER_UNSENT_DRAFT');
      assert.equal(requests.length, 2);
      await waitFor(`window.zcodeDesktop.messageQueue.load(${JSON.stringify(fixture)}).then(state => state.messages.some(message => message.text.includes('ORIGINAL_UNACCEPTED_MESSAGE') && message.files?.length === 1))`, 'failed message and attachment persisted');
      await reload();
      await waitFor('!!document.querySelector(".rail")', 'paused failure after reload');
      await openSession(firstSession);
      await waitFor('document.querySelector(".composer-input-row textarea")?.value === "NEWER_UNSENT_DRAFT" && !!document.querySelector(".msg-queue-paused")', 'new draft and original failure both restored');
      assert.equal(requests.length, 2);
      await capture('failed-send-paused-original-and-new-draft');
    });
    assert.equal(newer, true, 'new input retained during failed delivery gate');

    await check('A queue delivery failure retains the same item, then an explicit retry sends it once', async () => {
      faultMode = 'once';
      faultMarker = 'ORIGINAL_UNACCEPTED_MESSAGE';
      await click('.msg-queue-paused button');
      await waitFor('!!document.querySelector(".msg-queue-paused") && document.querySelectorAll(".msg-queue-item").length === 1', 'queue failure remains paused');
      assert.equal(requests.length, 2);
      assert.equal(await currentText(), 'NEWER_UNSENT_DRAFT');
      await click('.msg-queue-paused button');
      await waitFor('document.body.textContent.includes("SEND_RECOVERY_ACCEPTED_3") && !document.querySelector(".msg-queue-item") && !document.querySelector(".composer-stop")', 'explicit queue retry accepted once');
      assert.equal(requests.length, 3);
      assert.match(JSON.stringify(requests.at(-1)), /ORIGINAL_UNACCEPTED_MESSAGE/);
      assert.match(JSON.stringify(requests.at(-1)), /SEND_RECOVERY_ATTACHMENT/);
      assert.doesNotMatch(JSON.stringify(requests.at(-1)), /NEWER_UNSENT_DRAFT/);
      assert.equal(await currentText(), 'NEWER_UNSENT_DRAFT');
    });

    await check('A late failure stays with its original conversation while another conversation is edited', async () => {
      await click('.rail-primary-new');
      await writeDraft('SEND_RECOVERY_SECOND_SESSION');
      await send();
      await waitFor('document.querySelector(".rail-session.active .rail-convo-title")?.textContent.includes("SEND_RECOVERY_SECOND_SESSION")', 'new recovery conversation appears in session list');
      const secondSession = await evaluate('document.querySelector(".rail-session.active").dataset.sessionId');
      assert.ok(secondSession && secondSession !== firstSession);
      await openSession(firstSession);
      await writeDraft('LATE_ORIGINAL_SESSION_FAILURE');
      await holdSend('LATE_ORIGINAL_SESSION_FAILURE');
      await openSession(secondSession);
      await writeDraft('SECOND_SESSION_NEW_DRAFT');
      releaseFault();
      releaseFault = undefined;
      await waitFor('[...document.querySelectorAll(".toast-title")].some(node => node.textContent === "原会话消息未发送")', 'original conversation failure reported');
      assert.equal(await currentText(), 'SECOND_SESSION_NEW_DRAFT');
      assert.equal(requests.length, 4);
      await openSession(firstSession);
      assert.equal(await currentText(), 'LATE_ORIGINAL_SESSION_FAILURE');
    });

    await check('A slash command rejected for missing context keeps its unsent instruction editable', async () => {
      await click('.rail-primary-new');
      while (await evaluate('!!document.querySelector(".file-attachment-card .file-remove")')) {
        await evaluate('document.querySelector(".file-attachment-card .file-remove").click()');
        await settle();
      }
      while (await evaluate('!!document.querySelector(".mention-chip-remove")')) {
        await evaluate('document.querySelector(".mention-chip-remove").click()');
        await settle();
      }
      await writeDraft('/explain');
      await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
      await settle();
      await waitFor('document.body.textContent.includes("引用要解释的文件")', 'missing code context explained');
      assert.equal(await currentText(), '/explain');
      assert.equal(requests.length, 4);
    });

    await check('A late successful acknowledgement never clears text entered while delivery was pending', async () => {
      await openSession(firstSession);
      await writeDraft('DELAYED_ACCEPTED_ORIGINAL');
      await holdSend('DELAYED_ACCEPTED_ORIGINAL', 'delayed-success');
      await writeDraft('NEW_TEXT_AFTER_PENDING_SUCCESS');
      releaseFault();
      releaseFault = undefined;
      await waitFor('document.body.textContent.includes("SEND_RECOVERY_ACCEPTED_5") && !document.querySelector(".composer-stop")', 'delayed delivery accepted');
      assert.equal(requests.length, 5);
      assert.match(JSON.stringify(requests.at(-1)), /DELAYED_ACCEPTED_ORIGINAL/);
      assert.doesNotMatch(JSON.stringify(requests.at(-1)), /NEW_TEXT_AFTER_PENDING_SUCCESS/);
      assert.equal(await currentText(), 'NEW_TEXT_AFTER_PENDING_SUCCESS');
    });
  } finally {
    if (releaseFault) releaseFault();
    AgentBridge.prototype.prompt = originalPrompt;
    dialog.showOpenDialog = originalPicker;
    fs.writeFileSync(path.join(output, 'provider-user-messages.json'), JSON.stringify(requests, null, 2));
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
