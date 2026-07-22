import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { ToolRisk } from '../safety/policy.js';
import type { McpClient } from './client.js';
import type { McpToolDescriptor } from './types.js';

export function mcpToolName(serverName: string, toolName: string) {
  const sanitizedServer = sanitizeToken(serverName);
  const sanitizedTool = sanitizeToken(toolName);
  return `mcp_${sanitizedServer}_${sanitizedTool}`;
}

export function bridgeMcpTools(client: McpClient): ToolDefinition[] {
  return client.getTools().map((tool) => bridgeOne(client, tool));
}

function bridgeOne(client: McpClient, tool: McpToolDescriptor): ToolDefinition<Record<string, unknown>> {
  const name = mcpToolName(client.name, tool.name);
  const risk = riskForTool(tool);
  const description = `[mcp:${client.name}] ${tool.description ?? tool.name}`;
  const inputHint = inputHintForSchema(tool.inputSchema);

  return {
    name,
    description,
    inputHint,
    risk,
    validate(input) {
      if (input === undefined || input === null) return {};
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
      return input as Record<string, unknown>;
    },
    async execute(input): Promise<ToolResult> {
      try {
        const result = await client.callTool(tool.name, input);
        const text = formatContent(result.content);
        if (result.isError) {
          return { ok: false, output: text || `MCP tool ${tool.name} returned isError`, data: result };
        }
        return { ok: true, output: text || '(no output)', data: result };
      } catch (error) {
        return {
          ok: false,
          output: `MCP tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

export function riskForTool(tool: McpToolDescriptor): ToolRisk {
  if (tool.annotations?.readOnlyHint === true) return 'read';
  if (tool.annotations?.destructiveHint === true) return 'write';
  return 'shell';
}

function sanitizeToken(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

function inputHintForSchema(schema: Record<string, unknown> | undefined) {
  if (!schema) return '{}';
  try {
    const text = JSON.stringify(schema);
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  } catch {
    return '{}';
  }
}

function formatContent(content: Array<{ type: string; text?: string }> | undefined) {
  if (!content || content.length === 0) return '';
  return content
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join('\n');
}
