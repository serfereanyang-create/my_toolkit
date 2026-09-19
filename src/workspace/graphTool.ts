/**
 * graphTools.ts - Workspace 依赖图导出工具。
 */

import type { ToolDefinition } from '../tools/types.js';
import { discoverWorkspace } from './discover.js';
import { buildPackageGraph, graphToDot, graphToJson } from './graph.js';

export const workspaceGraphTool: ToolDefinition<{
  format: 'dot' | 'json';
}> = {
  name: 'workspace_graph',
  description: '输出 workspace 依赖图（Graphviz DOT 或 JSON，可直接喂给图渲染器）',
  inputHint: '{ "format": "dot" } 或 { "format": "json" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const format = record.format === 'json' ? 'json' : 'dot';
    return { format };
  },

  async execute(input, context) {
    const discovery = await discoverWorkspace(context.workspaceRoot);
    if (discovery.packages.length === 0) {
      return { ok: true, output: '未发现 workspace 包。' };
    }
    const graph = buildPackageGraph(discovery.packages);
    const body = input.format === 'json' ? '```json\n' + graphToJson(graph) + '\n```' : '```dot\n' + graphToDot(graph) + '\n```';
    const output = `## Workspace 依赖图（${graph.nodes.length} 节点 / ${graph.edges.length} 边）\n\n${body}`;
    return { ok: true, output, data: { format: input.format, graph } };
  },
};

export const workspaceGraphTools = [workspaceGraphTool];
