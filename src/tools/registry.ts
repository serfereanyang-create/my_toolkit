import { readFile } from 'node:fs/promises';
import { decideApproval, resolveWorkspacePath } from '../safety/policy.js';
import { formatApprovalOutcome, formatApprovalPrompt } from '../i18n/messages.js';
import { toolToProviderSpec, type ToolContext, type ToolDefinition, type ToolResult } from './types.js';

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

  list() {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
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
      const approved = await context.confirm(await approvalMessage(name, tool.risk, inputRecord, context, locale));
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

async function approvalMessage(
  name: string,
  risk: 'read' | 'write' | 'shell',
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
    const target = resolveWorkspacePath(context.workspaceRoot, input.path);
    const before = await readFile(target, 'utf8').catch(() => '');
    const beforeLines = before.split(/\r?\n/);
    const afterLines = input.content.split(/\r?\n/);
    return [`\n--- ${input.path}`, `+++ ${input.path}`, ...simpleDiff(beforeLines, afterLines).slice(0, 12)].join('\n');
  } catch {
    return '';
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
