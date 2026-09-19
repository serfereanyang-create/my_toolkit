/**
 * sessionTitleTool.ts — session_title_suggest 工具：为会话生成标题建议。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import { suggestTitle, summarizeActivity } from './sessionTitle.js';

interface SessionShape {
  id?: string;
  updatedAt?: string;
  messages?: Array<{ role?: unknown; content?: unknown }>;
  toolCalls?: Array<{ tool?: unknown }>;
}

function extractSources(session: SessionShape): { firstUser?: string; firstAssistant?: string; toolNames: string[] } {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  let firstUser: string | undefined;
  let firstAssistant: string | undefined;
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    if (message.role === 'user' && !firstUser) firstUser = message.content;
    if (message.role === 'assistant' && !firstAssistant) firstAssistant = message.content;
    if (firstUser && firstAssistant) break;
  }
  const toolNames = (Array.isArray(session.toolCalls) ? session.toolCalls : [])
    .map((c) => (typeof c.tool === 'string' ? c.tool : 'unknown'));
  return { firstUser, firstAssistant, toolNames };
}

export const sessionTitleTool: ToolDefinition<{ sessionId?: string }> = {
  name: 'session_title_suggest',
  description: '为最近（或指定）会话生成标题建议与活动摘要（启发式，无模型调用）',
  inputHint: '{ "sessionId": "可选" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.sessionId === 'string' && (r.sessionId.includes('..') || r.sessionId.includes('/') || r.sessionId.includes('\\'))) {
      throw new Error('sessionId 不能包含路径分隔符');
    }
    return { sessionId: typeof r.sessionId === 'string' && r.sessionId.trim() ? r.sessionId.trim() : undefined };
  },

  async execute(input, context) {
    const sessionsDir = join(context.workspaceRoot, '.aicode', 'sessions');
    let session: SessionShape | null = null;

    if (input.sessionId) {
      try {
        session = JSON.parse(await readFile(join(sessionsDir, `${input.sessionId}.json`), 'utf-8')) as SessionShape;
      } catch {
        return { ok: false, output: `找不到会话 ${input.sessionId}` };
      }
    } else {
      let names: string[] = [];
      try {
        names = (await readdir(sessionsDir)).filter((n) => n.endsWith('.json'));
      } catch {
        return { ok: false, output: '会话目录不存在或为空。' };
      }
      let latestTime = '';
      for (const name of names) {
        try {
          const candidate = JSON.parse(await readFile(join(sessionsDir, name), 'utf-8')) as SessionShape;
          if (candidate.updatedAt && candidate.updatedAt > latestTime) {
            latestTime = candidate.updatedAt;
            session = candidate;
          }
        } catch { /* skip broken */ }
      }
      if (!session) return { ok: false, output: '无法读取任何会话。' };
    }

    const sources = extractSources(session);
    const suggestion = suggestTitle(sources);
    const activity = summarizeActivity(sources.toolNames);
    const lines = [
      `## 标题建议`,
      '',
      `- 标题: **${suggestion.title}**`,
      `- 策略: ${suggestion.strategy}（置信度 ${suggestion.confidence}）`,
      activity ? `- 活动: ${activity}` : '- 活动: 无工具调用',
    ];
    return { ok: true, output: lines.join('\n'), data: { suggestion, activity } };
  },
};

export const sessionTitleTools = [sessionTitleTool];
