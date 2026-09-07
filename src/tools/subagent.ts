/**
 * spawn_subagent — run a focused sub-agent in-process.
 *
 * The main agent can call this tool to delegate a self-contained sub-task.
 * Up to MAX_SUBAGENT_DEPTH (3) levels of nesting are allowed; deeper calls
 * are refused to prevent runaway recursion.
 *
 * When readonly:true the sub-agent only sees read-risk tools, making it safe
 * to use for analysis and research tasks without write permissions.
 *
 * The sub-agent shares the parent's provider, workspace, approval callback,
 * and session directory; it runs in the same process (no extra bridge spawn).
 */

import type { ToolDefinition, ToolContext, SubAgentOptions } from './types.js';

export const MAX_SUBAGENT_DEPTH = 3;

type SpawnSubAgentInput = {
  goal: string;
  readonly: boolean;
  maxSteps: number;
  label: string;
};

export const spawnSubAgentTool: ToolDefinition<SpawnSubAgentInput> = {
  name: 'spawn_subagent',
  description:
    'Spawn an in-process sub-agent to handle a focused sub-task in parallel or sequentially. ' +
    'Use readonly:true for analysis/research (no file writes). ' +
    'Use label to identify the sub-agent in logs. ' +
    'Returns the sub-agent\'s final answer as a string. ' +
    'Max nesting depth: ' + MAX_SUBAGENT_DEPTH + ' levels.',
  inputHint: '{ "goal": "analyze the test coverage of src/", "readonly": true, "maxSteps": 20, "label": "coverage-analyzer" }',
  risk: 'read',

  validate(input: unknown): SpawnSubAgentInput {
    if (!input || typeof input !== 'object') {
      throw new Error('spawn_subagent input must be an object');
    }
    const obj = input as Record<string, unknown>;
    if (typeof obj.goal !== 'string' || !obj.goal.trim()) {
      throw new Error('spawn_subagent: goal (string) is required');
    }
    return {
      goal: String(obj.goal).trim(),
      readonly: obj.readonly === true,
      maxSteps: typeof obj.maxSteps === 'number' && obj.maxSteps > 0
        ? Math.min(Math.floor(obj.maxSteps), 50)
        : 20,
      label: typeof obj.label === 'string' && obj.label.trim()
        ? obj.label.trim()
        : 'subagent',
    };
  },

  async execute(input: SpawnSubAgentInput, context: ToolContext): Promise<{ ok: boolean; output: string }> {
    if (!context.subAgentRunner) {
      return {
        ok: false,
        output: 'spawn_subagent is not available: no subAgentRunner injected in this context. ' +
                'This tool requires the agent runtime to provide a subAgentRunner.',
      };
    }

    const opts: SubAgentOptions = {
      readonly: input.readonly,
      maxSteps: input.maxSteps,
    };

    try {
      const result = await context.subAgentRunner(input.goal, opts);
      return {
        ok: true,
        output: `[sub-agent:${input.label}] ${result}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: `[sub-agent:${input.label}] Failed: ${msg}`,
      };
    }
  },
};
