import type { ApprovalMode, ProviderToolSpec } from '../providers/types.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { HookRegistry } from '../hooks/hooks.js';
import type { ToolRisk } from '../safety/policy.js';
import type { Locale } from '../i18n/locale.js';
import type { CommandJobService } from '../safety/commandJobs.js';

export type ApprovalRequest = {
  tool: string;
  risk: ToolRisk;
  input: Record<string, unknown>;
  reason: string;
  message: string;
  /** Structured before/after for write tools, computed pre-write. */
  diff?: { path: string; originalContent: string; modifiedContent: string };
};

/**
 * Approval callback result.
 * - `true` / `false` accept or deny the current call.
 * - `'allow_session'` is treated as truthy by the registry; UI brokers
 *   (e.g. desktop bridge) may cache the decision for the rest of the session.
 */
export type ApprovalDecision = boolean | 'allow_session';

export type SubAgentOptions = {
  /** Only register read-risk tools in the sub-agent. Default false. */
  readonly?: boolean;
  /** Max tool-call steps before the sub-agent is cut off. Default 20. */
  maxSteps?: number;
  /**
   * Dispatch tier for this sub-agent. Undefined inherits the parent model;
   * 'cheap' swaps in the tier router's cheap provider so a delegated
   * mechanical task costs less than running it on the main model.
   */
  tier?: 'expensive' | 'standard' | 'cheap';
};

export type ParallelSafety = 'safe' | 'unsafe';

export type ToolContext = {
  signal?: AbortSignal;
  workspaceRoot: string;
  approval: ApprovalMode;
  confirm?: (message: string, request?: ApprovalRequest) => Promise<ApprovalDecision>;
  checkpoints?: CheckpointStore;
  hooks?: HookRegistry;
  beforeConfirm?: () => void;
  afterConfirm?: () => void;
  /** UI language for approval prompts and tool gate messages. */
  locale?: Locale;
  /**
   * Allowed hostnames for `network`-risk tools. A network tool may only reach a
   * host on this list; anything else is denied before any request is made. An
   * empty or missing list means no network access is permitted.
   */
  networkAllowlist?: string[];
  /** Desktop "任意应用": auto mode may run any non-destructive shell command. */
  computerAnyApp?: boolean;
  /**
   * In-process background command service. It exposes job operations only;
   * process handles and pids are intentionally unavailable to tools.
   */
  commandJobs?: CommandJobService;
  /** Desktop "始终允许的应用" list: commands launching these skip confirmation. */
  computerAllowedApps?: string[];
  /**
   * True for the current turn when computer-control tools are live (session
   * armed via /computer use, or full access + any-app auto-wake). Lets
   * command-less shell-risk GUI actions pass in auto mode even without anyApp.
   */
  computerUse?: boolean;
  /**
   * Automatic review of a risky action, consulted only when the policy layer
   * decided the user would otherwise be prompted.
   *
   * Returning `{decision:'allow'}` skips the prompt; `{decision:'deny'}` refuses
   * the call; `{decision:'abstain'}` falls through to `confirm`. It is never
   * consulted for a hard-denied action, so it cannot resurrect a blocked
   * command — see the call site in registry.ts.
   */
  autoReview?: (request: ApprovalRequest) => Promise<import('../safety/autoReview.js').AutoReviewDecision>;
  /**
   * Runner injected by the agent to support the spawn_subagent tool.
   * When present, a sub-agent can be spawned in-process sharing the same
   * provider, workspace, and approval context.
   */
  subAgentRunner?: (goal: string, options?: SubAgentOptions) => Promise<string>;
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
  inputSchema?: Record<string, unknown>;
  risk: ToolRisk;
  /** Only tools explicitly marked safe may run in a read-only batch. */
  parallelSafe?: boolean;
  /**
   * When true, this tool is trusted to run without the auto-mode allowlist gate
   * (used by user-declared plugins). Destructive hard-blocks still apply.
   */
  autoApprove?: boolean;
  /**
   * When true — or when the predicate returns true for the call's validated
   * input — this tool is never approved silently: the prompt is required in
   * every mode, and the registry refuses the call when no confirmation handler
   * exists. Reserved for actions that destroy work the model cannot
   * reconstruct, such as `git restore` discarding uncommitted edits.
   *
   * Use the predicate form when only some inputs are destructive.
   */
  alwaysPrompt?: boolean | ((input: Record<string, unknown>) => boolean);
  validate(input: unknown): TInput;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
};

export function toolToProviderSpec(tool: ToolDefinition): ProviderToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputHint: tool.inputHint,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    risk: tool.risk,
  };
}
