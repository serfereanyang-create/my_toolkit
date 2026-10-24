'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');

module.exports = async function runTaskBoardChecks(context) {
  const { evaluate, click, waitFor, capture, check, ownedDirectory, reload } = context;
  const workspace = ownedDirectory('task-board-workspace');
  const output = path.resolve(__dirname, '..', 'out', 'task-board-review'); fs.mkdirSync(output, { recursive: true });
  const runId = randomUUID();
  const sessionId = `sess_board_${runId.replaceAll('-', '')}`;
  const otherSessionId = `sess_board_other_${runId.replaceAll('-', '')}`;
  const boardId = `board_${runId.replaceAll('-', '')}`;
  const tasksDirectory = path.join(workspace, '.aicode', 'tasks');
  const sessionsDirectory = path.join(workspace, '.aicode', 'sessions');
  fs.mkdirSync(tasksDirectory, { recursive: true }); fs.mkdirSync(sessionsDirectory, { recursive: true });
  const now = new Date().toISOString();
  const board = { id: boardId, title: '任务板暂停与继续验收', goal: 'Preserve progress when pausing verification', status: 'active', createdAt: now, updatedAt: now, confirmedAt: now, tasks: [
    { id: 'task_prior', title: '已经完成的检查', status: 'done', dependsOn: [], resultSummary: 'Prior progress must remain unchanged', finishedAt: now },
    { id: 'task_current', title: 'Implement a local sample', status: 'pending', dependsOn: ['task_prior'] },
    { id: 'task_after', title: 'Inspect the dependent sample', status: 'pending', dependsOn: ['task_current'] },
  ] };
  const session = id => ({ id, createdAt: now, updatedAt: now, provider: 'openai', model: 'task-fixture', workspaceRoot: workspace, messages: [{ role: 'user', content: id === sessionId ? 'Task board cancellation review' : 'Other session must stay untouched', createdAt: now }], toolCalls: [], finalAnswers: [] });
  fs.writeFileSync(path.join(tasksDirectory, `${boardId}.json`), JSON.stringify(board));
  fs.writeFileSync(path.join(sessionsDirectory, `${sessionId}.json`), JSON.stringify({ ...session(sessionId), taskRuntime: { boardId, activeTaskId: 'task_current', mode: 'paused', lastSyncAt: now } }));
  fs.writeFileSync(path.join(sessionsDirectory, `${otherSessionId}.json`), JSON.stringify(session(otherSessionId)));
  const allowFile = path.join(workspace, `.aicode/allow-${runId}`);
  const enteredFile = path.join(workspace, '.aicode', 'verify-entered.json');
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'task-board-app-review', scripts: { test: 'node board-verify.cjs' } }));
  fs.writeFileSync(path.join(workspace, 'board-verify.cjs'), `const fs=require('node:fs');const {spawn}=require('node:child_process');if(fs.existsSync(${JSON.stringify(allowFile)})){console.log('verification passed');}else{const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(enteredFile)},JSON.stringify({runId:${JSON.stringify(runId)},parent:process.pid,worker:worker.pid}));setInterval(()=>{},1000);}`);
  const original = await evaluate('window.zcodeDesktop.settings.get()');
  let requests = 0;
  const verificationScenarios = [];
  const prompts = [];
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => {
      requests += 1;
      try { const messages = JSON.parse(body).messages; prompts.push(messages.filter(message => message.role === 'user').at(-1)?.content); } catch { prompts.push('unparsed'); }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `TASK_DONE: real model fixture ${requests}` } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const readBoard = () => JSON.parse(fs.readFileSync(path.join(tasksDirectory, `${boardId}.json`), 'utf8'));
  const readSession = () => JSON.parse(fs.readFileSync(path.join(sessionsDirectory, `${sessionId}.json`), 'utf8'));
  const continueSelector = 'button[aria-label="继续任务计划"]';
  const pauseSelector = 'button[aria-label="暂停任务计划"]';
  const alive = processId => { try { process.kill(processId, 0); return true; } catch { return false; } };
  const poll = async (predicate, label) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail(label); };
  const openSession = async id => { await waitFor(`!!document.querySelector('[data-session-id="${id}"] .rail-convo')`, 'task board conversation'); await click(`[data-session-id="${id}"] .rail-convo`); };
  try {
    const provider = { id: 'task-board-fixture', type: 'custom', label: 'Task board fixture', apiFormat: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'task-fixture', models: [{ id: 'task-fixture' }] };
    await evaluate("window.zcodeDesktop.secrets.setApiKey('task-board-fixture','test-only')");
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [workspace], preferences: { ...original.preferences, requestTimeoutMs: 60000, 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload(); await waitFor('!!document.querySelector(".rail")', 'task board review workspace');
    await openSession(otherSessionId);
    await evaluate(`window.zcodeDesktop.agent.start(${JSON.stringify(otherSessionId)})`);
    const otherBefore = fs.readFileSync(path.join(sessionsDirectory, `${otherSessionId}.json`), 'utf8');
    await openSession(sessionId);
    const restored = await check('BOARD Paused task plan restores while another conversation bridge is connected', async () => {
      await waitFor(`!!document.querySelector(${JSON.stringify(continueSelector)})`, 'restored paused task board');
      assert.equal(requests, 0);
      assert.equal(readBoard().tasks[0].status, 'done');
      await capture('task-board-restored');
    });
    assert.equal(restored, true, 'task plan restore gate');
    const cancelled = await check('BOARD Pause during real npm verification stops its process tree and keeps prior progress', async () => {
      await click('button[aria-label="继续任务计划"]');
      await poll(() => { try { return JSON.parse(fs.readFileSync(enteredFile, 'utf8')).runId === runId; } catch { return false; } }, 'real verification process never started');
      assert.equal(requests, 1);
      await waitFor(`!!document.querySelector(${JSON.stringify(pauseSelector)})`, 'task board pause button');
      await click('button[aria-label="暂停任务计划"]');
      await waitFor(`!!document.querySelector(${JSON.stringify(continueSelector)}) && !document.querySelector('.composer-stop')`, 'board paused after cancellation');
      const processIds = JSON.parse(fs.readFileSync(enteredFile, 'utf8'));
      await poll(() => !alive(processIds.parent) && !alive(processIds.worker), 'verification or worker still runs after pause');
      const persisted = readBoard();
      assert.deepEqual(persisted.tasks.map(task => task.status), ['done', 'pending', 'pending']);
      assert.equal(persisted.tasks[0].resultSummary, board.tasks[0].resultSummary);
      assert.equal(persisted.tasks[1].error, undefined);
      assert.equal(persisted.tasks[1].verification.at(-1).status, 'cancelled');
      assert.equal(readSession().taskRuntime.mode, 'paused');
      assert.ok(await evaluate('document.querySelector(\'.task-board-item[data-task-id="task_current"]\')?.classList.contains("current")'));
      assert.equal(fs.readFileSync(path.join(sessionsDirectory, `${otherSessionId}.json`), 'utf8'), otherBefore);
      assert.equal(fs.existsSync(path.join(tasksDirectory, `${boardId}.lease.json`)), false);
      await capture('task-board-verification-paused');
    });
    assert.equal(cancelled, true, 'verification pause gate');
    const reloaded = await check('BOARD Reload retains a paused plan without executing it automatically', async () => {
      await reload(); await waitFor('!!document.querySelector(".rail")', 'reloaded paused plan');
      await openSession(sessionId);
      await waitFor(`!!document.querySelector(${JSON.stringify(continueSelector)})`, 'reloaded continue action');
      assert.equal(requests, 1);
      assert.deepEqual(readBoard().tasks.map(task => task.status), ['done', 'pending', 'pending']);
      assert.equal(await evaluate('document.querySelector(".stream-inner")?.textContent.includes("You are executing one task from an approved project board")'), false);
      await capture('task-board-paused-reload');
    });
    assert.equal(reloaded, true, 'paused plan reload gate');
    await check('BOARD Continue reruns the interrupted task then completes its dependent task once', async () => {
      fs.writeFileSync(allowFile, 'verification may finish');
      await click('button[aria-label="继续任务计划"]');
      await waitFor('document.querySelector(".task-board-head small")?.textContent === "已完成" && !document.querySelector(".composer-stop")', 'completed task board');
      assert.equal(requests, 3);
      assert.deepEqual(readBoard().tasks.map(task => task.status), ['done', 'done', 'done']);
      assert.equal(readBoard().status, 'completed');
      assert.deepEqual(readBoard().tasks[1].verification.map(attempt => attempt.status), ['cancelled', 'passed']);
      assert.equal(fs.readFileSync(path.join(sessionsDirectory, `${otherSessionId}.json`), 'utf8'), otherBefore);
      assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
      await evaluate('document.querySelector(".task-board-card").scrollIntoView({ block: "start" })');
      await capture('task-board-resumed-complete');
    });
    for (const scenario of ['skipped', 'repaired', 'failed']) {
      const scenarioId = randomUUID().replaceAll('-', '');
      const caseSessionId = `sess_verify_${scenarioId}`;
      const caseBoardId = `board_verify_${scenarioId}`;
      const caseBoard = { ...board, id: caseBoardId, title: `验证证据：${scenario === 'skipped' ? '没有配置测试' : scenario === 'repaired' ? '修复后通过' : '持续失败'}`, goal: 'Inspect task verification evidence', tasks: [{ id: 'task_evidence', title: 'Implement verification sample', status: 'pending', dependsOn: [] }] };
      const counter = path.join(workspace, '.aicode', `verification-count-${scenarioId}`);
      const marker = scenario === 'repaired' ? 'first attempt failure retained' : 'persistent failure retained';
      if (scenario === 'skipped') fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'no-checks-review', scripts: {} }));
      else {
        fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'verification-evidence-review', scripts: { test: 'node evidence-verify.cjs' } }));
        fs.writeFileSync(path.join(workspace, 'evidence-verify.cjs'), `const fs=require('node:fs');const count=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))+1:1;fs.writeFileSync(${JSON.stringify(counter)},String(count));const pass=${JSON.stringify(scenario)}==='repaired'&&count>1;console.log(pass?'repaired attempt passed':${JSON.stringify(marker)});process.exit(pass?0:1);`);
      }
      fs.writeFileSync(path.join(tasksDirectory, `${caseBoardId}.json`), JSON.stringify(caseBoard));
      fs.writeFileSync(path.join(sessionsDirectory, `${caseSessionId}.json`), JSON.stringify({ ...session(caseSessionId), taskRuntime: { boardId: caseBoardId, activeTaskId: 'task_evidence', mode: 'paused', lastSyncAt: now } }));
      await reload(); await waitFor('!!document.querySelector(".rail")', 'verification review reload');
      await openSession(caseSessionId); await waitFor(`!!document.querySelector(${JSON.stringify(continueSelector)})`, 'verification scenario plan');
      const before = requests;
      const name = scenario === 'skipped' ? 'VERIFY App distinguishes an untested task from a verified task' : scenario === 'repaired' ? 'VERIFY App retains the failed output after repaired verification passes' : 'VERIFY App stops after one failed repair and keeps both failure logs';
      const checked = await check(name, async () => {
        await click(continueSelector);
        const expectedStatus = scenario === 'failed' ? 'failed' : scenario === 'repaired' ? 'passed' : 'skipped';
        await waitFor(`document.querySelector('.task-board-item[data-task-id="task_evidence"] [data-verification-status="${expectedStatus}"]') && !document.querySelector('.composer-stop')`, `${scenario} terminal verification state`);
        const persisted = JSON.parse(fs.readFileSync(path.join(tasksDirectory, `${caseBoardId}.json`), 'utf8'));
        const task = persisted.tasks[0];
        assert.equal(requests - before, scenario === 'skipped' ? 1 : 2);
        assert.deepEqual(task.verification.map(attempt => attempt.status), scenario === 'skipped' ? ['skipped'] : scenario === 'repaired' ? ['failed', 'passed'] : ['failed', 'failed']);
        assert.equal(task.status, scenario === 'failed' ? 'blocked' : 'done');
        if (scenario === 'skipped') assert.doesNotMatch(task.resultSummary, /\[verified/i);
        else assert.ok(task.verification[0].results.some(check => check.output.includes(marker)));
        await reload(); await waitFor('!!document.querySelector(".rail")', 'persisted evidence reload'); await openSession(caseSessionId);
        await waitFor('!!document.querySelector(".task-board-card")', 'restored evidence card');
        if (!await evaluate('!!document.querySelector(".task-verification")')) await click('.task-board-item[data-task-id="task_evidence"] .task-board-item-head');
        await waitFor('!!document.querySelector(".task-verification")', 'saved verification details');
        assert.equal(await evaluate('document.querySelectorAll(".task-verification-attempt").length'), task.verification.length);
        await evaluate('document.querySelectorAll(".task-verification details").forEach(detail => { detail.open = true; })');
        if (scenario !== 'skipped') assert.ok(await evaluate(`document.querySelector('.task-verification')?.textContent.includes(${JSON.stringify(marker)})`));
        await evaluate('document.querySelector(".task-verification").scrollIntoView({ block: "center" })');
        await capture(`task-verification-${scenario}`);
        verificationScenarios.push({ scenario, board: persisted, requests: requests - before });
      });
      assert.equal(checked, true, `verification evidence ${scenario} gate`);
    }
    await require('./app-task-graph-checks.cjs')(context, { workspace, tasksDirectory, sessionsDirectory, session, openSession, requests: () => requests });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ date: new Date().toISOString(), sessionId, otherSessionId, requests, board: readBoard(), runtime: readSession().taskRuntime, prompts }, null, 2));
    fs.writeFileSync(path.join(output, 'verification-evidence.json'), JSON.stringify({ date: new Date().toISOString(), verificationScenarios }, null, 2));
  } finally {
    await evaluate(`window.zcodeDesktop.agent.cancel(${JSON.stringify(sessionId)})`).catch(() => undefined);
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
};
