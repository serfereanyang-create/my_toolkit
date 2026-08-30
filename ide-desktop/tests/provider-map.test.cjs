const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cliProviderName, resolveBaseUrl, apiKeyEnvVar, OFFICIAL_OPENAI_BASE_URL } = require('../electron/provider-map.cjs');

test('cliProviderName maps built-in types', () => {
  assert.equal(cliProviderName({ type: 'mock' }), 'mock');
  assert.equal(cliProviderName({ type: 'openai' }), 'openai');
  assert.equal(cliProviderName({ type: 'anthropic' }), 'anthropic');
});

test('cliProviderName maps custom providers by apiFormat', () => {
  assert.equal(cliProviderName({ type: 'custom', apiFormat: 'anthropic' }), 'anthropic');
  assert.equal(cliProviderName({ type: 'custom', apiFormat: 'openai' }), 'openai');
  // Missing apiFormat defaults to openai wire format.
  assert.equal(cliProviderName({ type: 'custom' }), 'openai');
});

test('resolveBaseUrl forces official OpenAI endpoint only for empty built-in openai', () => {
  assert.equal(resolveBaseUrl({ type: 'openai', baseUrl: '' }), OFFICIAL_OPENAI_BASE_URL);
  assert.equal(resolveBaseUrl({ type: 'openai', baseUrl: '   ' }), OFFICIAL_OPENAI_BASE_URL);
  // A configured base URL is respected.
  assert.equal(resolveBaseUrl({ type: 'openai', baseUrl: 'https://proxy.example/v1' }), 'https://proxy.example/v1');
});

test('resolveBaseUrl passes custom provider base URL through unchanged', () => {
  assert.equal(resolveBaseUrl({ type: 'custom', apiFormat: 'anthropic', baseUrl: 'https://yunqiaoai.example' }), 'https://yunqiaoai.example');
  // A custom provider with an empty base URL is NOT forced to the OpenAI URL.
  assert.equal(resolveBaseUrl({ type: 'custom', apiFormat: 'anthropic', baseUrl: '' }), '');
});

test('apiKeyEnvVar picks the right env var per wire format', () => {
  assert.equal(apiKeyEnvVar('openai'), 'OPENAI_API_KEY');
  assert.equal(apiKeyEnvVar('anthropic'), 'ANTHROPIC_API_KEY');
  assert.equal(apiKeyEnvVar('mock'), null);
});

test('custom anthropic-format provider resolves to anthropic key env end-to-end', () => {
  const provider = { type: 'custom', apiFormat: 'anthropic', baseUrl: 'https://custom.example' };
  const cli = cliProviderName(provider);
  assert.equal(cli, 'anthropic');
  assert.equal(apiKeyEnvVar(cli), 'ANTHROPIC_API_KEY');
  assert.equal(resolveBaseUrl(provider), 'https://custom.example');
});
