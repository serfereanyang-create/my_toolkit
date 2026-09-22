import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DELEGATION_LEVEL, delegationHint } from '../src/agent/toolStrategy.js';
import { delegationLevelOf, loadConfig } from '../src/config/config.js';
import { parseArgs } from '../src/cli/args.js';
import { buildToolSystemPromptParts } from '../src/providers/protocol.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Sub-agent delegation eagerness.
 *
 * The tool has no framework gate — spawn_subagent is injected into every root
 * turn — so the ONLY thing deciding whether delegation happens is which
 * delegation block sits in the system prompt. These tests pin that the level
 * actually reaches that block, because a level that parses correctly and is
 * then dropped on the way to the prompt looks identical to a working feature.
 */

async function configWith(args: Parameters<typeof loadConfig>[0], env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-delegation-'));
  try {
    return await loadConfig({ ...args, workspace: dir }, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the default level is eager', async () => {
  const config = await configWith({});
  assert.equal(config.delegation, 'eager');
  assert.equal(DEFAULT_DELEGATION_LEVEL, 'eager');
});

test('--delegation accepts the three levels and rejects anything else', () => {
  for (const level of ['off', 'balanced', 'eager'] as const) {
    assert.equal(parseArgs(['--delegation', level]).delegation, level);
  }
  // A typo must not silently pick a level: 'eager' spends real money per turn
  // and 'off' silently disables the feature.
  assert.throws(() => parseArgs(['--delegation', 'aggressive']), /--delegation must be one of/);
  assert.throws(() => parseArgs(['--delegation', 'EAGER']), /--delegation must be one of/);
  // A missing value is caught earlier, by the arg reader — still a refusal,
  // which is the property that matters.
  assert.throws(() => parseArgs(['--delegation']), /Missing value for --delegation/);
  assert.throws(() => parseArgs(['--delegation', '']), /Missing value for --delegation/);
});

test('the precedence chain is args > env > file > default', async () => {
  const viaEnv = await configWith({}, { AICODE_DELEGATION: 'balanced' });
  assert.equal(viaEnv.delegation, 'balanced');

  const viaArgs = await configWith({ delegation: 'off' }, { AICODE_DELEGATION: 'balanced' });
  assert.equal(viaArgs.delegation, 'off', 'an explicit flag wins over the environment');
});

test('an unrecognized env value is unset, not a level', async () => {
  for (const raw of ['aggressive', 'EAGER', '1', 'true', '']) {
    const config = await configWith({}, { AICODE_DELEGATION: raw });
    assert.equal(config.delegation, 'eager', `${JSON.stringify(raw)} must fall back to the default`);
  }
  // Case-insensitive on a legitimate value, so a shell convention does not fail.
  assert.equal((await configWith({}, { AICODE_DELEGATION: 'OFF' })).delegation, 'off');
});

test('delegationLevelOf applies the default for an absent field', () => {
  // An AppConfig built by hand (tests, embedding, an older settings file) must
  // not read as "off" just because the field is missing.
  assert.equal(delegationLevelOf({}), 'eager');
  assert.equal(delegationLevelOf({ delegation: undefined }), 'eager');
  assert.equal(delegationLevelOf({ delegation: 'off' }), 'off');
});

test('each level produces a different delegation block', () => {
  const eager = delegationHint('eager');
  const balanced = delegationHint('balanced');
  const off = delegationHint('off');
  assert.notEqual(eager, balanced);
  assert.notEqual(balanced, off);
  assert.notEqual(eager, off);
});

test('off tells the agent not to delegate', () => {
  const off = delegationHint('off');
  assert.match(off, /不要派子智能体/);
  // It must not also carry the "when to delegate" scenarios, or the block
  // contradicts itself and the model picks whichever it reads first.
  assert.doesNotMatch(off, /适合委派的场景/);
  assert.doesNotMatch(off, /默认委派/);
});

test('eager makes delegation the default and lowers the bar', () => {
  const eager = delegationHint('eager');
  assert.match(eager, /默认委派/);
  // The old bar was "2 个或以上相互独立的子目标"; eager must not keep it, or a
  // single-part request still reads as not worth delegating.
  assert.doesNotMatch(eager, /2 个或以上/);
  assert.match(eager, /只要请求里存在任何一个可以独立完成的部分/);
});

test('eager keeps writes on the main agent', () => {
  // The security property of this feature. runSubAgent hardcodes every approval
  // to true, so a write performed by a sub-agent is a write the user never
  // confirms. Eager delegation is only safe while it delegates investigation
  // and leaves the edits to the agent whose writes surface in an approval card.
  const eager = delegationHint('eager');
  assert.match(eager, /写操作留在你自己手里/);
  assert.match(eager, /不弹确认框/);
  assert.match(eager, /由你自己调用工具完成/);
  // It must name the writable experts as off-limits, not just describe the rule.
  for (const expert of ['code_edit', 'git_ops', 'shell_runtime']) {
    assert.ok(eager.includes(expert), `eager must name ${expert} as not-to-delegate`);
  }
});

test('every level keeps the shared mechanics', () => {
  // The expert roster and dependsOn rules are level-independent: a level may
  // change the policy, never the mechanics.
  for (const level of ['balanced', 'eager'] as const) {
    const hint = delegationHint(level);
    assert.match(hint, /expert 角色选择指南/);
    assert.match(hint, /dependsOn 使用规则/);
    assert.match(hint, /code_search/);
  }
});

test('the level reaches the system prompt', () => {
  const blockFor = (level: 'off' | 'balanced' | 'eager' | undefined) =>
    buildToolSystemPromptParts([], undefined, undefined, { delegation: level }).stable;

  assert.match(blockFor('eager'), /默认委派/);
  assert.match(blockFor('balanced'), /适合委派的场景/);
  assert.match(blockFor('off'), /不要派子智能体/);
  // Absent identity — a caller that never heard of this setting — gets the
  // documented default, not the old behaviour.
  assert.equal(blockFor(undefined), blockFor('eager'));
});

test('the delegation block is byte-stable for a fixed level', () => {
  // It lives in the STABLE system prompt, inside the cached prefix. A block that
  // varied per call would invalidate the cache from byte 0 on every turn — the
  // exact failure this repo has hit before (see tools/scope.ts).
  for (const level of ['off', 'balanced', 'eager'] as const) {
    const first = buildToolSystemPromptParts([], undefined, undefined, { delegation: level }).stable;
    const second = buildToolSystemPromptParts([], undefined, undefined, { delegation: level }).stable;
    assert.equal(first, second, `${level} must be deterministic`);
  }
});

test('changing the level changes the prefix, as documented', () => {
  // The flip side, asserted so the cost is explicit rather than discovered:
  // switching level invalidates the cache once, exactly like switching scope.
  const eager = buildToolSystemPromptParts([], undefined, undefined, { delegation: 'eager' }).stable;
  const off = buildToolSystemPromptParts([], undefined, undefined, { delegation: 'off' }).stable;
  assert.notEqual(eager, off);
});

test('the config file can set the level', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-delegation-file-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'config.json'), JSON.stringify({ delegation: 'balanced' }));
    const config = await loadConfig({ configPath: join(dir, 'config.json'), workspace: dir }, {});
    assert.equal(config.delegation, 'balanced');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid level in the config file is ignored, not propagated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-delegation-bad-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'config.json'), JSON.stringify({ delegation: 'aggressive' }));
    const config = await loadConfig({ configPath: join(dir, 'config.json'), workspace: dir }, {});
    assert.equal(config.delegation, 'eager');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
