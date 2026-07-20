import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import { loadConfig } from '../src/config/config.js';
import { buildToolSystemPrompt } from '../src/providers/protocol.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { formatProjectContext, readProjectContext } from '../src/agent/context.js';

test('git tools are registered as read-only tools', () => {
  const registry = createDefaultToolRegistry();

  assert.equal(registry.get('git_status')?.risk, 'read');
  assert.equal(registry.get('git_diff')?.risk, 'read');
  assert.equal(registry.get('git_log')?.risk, 'read');
});

test('project context reads instruction files for provider prompts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-context-'));
  await writeFile(join(workspace, 'AGENTS.md'), 'Use short direct answers.');
  await writeFile(join(workspace, 'README.md'), '# Demo Project');

  const context = await readProjectContext(workspace);
  const formatted = formatProjectContext(context);
  const prompt = buildToolSystemPrompt([], formatted);

  assert.match(formatted ?? '', /AGENTS.md/);
  assert.match(prompt, /Project context and instructions/);
  assert.match(prompt, /Use short direct answers/);

  await rm(workspace, { recursive: true, force: true });
});

test('slash commands summarize plan and export session path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-summary-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  const config = await loadConfig({ provider: 'mock', workspace }, {});
  const provider = createMockProvider(config.model);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  await sessions.appendMessage(session, { role: 'user', content: 'inspect project' });
  await sessions.appendToolCall(session, { tool: 'project_index', input: {}, ok: true, output: 'files: 1' });
  await sessions.appendFinalAnswer(session, 'done');
  const tools = createDefaultToolRegistry();

  const summary = await handleSlashCommand({ line: '/summary', config, provider, tools, sessions, session });
  const plan = await handleSlashCommand({ line: '/plan', config, provider, tools, sessions, session });
  const exported = await handleSlashCommand({ line: '/export', config, provider, tools, sessions, session });

  assert.match(summary, /tool calls: 1/);
  assert.match(plan, /done project_index/);
  assert.match(exported, new RegExp(`${session.id}\\.json$`));

  await rm(workspace, { recursive: true, force: true });
});
