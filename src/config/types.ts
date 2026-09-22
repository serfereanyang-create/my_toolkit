import type { ApprovalMode, ProviderName, ReasoningEffort } from '../providers/types.js';
import type { ToolScope } from '../tools/scope.js';

/**
 * How readily the main agent hands work to a sub-agent.
 *
 * The tool itself has no framework gate — `spawn_subagent` is injected into
 * every root turn — so the only thing deciding whether delegation happens is
 * the model's reading of one prompt block. This level is what steers it.
 *
 * `eager` is the default: almost every request should produce at least one
 * delegated run. That costs real money (each sub-agent is a fresh session with
 * a cold prompt cache), so `balanced` and `off` exist to dial it back.
 */
export type DelegationLevel = 'off' | 'balanced' | 'eager';

export type CliArgs = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  customProvider?: boolean;
  computerAnyApp?: boolean;
  excelAutomation?: boolean;
  allowedApps?: string[];
  approval?: ApprovalMode;
  workspace?: string;
  sessionDir?: string;
  resumeSessionId?: string;
  prompt?: string;
  /** Optional per-turn model round-trip cap (--max-steps). Absent = unlimited. */
  maxSteps?: number;
  /** Optional per-turn token budget (--max-tokens). */
  maxTokens?: number;
  /**
   * Auto-review risky actions with a second model call instead of prompting the
   * user (--auto-review). Only actions the policy layer would have prompted for
   * are eligible; hard-denied ones are never reachable by the reviewer.
   */
  autoReview?: boolean;
  /** Sub-agent delegation eagerness (--delegation). */
  delegation?: DelegationLevel;
  noBanner?: boolean;
  version?: boolean;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  ci?: boolean;
  noInput?: boolean;
  configPath?: string;
  profile?: string;
  doctor?: boolean;
  /** Headless single-tool invocation: tool name (read-risk tools only). */
  invokeTool?: string;
  /** JSON input for --invoke-tool; '-' reads the payload from stdin. */
  toolInput?: string;
  completionShell?: 'bash' | 'zsh' | 'fish' | 'powershell';
  confirmPlan?: boolean;
  desktopBridge?: boolean;
  usageLog?: string;
  reasoningEffort?: ReasoningEffort;
  toolScope?: ToolScope;
};

export type FileProfileConfig = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  approval?: ApprovalMode;
  sessionDir?: string;
  /** Optional per-turn model round-trip cap. Absent = unlimited (the default). */
  maxSteps?: number;
  /** Optional weighted token budget for a turn — the honest bound to use instead. */
  maxTokens?: number;
  /** Auto-review risky actions instead of prompting the user. */
  autoReview?: boolean;
  /** Sub-agent delegation eagerness. Absent = 'eager'. */
  delegation?: DelegationLevel;
  reasoningEffort?: ReasoningEffort;
  toolScope?: ToolScope;
  /** Network egress policy for the fetch_url tool. */
  network?: { enabled?: boolean; allowlist?: string[] };
};

export type FileConfig = FileProfileConfig & {
  defaultProfile?: string;
  profiles?: Record<string, FileProfileConfig>;
};

export type AppConfig = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  customProvider?: boolean;
  computerAnyApp?: boolean;
  excelAutomation?: boolean;
  allowedApps?: string[];
  approval: ApprovalMode;
  workspaceRoot: string;
  sessionDir: string;
  network?: { enabled?: boolean; allowlist?: string[] };
  resumeSessionId?: string;
  prompt?: string;
  /**
   * Model round-trip cap for one turn. **Absent means unlimited**, which is the
   * default: a hard step count cuts real work off mid-task and reports it as a
   * failure, and the reference implementation (codex-rs) has no such cap at all
   * — its turn loop ends when the model stops calling tools, and what bounds a
   * long run is context compaction.
   *
   * Set it only as a deliberate experiment or for a scripted/CI run that must
   * terminate on a fixed budget. Use `maxTokens` for a real safety bound.
   */
  maxSteps?: number;
  /**
   * Weighted token budget for the whole turn. This is the honest bound to reach
   * for instead of a step count: it caps actual spend, not iteration count, so a
   * long task that is making progress is never cut off by arithmetic.
   */
  maxTokens?: number;
  /**
   * Auto-review risky actions with a second model call instead of prompting the
   * user. Only actions the policy layer would have prompted for are eligible;
   * hard-denied ones are never reachable by the reviewer.
   */
  autoReview?: boolean;
  /**
   * How readily the main agent delegates to sub-agents. `config.ts` resolves
   * this from --delegation / AICODE_DELEGATION / the config file, defaulting to
   * 'eager'; read it through `delegationLevelOf()` rather than testing it
   * against a literal, so an AppConfig built by hand (tests, embedding) still
   * gets the documented default instead of silently meaning "off".
   */
  delegation?: DelegationLevel;
  noBanner: boolean;
  version?: boolean;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  ci?: boolean;
  noInput?: boolean;
  configPath?: string;
  profile?: string;
  doctor?: boolean;
  /** Headless single-tool invocation: tool name (read-risk tools only). */
  invokeTool?: string;
  /** JSON input for --invoke-tool; '-' reads the payload from stdin. */
  toolInput?: string;
  completionShell?: 'bash' | 'zsh' | 'fish' | 'powershell';
  confirmPlan?: boolean;
  desktopBridge?: boolean;
  usageLog?: string;
  reasoningEffort?: ReasoningEffort;
  toolScope?: ToolScope;
};
