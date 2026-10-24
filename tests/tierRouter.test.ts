import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveTierSelector, resolveTiers, describeTier, listTierOptions, TIER_ORDER } from '../src/dispatch/tierRouter.js';

const V2 = join(homedir(), '.zcode', 'v2', 'config.json');
const hasV2 = existsSync(V2);

test('a tier resolves to an ordered chain', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ expensive: 'GLM-5.3', cheap: 'GLM-5.3-Flash' });
  assert.ok(!('error' in tiers));
  assert.equal(tiers.expensive?.length, 1);
  const primary = tiers.expensive?.[0];
  assert.ok(primary);
  assert.equal(primary.model.toLowerCase(), 'glm-5.3');
  assert.ok(primary.apiKey, 'carries the key needed to dispatch');
  assert.ok(primary.baseUrl);
  assert.ok((primary.contextWindow ?? 0) > 0);
});

test('a list keeps order: primary first, then fallbacks', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ cheap: ['GLM-5.3-Flash', 'deepseek-v4.1-flash'] });
  assert.ok(!('error' in tiers));
  const chain = tiers.cheap;
  assert.ok(chain);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].model.toLowerCase(), 'glm-5.3-flash');
  assert.equal(chain[1].model.toLowerCase(), 'deepseek-v4.1-flash');
});

test('unconfigured tiers are simply absent', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ cheap: 'GLM-5.3-Flash' });
  assert.ok(!('error' in tiers));
  assert.equal(tiers.expensive, undefined);
  assert.equal(tiers.standard, undefined);
});

test('three tiers coexist', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({
    expensive: 'GLM-5.3',
    standard: 'GLM-5.3-Flash',
    cheap: 'deepseek-v4.1-flash',
  });
  assert.ok(!('error' in tiers));
  assert.equal(TIER_ORDER.filter((t) => tiers[t]).length, 3);
});

test('an empty selection is an error, not a silent no-op', () => {
  const tiers = resolveTiers({});
  assert.ok('error' in tiers);
});

test('an unknown model is reported instead of guessed', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ expensive: 'no-such-model-xyz' });
  assert.ok('error' in tiers);
});

test('describeTier names provider and model', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ cheap: 'GLM-5.3-Flash' });
  assert.ok(!('error' in tiers));
  const primary = tiers.cheap?.[0];
  assert.ok(primary);
  assert.match(describeTier(primary), /\/.+/);
});

test('whitespace and _ / . / - are interchangeable in selector matching', { skip: !hasV2 }, () => {
  const dashed = resolveTiers({ cheap: 'gpt-5.6-sol' });
  assert.ok(!('error' in dashed), 'the dashed form resolves');
  const spaced = resolveTiers({ cheap: 'gpt-5.6 sol' });
  assert.ok(!('error' in spaced), 'a real v2 id containing a space resolves');
  const underscored = resolveTiers({ cheap: 'gpt-5.6_sol' });
  assert.ok(!('error' in underscored), 'underscores normalise too');
});

test('a stale provider prefix refuses an ambiguous model match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tier-router-ambiguous-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    provider: {
      first: {
        name: 'First Relay',
        kind: 'openai-compatible',
        options: { baseURL: 'https://first.invalid/v1' },
        models: { shared: {} },
      },
      second: {
        name: 'Second Relay',
        kind: 'openai-compatible',
        options: { baseURL: 'https://second.invalid/v1' },
        models: { shared: {} },
      },
    },
  }), 'utf8');
  try {
    const stale = resolveTierSelector('old-desktop-label/shared', 'cheap', configPath);
    assert.ok('error' in stale);
    assert.match(stale.error, /多个提供商/);

    const explicit = resolveTierSelector('first/shared', 'cheap', configPath);
    assert.ok(!('error' in explicit));
    assert.equal(explicit.providerName, 'First Relay');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider IDs take priority over colliding display names and duplicate labels require disambiguation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tier-router-identity-'));
  const configPath = join(dir, 'config.json');
  const providers = {
    first: {
      name: 'second',
      options: { baseURL: 'https://first.invalid/v1' },
      models: { shared: {} },
    },
    second: {
      name: 'Second Relay',
      options: { baseURL: 'https://second.invalid/v1' },
      models: { shared: {} },
    },
    third: {
      name: 'Duplicate',
      options: { baseURL: 'https://third.invalid/v1' },
      models: { shared: {}, unique: {} },
    },
    fourth: {
      name: 'Duplicate',
      options: { baseURL: 'https://fourth.invalid/v1' },
      models: { shared: {} },
    },
  };
  writeFileSync(configPath, JSON.stringify({ provider: providers }), 'utf8');
  try {
    for (const option of listTierOptions(configPath)) {
      const resolved = resolveTierSelector(option.value, 'cheap', configPath);
      assert.ok(!('error' in resolved), option.value);
      assert.equal(resolved.baseUrl, providers[option.providerId as keyof typeof providers].options.baseURL, option.value);
    }
    for (const selector of ['Duplicate/shared', 'Duplicate/*']) {
      const ambiguous = resolveTierSelector(selector, 'cheap', configPath);
      assert.ok('error' in ambiguous, selector);
      assert.match(ambiguous.error, /多个提供商/);
    }
    const unique = resolveTierSelector('Duplicate/unique', 'cheap', configPath);
    assert.ok(!('error' in unique));
    assert.equal(unique.baseUrl, providers.third.options.baseURL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
