import path from 'node:path';
import type { ApprovalMode } from '../config/types.js';
import type { ApprovalRequest, ToolContext, ToolDefinition } from '../tools/types.js';

export function resolveWorkspacePath(workspace: string, requested = '.'): string {
  const root = path.resolve(workspace); const target = path.resolve(root, requested);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Path is outside the workspace');
  return target;
}
export function hostAllowed(urlText: string, allowlist: string[]): boolean {
  const host = new URL(urlText).hostname.toLowerCase();
  return allowlist.some(item => item.trim().toLowerCase() === host);
}
export async function authorize(tool: ToolDefinition, input: Record<string, unknown>, ctx: ToolContext, mode: ApprovalMode): Promise<{ allowed: boolean; message?: string }> {
  if (tool.risk === 'read' || tool.autoApprove || mode === 'auto') return { allowed: true };
  if (mode === 'deny') return { allowed: false, message: `${tool.name} blocked by approval mode deny` };
  const key = `${tool.risk}:${tool.name}`; if (ctx.sessionApproved?.has(key)) return { allowed: true };
  const request: ApprovalRequest = { tool: tool.name, risk: tool.risk, input, reason: `${tool.risk} operation`, message: `Approve ${tool.name} (${tool.risk})?` };
  if (!ctx.confirm) return { allowed: false, message: `${tool.name} requires approval` };
  const decision = await ctx.confirm(request.message, request);
  if (decision === 'allow_session') ctx.sessionApproved?.add(key);
  return decision ? { allowed: true } : { allowed: false, message: `${tool.name} was not approved` };
}
