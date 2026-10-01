import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveTiers, describeTier } from '../src/dispatch/tierRouter.js';

/** The user's real v2 config; skip the integration test when it is absent. */
const V2 = join(homedir(), '.zcode', 'v2', 'config.json');
const hasV2 = existsSync(V2);

test('resolving a tier returns provider, model and context window', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ expensive: 'GLM-5.3', cheap: 'GLM-5.3-Flash' }, V2);
  assert.ok(!('error' in tiers), 'real config resolves');
  const { expensive, cheap } = tiers as Exclude<typeof tiers, { error: string }>;
  // Case comes from the credentialed config entry, not from how the user
  // typed it: the API expects the provider's own spelling of the model id.
  assert.equal(expensive.model.toLowerCase(), 'glm-5.3');
  assert.equal(cheap.model.toLowerCase(), 'glm-5.3-flash');
  // Both live on the same vendor here, but each carries its own credentials.
  assert.ok(expensive.providerName);
  assert.ok(expensive.apiKey, 'resolved tier carries the API key for dispatch');
  assert.ok(expensive.baseUrl);
  assert.ok((expensive.contextWindow ?? 0) > 0, 'context window comes from the model table');
  assert.match(describeTier(cheap), /GLM-5\.3-Flash$/);
});

test('an unknown model is reported instead of silently resolving', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ expensive: 'GLM-5.3', cheap: 'definitely-not-a-model-xyz' }, V2);
  assert.ok('error' in tiers, 'unmatched cheap model must surface an error');
  assert.match((tiers as { error: string }).error, /definitely-not-a-model-xyz/);
});

test('a missing config file is an error, not a crash', () => {
  const tiers = resolveTiers({ expensive: 'a', cheap: 'b' }, join(homedir(), '.zcode', 'v2', 'nope.json'));
  assert.ok('error' in tiers);
});

test('the two tiers must differ, or the dispatch saves nothing', { skip: !hasV2 }, () => {
  const tiers = resolveTiers({ expensive: 'GLM-5.3', cheap: 'GLM-5.3' }, V2);
  assert.ok('error' in tiers, 'identical tiers defeat the purpose');
});

