import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { SessionRecord } from '../session/store.js';
import { resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';

const execFileAsync = promisify(execFile);

type RecentActivityInput = {
  maxSessions: number;
  maxFiles: number;
};

export const recentActivityTool: ToolDefinition<RecentActivityInput> = {
  name: 'recent_activity',
  description: 'Summarize recent CLI sessions, tool calls, modified files, and git activity when available.',
  inputHint: '{ "maxSessions": 5, "maxFiles": 10 }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return { maxSessions: 5, maxFiles: 10 };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      maxSessions: typeof record.maxSessions === 'number' && record.maxSessions > 0 ? Math.min(Math.floor(record.maxSessions), 20) : 5,
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.min(Math.floor(record.maxFiles), 50) : 10,
    };
  },
  async execute(input, context) {
    const [sessions, files, git] = await Promise.all([readRecentSessions(context.workspaceRoot, input.maxSessions), readRecentFiles(context.workspaceRoot, input.maxFiles), readGitActivity(context.workspaceRoot)]);
    const output = [formatSessions(sessions), formatFiles(files), formatGit(git)].filter(Boolean).join('\n\n');
    return { ok: true, output: output || '(no recent activity found)', data: { sessions, files, git } };
  },
};

async function readRecentSessions(workspaceRoot: string, limit: number) {
  const sessionDir = resolveWorkspacePath(workspaceRoot, '.aicode/sessions');
  try {
    const names = await readdir(sessionDir);
    const sessions: SessionRecord[] = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      try {
        sessions.push(JSON.parse(await readFile(join(sessionDir, name), 'utf8')) as SessionRecord);
      } catch {
        // Ignore corrupt sessions.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((session) => ({
      id: session.id,
      updatedAt: session.updatedAt,
      provider: session.provider,
      model: session.model,
      messages: session.messages.length,
      toolCalls: session.toolCalls.length,
      lastUser: [...session.messages].reverse().find((message) => message.role === 'user')?.content,
      lastTools: session.toolCalls.slice(-3).map((call) => `${call.ok ? 'ok' : 'failed'}:${call.tool}`),
    }));
  } catch {
    return [];
  }
}

async function readRecentFiles(workspaceRoot: string, limit: number) {
  const files: Array<{ path: string; modifiedAt: string }> = [];
  await walk(workspaceRoot, workspaceRoot, files, Math.max(limit * 4, limit));
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

async function walk(current: string, workspaceRoot: string, files: Array<{ path: string; modifiedAt: string }>, maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;
  const info = await stat(current);
  if (info.isFile()) {
    files.push({ path: relative(workspaceRoot, current).replace(/\\/g, '/'), modifiedAt: info.mtime.toISOString() });
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (entry.isDirectory() && isIgnoredDirName(entry.name)) continue;
    await walk(join(current, entry.name), workspaceRoot, files, maxFiles);
  }
}

async function readGitActivity(workspaceRoot: string) {
  try {
    const status = await execFileAsync('git', ['status', '--short', '--branch'], { cwd: workspaceRoot, timeout: 10000, windowsHide: true, maxBuffer: 256 * 1024 });
    const log = await execFileAsync('git', ['log', '--oneline', '-n', '5'], { cwd: workspaceRoot, timeout: 10000, windowsHide: true, maxBuffer: 256 * 1024 });
    return { available: true, status: status.stdout.trim(), log: log.stdout.trim() };
  } catch {
    return { available: false, status: 'not a git repository', log: '' };
  }
}

function formatSessions(sessions: Awaited<ReturnType<typeof readRecentSessions>>) {
  if (sessions.length === 0) return 'sessions: none';
  return ['sessions:', ...sessions.map((session) => `- ${session.id} ${session.updatedAt} ${session.provider}/${session.model} messages=${session.messages} tools=${session.toolCalls} lastUser=${truncate(session.lastUser ?? '(none)', 80)} lastTools=${session.lastTools.join(',') || '(none)'}`)].join('\n');
}

function formatFiles(files: Awaited<ReturnType<typeof readRecentFiles>>) {
  if (files.length === 0) return 'recent files: none';
  return ['recent files:', ...files.map((file) => `- ${file.modifiedAt} ${file.path}`)].join('\n');
}

function formatGit(git: Awaited<ReturnType<typeof readGitActivity>>) {
  if (!git.available) return 'git: not a git repository';
  return [`git status:\n${git.status || '(clean)'}`, `git log:\n${git.log || '(no commits)'}`].join('\n');
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
