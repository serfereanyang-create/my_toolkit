import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import { loadConfig, requireProviderAuth, safeConfig } from '../src/config/config.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('loadConfig applies config profiles with CLI and env precedence', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-config-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  const configPath = join(workspace, '.aicode', 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      defaultProfile: 'local',
      profiles: {
        local: { provider: 'mock', model: 'file-model', approval: 'deny', sessionDir: '.sessions', maxSteps: 5, apiKey: 'file-secret' },
      },
    }),
  );

  const config = await loadConfig({ workspace, model: 'cli-model' }, { AICODE_APPROVAL: 'auto', MOCK_MODEL: 'env-model' });

  assert.equal(config.provider, 'mock');
  assert.equal(config.model, 'cli-model');
  assert.equal(config.approval, 'auto');
  assert.equal(config.sessionDir, join(workspace, '.sessions'));
  assert.equal(config.maxSteps, 5);
  assert.equal(config.apiKey, 'file-secret');
  assert.equal(config.profile, 'local');
  assert.equal(config.configPath, configPath);

  await rm(workspace, { recursive: true, force: true });
});

test('safeConfig redacts API keys', async () => {
  const config = await loadConfig({ provider: 'mock' }, { MOCK_API_KEY: 'abcd1234secret' });
  const safe = safeConfig(config);

  assert.equal(safe.apiKey, 'abcd...cret');
  assert.doesNotMatch(JSON.stringify(safe), /1234se/);
});

test('requireProviderAuth rejects missing hosted provider key', async () => {
  const config = await loadConfig({ provider: 'openai' }, { AICODE_OPENAI_BASE_URL: 'http://localhost/v1' });

  assert.throws(() => requireProviderAuth(config), /OPENAI_API_KEY is required/);
});

test('/config slash command shows redacted effective config', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-config-command-'));
  const config = await loadConfig({ provider: 'mock', workspace }, { MOCK_API_KEY: 'abcd1234secret' });
  const provider = createMockProvider(config.model);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  const output = await handleSlashCommand({ line: '/config', config, provider, tools: createDefaultToolRegistry(), sessions, session });

  assert.match(output, /abcd\.\.\.cret/);
  assert.doesNotMatch(output, /abcd1234secret/);

  await rm(workspace, { recursive: true, force: true });
});

test('gemini reads its documented environment variables', async () => {
  // Before: apiKeyFromEnv fell through to MOCK_API_KEY, so the provider threw
  // "GEMINI_API_KEY is required" on every call and requireProviderAuth agreed.
  const config = await loadConfig(
    { provider: 'gemini' },
    { GEMINI_API_KEY: 'gemini-test-key-123', GEMINI_MODEL: 'gemini-test-model', GEMINI_BASE_URL: 'http://localhost:9/v1beta' },
  );
  assert.equal(config.apiKey, 'gemini-test-key-123');
  assert.equal(config.model, 'gemini-test-model');
  assert.equal(config.baseUrl, 'http://localhost:9/v1beta');
  assert.doesNotThrow(() => requireProviderAuth(config));
  // safeConfig still redacts it.
  assert.equal(safeConfig(config).apiKey, 'gemi...-123');
});

test('a configured gemini key does not leak into an unconfigured provider', async () => {
  const config = await loadConfig({ provider: 'mock' }, { GEMINI_API_KEY: 'gemini-test-key-123' });
  assert.notEqual(config.apiKey, 'gemini-test-key-123');
});
