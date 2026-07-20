import { readFile } from 'node:fs/promises';
import { decideApproval, resolveWorkspacePath } from '../safety/policy.js';
import { toolToProviderSpec, type ToolContext, type ToolDefinition, type ToolResult } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
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
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool: ${name}` };
    }

    let parsed: unknown;
    try {
      parsed = tool.validate(input);
    } catch (error) {
      return { ok: false, output: `Invalid input for ${name}: ${errorMessage(error)}` };
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
      return { ok: false, output: `Tool ${name} blocked: ${decision.reason}` };
    }

    if (decision.needsPrompt) {
      if (!context.confirm) {
        return { ok: false, output: `Tool ${name} blocked: ${decision.reason}; no confirmation handler is available` };
      }
      context.beforeConfirm?.();
      const approved = await context.confirm(await approvalMessage(name, tool.risk, inputRecord, context));
      context.afterConfirm?.();
      if (!approved) {
        return { ok: false, output: `Tool ${name} cancelled by user` };
      }
    }

    try {
      await context.hooks?.beforeTool({ tool: name, input: parsed });
      const result = await tool.execute(parsed, context);
      await context.hooks?.afterTool({ tool: name, input: parsed, result });
      return result;
    } catch (error) {
      await context.hooks?.onError({ tool: name, input: parsed, error });
      return { ok: false, output: `Tool ${name} failed: ${errorMessage(error)}` };
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

async function approvalMessage(name: string, risk: string, input: Record<string, unknown>, context: ToolContext) {
  const target = typeof input.path === 'string' ? ` path=${input.path}` : '';
  const from = typeof input.from === 'string' ? ` from=${input.from}` : '';
  const to = typeof input.to === 'string' ? ` to=${input.to}` : '';
  const command = typeof input.command === 'string' ? ` command=${input.command}` : '';
  const preview = await diffPreview(name, input, context);
  return `Approve ${risk} tool ${name}${target}${from}${to}${command}?${preview}`;
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
