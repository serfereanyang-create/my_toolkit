'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  parseCommandFile,
  generateCommandFileContent,
  createCommandsService,
} = require('../electron/commands.cjs');

test('parseCommandFile reads frontmatter and derives the slash name', () => {
  const content = `---
description: Review the current diff
argument-hint: [file]
unknown-key: keep me

Custom extra frontmatter line
---

You are reviewing {{file}}. Be thorough.
`;
  const parsed = parseCommandFile(content, 'C:\\cmds\\review.md');
  assert.equal(parsed.name, '/review');
  assert.equal(parsed.description, 'Review the current diff');
  assert.equal(parsed.argumentHint, '[file]');
  assert.equal(parsed.prompt, 'You are reviewing {{file}}. Be thorough.');
});

test('multiline frontmatter values are joined', () => {
  const content = '---\ndescription: line one\n  line two\n---\n\nbody\n';
  const parsed = parseCommandFile(content, 'multi.md');
  assert.equal(parsed.description, 'line one line two');
});

test('generateCommandFileContent preserves unknown keys and replaces known ones', () => {
  const existing = '---\nunknown-key: keep\ndescription: old\n---\n\nold body\n';
  const generated = generateCommandFileContent({ prompt: 'new body', description: 'new desc' }, existing);
  assert.ok(generated.includes('unknown-key: keep'));
  assert.ok(!generated.includes('description: old'));
  assert.ok(generated.includes('description: new desc'));
  assert.ok(generated.endsWith('new body'));
});

test('service lists user+workspace commands with workspace priority', async () => {
  const userDir = await mkdtemp(join(tmpdir(), 'cmds-user-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'cmds-ws-'));
  const service = createCommandsService({ userCommandsDir: userDir, workspaceCommandsDir: wsDir });
  try {
    await writeFile(join(userDir, 'deploy.md'), '---\ndescription: user version\n---\n\nuser prompt\n');
    await writeFile(join(userDir, 'local.md'), 'user only\n');
    await mkdir(join(wsDir, 'git'), { recursive: true });
    await writeFile(join(wsDir, 'git', 'undo.md'), 'workspace undo\n');
    await writeFile(join(wsDir, 'deploy.md'), '---\ndescription: workspace version\n---\n\nworkspace prompt\n');

    const commands = await service.listCommands();
    const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
    assert.deepEqual(commands.map((c) => c.name).sort(), ['/deploy', '/git/undo', '/local']);
    assert.equal(byName['/deploy'].scope, 'workspace');
    assert.equal(byName['/deploy'].description, 'workspace version');
    assert.equal(byName['/local'].scope, 'user');
    assert.equal(byName['/git/undo'].prompt, 'workspace undo');
  } finally {
    await rm(userDir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test('save and delete round-trip with namespaced names', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'cmds-save-'));
  const service = createCommandsService({ userCommandsDir: wsDir, workspaceCommandsDir: wsDir });
  try {
    await service.saveCommand({ name: '/git/squash', prompt: 'squash it', description: 'desc', argumentHint: '[n]' });
    const saved = await readFile(join(wsDir, 'git', 'squash.md'), 'utf-8');
    assert.ok(saved.includes('description: desc'));
    assert.ok(saved.includes('argument-hint: [n]'));
    const parsed = parseCommandFile(saved, join(wsDir, 'git', 'squash.md'));
    assert.equal(parsed.prompt, 'squash it');

    await assert.rejects(() => service.saveCommand({ name: 'no-slash', prompt: 'x' }), /Invalid command name/);

    await service.deleteCommand({ name: '/git/squash' });
    const commands = await service.listCommands();
    assert.ok(!commands.some((c) => c.name === '/git/squash'));
  } finally {
    await rm(wsDir, { recursive: true, force: true });
  }
});
