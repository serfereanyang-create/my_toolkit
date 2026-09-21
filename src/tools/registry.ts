import { readFile } from 'node:fs/promises';
import { decideApproval, pathScopeFor, resolveWorkspacePath } from '../safety/policy.js';
import { formatApprovalOutcome, formatApprovalPrompt } from '../i18n/messages.js';
import { toolToProviderSpec, type ApprovalRequest, type ToolContext, type ToolDefinition, type ToolResult } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition, options?: { replace?: boolean }) {
    if (this.tools.has(tool.name) && !options?.replace) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  unregister(name: string) {
    return this.tools.delete(name);
  }

  list() {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  static fromTools(tools: ToolDefinition[]) {
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    return registry;
  }

  specs() {
    return this.list().map(toolToProviderSpec);
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const locale = context.locale ?? 'en';
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: formatApprovalOutcome({ locale, kind: 'unknown_tool', tool: name }) };
    }

    let parsed: unknown;
    try {
      parsed = tool.validate(input);
    } catch (error) {
      return {
        ok: false,
        output: formatApprovalOutcome({
          locale,
          kind: 'invalid_input',
          tool: name,
          detail: errorMessage(error),
        }),
      };
    }

    const inputRecord = isRecord(parsed) ? parsed : {};
    const decision = decideApproval({
      mode: context.approval,
      risk: tool.risk,
      workspaceRoot: context.workspaceRoot,
      command: typeof inputRecord.command === 'string' ? inputRecord.command : undefined,
      targetPath: approvalTargetPath(inputRecord),
      url: typeof inputRecord.url === 'string' ? inputRecord.url : undefined,
      networkAllowlist: context.networkAllowlist,
      autoApprove: tool.autoApprove === true,
      alwaysPrompt: resolveAlwaysPrompt(tool, inputRecord),
      computerAnyApp: context.computerAnyApp === true,
      allowedApps: context.computerAllowedApps,
      computerUse: context.computerUse === true,
    });

    if (!decision.allowed) {
      return {
        ok: false,
        output: formatApprovalOutcome({ locale, kind: 'blocked', tool: name, reason: decision.reason }),
      };
    }

    if (decision.needsPrompt) {
      if (!context.confirm) {
        return {
          ok: false,
          output: formatApprovalOutcome({ locale, kind: 'no_confirm', tool: name, reason: decision.reason }),
        };
      }
      context.beforeConfirm?.();
      const message = await approvalMessage(name, tool.risk, inputRecord, context, locale);
      // Attach a structured before/after diff for write tools so desktop UIs
      // can render the real change during confirmation. Zero disk access after
      // this point if the user denies.
      const diff = tool.risk === 'write' ? await buildWriteDiff(name, inputRecord, context) : undefined;
      const request: ApprovalRequest = {
        tool: name,
        risk: tool.risk,
        input: inputRecord,
        reason: decision.reason,
        message,
        diff,
      };

      // Automatic review, before the user is asked.
      //
      // This is the only place it can go and still be safe: `!decision.allowed`
      // returned above, so the command blocklist, the SSRF guard, `deny` mode
      // and `alwaysPrompt` destructive tools are all already decided and out of
      // the reviewer's reach. Nothing has touched disk yet either — the diff
      // above is computed from the arguments.
      //
      // A verdict only decides whether to ASK. Approving must not bypass the
      // execution path below (hooks, the tool call itself) — returning early
      // here once skipped the tool entirely.
      let approved: boolean;
      const autoReview = await context.autoReview?.(request);
      if (autoReview?.decision === 'allow') {
        approved = true;
      } else if (autoReview?.decision === 'deny') {
        context.afterConfirm?.();
        return {
          ok: false,
          output: `${formatApprovalOutcome({ locale, kind: 'cancelled', tool: name })}\n自动审核拒绝：${autoReview.rationale}\n这是审核判定，不是执行失败；可以换一种更窄的做法，或请用户明确授权。`,
          data: { autoReviewed: true, decision: 'deny', riskLevel: autoReview.riskLevel, rationale: autoReview.rationale },
        };
      } else {
        // abstain → ask the user, which is the pre-existing behaviour.
        const decisionFromUser = await context.confirm(message, request);
        approved = decisionFromUser === true || decisionFromUser === 'allow_session';
      }
      context.afterConfirm?.();
      if (!approved) {
        return { ok: false, output: formatApprovalOutcome({ locale, kind: 'cancelled', tool: name }) };
      }
    }

    try {
      await context.hooks?.beforeTool({ tool: name, input: parsed });
      const result = await tool.execute(parsed, context);
      await context.hooks?.afterTool({ tool: name, input: parsed, result });
      return result;
    } catch (error) {
      await context.hooks?.onError({ tool: name, input: parsed, error });
      return {
        ok: false,
        output: formatApprovalOutcome({
          locale,
          kind: 'failed',
          tool: name,
          detail: errorMessage(error),
        }),
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function approvalTargetPath(input: Record<string, unknown>) {
  if (typeof input.path === 'string') return input.path;
  if (typeof input.to === 'string') return input.to;
  if (typeof input.from === 'string') return input.from;
  return undefined;
}

/**
 * Resolve the tool's alwaysPrompt flag against the call's validated input.
 * A predicate lets one tool gate only its destructive inputs (e.g.
 * `git restore` without `--staged`, which discards uncommitted edits) while
 * letting the recoverable ones (unstaging) follow the normal policy.
 */
function resolveAlwaysPrompt(tool: ToolDefinition, input: Record<string, unknown>): boolean {
  if (tool.alwaysPrompt === undefined) return false;
  if (typeof tool.alwaysPrompt === 'boolean') return tool.alwaysPrompt;
  try {
    return tool.alwaysPrompt(input) === true;
  } catch {
    // A throwing predicate must fail CLOSED: an unevaluable destructive guard
    // is not evidence that the action is safe.
    return true;
  }
}

async function approvalMessage(
  name: string,
  risk: 'read' | 'write' | 'shell' | 'network',
  input: Record<string, unknown>,
  context: ToolContext,
  locale: import('../i18n/locale.js').Locale,
) {
  const preview = await diffPreview(name, input, context);
  return formatApprovalPrompt({
    locale,
    tool: name,
    risk,
    path: typeof input.path === 'string' ? input.path : undefined,
    // Multi-target tools (git_restore/git_add) carry `paths`; surface every
    // target so the user approves the exact list, not just the tool name.
    paths: Array.isArray(input.paths)
      ? input.paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : undefined,
    from: typeof input.from === 'string' ? input.from : undefined,
    to: typeof input.to === 'string' ? input.to : undefined,
    command: typeof input.command === 'string' ? input.command : undefined,
    preview,
  });
}

function simpleDiff(before: string[], after: string[]) {
  if (before.join('\n') === after.join('\n')) return ['(no textual changes)'];
  const lines: string[] = [];
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max; index += 1) {
    if (before[index] === after[index]) continue;
    if (before[index] !== undefined) lines.push(`- ${before[index]}`);
    if (after[index] !== undefined) lines.push(`+ ${after[index]}`);
    if (lines.length >= 12) break;
  }
  return lines;
}

async function diffPreview(name: string, input: Record<string, unknown>, context: ToolContext) {
  if (name !== 'write_file' || typeof input.path !== 'string' || typeof input.content !== 'string') return '';
  try {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const before = await readFile(target, 'utf8').catch(() => '');
    const beforeLines = before.split(/\r?\n/);
    const afterLines = input.content.split(/\r?\n/);
    return [`\n--- ${input.path}`, `+++ ${input.path}`, ...simpleDiff(beforeLines, afterLines).slice(0, 12)].join('\n');
  } catch {
    return '';
  }
}

/**
 * Structured before/after for the three write tools, computed WITHOUT touching
 * disk. Attached to the ApprovalRequest so desktop UIs can render a real diff
 * during confirmation. Deny at this point is zero-side-effect (no checkpoint,
 * no write). Mirrors each tool's execute() transformation logic.
 */
async function buildWriteDiff(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<import('./types.js').ApprovalRequest['diff']> {
  if (typeof input.path !== 'string' || !input.path) return undefined;
  try {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const originalContent = await readFile(target, 'utf8').catch(() => '');
    let modifiedContent: string | undefined;

    if (name === 'write_file' && typeof input.content === 'string') {
      modifiedContent = input.content;
    } else if (name === 'apply_patch' && typeof input.newText === 'string') {
      if (input.oldText === undefined) {
        modifiedContent = input.newText;
      } else if (typeof input.oldText === 'string' && originalContent.includes(input.oldText)) {
        modifiedContent = originalContent.replace(input.oldText, input.newText);
      } else {
        return undefined; // tool will fail later anyway
      }
    } else if (name === 'edit_lines') {
      const beforeLines = originalContent === '' ? [] : originalContent.replace(/\r\n/g, '\n').split('\n');
      let lines = [...beforeLines];
      const start = typeof input.start === 'number' ? input.start : NaN;
      const end = typeof input.end === 'number' ? input.end : NaN;
      const text = typeof input.text === 'string' ? input.text : '';
      const mode = typeof input.mode === 'string' ? input.mode : 'replace';
      if (Number.isNaN(start)) return undefined;
      const replaceMode = mode === 'replace' || mode === 'insert';
      if (replaceMode) {
        const inserted = text.length ? text.split(/\r?\n/) : [];
        lines.splice(start - 1, mode === 'replace' ? Math.max(0, end - start + 1) : 0, ...inserted);
      } else if (mode === 'delete') {
        lines.splice(start - 1, Math.max(1, end - start + 1));
      } else {
        return undefined;
      }
      modifiedContent = lines.join('\n');
    } else {
      return undefined;
    }

    if (modifiedContent === undefined || modifiedContent === originalContent) return undefined;
    return { path: input.path, originalContent, modifiedContent };
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
