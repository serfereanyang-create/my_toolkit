import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import type { AppConfig } from '../src/config/types.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

async function createFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-session-meta-'));
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
    sessionDir,
    sessions,
    session,
    run: (line: string) => handleSlashCommand({ line, config, provider, tools, sessions, session }),
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

async function readRecord(sessionDir: string, id: string) {
  return JSON.parse(await readFile(join(sessionDir, `${id}.json`), 'utf8'));
}

// /rename stored the title in finalAnswers[0], which every reader treats as an
// answer — so renaming a session destroyed its first answer, and the title
// itself was invisible (nothing reads a title from finalAnswers).
test('/rename stores the title on the record and leaves finalAnswers alone', async () => {
  const fixture = await createFixture();
  try {
    await fixture.sessions.appendMessage(fixture.session, { role: 'user', content: '第一个问题' });
    await fixture.sessions.appendFinalAnswer(fixture.session, '第一轮的真答案');

    const output = await fixture.run('/rename 我的会话');
    assert.match(output, /renamed/i);

    const record = await readRecord(fixture.sessionDir, fixture.session.id);
    assert.equal(record.title, '我的会话');
    assert.deepEqual(record.finalAnswers, ['第一轮的真答案'], 'the first answer survives');
  } finally {
    await fixture.cleanup();
  }
});

// /pin wrote to guard.pinned, a field no reader consulted, so pinning had no
// visible effect anywhere (and empty-session cleanup still saw it as deletable).
test('/pin writes a record-level pin that toggles', async () => {
  const fixture = await createFixture();
  try {
    assert.match(await fixture.run('/pin'), /pinned/i);
    let record = await readRecord(fixture.sessionDir, fixture.session.id);
    assert.equal(record.pinned, true);

    assert.match(await fixture.run('/pin'), /unpinned/i);
    record = await readRecord(fixture.sessionDir, fixture.session.id);
    assert.equal(record.pinned, false);
  } finally {
    await fixture.cleanup();
  }
});

test('/pin still toggles a pin an older build hid in guard.pinned', async () => {
  const fixture = await createFixture();
  try {
    fixture.session.guard = { pinned: true } as never;
    await fixture.sessions.save(fixture.session);

    await fixture.run('/pin');
    const record = await readRecord(fixture.sessionDir, fixture.session.id);
    assert.equal(record.pinned, false, 'the legacy pin counts as pinned, so /pin unpins');
  } finally {
    await fixture.cleanup();
  }
});

test('/sessions shows the renamed title', async () => {
  const fixture = await createFixture();
  try {
    await fixture.run('/rename 有名字的会话');
    const output = await fixture.run('/sessions');
    assert.match(output, /有名字的会话/);
  } finally {
    await fixture.cleanup();
  }
});

// /clear promised "the next message starts a fresh context" but left the
// OpenAI Responses chain id in place, so the next request resumed the cleared
// conversation on the provider; the retry payload and tool log survived too.
test('/clear really starts a fresh context', async () => {
  const fixture = await createFixture();
  try {
    await fixture.sessions.appendMessage(fixture.session, { role: 'user', content: '旧对话' });
    await fixture.sessions.appendToolCall(fixture.session, { tool: 'read_file', input: { path: 'a.ts' }, output: 'contents', ok: true });
    fixture.session.providerContinuation = { responseId: 'resp_OLD_CHAIN', status: 'pending' };
    await fixture.sessions.setLastTurn(fixture.session, {
      prompt: '旧对话', status: 'done', startedAt: new Date().toISOString(),
    });

    await fixture.run('/clear');

    const record = await readRecord(fixture.sessionDir, fixture.session.id);
    assert.deepEqual(record.messages, []);
    assert.deepEqual(record.finalAnswers, []);
    assert.equal(record.providerContinuation, undefined, 'the provider chain must not be continued');
    assert.equal(record.lastTurn, undefined, 'a cleared session has nothing to retry');
    assert.deepEqual(record.toolCalls, [], '/status must not report tools from the cleared turn');
  } finally {
    await fixture.cleanup();
  }
});
