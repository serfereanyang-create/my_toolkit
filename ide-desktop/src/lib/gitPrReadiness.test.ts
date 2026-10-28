import { describe, expect, it } from 'vitest';
import { canCreatePullRequest } from './gitPrReadiness';

describe('pull request readiness', () => {
  it('requires a configured non-local remote', () => {
    expect(canCreatePullRequest([])).toBe(false);
    expect(canCreatePullRequest(['.'])).toBe(false);
    expect(canCreatePullRequest(['origin'])).toBe(true);
  });
});
