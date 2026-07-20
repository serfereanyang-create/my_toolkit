import type { ToolResult } from '../tools/types.js';

export type HookEvent = {
  tool: string;
  input?: unknown;
  result?: ToolResult;
  error?: unknown;
};

export type HookRegistry = {
  beforeTool(event: HookEvent): Promise<void>;
  afterTool(event: HookEvent): Promise<void>;
  onError(event: HookEvent): Promise<void>;
};

export function createNoopHooks(): HookRegistry {
  return {
    async beforeTool() {},
    async afterTool() {},
    async onError() {},
  };
}
