import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { GitAuditLog } from '../src/git-safety/audit.js';
import { GitProcess } from '../src/git-safety/git.js';
import { LocalGitPublisher } from '../src/git-safety/publisher.js';
import { decideApproval, isAutoAllowedCommand, isBlockedCommand } from '../src/safety/policy.js';
import { git, makeGitRepository, writeText } from './git-test-helpers.js';

async function makePublishFixture() {
  const source = await makeGitRepository('publisher-source');
  const remoteRoot = await mkdtemp(join(tmpdir(), 'aicode-publisher-remote-'));
  await git(remoteRoot, ['init', '--bare']);
  await source.git(['remote', 'add', 'origin', remoteRoot]);
  await source.git(['push', '-u', 'origin', 'main']);
  return {
    source,
    remoteRoot,
    cleanup: async () => {
      await source.cleanup();
      await rm(remoteRoot, { recursive: true, force: true });
    },
  };
}

test('publisher makes no remote change without a confirmation callback', async () => {
  const fixture = await makePublishFixture();
  try {
    await writeText(fixture.source.root, 'push.txt', 'one\n');
    await fixture.source.git(['add', '.']);
    await fixture.source.git(['commit', '-m', 'one']);
    const before = (await git(fixture.remoteRoot, ['rev-parse', 'refs/heads/main'])).stdout.toString().trim();
    const publisher = new LocalGitPublisher(fixture.source.workspace, new GitProcess(fixture.source.workspace), new GitAuditLog(fixture.source.workspace));
    const result = await publisher.publish({
      remote: 'origin',
      localRef: 'refs/heads/main',
      remoteBranch: 'main',
      sessionId: 'sess',
    });
    assert.equal(result.ok, false);
    const after = (await git(fixture.remoteRoot, ['rev-parse', 'refs/heads/main'])).stdout.toString().trim();
    assert.equal(after, before);
  } finally {
    await fixture.cleanup();
  }
});

test('publisher asks independently for every push', async () => {
  const fixture = await makePublishFixture();
  try {
    const publisher = new LocalGitPublisher(fixture.source.workspace, new GitProcess(fixture.source.workspace), new GitAuditLog(fixture.source.workspace));
    let asks = 0;
    for (let index = 0; index < 2; index += 1) {
      await writeText(fixture.source.root, 'push.txt', `v${index}\n`);
      await fixture.source.git(['add', '.']);
      await fixture.source.git(['commit', '-m', `v${index}`]);
      await publisher.publish({
        remote: 'origin',
        localRef: 'refs/heads/main',
        remoteBranch: 'main',
        sessionId: 'sess',
      }, async () => {
        asks += 1;
        return true;
      });
    }
    assert.equal(asks, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('publisher pushes a normal branch after exact confirmation and audits it', async () => {
  const fixture = await makePublishFixture();
  try {
    await writeText(fixture.source.root, 'push.txt', 'published\n');
    await fixture.source.git(['add', '.']);
    await fixture.source.git(['commit', '-m', 'publish']);
    const localOid = (await fixture.source.git(['rev-parse', 'HEAD'])).stdout.toString().trim();
    const audit = new GitAuditLog(fixture.source.workspace);
    const publisher = new LocalGitPublisher(fixture.source.workspace, new GitProcess(fixture.source.workspace), audit);
    const result = await publisher.publish({
      remote: 'origin',
      localRef: 'refs/heads/main',
      remoteBranch: 'main',
      sessionId: 'sess',
    }, async () => true);
    assert.equal(result.ok, true);
    const remoteOid = (await git(fixture.remoteRoot, ['rev-parse', 'refs/heads/main'])).stdout.toString().trim();
    assert.equal(remoteOid, localOid);
    const events = await audit.read();
    assert.ok(events.events.some((event) => event.type === 'push_succeeded'));
  } finally {
    await fixture.cleanup();
  }
});

test('publisher rejects force deletion wildcard and checkpoint refspecs before confirmation', async () => {
  const fixture = await makePublishFixture();
  try {
    const publisher = new LocalGitPublisher(fixture.source.workspace, new GitProcess(fixture.source.workspace), new GitAuditLog(fixture.source.workspace));
    let asked = false;
    await assert.rejects(publisher.publish({
      remote: 'origin',
      localRef: 'refs/aicode/checkpoints/unit_1/baseline',
      remoteBranch: 'main',
      sessionId: 'sess',
    }, async () => {
      asked = true;
      return true;
    }));
    await assert.rejects(publisher.publish({
      remote: 'origin',
      localRef: 'refs/heads/main',
      remoteBranch: '*',
      sessionId: 'sess',
    }, async () => {
      asked = true;
      return true;
    }));
    assert.equal(asked, false);
  } finally {
    await fixture.cleanup();
  }
});

test('command policy rejects mutating git branch forms', () => {
  assert.equal(isAutoAllowedCommand('git branch new-feature'), false);
  assert.equal(isAutoAllowedCommand('git branch -D old'), false);
  assert.equal(isAutoAllowedCommand('git branch --list'), true);
});

test('command policy rejects destructive git commands with executable suffixes and global options', () => {
  assert.equal(isBlockedCommand('git.exe reset --hard'), true);
  assert.equal(isBlockedCommand('git -c foo=bar reset --hard HEAD'), true);
  assert.equal(isBlockedCommand('git clean -fdx'), true);
});

test('command policy never auto-allows git push', () => {
  assert.equal(isAutoAllowedCommand('git push origin main'), false);
  const decision = decideApproval({
    mode: 'auto',
    risk: 'shell',
    command: 'git push origin main',
    workspaceRoot: resolve('.'),
  });
  assert.equal(decision.allowed, false);
});
