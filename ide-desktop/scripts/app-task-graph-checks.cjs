'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = async function runTaskGraphChecks(context, fixture) {
  const { evaluate, click, waitFor, capture, check, reload } = context;
  const { workspace, tasksDirectory, sessionsDirectory, session, openSession, requests } = fixture;
  const reports = [];
  const task = (id, dependencies = [], status = 'pending') => ({ id, title: id, status, dependsOn: dependencies });
  const scenarios = [
    { key: 'cycle', tasks: [task('a', ['b']), task('b', ['a']), task('independent')], label: '循环依赖' },
    { key: 'missing', tasks: [task('a', ['ghost'])], label: '依赖任务不存在' },
    { key: 'duplicate', tasks: [task('dup'), task('dup')], label: '编号重复' },
    { key: 'malformed', tasks: null, label: '任务' },
    { key: 'cancelled-parent', tasks: [task('cancelled-parent', [], 'cancelled'), task('dependent', ['cancelled-parent'])] },
    { key: 'live-lease', tasks: [task('already-owned')], leased: true },
  ];
  for (const scenario of scenarios) {
    const token = randomUUID().replaceAll('-', ''); const id = `sess_graph_${token}`; const boardId = `board_graph_${token}`;
    const now = new Date().toISOString();
    const board = { id: boardId, title: `依赖恢复验收：${scenario.key}`, goal: 'Inspect saved plan dependencies', status: 'active', createdAt: now, updatedAt: now, tasks: scenario.tasks };
    const file = path.join(tasksDirectory, `${boardId}.json`); const sessionFile = path.join(sessionsDirectory, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(board));
    fs.writeFileSync(sessionFile, JSON.stringify({ ...session(id), taskRuntime: { boardId, mode: 'paused', lastSyncAt: now } }));
    const leaseFile = path.join(tasksDirectory, `${boardId}.lease.json`);
    const lease = JSON.stringify({ boardId, taskId: 'already-owned', pid: process.pid, updatedAt: now });
    if (scenario.leased) fs.writeFileSync(leaseFile, lease);
    await reload(); await waitFor('!!document.querySelector(".rail")', 'graph review workspace'); await openSession(id);
    await waitFor(`document.querySelector('.task-board-head strong')?.textContent === ${JSON.stringify(board.title)}`, 'saved graph card');
    await evaluate('window.taskGraphUnsubscribe?.(); window.taskGraphEvents = []; window.taskGraphUnsubscribe = window.zcodeDesktop.agent.onEvent(event => { if (event.type === "turn_done") window.taskGraphEvents.push(event); }); undefined');
    const before = requests();
    const checked = await check(`GRAPH App handles ${scenario.key} without a model call, dependency rewrite or renderer crash`, async () => {
      if (scenario.label) {
        assert.ok(await evaluate(`document.querySelector('.task-board-graph-error')?.textContent.includes(${JSON.stringify(scenario.label)})`));
        assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify('button[aria-label="继续任务计划"]')})`), false);
      }
      await evaluate(`window.zcodeDesktop.agent.taskBoardAction('continue', undefined, ${JSON.stringify(id)})`);
      await waitFor(`window.taskGraphEvents?.some(event => event.sessionId === ${JSON.stringify(id)})`, 'graph command completion');
      await waitFor(`(async () => { const session = await window.zcodeDesktop.sessions.load(${JSON.stringify(id)}); return session.taskRuntime?.mode === 'paused'; })()`, 'graph execution refusal');
      await waitFor('!document.querySelector(".composer-stop")', 'graph operation ends');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(saved.tasks, scenario.tasks);
      assert.equal(saved.status, scenario.leased ? 'active' : 'blocked');
      assert.equal(requests(), before);
      if (scenario.leased) assert.equal(fs.readFileSync(leaseFile, 'utf8'), lease);
      else assert.ok(saved.error);
      assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
      await evaluate('document.querySelector(".task-board-card").scrollIntoView({ block: "start" })');
      await capture(`task-graph-${scenario.key}`);
      reports.push({ scenario: scenario.key, modelRequests: requests() - before, preservedDependencies: true, board: saved, preservedLease: Boolean(scenario.leased) });
    });
    assert.equal(checked, true, `saved graph ${scenario.key} gate`);
  }
  const output = path.resolve(__dirname, '..', 'out', 'task-graph-review'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'app-results.json'), JSON.stringify({ date: new Date().toISOString(), reports }, null, 2));
};
