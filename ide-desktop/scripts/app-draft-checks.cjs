'use strict';
require('./lib/probe-guard.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

module.exports = async function runDraftChecks(context) {
  const { evaluate, click, waitFor, settle, check, capture, reload, fixture } = context;
  const writeDraft = async text => {
    await evaluate(`(() => {
      const field = document.querySelector('.composer-input-row textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
      field.setSelectionRange(field.value.length, field.value.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
  };
  const currentDraft = () => evaluate('document.querySelector(".composer-input-row textarea").value');
  await click('.rail button[aria-label="对话"]');
  await waitFor('!!document.querySelector(".composer-input-row textarea")', 'draft composer');
  await evaluate(`(() => {
    const field = document.querySelector('.composer-input-row textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'DRAFT_NAVIGATION_MARKER');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle();
  const preserved = await check('Unsent draft survives leaving chat and returning from files', async () => {
    await click('.rail button[aria-label="文件"]');
    await waitFor('!document.querySelector(".composer-input-row textarea")', 'composer unmounted');
    await click('.rail button[aria-label="对话"]');
    await waitFor('!!document.querySelector(".composer-input-row textarea")', 'composer remounted');
    assert.equal(await evaluate('document.querySelector(".composer-input-row textarea").value'), 'DRAFT_NAVIGATION_MARKER');
  });
  assert.equal(preserved, true, 'draft navigation gate');
  await check('Unsent draft also survives visiting the settings page', async () => {
    await click('.rail-settings');
    await waitFor('!!document.querySelector(".settings-view")', 'settings instead of chat');
    await click('.settings-view .back-button');
    await waitFor('!!document.querySelector(".composer-input-row textarea")', 'chat after settings');
    assert.equal(await currentDraft(), 'DRAFT_NAVIGATION_MARKER');
  });

  const recovered = await check('Unsent draft survives a real renderer restart', async () => {
    await reload();
    await waitFor('!!document.querySelector(".rail")', 'workspace after renderer restart');
    await click('.rail button[aria-label="对话"]');
    await waitFor('document.querySelector(".composer-input-row textarea")?.value === "DRAFT_NAVIGATION_MARKER"', 'draft restored from durable storage');
  });
  assert.equal(recovered, true, 'durable draft recovery gate');

  const output = path.join(__dirname, '..', 'out', 'draft-review');
  fs.mkdirSync(output, { recursive: true });
  const original = await evaluate('window.zcodeDesktop.settings.get()');
  const { dialog } = require('electron');
  const originalPicker = dialog.showOpenDialog;
  const requests = [];
  let releasePicker;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        requests.push(payload.messages.filter(message => message.role === 'user').at(-1));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `DRAFT_FIXTURE_REPLY_${requests.length}` } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) {
        response.writeHead(400);
        response.end(error.message);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = async () => {
    const expected = requests.length + 1;
    await click('button[aria-label="发送消息"]');
    await waitFor(`document.body.textContent.includes("DRAFT_FIXTURE_REPLY_${expected}") && !document.querySelector('.composer-stop')`, 'draft fixture reply');
  };
  const openSession = async id => {
    const selector = `[data-session-id="${id}"] .rail-convo`;
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 'saved draft conversation');
    await click(selector);
    await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current') === 'page' && !!document.querySelector('.composer-input-row textarea')`, 'selected draft conversation');
  };
  /** Poll without throwing, so a caller can retry instead of waiting out waitFor. */
  const poll = async (expression, attempts = 40) => {
    for (let index = 0; index < attempts; index += 1) {
      if (await evaluate(expression).catch(() => false)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  };
  /**
   * Open a genuinely empty conversation.
   *
   * `newChat` returns early on purpose while another workspace/session switch is
   * still in flight, so a single click can land on nothing and leave the old
   * conversation active. Writing a draft there and sending it produced the bug
   * this check exists to catch (two "conversations" that were one CLI session),
   * which is a test-side race, not an app-side one: retry the click until the
   * rail has no current conversation and the chat pane is empty.
   */
  const openFreshConversation = async () => {
    const fresh = '!!document.querySelector(".composer-input-row textarea") && !document.querySelector(\'[data-session-id] .rail-convo[aria-current="page"]\') && document.querySelectorAll(".msg-user-group").length === 0';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await click('.rail-primary-new');
      if (await poll(fresh)) return;
      await settle();
    }
    throw new Error('App never opened a fresh conversation (newChat kept returning early)');
  };
  const seeded = [];
  const seedSession = async marker => {
    await openFreshConversation();
    await writeDraft(marker);
    assert.equal(await currentDraft(), marker, 'the new conversation composer accepts the draft');
    await send();
    // The rail is the app's own record of which conversation the message went
    // to; the bridge announcement must agree with it, or two conversations
    // collapsed into one CLI session and everything below is meaningless.
    const activeSelector = '[data-session-id] .rail-convo[aria-current="page"]';
    await waitFor(`!!document.querySelector(${JSON.stringify(activeSelector)})`, 'sent conversation in the rail');
    const railId = await evaluate(`document.querySelector(${JSON.stringify(activeSelector)}).closest("[data-session-id]").getAttribute("data-session-id")`);
    const announced = await evaluate('window.draftReviewEvents.filter(event => event.type === "bridge_ready").at(-1)?.sessionId');
    seeded.push({ marker, railId, announced: announced ?? null });
    assert.equal(railId, announced ?? railId, 'bridge announcement matches the conversation the rail opened');
    return railId;
  };
  let first;
  let second;
  try {
    const provider = {
      id: 'draft-fixture', type: 'custom', label: 'Draft fixture', apiFormat: 'openai-chat',
      baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }],
    };
    await evaluate('window.zcodeDesktop.secrets.setApiKey("draft-fixture", "test-only")');
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...original.preferences, 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail")', 'draft fixture workspace');
    await evaluate('window.draftReviewEvents = []; window.zcodeDesktop.agent.onEvent(event => { if (event.type === "bridge_ready") window.draftReviewEvents.push(event); }); true;');
    first = await seedSession('DRAFT_SESSION_ALPHA');
    second = await seedSession('DRAFT_SESSION_BETA');
    assert.ok(first && second && first !== second, 'two independent real conversations');
    const attachment = path.join(fixture, '.aicode', 'draft-source-note.txt');
    fs.writeFileSync(attachment, 'DRAFT_ATTACHMENT_ALPHA\n');

    const attached = await check('A late attachment belongs to its original conversation after switching', async () => {
      await openSession(first);
      await writeDraft('DRAFT_ALPHA');
      dialog.showOpenDialog = () => new Promise(resolve => { releasePicker = resolve; });
      await click('.composer button[aria-label="添加附件"]');
      assert.equal(typeof releasePicker, 'function');
      await openSession(second);
      await writeDraft('DRAFT_BETA');
      releasePicker({ canceled: false, filePaths: [attachment] });
      releasePicker = undefined;
      await openSession(first);
      await waitFor('document.querySelector(".file-attachment-card")?.textContent.includes("draft-source-note.txt")', 'attachment returns to its owner');
      assert.equal(await currentDraft(), 'DRAFT_ALPHA');
      await openSession(second);
      assert.equal(await currentDraft(), 'DRAFT_BETA');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 0);
    });
    assert.equal(attached, true, 'asynchronous attachment ownership gate');

    await check('Text, attachments and file references restore together for each conversation', async () => {
      await openSession(first);
      await writeDraft('DRAFT_ALPHA @session');
      await waitFor('[...document.querySelectorAll(".mention-item")].some(item => item.textContent.includes("session.ts"))', 'file reference result');
      await evaluate('[...document.querySelectorAll(".mention-item")].find(item => item.textContent.includes("session.ts")).click()');
      await waitFor('!!document.querySelector(".mention-chip")', 'file reference selected');
      await openSession(second);
      assert.equal(await currentDraft(), 'DRAFT_BETA');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card, .mention-chip").length'), 0);
      await openSession(first);
      assert.equal(await currentDraft(), 'DRAFT_ALPHA @session.ts');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      assert.match(await evaluate('document.querySelector(".mention-chip").textContent'), /session.ts/);
      await click('.rail button[aria-label="文件"]');
      await click('.rail button[aria-label="对话"]');
      assert.equal(await currentDraft(), 'DRAFT_ALPHA @session.ts');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      assert.equal(await evaluate('document.querySelectorAll(".mention-chip").length'), 1);
      await waitFor(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(fixture)}).then(records => records.some(record => record.sessionId === ${JSON.stringify(first)} && record.files.length === 1 && record.mentions.length === 1) && records.some(record => record.sessionId === ${JSON.stringify(second)} && record.text === 'DRAFT_BETA'))`, 'both conversations saved independently');
      await reload();
      await waitFor('!!document.querySelector(".rail")', 'workspace after draft reload');
      await openSession(first);
      await waitFor('document.querySelector(".composer-input-row textarea")?.value === "DRAFT_ALPHA @session.ts"', 'conversation draft restored after renderer restart');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      assert.equal(await evaluate('document.querySelectorAll(".mention-chip").length'), 1);
      await openSession(second);
      assert.equal(await currentDraft(), 'DRAFT_BETA');
      await openSession(first);
      await capture('draft-restored-with-attachment');
    });

    await check('Submitting clears only that draft and the provider receives its references', async () => {
      await send();
      const content = JSON.stringify(requests.at(-1));
      assert.match(content, /DRAFT_ALPHA/);
      assert.match(content, /DRAFT_ATTACHMENT_ALPHA/);
      assert.match(content, /src[\\/]+session.ts/);
      assert.doesNotMatch(content, /DRAFT_BETA/);
      await click('.rail button[aria-label="文件"]');
      await click('.rail button[aria-label="对话"]');
      assert.equal(await currentDraft(), '');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card, .mention-chip").length'), 0);
      await openSession(second);
      assert.equal(await currentDraft(), 'DRAFT_BETA');
      await openSession(first);
    });

    await check('An edited message is consumed once and cannot overwrite a newer draft on remount', async () => {
      await evaluate(`[...document.querySelectorAll('.msg-user-group')].find(group => group.querySelector('.msg-user').textContent.includes('DRAFT_SESSION_ALPHA')).querySelector('button[title="编辑"]').click()`);
      await waitFor('document.querySelector(".composer-input-row textarea").value === "DRAFT_SESSION_ALPHA"', 'edit action prefills text');
      await writeDraft('DRAFT_EDITED_BY_USER');
      await click('.rail button[aria-label="文件"]');
      await click('.rail button[aria-label="对话"]');
      assert.equal(await currentDraft(), 'DRAFT_EDITED_BY_USER');
    });
  } finally {
    if (releasePicker) releasePicker({ canceled: true, filePaths: [] });
    dialog.showOpenDialog = originalPicker;
    fs.writeFileSync(path.join(output, 'provider-user-messages.json'), JSON.stringify(requests, null, 2));
    fs.writeFileSync(path.join(output, 'sessions.json'), JSON.stringify({ first, second }, null, 2));
    // Diagnostics: which conversation each seed actually landed in, and what the
    // bridge announced. A repeated id here means the two "conversations" were
    // one CLI session, which changes what everything below proves.
    fs.writeFileSync(path.join(output, 'seeded.json'), JSON.stringify(seeded, null, 2));
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
