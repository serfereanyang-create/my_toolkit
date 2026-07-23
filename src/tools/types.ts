import type { ApprovalMode, ProviderToolSpec } from '../providers/types.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { HookRegistry } from '../hooks/hooks.js';
import type { ToolRisk } from '../safety/policy.js';
import type { Locale } from '../i18n/locale.js';

export type ToolContext = {
  workspaceRoot: string;
  approval: ApprovalMode;
  confirm?: (message: string) => Promise<boolean>;
  checkpoints?: CheckpointStore;
  hooks?: HookRegistry;
  beforeConfirm?: () => void;
  afterConfirm?: () => void;
  /** UI language for approval prompts and tool gate messages. */
  locale?: Locale;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  data?: unknown;
};

export type ToolDefinition<TInput = unknown> = {
  name: string;
  description: string;
  inputHint: string;
  risk: ToolRisk;
  validate(input: unknown): TInput;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
};

export function toolToProviderSpec(tool: ToolDefinition): ProviderToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputHint: tool.inputHint,
    risk: tool.risk,
  };
}
