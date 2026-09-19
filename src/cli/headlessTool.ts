/**
 * headlessTool.ts — 无头单工具执行入口
 *
 * 供宿主集成（如桌面质量工具网关）以子进程方式调用单个只读分析工具。
 * 安全边界：只允许 risk === 'read' 的工具；write/shell/network 风险工具
 * 必须走交互 Agent 的审批、checkpoint 流程，不能从这里旁路执行。
 */

import type { AppConfig } from '../config/types.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ToolResult } from '../tools/types.js';

export type HeadlessToolResult = {
  ok: boolean;
  output: string;
  data?: unknown;
  error?: string;
};

function readAllStdin(): Promise<string> {
  return new Promise((resolveInput, rejectInput) => {
    let payload = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { payload += chunk; });
    process.stdin.on('end', () => resolveInput(payload));
    process.stdin.on('error', rejectInput);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHeadlessTool(
  config: AppConfig,
  registry: ToolRegistry,
): Promise<HeadlessToolResult> {
  const name = config.invokeTool as string;
  // Resolve by scanning instead of a keyed map access; identical behavior.
  const tool = registry.list().find((candidate) => candidate.name === name);
  if (!tool) {
    return { ok: false, output: '', error: 'Unknown tool: ' + name };
  }
  if (tool.risk !== 'read') {
    return {
      ok: false,
      output: '',
      error: 'Tool "' + name + '" is risk "' + tool.risk + '". invoke-tool mode only exposes ' +
        'read-only analysis tools; write tools require the interactive approval flow.',
    };
  }

  let raw = config.toolInput ?? '{}';
  if (raw === '-') {
    try { raw = await readAllStdin(); } catch (error) {
      return { ok: false, output: '', error: 'Failed to read tool input from stdin: ' + errorText(error) };
    }
  }

  let input: unknown;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    return { ok: false, output: '', error: '--tool-input is not valid JSON: ' + errorText(error) };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, output: '', error: '--tool-input must be a JSON object' };
  }

  let validated: unknown;
  try {
    const validator = tool.validate.bind(tool);
    validated = validator(input);
  } catch (error) {
    return { ok: false, output: '', error: 'Invalid input for the requested tool: ' + errorText(error) };
  }

  try {
    const runner = tool.execute.bind(tool);
    const result: ToolResult = await runner(validated, {
      workspaceRoot: config.workspaceRoot,
      approval: 'deny',
      // No network allowlist in headless mode: analysis tools that touch the
      // network are denied at the tool layer instead of surprising the host.
    });
    return {
      ok: result.ok,
      output: result.output,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.ok ? {} : { error: result.output }),
    };
  } catch (error) {
    return { ok: false, output: '', error: errorText(error) };
  }
}
