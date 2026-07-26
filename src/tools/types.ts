import type { ApprovalMode, ProviderToolSpec } from '../providers/types.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { HookRegistry } from '../hooks/hooks.js';
import type { ToolRisk } from '../safety/policy.js';
import type { Locale } from '../i18n/locale.js';

export type ApprovalRequest = {
  tool: string;
  risk: ToolRisk;
  input: Record<string, unknown>;
  reason: string;
  message: string;
};

/**
 * Approval callback result.
 * - `true` / `false` accept or deny the current call.
 * - `'allow_session'` is treated as truthy by the registry; UI brokers
 *   (e.g. desktop bridge) may cache the decision for the rest of the session.
 */
export type ApprovalDecision = boolean | 'allow_session';

export type ToolContext = {
  workspaceRoot: string;
  approval: ApprovalMode;
  confirm?: (message: string, request?: ApprovalRequest) => Promise<ApprovalDecision>;
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
