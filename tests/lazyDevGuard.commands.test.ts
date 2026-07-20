import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import type { AppConfig } from '../src/config/types.js';
import { createInitialLazyDevGuardState } from '../src/guard/config.js';
import type { LazyDevRequirement } from '../src/guard/types.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore, type SessionRecord } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

async function createFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-lazy-command-'));
  const sessionDir = join(workspace, '.aicode', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '',
    maxSteps: 20,
    noBanner: true,
  };
  const provider = createMockProvider(config.model);
  const tools = createDefaultToolRegistry();
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

  return {
    workspace,
    config,
    provider,
    tools,
    sessions,
    session,
    run: (line: string) => handleSlashCommand({ line, config, provider, tools, sessions, session }),
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

function createRequirement(overrides: Partial<LazyDevRequirement> = {}): LazyDevRequirement {
  return {
    id: 'req_command_test',
    originalPrompt: '做一个保存按钮，失败时提醒用户',
    translatedRequirement: {
      summary: '提供保存入口并反馈成功或失败状态。',
      fields: [
        { name: '目标', value: '保存当前内容' },
        { name: '输入', value: '用户点击保存按钮' },
        { name: '输出', value: '成功或失败反馈' },
        { name: '失败情况', value: '保存失败时展示错误并允许重试' },
        { name: '验收标准', value: '点击保存后用户知道是否成功' },
      ],
      incomplete: false,
    },
    domainMatches: [{ adapterId: 'software', label: '软件开发', confidence: 0.9, reasons: ['保存按钮'] }],
    riskLevel: 'medium',
    status: 'checking',
    attemptsUsed: 1,
    maxAttempts: 2,
    askedQuestionIds: [],
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

async function loadLazyDev(sessions: SessionStore, session: SessionRecord) {
  return (await sessions.load(session.id)).guard?.lazyDev;
}

test('/help lists /不准偷懒开发', async () => {
  const fixture = await createFixture();
  try {
    const output = await fixture.run('/help');

    assert.match(output, /\/不准偷懒开发\s+开启学习守门模式/);
    assert.match(output, /\/不准偷懒开发 状态\s+查看守门状态/);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 enables guard and saves session state', async () => {
  const fixture = await createFixture();
  try {
    const output = await fixture.run('/不准偷懒开发');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /不准偷懒开发已开启|开启学习守门模式/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
    assert.equal(saved?.enabled, true);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 状态 before enabling reports closed without initializing guard', async () => {
  const fixture = await createFixture();
  try {
    const output = await fixture.run('/不准偷懒开发 状态');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /状态：关闭/);
    assert.match(output, /尚未开启/);
    assert.equal(fixture.session.guard?.lazyDev, undefined);
    assert.equal(saved, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 什么鬼 before enabling returns help without initializing guard', async () => {
  const fixture = await createFixture();
  try {
    const output = await fixture.run('/不准偷懒开发 什么鬼');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /未知的不准偷懒开发命令/);
    assert.match(output, /\/不准偷懒开发 状态/);
    assert.equal(fixture.session.guard?.lazyDev, undefined);
    assert.equal(saved, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 状态 reports active guard details', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.config.strictness = 'experienced';
    state.currentRequirement = createRequirement();
    state.metrics.totalChecks = 5;
    state.metrics.blocked = 2;
    fixture.session.guard = { lazyDev: state };

    const output = await fixture.run('/不准偷懒开发 状态');

    assert.match(output, /状态：开启/);
    assert.match(output, /强度：experienced/);
    assert.match(output, /当前需求：checking/);
    assert.match(output, /风险：medium/);
    assert.match(output, /剩余补答：1/);
    assert.match(output, /检查次数：5/);
    assert.match(output, /阻塞次数：2/);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 设置 最大补答次数 3 updates config', async () => {
  const fixture = await createFixture();
  try {
    const output = await fixture.run('/不准偷懒开发 设置 最大补答次数 3');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /最大补答次数：3/);
    assert.equal(fixture.session.guard?.lazyDev?.config.defaultMaxAttempts, 3);
    assert.equal(saved?.config.defaultMaxAttempts, 3);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 设置 最大补答次数 invalid value does not mutate config', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.config.defaultMaxAttempts = 2;
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 设置 最大补答次数 4');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /请提供最大补答次数：1、2 或 3/);
    assert.equal(fixture.session.guard?.lazyDev?.config.defaultMaxAttempts, 2);
    assert.equal(saved?.config.defaultMaxAttempts, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 设置 最大补答次数 missing value does not mutate config', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.config.defaultMaxAttempts = 3;
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 设置 最大补答次数');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /请提供最大补答次数：1、2 或 3/);
    assert.equal(fixture.session.guard?.lazyDev?.config.defaultMaxAttempts, 3);
    assert.equal(saved?.config.defaultMaxAttempts, 3);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 继续 resumes blocked requirement and saves session state', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement({ status: 'blocked', blockedReason: '答案不完整' });
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 继续');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /继续检查/);
    assert.equal(fixture.session.guard?.lazyDev?.currentRequirement?.status, 'checking');
    assert.equal(fixture.session.guard?.lazyDev?.currentRequirement?.blockedReason, undefined);
    assert.equal(saved?.currentRequirement?.status, 'checking');
    assert.ok(saved?.currentRequirement?.lastQuestion);
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 归档 archives current requirement and keeps guard enabled', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement();
    fixture.session.guard = { lazyDev: state };

    const output = await fixture.run('/不准偷懒开发 归档');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /已归档当前需求/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
    assert.equal(fixture.session.guard?.lazyDev?.currentRequirement, undefined);
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.history.at(-1)?.status, 'archived');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 取消 cancels current requirement and keeps guard enabled', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement();
    fixture.session.guard = { lazyDev: state };

    const output = await fixture.run('/不准偷懒开发 取消');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /已取消当前需求/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
    assert.equal(fixture.session.guard?.lazyDev?.currentRequirement, undefined);
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.history.at(-1)?.status, 'cancelled');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 关闭 refuses active unchecked requirement and keeps enabled true', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement({ status: 'checking' });
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 关闭');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /不能关闭不准偷懒开发/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.currentRequirement?.status, 'checking');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 确认关闭不准偷懒开发 refuses active unchecked requirement and keeps enabled true', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement({ status: 'checking' });
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 确认关闭不准偷懒开发');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /不能关闭不准偷懒开发/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.currentRequirement?.status, 'checking');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 关闭 asks for exact confirmation and keeps enabled true', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement({ status: 'passed' });
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 关闭');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /确认关闭不准偷懒开发/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.currentRequirement?.status, 'passed');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 确认关闭不准偷懒开发 disables without active unchecked requirement', async () => {
  const fixture = await createFixture();
  try {
    const state = createInitialLazyDevGuardState();
    state.currentRequirement = createRequirement({ status: 'passed' });
    fixture.session.guard = { lazyDev: state };
    await fixture.sessions.save(fixture.session);

    const output = await fixture.run('/不准偷懒开发 确认关闭不准偷懒开发');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /不准偷懒开发已关闭/);
    assert.equal(fixture.session.guard?.lazyDev?.enabled, false);
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.currentRequirement?.status, 'passed');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 暂停 records reason', async () => {
  const fixture = await createFixture();
  try {
    const output = await fixture.run('/不准偷懒开发 暂停 非开发闲聊');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /不准偷懒开发已暂停：非开发闲聊/);
    assert.equal(fixture.session.guard?.lazyDev?.paused?.reason, '非开发闲聊');
    assert.equal(fixture.session.guard?.lazyDev?.paused?.resumeHint, '/不准偷懒开发 继续');
    assert.equal(saved?.paused?.reason, '非开发闲聊');
    assert.equal(saved?.paused?.resumeHint, '/不准偷懒开发 继续');
  } finally {
    await fixture.cleanup();
  }
});

test('/不准偷懒开发 暂停 then 继续 clears pause and saves session state', async () => {
  const fixture = await createFixture();
  try {
    await fixture.run('/不准偷懒开发 暂停 非开发闲聊');

    const output = await fixture.run('/不准偷懒开发 继续');
    const saved = await loadLazyDev(fixture.sessions, fixture.session);

    assert.match(output, /不准偷懒开发已恢复/);
    assert.equal(fixture.session.guard?.lazyDev?.paused, undefined);
    assert.equal(saved?.paused, undefined);
  } finally {
    await fixture.cleanup();
  }
});
