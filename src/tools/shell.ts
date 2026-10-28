import { assertNoPosixDrivePath, formatSandboxResult, runSandboxedCommand } from '../safety/sandbox.js';
import { DEFAULT_COMMAND_JOB_MAX_OUTPUT_BYTES } from '../safety/commandJobs.js';
import type { ToolDefinition } from './types.js';

export type RunCommandInput = {
  command: string;
  timeoutMs: number;
  background: boolean;
  maxOutputBytes?: number;
};

/*
 * The platform line the model kept ignoring, made specific.
 *
 * It used to say only "commands run through cmd.exe" - true, and useless when
 * the model's next call is `tail -20 file` or `... | ForEach-Object { ... }`.
 * Measured: 6 of 11 shell failures in one session were exactly that, and each
 * one cost three calls (the guess, the failure, the retry) plus a re-read of the
 * file it was trying to inspect. Naming the missing set costs ~70 tokens in the
 * cached prefix and removes the whole class, so this is the one shell fix with
 * no trade-off behind it.
 */
const SHELL_HINT = process.platform === 'win32'
  ? ' Commands run through cmd.exe: use Windows syntax (dir, %VAR%, &&), and Windows paths ("C:\\Users\\me\\x.txt" or a workspace-relative path) — an MSYS path like /c/Users/me/x.txt does not exist here.'
    + ' cmd.exe has no POSIX filters (head, tail, grep, sed, awk, ls, cat, wc) and no PowerShell cmdlets (Get-Content, Select-String, ForEach-Object, Get-ChildItem): for those, use the dedicated tool instead — head_tail (mode "head"/"tail"), read_lines, search_text, list_files, read_file, word_count, text_slice — or invoke PowerShell explicitly as powershell -NoProfile -Command "...".'
  : ' Commands run through /bin/sh. For file reads, searches, line ranges and counts prefer the dedicated tools (read_file, search_text, list_files, head_tail, read_lines, word_count) over shelling out.';

export const runCommandTool: ToolDefinition<RunCommandInput> = {
  name: 'run_command',
  description: `Run an approved shell command in the workspace under the process sandbox. Set background=true to start an in-process job and poll it with poll_command.${SHELL_HINT}`,
  inputHint: '{ "command": "node --version", "timeoutMs": 30000, "background": false }',
  risk: 'shell',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.command !== 'string' || record.command.length === 0) throw new Error('command is required');
    // Fail before the approval prompt: asking the user to approve a command
    // that cmd.exe cannot run wastes their decision on a doomed call.
    assertNoPosixDrivePath(record.command);
    if (record.background !== undefined && typeof record.background !== 'boolean') throw new Error('background must be a boolean');
    if (record.maxOutputBytes !== undefined && (typeof record.maxOutputBytes !== 'number' || !Number.isFinite(record.maxOutputBytes) || record.maxOutputBytes <= 0)) {
      throw new Error('maxOutputBytes must be a positive number');
    }
    return {
      command: record.command,
      timeoutMs: typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 120000) : 30000,
      background: record.background === true,
      maxOutputBytes: typeof record.maxOutputBytes === 'number' ? Math.min(Math.floor(record.maxOutputBytes), 16 * 1024 * 1024) : undefined,
    };
  },
  async execute(input, context) {
    if (input.background) {
      try {
        // Background jobs require a runtime-owned manager. This avoids creating
        // an untracked process when a caller forgot to inject the service.
        if (!context.commandJobs) {
          return {
            ok: false,
            output: 'Background commands are unavailable because no command job service was injected.',
            data: { command: input.command, background: true },
          };
        }
        const jobs = context.commandJobs;
        const started = jobs.start({
          signal: context.signal,
          command: input.command,
          cwd: context.workspaceRoot,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes ?? DEFAULT_COMMAND_JOB_MAX_OUTPUT_BYTES,
        });
        return {
          ok: true,
          output: `Started background command job ${started.jobId} (${started.status}).`,
          data: {
            jobId: started.jobId,
            status: started.status,
            startedAt: started.startedAt,
            maxOutputBytes: input.maxOutputBytes ?? DEFAULT_COMMAND_JOB_MAX_OUTPUT_BYTES,
          },
        };
      } catch (error) {
        return {
          ok: false,
          output: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
          data: { command: input.command, background: true },
        };
      }
    }

    // Keep the foreground path exactly on the existing sandbox implementation.
    try {
      const result = await runSandboxedCommand({
        signal: context.signal,
        command: input.command,
        cwd: context.workspaceRoot,
        timeoutMs: input.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return formatSandboxResult(result, input.command);
    } catch (error) {
      return {
        ok: false,
        output: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
        data: { command: input.command },
      };
    }
  },
};
