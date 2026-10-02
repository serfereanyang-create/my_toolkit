import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveTiers, describeTier, TIER_ORDER } from '../src/dispatch/tierRouter.js';

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
