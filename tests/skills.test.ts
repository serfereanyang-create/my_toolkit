import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMarkdown } from '../src/skills/types.js';
import { scanSkills, findSkillByName } from '../src/skills/loader.js';
import { matchSkills, buildSkillBlock } from '../src/skills/matcher.js';

const RELEASE_SKILL = `---
name: release-checklist
description: 发布前检查清单，覆盖测试、版本号与变更日志
triggers: 发布, release, 上线
---

发布前必须完成：
1. 全量测试通过
2. 更新 CHANGELOG
3. 版本号一致
`;

const RAW_SKILL = '# 部署指南\n\n先构建，再上传。';

test('parseSkillMarkdown extracts frontmatter fields', () => {
  const parsed = parseSkillMarkdown(RELEASE_SKILL, 'fallback', '/tmp/SKILL.md');
  assert.ok(!('error' in parsed));
  assert.equal(parsed.name, 'release-checklist');
  assert.ok(parsed.description.includes('发布前检查清单'));
  assert.deepEqual(parsed.triggers, ['发布', 'release', '上线']);
  assert.ok(parsed.instructions.includes('全量测试通过'));
});

test('parseSkillMarkdown without frontmatter uses body as instructions', () => {
  const parsed = parseSkillMarkdown(RAW_SKILL, 'deploy', '/tmp/SKILL.md');
  assert.ok(!('error' in parsed));
  assert.equal(parsed.name, 'deploy');
  assert.equal(parsed.triggers.length, 0);
  assert.ok(parsed.instructions.startsWith('# 部署指南'));
});

test('parseSkillMarkdown reports empty content as error', () => {
  const parsed = parseSkillMarkdown('   ', 'empty', '/tmp/SKILL.md');
  assert.ok('error' in parsed);
});

test('scanSkills loads skills and reports broken ones honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-'));
  try {
    await mkdir(join(root, '.aicode', 'skills', 'release-checklist'), { recursive: true });
    await writeFile(join(root, '.aicode', 'skills', 'release-checklist', 'SKILL.md'), RELEASE_SKILL, 'utf-8');
    await mkdir(join(root, '.aicode', 'skills', 'broken'), { recursive: true });
    await writeFile(join(root, '.aicode', 'skills', 'broken', 'SKILL.md'), '', 'utf-8');
    // 无 SKILL.md 的目录应被跳过
    await mkdir(join(root, '.aicode', 'skills', 'no-file'), { recursive: true });

    const { skills, errors } = await scanSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, 'release-checklist');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.path, /broken/);

    const found = await findSkillByName(root, 'RELEASE-checklist');
    assert.ok(found);
    assert.equal(await findSkillByName(root, 'nope'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('matchSkills ranks trigger hits above description hits', () => {
  const release = parseSkillMarkdown(RELEASE_SKILL, 'release-checklist', '/tmp') as { name: string };
  const deploy = parseSkillMarkdown(RAW_SKILL, 'deploy', '/tmp') as { name: string };
  assert.ok(!('error' in release) && !('error' in deploy));

  const skills = [
    { name: 'release-checklist', description: '发布前检查清单，覆盖测试、版本号与变更日志', triggers: ['发布', 'release', '上线'], instructions: 'x', sourcePath: '' },
    { name: 'deploy', description: '部署指南 构建 上传', triggers: [], instructions: 'y', sourcePath: '' },
  ];
  const matches = matchSkills('帮我准备 release 上线流程', skills);
  assert.equal(matches[0]!.skill.name, 'release-checklist');
  assert.ok(matches[0]!.score >= 10);

  const none = matchSkills('写一个斐波那契函数', skills);
  assert.equal(none.length, 0);

  const block = buildSkillBlock(matches);
  assert.ok(block.startsWith('<relevant-skills>'));
  assert.ok(block.includes('release-checklist'));
});
