const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildPersonaMarkdown, syncPersonaFile } = require('../electron/persona.cjs');

test('buildPersonaMarkdown omits personalize block when persona disabled', () => {
  const md = buildPersonaMarkdown({ personaEnabled: false, personaNickname: '小明' });
  assert.doesNotMatch(md, /小明/);
  // Git defaults still inject so agent git/PR behavior stays configured.
  assert.match(md, /Git 工作流偏好/);
});

test('buildPersonaMarkdown still emits git defaults with empty prefs', () => {
  const md = buildPersonaMarkdown({});
  assert.match(md, /Git 工作流偏好/);
  assert.match(md, /codex\//);
  assert.match(md, /草稿/);
});

test('buildPersonaMarkdown includes nickname, role, tone, verbosity, instructions', () => {
  const md = buildPersonaMarkdown({
    personaNickname: '小明',
    personaRole: '前端工程师',
    personaTone: 'concise',
    personaVerbosity: 'high',
    personaInstructions: '回答请使用中文',
  });
  assert.match(md, /小明/);
  assert.match(md, /前端工程师/);
  assert.match(md, /简洁/);
  assert.match(md, /详尽/);
  assert.match(md, /回答请使用中文/);
  assert.match(md, /用户个性化设置/);
});

test('buildPersonaMarkdown reads dotted persona keys from the settings UI', () => {
  const md = buildPersonaMarkdown({
    'persona.nickname': '阿强',
    'persona.role': '后端',
    'persona.tone': 'formal',
    'persona.verbosity': 'low',
    'persona.instructions': '用中文',
    'persona.enabled': true,
  });
  assert.match(md, /阿强/);
  assert.match(md, /后端/);
  assert.match(md, /正式/);
  assert.match(md, /精简/);
  assert.match(md, /用中文/);
});

test('buildPersonaMarkdown injects git prefs and guides', () => {
  const md = buildPersonaMarkdown({
    gitBranchPrefix: 'yoy/',
    gitMergeMethod: 'squash',
    gitForcePush: true,
    gitDraftPr: false,
    gitReviewMode: 'separate',
    gitCommitGuide: '用英文 conventional commits',
    gitPrGuide: '标题写清楚影响面',
  });
  assert.match(md, /yoy\//);
  assert.match(md, /squash/);
  assert.match(md, /force-with-lease/);
  assert.match(md, /正式（非草稿）/);
  assert.match(md, /单独的审查/);
  assert.match(md, /用英文 conventional commits/);
  assert.match(md, /标题写清楚影响面/);
});

test('syncPersonaFile writes .aicode/persona.md when content present', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-persona-'));
  const result = await syncPersonaFile(root, { personaNickname: '小明' });
  assert.equal(result.written, true);
  const content = await readFile(path.join(root, '.aicode', 'persona.md'), 'utf8');
  assert.match(content, /小明/);
  assert.match(content, /Git 工作流偏好/);
  await rm(root, { recursive: true, force: true });
});

test('syncPersonaFile still writes git defaults when persona is disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-persona-'));
  await syncPersonaFile(root, { personaNickname: '小明' });
  const result = await syncPersonaFile(root, { personaEnabled: false });
  assert.equal(result.written, true);
  const content = await readFile(path.join(root, '.aicode', 'persona.md'), 'utf8');
  assert.doesNotMatch(content, /小明/);
  assert.match(content, /Git 工作流偏好/);
  await rm(root, { recursive: true, force: true });
});

test('syncPersonaFile is a no-op with no workspace root', async () => {
  const result = await syncPersonaFile('', { personaNickname: '小明' });
  assert.equal(result.written, false);
});
