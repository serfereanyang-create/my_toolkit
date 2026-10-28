'use strict';
require('./lib/probe-guard.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

/*
 * Copy-the-reply, against a real Electron window.
 *
 * The unit test in src/components/ConversationStream.copy.test.tsx can only see
 * markup: it proves the button is rendered (and withheld while the reply is
 * still streaming) but not that a click puts the right text on the OS
 * clipboard. That is the failure mode worth guarding — the same shape as the
 * message-queue bug where the buttons rendered and did nothing.
 *
 * So this drives a real turn through a fixture provider, clicks the button with
 * real mouse events, and reads the clipboard back from the main process.
 */

module.exports = async function runCopyChecks(context) {
  const { evaluate, clickPoint, waitFor, capture, check, fixture, ownedDirectory, reload, settle } = context;
  const { clipboard } = require('electron');
  ownedDirectory('profile');
  const output = path.join(__dirname, '..', 'out', 'copy-review', 'app');
  fs.mkdirSync(output, { recursive: true });
  const original = await evaluate('window.zcodeDesktop.settings.get()');

  // One reply, streamed in two deltas, holding both prose and a fenced block:
  // the whole reply is what must reach the clipboard, markdown included.
  const head = '复制检查：这条回复包含代码块。\n\n```js\n';
  const tail = 'console.log("copied");\n```\n\n结尾一行。';
  const replyText = head + tail;

  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: head } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tail } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const input = 'textarea[aria-label="输入任务或问题"]';
  const submit = async (text) => {
    await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(input)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
    await settle();
  };
  const readClipboard = () => clipboard.readText();

  try {
    const provider = {
      id: 'copy-fixture', type: 'custom', label: 'Copy fixture', apiFormat: 'openai-chat',
      baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }],
    };
    await evaluate(`window.zcodeDesktop.secrets.setApiKey('copy-fixture', 'test-only')`);
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...original.preferences, 'gen.sendShortcut': 'enter', 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail-primary-new")', 'copy fixture workspace');
    await evaluate(`window.zcodeDesktop.messageQueue.save(${JSON.stringify(fixture)}, { messages: [], pausedSessions: [] })`);
    await clickPoint({ x: 5, y: 5 });
    await evaluate(`document.querySelector('.rail-primary-new').click()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 'chat composer');
    clipboard.clear();
    await submit('把回复复制出来');
    await waitFor('document.body.textContent.includes("结尾一行")', 'finished streamed reply');

    const copied = await check('COPY App puts the whole reply on the OS clipboard from one click', async () => {
      const markup = await evaluate('[...document.querySelectorAll(".msg-assistant")].map(el => el.outerHTML).join("\\n<!-- next -->\\n")');
      fs.writeFileSync(path.join(output, 'assistant-markup.html'), markup);
      const count = await evaluate('document.querySelectorAll(".msg-reply-copy").length');
      assert.ok(count > 0, `no reply copy control rendered; assistant markup in ${path.join(output, 'assistant-markup.html')}`);
      const label = await evaluate('document.querySelector(".msg-reply-copy").textContent');
      assert.match(label, /复制/);
      assert.equal(await evaluate(`document.querySelector('.msg-reply-copy').getAttribute('aria-label')`), '复制整条回复');
      // Pinned, not hover-revealed: it has to be hit-testable with the pointer
      // parked in the far corner. The hover-revealed version was reported as
      // impossible to click — the pointer had to leave the message to reach it,
      // which dropped the hover and hid the button mid-approach.
      await context.moveMouse({ x: 4, y: 4 });
      await settle();
      const target = await evaluate(`(() => {
        const button = document.querySelector('.msg-reply-copy');
        button.scrollIntoView({ block: 'center' });
        const bounds = button.getBoundingClientRect();
        const point = { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          point,
          hit: hit && hit.closest('.msg-reply-copy') ? 'button' : (hit ? String(hit.className || hit.tagName) : null),
          rect: { left: Math.round(bounds.left), top: Math.round(bounds.top), width: Math.round(bounds.width), height: Math.round(bounds.height) },
          pointerEvents: getComputedStyle(button).pointerEvents,
          opacity: getComputedStyle(button.parentElement).opacity,
          messageHovered: button.closest('.msg-assistant').matches(':hover'),
        };
      })()`);
      fs.writeFileSync(path.join(output, 'copy-control-state.json'), JSON.stringify(target, null, 2));
      assert.equal(target.pointerEvents, 'auto', 'copy control accepts clicks without hover');
      assert.equal(target.messageHovered, false, 'pointer was parked away, so the assertion above is about the pinned state');
      assert.equal(target.hit, 'button', `hit test at ${JSON.stringify(target.point)} returned ${target.hit}`);
      await capture('copy-reply-pinned');
      await context.clickPoint(target.point);
      await waitFor('document.querySelector(".msg-reply-copy")?.textContent.includes("已复制")', 'copy confirmation');
      await capture('copy-reply-confirmed');
    });

    // Where did the fenced block go? Dump what the session actually stored.
    await evaluate(`(async () => {
      const list = await window.zcodeDesktop.sessions.list();
      const id = list[0]?.id || list[0]?.sessionId;
      window.copyStoredSession = id ? await window.zcodeDesktop.sessions.load(id) : null;
    })()`).catch(() => undefined);
    fs.writeFileSync(path.join(output, 'stored-session.json'), JSON.stringify(await evaluate('window.copyStoredSession || null'), null, 2));

    const pasted = await check('COPY The clipboard carries the reply markdown, not a flattened transcript', async () => {
      let text = '';
      for (let attempt = 0; attempt < 50; attempt += 1) {
        text = readClipboard();
        if (text) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      fs.writeFileSync(path.join(output, 'clipboard.txt'), text);
      assert.equal(text, replyText);
      assert.match(text, /```js/);
      assert.match(text, /结尾一行/);
    });

    assert.equal(copied, true, 'copy click gate');
    assert.equal(pasted, true, 'clipboard payload gate');
  } finally {
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};
