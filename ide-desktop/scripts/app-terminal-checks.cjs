'use strict';
require('./lib/probe-guard.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

module.exports = async function runTerminalChecks(context) {
  const { evaluate, click, waitFor, capture, check, fixture, reload, settle } = context;
  const output = path.join(__dirname, '..', 'out', 'terminal-review');
  fs.mkdirSync(output, { recursive: true });
  const original = await evaluate('window.zcodeDesktop.settings.get()');
  const requests = [];
  const snapshots = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const user = payload.messages.filter(message => message.role === 'user').at(-1);
        requests.push(user);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `TERMINAL_CONTEXT_ACCEPTED_${requests.length}` } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) {
        response.writeHead(400);
        response.end(error.message);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const writeInput = async text => {
    await evaluate(`(() => {
      const field = document.querySelector('textarea[aria-label="输入任务或问题"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
      field.setSelectionRange(field.value.length, field.value.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
  };
  const referenceActive = async () => {
    await click('.terminal-capture-btn');
    await click('.rail button[aria-label="对话"]');
    await waitFor('!!document.querySelector(".composer-input-row textarea")', 'terminal mention composer');
    await writeInput('请检查 ');
    await click('.composer button[aria-label="引用文件或符号"]');
    await waitFor('!!document.querySelector(".mention-picker")', 'terminal picker');
    await evaluate('[...document.querySelectorAll(".mention-tab")].find(button => button.textContent.includes("终端")).click()');
    await waitFor('!!document.querySelector(".mention-item[data-mention-content]")', 'captured terminal item');
    snapshots.push(await evaluate('document.querySelector(".mention-item[data-mention-content]").getAttribute("data-mention-content")'));
    await click('.mention-item[data-mention-content]');
    const draft = await evaluate('document.querySelector(".composer-input-row textarea").value');
    assert.equal(draft, '请检查 @终端输出', 'mention insertion must preserve the draft and add one @');
  };
  const sendReference = async () => {
    const expected = requests.length + 1;
    await click('button[aria-label="发送消息"]');
    await waitFor(`document.body.textContent.includes("TERMINAL_CONTEXT_ACCEPTED_${expected}") && !document.querySelector('button[aria-label="停止当前任务"]')`, 'real provider receives terminal reference');
    const message = requests.at(-1);
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    return content;
  };

  try {
    const provider = {
      id: 'terminal-fixture', type: 'custom', label: 'Terminal fixture', apiFormat: 'openai-chat',
      baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }],
    };
    await evaluate('window.zcodeDesktop.secrets.setApiKey("terminal-fixture", "test-only")');
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...original.preferences, 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail")', 'terminal fixture workspace');
    await evaluate('window.terminalReviewEvents = {}; window.zcodeDesktop.terminal.onEvent(event => { if (event.type === "data") window.terminalReviewEvents[event.id] = (window.terminalReviewEvents[event.id] || "") + event.data; }); true;');
    fs.mkdirSync(path.join(fixture, '.aicode'), { recursive: true });
    fs.writeFileSync(path.join(fixture, '.aicode', 'terminal-stream.cjs'), [
      'const name = process.argv[2];',
      'process.stdout.write("\\x1b[2J\\x1b[H");',
      'process.stdout.write("YOY_" + name + "_");',
      'for (let index = 0; index < 240; index += 1) process.stdout.write("x");',
      'process.stdout.write("\\r\\n\\x1b[31m" + name + "_COLOR\\x1b[0m\\r\\n");',
      'process.stdout.write("old-value\\rnew-value\\x1b[K\\r\\n");',
      'console.log("literal ``` marker");',
      'console.log("END_" + name);',
    ].join('\n'));
    await click('.rail button[aria-label="新标签页"]');
    await click('.newtab-cell [data-newtab-action="terminal"]');
    await waitFor('!!document.querySelector(".terminal-tab.active")', 'first real terminal');
    const first = await evaluate('document.querySelector(".terminal-tab.active").dataset.terminalTabId');
    await evaluate(`window.zcodeDesktop.terminal.write(${JSON.stringify(first)}, "node .aicode/terminal-stream.cjs FIRST\\r")`);
    await waitFor(`window.terminalReviewEvents[${JSON.stringify(first)}]?.includes("END_FIRST")`, 'first shell command completes');
    await click('.terminal-new');
    await waitFor('document.querySelectorAll(".terminal-tab").length === 2', 'second real terminal');
    const second = await evaluate('document.querySelector(".terminal-tab.active").dataset.terminalTabId');
    assert.notEqual(first, second);
    await evaluate(`window.zcodeDesktop.terminal.write(${JSON.stringify(second)}, "node .aicode/terminal-stream.cjs SECOND\\r")`);
    await waitFor(`window.terminalReviewEvents[${JSON.stringify(second)}]?.includes("END_SECOND")`, 'second shell command completes');

    const inserted = await check('Terminal mention preserves the draft and inserts a single @', referenceActive);
    assert.equal(inserted, true, 'terminal mention insertion gate');
    const delivered = await check('Only the active terminal reaches the real provider with rendered lines intact', async () => {
      await click('.terminal-tabs .terminal-tab:first-child .terminal-tab-label');
      const secondContent = await sendReference();
      assert.ok(secondContent.includes(`YOY_SECOND_${'x'.repeat(240)}`), 'wrapped output must remain a single logical line');
      assert.match(secondContent, /SECOND_COLOR/);
      assert.match(secondContent, /new-value/);
      assert.doesNotMatch(secondContent, /YOY_FIRST_|old-value|\x1b|\r/);
      assert.match(secondContent, /````text\n[\s\S]*literal ``` marker[\s\S]*\n````/);
      await click('.terminal-tabs .terminal-tab:first-child .terminal-tab-label');
      await referenceActive();
      const firstContent = await sendReference();
      assert.ok(firstContent.includes(`YOY_FIRST_${'x'.repeat(240)}`));
      assert.doesNotMatch(firstContent, /YOY_SECOND_/);
      await capture('terminal-reference-delivered');
    });
    assert.equal(delivered, true, 'terminal provider delivery gate');
  } finally {
    fs.writeFileSync(path.join(output, 'provider-user-messages.json'), JSON.stringify(requests, null, 2));
    fs.writeFileSync(path.join(output, 'captured-terminal-snapshots.json'), JSON.stringify(snapshots, null, 2));
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
