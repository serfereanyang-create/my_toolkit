'use strict';
require('./lib/probe-guard.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');

module.exports = async function runAttachmentRecoveryChecks(context) {
  const { evaluate, click, waitFor, settle, capture, check, reload, fixture, ownedDirectory } = context;
  const { dialog } = require('electron');
  const output = path.join(__dirname, '..', 'out', 'attachment-recovery-review');
  fs.mkdirSync(output, { recursive: true });
  const sourceDirectory = ownedDirectory('attachment-recovery-source');
  const sourcePath = path.join(sourceDirectory, 'recovery-reference.txt');
  const movedPath = path.join(sourceDirectory, 'moved-reference.txt');
  const sourceContent = 'ATTACHMENT_RECOVERY_CONTENT\n';
  fs.writeFileSync(sourcePath, sourceContent);
  const originalSettings = await evaluate('window.zcodeDesktop.settings.get()');
  const originalPicker = dialog.showOpenDialog;
  const originalStat = fsPromises.stat;
  const requests = [];
  let releaseInspection;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        requests.push(payload.messages.filter(message => message.role === 'user').at(-1));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `ATTACHMENT_RECOVERY_ACCEPTED_${requests.length}` } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) { response.writeHead(400); response.end(error.message); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const text = () => evaluate('document.querySelector(".composer-input-row textarea").value');
  const writeDraft = async value => {
    await evaluate(`(() => {
      const field = document.querySelector('.composer-input-row textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
  };
  const addFile = async () => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourcePath] });
    await click('.composer button[aria-label="添加附件"]');
    await waitFor('!!document.querySelector(".file-attachment-card")', 'selected recovery attachment');
  };
  const send = async () => {
    const expected = requests.length + 1;
    await click('button[aria-label="发送消息"]');
    await waitFor(`document.body.textContent.includes('ATTACHMENT_RECOVERY_ACCEPTED_${expected}') && !document.querySelector('.composer-stop')`, 'provider receives the verified attachment');
  };

  try {
    const provider = { id: 'attachment-recovery-fixture', type: 'custom', label: 'Attachment recovery fixture', apiFormat: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }] };
    await evaluate('window.zcodeDesktop.secrets.setApiKey("attachment-recovery-fixture", "test-only")');
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...originalSettings, activeProviderId: provider.id, providers: [...originalSettings.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...originalSettings.preferences, 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail")', 'attachment recovery workspace');
    await click('.rail-primary-new');
    await waitFor('!!document.querySelector(".composer-input-row textarea")', 'attachment recovery composer');
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
    await writeDraft('ATTACHMENT_RECOVERY_REQUEST');
    await addFile();
    await waitFor(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(fixture)}).then(records => records.some(record => record.sessionId === null && record.text === 'ATTACHMENT_RECOVERY_REQUEST' && record.files.some(file => file.path === ${JSON.stringify(sourcePath)})))`, 'attachment draft persisted');
    fs.renameSync(sourcePath, movedPath);

    const missing = await check('A restored missing attachment explains its failure and sending keeps the draft', async () => {
      await reload();
      await waitFor('!!document.querySelector(".rail")', 'reload after attachment moves');
      await click('.rail button[aria-label="对话"]');
      await waitFor('!!document.querySelector(".file-attachment-card[data-attachment-error=true]")', 'missing attachment error card');
      assert.match(await evaluate('document.querySelector(".file-attachment-error").textContent'), /移动或删除/);
      assert.equal(await text(), 'ATTACHMENT_RECOVERY_REQUEST');
      await click('button[aria-label="发送消息"]');
      await waitFor('[...document.querySelectorAll(".toast-title")].some(node => node.textContent === "附件无法发送")', 'blocked attachment send');
      assert.equal(requests.length, 0);
      assert.equal(await text(), 'ATTACHMENT_RECOVERY_REQUEST');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      await capture('attachment-missing-preserves-draft');
    });
    assert.equal(missing, true, 'missing attachment gate');

    const restored = await check('Restoring the file and retrying clears the error and delivers its real content', async () => {
      fs.renameSync(movedPath, sourcePath);
      await click('.file-attachment-retry');
      await waitFor('!!document.querySelector(".file-attachment-card") && !document.querySelector("[data-attachment-error=true]")', 'file readable after retry');
      await send();
      assert.match(JSON.stringify(requests.at(-1)), /ATTACHMENT_RECOVERY_CONTENT/);
      assert.equal(await text(), '');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 0);
    });
    assert.equal(restored, true, 'attachment retry gate');

    await check('A file growing past the limit is blocked again immediately before sending', async () => {
      await writeDraft('ATTACHMENT_GROWN_REQUEST');
      await addFile();
      fs.truncateSync(sourcePath, 50 * 1024 * 1024 + 1);
      await click('button[aria-label="发送消息"]');
      await waitFor('document.querySelector(".file-attachment-error")?.textContent.includes("50MB")', 'grown attachment size failure');
      assert.equal(requests.length, 1);
      assert.equal(await text(), 'ATTACHMENT_GROWN_REQUEST');
      assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
      fs.writeFileSync(sourcePath, sourceContent);
      await click('.file-attachment-retry');
      await waitFor('!document.querySelector("[data-attachment-error=true]")', 'grown file restored');
      await click('.file-attachment-card .file-remove');
      assert.equal(await text(), 'ATTACHMENT_GROWN_REQUEST');
    });

    await check('Typing during a pending attachment check keeps the latest draft unsent', async () => {
      await addFile();
      await writeDraft('DRAFT_BEFORE_ATTACHMENT_CHECK');
      await evaluate(`window.zcodeDesktop.files.inspect([${JSON.stringify(sourcePath)}])`);
      await settle();
      let inspectionStarted;
      const started = new Promise(resolve => { inspectionStarted = resolve; });
      let captured = false;
      fsPromises.stat = async (target, ...args) => {
        if (target === sourcePath && !captured) {
          captured = true;
          inspectionStarted();
          await new Promise(resolve => { releaseInspection = resolve; });
        }
        return originalStat(target, ...args);
      };
      await click('button[aria-label="发送消息"]');
      let timer;
      try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No live attachment inspection started')), 3000); })]); }
      finally { clearTimeout(timer); }
      await writeDraft('DRAFT_EDITED_DURING_ATTACHMENT_CHECK');
      releaseInspection();
      releaseInspection = undefined;
      await waitFor('[...document.querySelectorAll(".toast-title")].some(node => node.textContent === "草稿已变更")', 'new edits retained');
      fsPromises.stat = originalStat;
      assert.equal(await text(), 'DRAFT_EDITED_DURING_ATTACHMENT_CHECK');
      assert.equal(requests.length, 1);
      await send();
      assert.match(JSON.stringify(requests.at(-1)), /DRAFT_EDITED_DURING_ATTACHMENT_CHECK/);
      assert.match(JSON.stringify(requests.at(-1)), /ATTACHMENT_RECOVERY_CONTENT/);
      assert.equal(requests.length, 2);
    });
  } finally {
    if (releaseInspection) releaseInspection();
    fsPromises.stat = originalStat;
    dialog.showOpenDialog = originalPicker;
    fs.writeFileSync(sourcePath, sourceContent);
    fs.writeFileSync(path.join(output, 'provider-user-messages.json'), JSON.stringify(requests, null, 2));
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(originalSettings)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
