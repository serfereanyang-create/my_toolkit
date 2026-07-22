import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { GitAuditLog } from '../src/git-safety/audit.js';
import { GitSnapshotDiff } from '../src/git-safety/diff.js';
import {
  GitCommandError,
  GitProcess,
  assertObjectId,
  assertSafeCheckpointRef,
  assertSafeRef,
  assertSafeRelativePath,
  assertSafeWorkspacePathspec,
  buildGitEnvironment,
  literalPathspec,
  sanitizeError,
  sanitizeRemote,
  stripGitNoise,
} from '../src/git-safety/git.js';
import { GitRepository } from '../src/git-safety/repository.js';
import { GitSafetyService } from '../src/git-safety/service.js';
import { GitSnapshotStore } from '../src/git-safety/snapshot.js';
import type { GitAuditEvent, GitPathChange, GitSnapshot, GitUnitRequest, GitUnitResult } from '../src/git-safety/types.js';
import { makeGitRepository, makeTempWorkspace, writeText } from './git-test-helpers.js';

function auditEvent(workspaceRoot: string, id: string, type: GitAuditEvent['type'] = 'unit_started'): GitAuditEvent {
  return {
    version: 1,
    id,
    type,
    timestamp: '2026-07-18T00:00:00.000Z',
    workspaceRoot,
  };
}

function snapshot(workspaceRoot: string, id = 'snapshot_1'): GitSnapshot {
  return {
    id,
    unitId: 'unit_1',
    phase: 'baseline',
    ref: `refs/aicode/checkpoints/unit_1/${id}`,
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    createdAt: '2026-07-18T00:00:00.000Z',
    repository: {
      root: workspaceRoot,
      workspaceRoot,
      workspacePathspec: '.',
      head: 'c'.repeat(40),
      branch: 'refs/heads/main',
    },
  };
}

function largeChanges(id: string): GitPathChange[] {
  return Array.from({ length: 160 }, (_, index) => {
    const path = `src/${id}/${index}-${'x'.repeat(1_024)}.ts`;
    return {
      kind: 'modify' as const,
      path,
      baseline: { path, oid: 'a'.repeat(40), mode: '100644' as const },
      result: { path, oid: 'b'.repeat(40), mode: '100644' as const },
      resultIndex: [{ path, oid: 'b'.repeat(40), mode: '100644', stage: 0 }],
    };
  });
}

function requireFinishedResult(result: GitUnitResult): true {
  return result.finished;
}

const validTurnRequest: GitUnitRequest = { kind: 'turn', sessionId: 'sess_1', turnId: 'turn_1' };
const validTaskRequest: GitUnitRequest = { kind: 'task', sessionId: 'sess_1', boardId: 'board_1', taskId: 'task_1' };
// @ts-expect-error turn requests require turnId
const turnMissingTurnId: GitUnitRequest = { kind: 'turn', sessionId: 'sess_1' };
// @ts-expect-error turn requests cannot carry board/task identifiers
const turnWithTaskFields: GitUnitRequest = { kind: 'turn', sessionId: 'sess_1', turnId: 'turn_1', boardId: 'board_1', taskId: 'task_1' };
// @ts-expect-error task requests require boardId and taskId
const taskMissingTaskFields: GitUnitRequest = { kind: 'task', sessionId: 'sess_1' };
// @ts-expect-error task requests cannot carry turnId
const taskWithTurnId: GitUnitRequest = { kind: 'task', sessionId: 'sess_1', boardId: 'board_1', taskId: 'task_1', turnId: 'turn_1' };
void [requireFinishedResult, validTurnRequest, validTaskRequest, turnMissingTurnId, turnWithTaskFields, taskMissingTaskFields, taskWithTurnId];

test('Git validators reject unsafe refs object ids and paths', () => {
  for (const ref of ['--help', '-d', 'refs/aicode/../../heads/main', 'refs/aicode/@{main', 'refs/aicode/control\u0001', 'refs/aicode/has space', 'refs/aicode/~main', 'refs/aicode/^main', 'refs/aicode/:main', 'refs/aicode/?main', 'refs/aicode/*main', 'refs/aicode/[main', 'refs\\heads\\main', '/refs/heads/main', 'refs/heads/main/', '.refs/heads/main', 'refs/heads/main.', 'refs//heads/main']) {
    assert.throws(() => assertSafeRef(ref), ref);
  }
  for (const oid of ['HEAD', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40)]) {
    assert.throws(() => assertObjectId(oid), oid);
  }
  for (const path of ['.', '../outside.txt', '/outside.txt', 'C:\\outside.txt', '\\\\server\\share\\outside.txt', 'src\\file.ts', 'src/../outside.txt', 'src/./file.ts', 'src//file.ts', ':(top)src/file.ts', 'src/*.ts', 'src/file?.ts', 'src/[abc].ts', 'src/null\u0000byte.ts']) {
    assert.throws(() => assertSafeRelativePath(path), path);
  }
  assert.equal(assertSafeRef('refs/aicode/checkpoints/unit_123/baseline'), 'refs/aicode/checkpoints/unit_123/baseline');
  assert.equal(assertObjectId('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(assertObjectId('ABCD'.repeat(16)), 'ABCD'.repeat(16));
  assert.equal(assertSafeRelativePath('src/space name.ts'), 'src/space name.ts');
  assert.equal(assertSafeRelativePath('src/你好.ts'), 'src/你好.ts');
});

test('checkpoint refs pathspecs and literal pathspecs enforce their distinct domains', () => {
  assert.equal(
    assertSafeCheckpointRef('refs/aicode/checkpoints/session_1/turn-你好/result'),
    'refs/aicode/checkpoints/session_1/turn-你好/result',
  );
  for (const ref of ['refs/heads/main', 'refs/aicode/checkpoints', 'refs/aicode/checkpoints/', 'refs/aicode/checkpoints/../heads/main']) {
    assert.throws(() => assertSafeCheckpointRef(ref), ref);
  }

  assert.equal(assertSafeWorkspacePathspec('.'), '.');
  assert.equal(assertSafeWorkspacePathspec('packages/app'), 'packages/app');
  assert.equal(literalPathspec('src/space name.ts'), ':(literal)src/space name.ts');
  assert.equal(literalPathspec('src/你好.ts'), ':(literal)src/你好.ts');
  assert.throws(() => literalPathspec('.'));
  assert.throws(() => assertSafeWorkspacePathspec('src\\app'));
});

test('sanitizeRemote strips URL credentials query and fragment but preserves remote names', () => {
  assert.equal(sanitizeRemote('https://user:secret@example.test/repo.git?token=hidden#fragment'), 'https://example.test/repo.git');
  assert.equal(sanitizeRemote('origin'), 'origin');
});

test('stripGitNoise removes CRLF and ignored-path advice', () => {
  const noisy = [
    "warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it",
    'The following paths are ignored by one of your .gitignore files:',
    '.aicode',
    'hint: Use -f if you really want to add them.',
    'hint: Disable this message with "git config set advice.addIgnoredFile false"',
    'fatal: real problem remains',
  ].join('\n');
  assert.equal(stripGitNoise(noisy).trim(), 'fatal: real problem remains');
  assert.match(sanitizeError(noisy), /real problem remains/);
  assert.doesNotMatch(sanitizeError(noisy), /LF will be replaced/);
});

test('buildGitEnvironment isolates ambient Git and secret variables without mutating input', () => {
  const input = {
    PATH: '/trusted/bin',
    SystemRoot: 'C:\\Windows',
    HOME: '/home/example',
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    GIT_DIR: '/attacker/repo',
    GIT_WORK_TREE: '/attacker/tree',
    GIT_INDEX_FILE: '/attacker/index',
    GIT_OBJECT_DIRECTORY: '/attacker/objects',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: 'attacker',
    GIT_ASKPASS: '/attacker/askpass',
    SSH_ASKPASS: '/attacker/ssh-askpass',
    OPENAI_API_KEY: 'openai-secret',
    ANTHROPIC_TOKEN: 'anthropic-secret',
    SERVICE_API_KEY: 'service-secret',
    DEPLOY_TOKEN: 'deploy-secret',
    DB_PASSWORD: 'password-secret',
    APP_SECRET: 'app-secret',
    SAFE_BUT_UNLISTED: 'must-not-propagate',
  };
  const before = { ...input };

  const env = buildGitEnvironment(input);

  assert.deepEqual(input, before);
  assert.deepEqual(env, {
    PATH: '/trusted/bin',
    SystemRoot: 'C:\\Windows',
    HOME: '/home/example',
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
  });
  assert.notEqual(env, input);
});

test('buildGitEnvironment allows explicit trusted Git overrides and case-insensitive deletion', () => {
  const env = buildGitEnvironment(
    { Path: 'C:\\Git\\cmd', TEMP: 'C:\\Temp', GIT_INDEX_FILE: 'ambient-index' },
    {
      path: 'D:\\TrustedGit\\cmd',
      GIT_INDEX_FILE: 'trusted-index',
      GIT_AUTHOR_NAME: 'Aicode Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Child User',
      temp: undefined,
    },
  );

  assert.equal(env.path, 'D:\\TrustedGit\\cmd');
  assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === 'path').length, 1);
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === 'temp'), false);
  assert.equal(env.GIT_INDEX_FILE, 'trusted-index');
  assert.equal(env.GIT_AUTHOR_NAME, 'Aicode Agent');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'agent@example.test');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'Child User');
});

test('GitProcess passes child-only env without mutating process.env', async () => {
  const fixture = await makeTempWorkspace('git-process-env');
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    const output = await new GitProcess(fixture.root).text(['config', '--get', 'user.name'], {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'child-only-name',
      },
    });

    assert.equal(output.trim(), 'child-only-name');
    assert.deepEqual(keys.map((key) => process.env[key]), before);
  } finally {
    await fixture.cleanup();
  }
});

test('GitProcess buffer accepts stdin', async () => {
  const fixture = await makeTempWorkspace('git-process-stdin');
  try {
    const output = await new GitProcess(fixture.root).buffer(['hash-object', '--stdin'], { stdin: Buffer.from('hello') });

    assert.ok(Buffer.isBuffer(output));
    assert.match(output.toString('utf8').trim(), /^[0-9a-f]{40,64}$/);
  } finally {
    await fixture.cleanup();
  }
});

test('GitProcess handles early stdin EOF without an unhandled EventEmitter error', async () => {
  const fixture = await makeTempWorkspace('git-process-stdin-epipe');
  try {
    const operation = new GitProcess(fixture.root).buffer(['--version'], { stdin: Buffer.alloc(8 * 1024 * 1024) });
    await assert.doesNotReject(operation.catch((error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.equal(error.kind, 'stdin');
      assert.equal(typeof error.errnoCode, 'string');
    }));
  } finally {
    await fixture.cleanup();
  }
});

test('GitProcess reports spawn errors with structured metadata', async () => {
  const fixture = await makeTempWorkspace('git-process-spawn-error');
  try {
    await assert.rejects(
      new GitProcess(fixture.root).text(['--version'], { env: { PATH: '' } }),
      (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.equal(error.kind, 'spawn');
        assert.equal(error.exitCode, null);
        assert.equal(error.signal, null);
        assert.equal(error.timedOut, false);
        assert.equal(error.errnoCode, 'ENOENT');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('GitCommandError exposes an exit code without leaking credentials', async () => {
  const fixture = await makeTempWorkspace('git-process-error');
  try {
    await assert.rejects(
      new GitProcess(fixture.root).text(['-c', 'token.value=plain-secret', 'config', '--get', 'aicode-missing-test.value']),
      (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.equal(error.kind, 'exit');
        assert.equal(typeof error.exitCode, 'number');
        assert.equal(error.signal, null);
        assert.equal(error.timedOut, false);
        assert.equal(error.errnoCode, undefined);
        assert.equal(error.stderr, '');
        assert.doesNotMatch(error.message, /secret/);
        assert.equal(error.cause, undefined);
        assert.equal('argv' in error, false);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog appends events and skips corrupt lines with a warning', async () => {
  const fixture = await makeTempWorkspace('audit');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append({
      version: 1,
      id: 'event_1',
      type: 'unit_started',
      timestamp: '2026-07-18T00:00:00.000Z',
      workspaceRoot: fixture.root,
      sessionId: 'sess_1',
      unitId: 'unit_1',
      unitKind: 'turn',
    });
    await appendFile(log.filePath, 'not-json\n', 'utf8');

    const result = await log.read();

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.type, 'unit_started');
    assert.match(result.warnings[0] ?? '', /corrupt audit line 2/i);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog redacts credentials from remote publication events', async () => {
  const fixture = await makeTempWorkspace('audit-redact');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append({
      version: 1,
      id: 'event_2',
      type: 'push_requested',
      timestamp: '2026-07-18T00:00:00.000Z',
      workspaceRoot: fixture.root,
      sessionId: 'sess_1',
      remote: 'https://user:secret@example.test/repo.git?token=query-secret#hash-secret',
      localRef: 'refs/heads/main',
      remoteBranch: 'main',
      error: 'push failed: Authorization: Bearer bearer-secret Bearer standalone-secret password=plain-secret token=generic-secret secret=key-secret credential=credential-secret https://other:other-secret@example.test/repo.git?access_token=url-secret',
    });
    await log.append({
      version: 1,
      id: 'event_3',
      type: 'push_failed',
      timestamp: '2026-07-18T00:00:01.000Z',
      workspaceRoot: fixture.root,
      remote: 'token=remote-secret',
    });

    const raw = await readFile(log.filePath, 'utf8');

    assert.doesNotMatch(raw, /secret|access_token|Authorization|password/i);
    assert.match(raw, /https:\/\/example\.test\/repo\.git/);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog rejects undeclared top-level fields', async () => {
  const fixture = await makeTempWorkspace('audit-field-allowlist');
  try {
    const log = new GitAuditLog(fixture.root);
    const event = {
      ...auditEvent(fixture.root, 'event_extra_fields'),
      prompt: 'prompt-secret',
      fileContent: 'file-secret',
      credential: 'credential-secret',
    } as GitAuditEvent;

    await assert.rejects(log.append(event), /invalid audit event/i);
    await assert.rejects(readFile(log.filePath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog returns valid events after a corrupt line', async () => {
  const fixture = await makeTempWorkspace('audit-corrupt-middle');
  try {
    const log = new GitAuditLog(fixture.root);
    const event = auditEvent(fixture.root, 'event_before');
    await log.append(event);
    await appendFile(log.filePath, 'not-json\n', 'utf8');
    await log.append({ ...event, id: 'event_after', type: 'unit_finished' });

    const result = await log.read();

    assert.deepEqual(result.events.map(({ id }) => id), ['event_before', 'event_after']);
    assert.match(result.warnings[0] ?? '', /line 2/);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog serializes concurrent large appends on one instance', async () => {
  const fixture = await makeTempWorkspace('audit-concurrent-one');
  try {
    const log = new GitAuditLog(fixture.root);
    const events = Array.from({ length: 12 }, (_, index) => ({
      ...auditEvent(fixture.root, `same_${index}`, 'unit_finished'),
      changes: largeChanges(`same_${index}`),
    }));

    await Promise.all(events.map((event) => log.append(event)));
    const result = await log.read();

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(new Set(result.events.map(({ id }) => id)), new Set(events.map(({ id }) => id)));
    assert.equal(result.events.length, events.length);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog serializes concurrent large appends across instances', async () => {
  const fixture = await makeTempWorkspace('audit-concurrent-many');
  try {
    const logs = [new GitAuditLog(fixture.root), new GitAuditLog(fixture.root)];
    const events = Array.from({ length: 12 }, (_, index) => ({
      ...auditEvent(fixture.root, `many_${index}`, 'unit_finished'),
      changes: largeChanges(`many_${index}`),
    }));

    await Promise.all(events.map((event, index) => logs[index % logs.length]!.append(event)));
    const result = await logs[0]!.read();

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(new Set(result.events.map(({ id }) => id)), new Set(events.map(({ id }) => id)));
    assert.equal(result.events.length, events.length);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog repairs a missing trailing newline before append', async () => {
  const fixture = await makeTempWorkspace('audit-newline');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append(auditEvent(fixture.root, 'first'));
    const firstLine = (await readFile(log.filePath, 'utf8')).trimEnd();
    await writeFile(log.filePath, firstLine, 'utf8');

    await log.append(auditEvent(fixture.root, 'second'));
    const result = await log.read();

    assert.deepEqual(result.events.map(({ id }) => id), ['first', 'second']);
    assert.deepEqual(result.warnings, []);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog recovers a stale cross-process lock file', async () => {
  const fixture = await makeTempWorkspace('audit-stale-lock');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append(auditEvent(fixture.root, 'first'));
    const lockPath = `${log.filePath}.lock`;
    await writeFile(lockPath, 'stale owner', 'utf8');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    await utimes(lockPath, staleTime, staleTime);

    await log.append(auditEvent(fixture.root, 'second'));

    await assert.rejects(stat(lockPath), { code: 'ENOENT' });
    assert.deepEqual((await log.read()).events.map(({ id }) => id), ['first', 'second']);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog rebuilds and sanitizes every nested audit field', async () => {
  const fixture = await makeTempWorkspace('audit-nested-redact');
  try {
    const log = new GitAuditLog(fixture.root);
    const baseline = snapshot('https://user:nested-password@example.test/work.git?token=nested-token', 'baseline_1');
    const path = 'src/password=nested-password.ts';
    const changes: GitPathChange[] = [{
      kind: 'modify',
      path,
      sourcePath: 'src/token=nested-token.ts',
      baseline: { path, oid: 'a'.repeat(40), mode: '100644' },
      result: { path, oid: 'b'.repeat(40), mode: '100755' },
      resultIndex: [{ path, oid: 'b'.repeat(40), mode: '100755', stage: 0 }],
    }];

    await log.append({
      ...auditEvent(fixture.root, 'nested', 'unit_finished'),
      baseline,
      changes,
      error: 'failed\nAuthorization: token ghp_LEAKED password=also-leaked',
    });
    const raw = await readFile(log.filePath, 'utf8');

    assert.doesNotMatch(raw, /nested-password|nested-token|ghp_LEAKED|also-leaked/);
    assert.match(raw, /https:\/\/example\.test\/work\.git/);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog rejects unknown nested fields without invoking toJSON', async () => {
  const fixture = await makeTempWorkspace('audit-malicious-json');
  try {
    const log = new GitAuditLog(fixture.root);
    let invoked = false;
    const malicious = {
      ...snapshot(fixture.root),
      unknownNested: 'must-be-rejected',
      toJSON() {
        invoked = true;
        return { leaked: 'toJSON-secret' };
      },
    };

    await assert.rejects(
      log.append({ ...auditEvent(fixture.root, 'malicious', 'snapshot_created'), snapshot: malicious } as unknown as GitAuditEvent),
      /invalid audit event/i,
    );
    assert.equal(invoked, false);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog bounds long sanitized errors and records truncation', async () => {
  const fixture = await makeTempWorkspace('audit-error-limit');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append({ ...auditEvent(fixture.root, 'long-error', 'snapshot_failed'), error: 'x'.repeat(100_000) });

    const [event] = (await log.read()).events as Array<GitAuditEvent & { errorTruncated?: boolean }>;
    assert.equal(event?.errorTruncated, true);
    assert.ok((event?.error?.length ?? Number.POSITIVE_INFINITY) <= 16 * 1024);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog append rejects the complete set of invalid v1 shapes', async () => {
  const fixture = await makeTempWorkspace('audit-schema-append');
  try {
    const log = new GitAuditLog(fixture.root);
    const validSnapshot = snapshot(fixture.root);
    const validChange = largeChanges('schema')[0]!;
    const invalidEvents: unknown[] = [
      { ...auditEvent(fixture.root, 'bad-type'), type: 'not_a_v1_event' },
      { ...auditEvent(fixture.root, 'bad-top'), unknown: true },
      { ...auditEvent(fixture.root, 'bad-version'), version: 2 },
      { ...auditEvent(fixture.root, 'bad-enum'), unitKind: 'job' },
      { ...auditEvent(fixture.root, 'bad-array'), conflicts: ['ok', 1] },
      { ...auditEvent(fixture.root, 'bad-oid'), baseline: { ...validSnapshot, commit: 'a'.repeat(41) } },
      { ...auditEvent(fixture.root, 'bad-ref'), baseline: { ...validSnapshot, ref: '--help' } },
      { ...auditEvent(fixture.root, 'bad-mode'), changes: [{ ...validChange, result: { ...validChange.result, mode: '100600' } }] },
      { ...auditEvent(fixture.root, 'bad-stage'), changes: [{ ...validChange, resultIndex: [{ ...validChange.resultIndex[0], stage: 4 }] }] },
      { ...auditEvent(fixture.root, 'bad-change-field'), changes: [{ ...validChange, unknown: true }] },
      { ...auditEvent(fixture.root, 'bad-repository-field'), baseline: { ...validSnapshot, repository: { ...validSnapshot.repository, unknown: true } } },
    ];

    for (const event of invalidEvents) {
      await assert.rejects(log.append(event as GitAuditEvent), /invalid audit event/i);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog rejects prototype-sensitive append objects', async () => {
  const fixture = await makeTempWorkspace('audit-prototype');
  try {
    const log = new GitAuditLog(fixture.root);
    const event = Object.create(auditEvent(fixture.root, 'inherited')) as GitAuditEvent;

    await assert.rejects(log.append(event), /invalid audit event/i);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog read warns for schema-invalid and oversized lines then continues', async () => {
  const fixture = await makeTempWorkspace('audit-schema-read');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append(auditEvent(fixture.root, 'first'));
    await appendFile(log.filePath, `${JSON.stringify({ ...auditEvent(fixture.root, 'invalid'), type: 'invalid_type' })}\n`, 'utf8');
    await appendFile(log.filePath, `${'x'.repeat(8 * 1024 * 1024 + 1)}\n`, 'utf8');
    await log.append(auditEvent(fixture.root, 'last'));

    const result = await log.read();

    assert.deepEqual(result.events.map(({ id }) => id), ['first', 'last']);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0] ?? '', /line 2/);
    assert.match(result.warnings[1] ?? '', /line 3/);
  } finally {
    await fixture.cleanup();
  }
});


test('GitRepository initializes only after explicit confirmation', async () => {
  const fixture = await makeTempWorkspace('repo-init-confirm');
  try {
    const gitProcess = new GitProcess(fixture.root);
    const repository = new GitRepository(fixture.root, gitProcess);
    const declined = await repository.ensure(async () => false);
    assert.equal(declined, undefined);
    await assert.rejects(stat(resolve(fixture.root, '.git')), { code: 'ENOENT' });

    const accepted = await repository.ensure(async () => true);
    assert.ok(accepted);
    assert.equal(accepted.workspacePathspec, '.');
    await stat(resolve(fixture.root, '.git'));
  } finally {
    await fixture.cleanup();
  }
});

test('GitSnapshotStore creates readable baseline and result refs', async () => {
  const fixture = await makeGitRepository('snapshot-refs');
  try {
    const gitProcess = new GitProcess(fixture.workspace);
    const repository = await new GitRepository(fixture.workspace, gitProcess).discover();
    assert.ok(repository);
    const store = new GitSnapshotStore(gitProcess, fixture.workspace);
    const baseline = await store.create(repository, 'unit_refs_1', 'baseline');
    await writeText(fixture.root, 'src/app.ts', 'v1\n');
    const result = await store.create(repository, 'unit_refs_1', 'result');

    const baselineOid = (await fixture.git(['rev-parse', baseline.ref])).stdout.toString().trim();
    const resultOid = (await fixture.git(['rev-parse', result.ref])).stdout.toString().trim();
    assert.equal(baselineOid, baseline.commit);
    assert.equal(resultOid, result.commit);
    await fixture.git(['cat-file', '-e', baseline.commit + '^{commit}']);
    await fixture.git(['cat-file', '-e', result.commit + '^{commit}']);
  } finally {
    await fixture.cleanup();
  }
});

test('GitSnapshotStore captures dirty tracked staged deleted and untracked files', async () => {
  const fixture = await makeGitRepository('snapshot-dirty');
  try {
    await writeText(fixture.root, 'tracked.txt', 'tracked\n');
    await writeText(fixture.root, 'deleted.txt', 'delete-me\n');
    await fixture.git(['add', 'tracked.txt', 'deleted.txt']);
    await fixture.git(['commit', '-m', 'seed']);
    await writeText(fixture.root, 'tracked.txt', 'tracked-changed\n');
    await writeText(fixture.root, 'staged.txt', 'staged\n');
    await fixture.git(['add', 'staged.txt']);
    await writeText(fixture.root, 'untracked.txt', 'untracked\n');
    await rm(resolve(fixture.root, 'deleted.txt'), { force: true });

    const gitProcess = new GitProcess(fixture.workspace);
    const repository = await new GitRepository(fixture.workspace, gitProcess).discover();
    assert.ok(repository);
    const store = new GitSnapshotStore(gitProcess, fixture.workspace);
    const snapshot = await store.create(repository, 'unit_dirty_1', 'result');
    const tree = String((await fixture.git(['ls-tree', '-r', '--name-only', snapshot.tree])).stdout);
    assert.match(tree, /tracked\.txt/);
    assert.match(tree, /staged\.txt/);
    assert.match(tree, /untracked\.txt/);
    assert.doesNotMatch(tree, /deleted\.txt/);
  } finally {
    await fixture.cleanup();
  }
});

test('GitSnapshotStore supports an unborn HEAD', async () => {
  const fixture = await makeGitRepository('snapshot-unborn', { unborn: true });
  try {
    await writeText(fixture.root, 'first.txt', 'first\n');
    const gitProcess = new GitProcess(fixture.workspace);
    const repository = await new GitRepository(fixture.workspace, gitProcess).discover();
    assert.ok(repository);
    assert.equal(repository.head, undefined);
    const store = new GitSnapshotStore(gitProcess, fixture.workspace);
    const snapshot = await store.create(repository, 'unit_unborn_1', 'baseline');
    const parents = (await fixture.git(['rev-list', '--parents', '-n', '1', snapshot.commit])).stdout.toString().trim().split(/\s+/);
    assert.equal(parents.length, 1);
    assert.equal(parents[0], snapshot.commit);
  } finally {
    await fixture.cleanup();
  }
});

test('GitSnapshotStore excludes aicode runtime artifacts', async () => {
  const fixture = await makeGitRepository('snapshot-exclude-aicode');
  try {
    await mkdir(resolve(fixture.root, '.aicode', 'git-safety'), { recursive: true });
    await writeText(fixture.root, '.aicode/git-safety/audit.jsonl', '{}\n');
    await writeText(fixture.root, 'src/keep.ts', 'keep\n');
    const gitProcess = new GitProcess(fixture.workspace);
    const repository = await new GitRepository(fixture.workspace, gitProcess).discover();
    assert.ok(repository);
    const store = new GitSnapshotStore(gitProcess, fixture.workspace);
    const snapshot = await store.create(repository, 'unit_exclude_1', 'baseline');
    const tree = String((await fixture.git(['ls-tree', '-r', '--name-only', snapshot.tree])).stdout);
    assert.match(tree, /src\/keep\.ts/);
    assert.doesNotMatch(tree, /\.aicode\//);
  } finally {
    await fixture.cleanup();
  }
});

test('snapshot creation preserves HEAD branch worktree and real index', async () => {
  const fixture = await makeGitRepository('snapshot-preserve');
  try {
    await writeText(fixture.root, 'tracked.txt', 'tracked\n');
    await fixture.git(['add', 'tracked.txt']);
    await fixture.git(['commit', '-m', 'seed']);
    await writeText(fixture.root, 'tracked.txt', 'dirty\n');
    await writeText(fixture.root, 'staged.txt', 'staged\n');
    await fixture.git(['add', 'staged.txt']);
    await writeText(fixture.root, 'untracked.txt', 'untracked\n');

    const before = {
      head: (await fixture.git(['rev-parse', 'HEAD'])).stdout.toString().trim(),
      branch: (await fixture.git(['symbolic-ref', '-q', 'HEAD'])).stdout.toString().trim(),
      status: (await fixture.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout,
      index: await fixture.readIndexBytes(),
      tracked: await readFile(resolve(fixture.root, 'tracked.txt')),
      staged: await readFile(resolve(fixture.root, 'staged.txt')),
      untracked: await readFile(resolve(fixture.root, 'untracked.txt')),
    };

    const gitProcess = new GitProcess(fixture.workspace);
    const repository = await new GitRepository(fixture.workspace, gitProcess).discover();
    assert.ok(repository);
    const store = new GitSnapshotStore(gitProcess, fixture.workspace);
    await store.create(repository, 'unit_preserve_1', 'baseline');

    const after = {
      head: (await fixture.git(['rev-parse', 'HEAD'])).stdout.toString().trim(),
      branch: (await fixture.git(['symbolic-ref', '-q', 'HEAD'])).stdout.toString().trim(),
      status: (await fixture.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout,
      index: await fixture.readIndexBytes(),
      tracked: await readFile(resolve(fixture.root, 'tracked.txt')),
      staged: await readFile(resolve(fixture.root, 'staged.txt')),
      untracked: await readFile(resolve(fixture.root, 'untracked.txt')),
    };

    assert.equal(after.head, before.head);
    assert.equal(after.branch, before.branch);
    assert.deepEqual(after.status, before.status);
    assert.deepEqual(after.index, before.index);
    assert.deepEqual(after.tracked, before.tracked);
    assert.deepEqual(after.staged, before.staged);
    assert.deepEqual(after.untracked, before.untracked);
  } finally {
    await fixture.cleanup();
  }
});

test('GitSnapshotDiff parses Unicode spaced binary rename and mode changes', async () => {
  const fixture = await makeGitRepository('snapshot-diff');
  try {
    await writeText(fixture.root, 'old name.txt', 'rename-me\n');
    await writeText(fixture.root, 'binary.bin', 'bin-v1');
    await writeText(fixture.root, 'mode.sh', 'echo hi\n');
    await writeText(fixture.root, 'unicode/你好.ts', 'u1\n');
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'seed']);

    const gitProcess = new GitProcess(fixture.workspace);
    const repository = await new GitRepository(fixture.workspace, gitProcess).discover();
    assert.ok(repository);
    const store = new GitSnapshotStore(gitProcess, fixture.workspace);
    const baseline = await store.create(repository, 'unit_diff_1', 'baseline');

    await writeText(fixture.root, 'new name.txt', 'rename-me\n');
    await rm(resolve(fixture.root, 'old name.txt'), { force: true });
    await writeText(fixture.root, 'binary.bin', 'bin-v2');
    await writeText(fixture.root, 'unicode/你好.ts', 'u2\n');
    await writeText(fixture.root, 'mode.sh', 'echo hi\n');
    try {
      await chmod(resolve(fixture.root, 'mode.sh'), 0o755);
    } catch {
      // Windows without filemode support still exercises rename/binary/unicode paths.
    }
    await writeText(fixture.root, 'added spaced file.ts', 'added\n');

    const result = await store.create(repository, 'unit_diff_1', 'result');
    const diff = new GitSnapshotDiff(gitProcess);
    const changes = await diff.manifest(repository, baseline, result);
    const byPath = new Map(changes.map((change) => [change.path, change]));
    assert.ok(byPath.has('added spaced file.ts'));
    assert.ok(byPath.has('binary.bin'));
    assert.ok(byPath.has('unicode/你好.ts'));
    const rename = changes.find((change) => change.kind === 'rename' || change.sourcePath === 'old name.txt' || change.path === 'new name.txt');
    assert.ok(rename);
  } finally {
    await fixture.cleanup();
  }
});

function createService(workspaceRoot: string) {
  const gitProcess = new GitProcess(workspaceRoot);
  const repository = new GitRepository(workspaceRoot, gitProcess);
  const snapshots = new GitSnapshotStore(gitProcess, workspaceRoot);
  const diff = new GitSnapshotDiff(gitProcess);
  const audit = new GitAuditLog(workspaceRoot);
  return {
    service: new GitSafetyService(workspaceRoot, repository, snapshots, diff, audit),
    audit,
    gitProcess,
  };
}

test('GitSafetyService degrades after repository initialization is declined', async () => {
  const fixture = await makeTempWorkspace('service-decline');
  try {
    const { service, audit } = createService(fixture.root);
    const context = await service.startUnit(
      { kind: 'turn', sessionId: 'sess_1', turnId: 'turn_1' },
      { confirm: async () => false },
    );
    assert.equal(context.protectionMode, 'file-checkpoint-only');
    await assert.rejects(stat(resolve(fixture.root, '.git')), { code: 'ENOENT' });
    const events = await audit.read();
    assert.ok(events.events.some((event) => event.type === 'repository_init_declined'));
  } finally {
    await fixture.cleanup();
  }
});

test('GitSafetyService creates one baseline and one result per unit', async () => {
  const fixture = await makeGitRepository('service-once');
  try {
    const { service, audit } = createService(fixture.workspace);
    const context = await service.startUnit({ kind: 'turn', sessionId: 'sess_1', turnId: 'turn_1' });
    assert.equal(context.protectionMode, 'git');
    assert.ok(context.baseline);
    await writeText(fixture.root, 'service.txt', 'changed\n');
    const finished = await service.finishUnit(context, 'done');
    assert.equal(finished.finished, true);
    assert.ok(finished.result);
    const events = await audit.read();
    const snapshots = events.events.filter((event) => event.type === 'snapshot_created');
    const finishedEvents = events.events.filter((event) => event.type === 'unit_finished');
    assert.equal(snapshots.length, 2);
    assert.equal(finishedEvents.length, 1);
    assert.ok((finishedEvents[0]?.changes?.length ?? 0) >= 1);
  } finally {
    await fixture.cleanup();
  }
});

test('GitSafetyService attempts result after blocked failed and cancelled outcomes', async () => {
  const fixture = await makeGitRepository('service-outcomes');
  try {
    for (const outcome of ['blocked', 'failed', 'cancelled'] as const) {
      const { service } = createService(fixture.workspace);
      const context = await service.startUnit({ kind: 'task', sessionId: 'sess_1', boardId: 'board_1', taskId: `task_${outcome}` });
      const finished = await service.finishUnit(context, outcome);
      assert.equal(finished.outcome, outcome);
      assert.ok(finished.result);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('GitSafetyService records snapshot failure without changing business outcome', async () => {
  const fixture = await makeGitRepository('service-snapshot-fail');
  try {
    const gitProcess = new GitProcess(fixture.workspace);
    const repository = new GitRepository(fixture.workspace, gitProcess);
    const snapshots = {
      create: async () => {
        throw new Error('simulated snapshot failure');
      },
    } as unknown as GitSnapshotStore;
    const diff = new GitSnapshotDiff(gitProcess);
    const audit = new GitAuditLog(fixture.workspace);
    const service = new GitSafetyService(fixture.workspace, repository, snapshots, diff, audit);
    const context = await service.startUnit({ kind: 'turn', sessionId: 'sess_1', turnId: 'turn_fail' });
    assert.equal(context.protectionMode, 'file-checkpoint-only');
    const finished = await service.finishUnit(context, 'done');
    assert.equal(finished.outcome, 'done');
    const events = await audit.read();
    assert.ok(events.events.some((event) => event.type === 'snapshot_failed'));
    assert.ok(events.events.some((event) => event.type === 'unit_finished' && event.outcome === 'done'));
  } finally {
    await fixture.cleanup();
  }
});

test('GitSafetyService finishes a unit at most once', async () => {
  const fixture = await makeGitRepository('service-idempotent');
  try {
    const { service, audit } = createService(fixture.workspace);
    const context = await service.startUnit({ kind: 'turn', sessionId: 'sess_1', turnId: 'turn_once' });
    const first = await service.finishUnit(context, 'done');
    const second = await service.finishUnit(context, 'failed');
    assert.equal(second.unitId, first.unitId);
    assert.equal(second.outcome, first.outcome);
    const finishedEvents = (await audit.read()).events.filter((event) => event.type === 'unit_finished');
    assert.equal(finishedEvents.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

