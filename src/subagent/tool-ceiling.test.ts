import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { subAgentToolCeiling } from './runner.js';
import { ToolRegistry } from '../tools/registry.js';
import { selectScopedTools } from '../tools/scope.js';
import { createDefaultToolRegistry } from '../tools/index.js';

const names = (registry: ToolRegistry) => registry.list().map((tool) => tool.name);

/**
 * The sub-agent tool ceiling.
 *
 * The bug this guards: the child used to draw from `allTools` (the whole
 * registry) filtered only by the expert profile. `spawn_subagent` chooses the
 * expert by goal when the caller does not name one, and `general` is
 * `toolFilter: () => true` with `toolScopeOverride: 'full'` — so a parent in
 * `standard` could delegate and hand the child tools the parent itself is not
 * allowed to see. Nothing about that is visible in the parent's tool list, which
 * is what made it a hole rather than a trade-off.
 */
describe('sub-agent tool ceiling', () => {
  it('stops at the parent scope instead of the whole registry', () => {
    const allTools = createDefaultToolRegistry();
    const scoped = ToolRegistry.fromTools(selectScopedTools(allTools, 'standard'));
    const ceiling = subAgentToolCeiling({ tools: scoped, allTools, resolvedToolScope: 'standard' });

    const passed = names(ceiling);
    // The parent in standard cannot see these, so neither may the child.
    for (const denied of ['delete_path', 'git_init']) {
      assert.ok(!names(scoped).includes(denied), `fixture assumption: standard must not expose ${denied}`);
      assert.ok(!passed.includes(denied), `${denied} leaked past the parent scope`);
    }
    // And everything the parent can call is still reachable, so delegation keeps
    // working: the ceiling narrows, it does not gut the child.
    assert.deepEqual(passed.sort(), names(scoped).sort());
  });

  it('lets a full-scope parent delegate everything it already has', () => {
    const allTools = createDefaultToolRegistry();
    const ceiling = subAgentToolCeiling({ tools: allTools, allTools, resolvedToolScope: 'full' });
    assert.deepEqual(names(ceiling).sort(), names(allTools).sort());
  });

  it('falls back to allTools only while no scope has been resolved', () => {
    // Embedding callers and tests build runtimes by hand; there is no parent
    // scope to inherit yet, so the old behaviour is the only useful one.
    const allTools = createDefaultToolRegistry();
    const ceiling = subAgentToolCeiling({ tools: new ToolRegistry(), allTools, resolvedToolScope: undefined });
    expect(names(ceiling).length).toBe(names(allTools).length);
  });
});
