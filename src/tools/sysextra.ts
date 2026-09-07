import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, delimiter, join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { resolveReadablePath, resolveWorkspacePath } from '../safety/policy.js';
import { isSecretEnvKey } from '../safety/sandbox.js';
import { lineDiff } from './lineDiff.js';
import type { ToolDefinition } from './types.js';

/*
 * A small batch of system/file utilities that round out the toolset to parity
 * with mainstream agents. Reads use resolveReadablePath; the one write
 * (append_file) uses resolveWorkspacePath + a checkpoint so it can be undone.
 * env_get scrubs secret-looking variables so keys never leak into output.
 */

function expectRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

async function readFileOrEmpty(target: string): Promise<string> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return '';
  }
}

// read_lines — return a 1-based inclusive line range from a text file. Useful
// for quoting a specific span without dumping the whole file into context.
export const readLinesTool: ToolDefinition<{ path: string; start: number; end: number }> = {
  name: 'read_lines',
  description: 'Read a 1-based inclusive line range from a text file (e.g. lines 40-80). Returns the numbered lines. Use to inspect a specific span without reading the whole file.',
  inputHint: '{ "path": "src/index.ts", "start": 1, "end": 40 }',
  risk: 'read',
  validate(input) {
    const record = expectRecord(input);
    if (typeof record.path !== 'string' || record.path.trim() === '') throw new Error('path is required');
    const start = typeof record.start === 'number' && record.start > 0 ? Math.floor(record.start) : 1;
    const end = typeof record.end === 'number' && record.end >= start ? Math.floor(record.end) : start + 39;
    return { path: record.path.trim(), start, end };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const raw = await readFile(target, 'utf8');
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const from = Math.min(input.start, lines.length);
    const to = Math.min(input.end, lines.length);
    const slice = lines.slice(from - 1, to);
    const numbered = slice.map((text, i) => `${from + i}\t${text}`).join('\n');
    return {
      ok: true,
      output: slice.length ? numbered : `(no lines in range ${input.start}-${input.end}; file has ${lines.length} lines)`,
      data: { path: input.path, start: from, end: to, totalLines: lines.length, returned: slice.length },
    };
  },
};

// append_file — append text to a workspace file (creating it if needed), with
// a checkpoint so the change is undoable and genuine line-diff reporting.
export const appendFileTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'append_file',
  description: 'Append UTF-8 text to a file inside the workspace, creating it if missing. Unlike write_file this preserves existing content. The change is checkpointed and undoable.',
  inputHint: '{ "path": "notes.md", "content": "\\n- another line\\n" }',
  risk: 'write',
  validate(input) {
    const record = expectRecord(input);
    if (typeof record.path !== 'string' || record.path.trim() === '') throw new Error('path is required');
    if (typeof record.content !== 'string') throw new Error('content is required');
    return { path: record.path.trim(), content: record.content };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path);
    const checkpoint = await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    const previous = await readFileOrEmpty(target);
    const next = previous + input.content;
    await writeFile(target, next, 'utf8');
    const { added, removed } = lineDiff(previous, next);
    return {
      ok: true,
      output: `Appended to ${input.path} (${Buffer.byteLength(input.content)} bytes, +${added} -${removed})`,
      data: { path: input.path, bytes: Buffer.byteLength(next), added, removed, checkpointId: checkpoint?.id },
    };
  },
};

// env_get — read environment variables, with secret-looking ones redacted so
// API keys/tokens never leak into the conversation.
export const envGetTool: ToolDefinition<{ name?: string }> = {
  name: 'env_get',
  description: 'Read environment variables. With a name, returns that one; without, lists all names. Secret-looking values (keys, tokens, passwords) are redacted. Use to inspect PATH, HOME, NODE_ENV, etc.',
  inputHint: '{ "name": "PATH" }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return {};
    const record = expectRecord(input);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
    return { name };
  },
  async execute(input) {
    if (input.name) {
      const raw = process.env[input.name];
      if (raw === undefined) return { ok: true, output: `(${input.name} is not set)`, data: { name: input.name, set: false } };
      const value = isSecretEnvKey(input.name) ? '***redacted***' : raw;
      return { ok: true, output: `${input.name}=${value}`, data: { name: input.name, set: true, redacted: isSecretEnvKey(input.name) } };
    }
    const names = Object.keys(process.env).sort();
    return { ok: true, output: names.join('\n'), data: { count: names.length, names } };
  },
};

// which_command — resolve an executable's absolute path by scanning PATH,
// cross-platform (honours PATHEXT on Windows). Read-only, no execution.
export const whichCommandTool: ToolDefinition<{ command: string }> = {
  name: 'which_command',
  description: 'Find the absolute path of an executable on PATH, like `which`/`where`. Returns the first match. Cross-platform (honours PATHEXT on Windows). Does not run anything.',
  inputHint: '{ "command": "node" }',
  risk: 'read',
  validate(input) {
    const record = expectRecord(input);
    if (typeof record.command !== 'string' || record.command.trim() === '') throw new Error('command is required');
    return { command: record.command.trim() };
  },
  async execute(input) {
    const pathVar = process.env.PATH ?? process.env.Path ?? '';
    const dirs = pathVar.split(delimiter).filter(Boolean);
    const isWindows = process.platform === 'win32';
    const exts = isWindows
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
    const candidates: string[] = [];
    for (const dir of dirs) {
      // If the command already has an extension (or on POSIX), try it as-is.
      candidates.push(join(dir, input.command));
      if (isWindows) {
        for (const ext of exts) candidates.push(join(dir, `${input.command}${ext.toLowerCase()}`));
      }
    }
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return { ok: true, output: candidate, data: { command: input.command, path: candidate } };
      } catch {
        // On Windows X_OK is not meaningful; fall back to plain existence.
        if (isWindows) {
          try {
            await access(candidate, constants.F_OK);
            return { ok: true, output: candidate, data: { command: input.command, path: candidate } };
          } catch {
            // keep scanning
          }
        }
      }
    }
    return { ok: false, output: `${input.command} not found on PATH`, data: { command: input.command } };
  },
};
