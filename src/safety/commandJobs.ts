import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  buildSandboxEnv,
  isSandboxScrubEnabled,
  validateSandboxCommand,
} from './sandbox.js';

/** States retained by the in-process command job manager. */
export type CommandJobStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'killed';

/** Public, serializable view of a command job. It intentionally contains no process handle or pid. */
export type CommandJobSnapshot = {
  jobId: string;
  status: CommandJobStatus;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  maxOutputBytes: number;
  startedAt: string;
  finishedAt?: string;
};

export type StartCommandJobOptions = {
  signal?: AbortSignal;
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  scrubSecrets?: boolean;
  shell?: boolean | string;
};

export type CommandJobStart = Pick<CommandJobSnapshot, 'jobId' | 'status' | 'startedAt'>;

/**
 * Narrow interface injected into tools. The child process is an implementation detail
 * of CommandJobManager and is never part of this interface or any returned value.
 */
export interface CommandJobService {
  start(options: StartCommandJobOptions): CommandJobStart;
  poll(jobId: string): CommandJobSnapshot | undefined;
  settleCancellation?(signal: AbortSignal): Promise<void>;
}

type JobRecord = {
  signal?: AbortSignal;
  snapshot: CommandJobSnapshot;
  child: ChildProcessWithoutNullStreams;
  timer: NodeJS.Timeout;
  closePromise: Promise<void>;
  resolveClose: () => void;
  closeRequested: boolean;
  killPromise?: Promise<void>;
};

export const DEFAULT_COMMAND_JOB_TIMEOUT_MS = 30_000;
export const DEFAULT_COMMAND_JOB_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_JOB_TIMEOUT_MS = 120_000;
const MAX_COMMAND_JOB_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Owns background command processes for one runtime/process.
 *
 * Jobs are deliberately in-memory only: a job id cannot be used to inspect a
 * process from another CLI process. Calling close() kills every still-running
 * process tree and drops all retained snapshots.
 */
export class CommandJobManager implements CommandJobService {
  private readonly jobs = new Map<string, JobRecord>();
  private closed = false;

  start(options: StartCommandJobOptions): CommandJobStart {
    options.signal?.throwIfAborted();
    if (this.closed) throw new Error('command job manager is closed');
    validateSandboxCommand(options.command);

    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const maxOutputBytes = normalizeMaxOutput(options.maxOutputBytes);
    const scrubbed = options.scrubSecrets ?? isSandboxScrubEnabled(options.env ?? process.env);
    const env = buildSandboxEnv(options.env ?? process.env, { scrubSecrets: scrubbed });
    const isWin = process.platform === 'win32';
    const child = spawn(options.command, [], {
      cwd: resolve(options.cwd),
      env,
      windowsHide: true,
      shell: options.shell ?? true,
      // Match runSandboxedCommand: POSIX children get their own group so the
      // timeout and close paths can kill the complete process tree.
      detached: !isWin,
    } as SpawnOptions) as ChildProcessWithoutNullStreams;

    const jobId = `job_${randomUUID()}`;
    const snapshot: CommandJobSnapshot = {
      jobId,
      status: 'running',
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      truncated: false,
      maxOutputBytes,
      startedAt: new Date().toISOString(),
    };

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolvePromise) => {
      resolveClose = resolvePromise;
    });
    const record: JobRecord = {
      signal: options.signal,
      snapshot,
      child,
      timer: setTimeout(() => {
        if (record.snapshot.finishedAt) return;
        record.snapshot.timedOut = true;
        record.snapshot.status = 'timed_out';
        record.killPromise = killProcessTree(child.pid, isWin);
      }, timeoutMs),
      closePromise,
      resolveClose,
      closeRequested: false,
    };
    this.jobs.set(jobId, record);
    const abort = () => {
      if (record.snapshot.finishedAt) return;
      record.closeRequested = true;
      clearTimeout(record.timer);
      record.snapshot.status = 'killed';
      record.killPromise = killProcessTree(record.child.pid, isWin);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdout?.on('data', (chunk: Buffer) => appendOutput(record.snapshot, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendOutput(record.snapshot, 'stderr', chunk));
    child.on('error', () => {
      if (!record.snapshot.finishedAt) record.snapshot.status = record.closeRequested ? 'killed' : 'failed';
    });
    child.on('close', async (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      if (record.snapshot.finishedAt) return;
      clearTimeout(record.timer);
      record.snapshot.code = code;
      record.snapshot.signal = signal;
      record.snapshot.finishedAt = new Date().toISOString();
      if (record.closeRequested) record.snapshot.status = 'killed';
      else if (record.snapshot.timedOut) record.snapshot.status = 'timed_out';
      else record.snapshot.status = code === 0 ? 'completed' : 'failed';
      await record.killPromise;
      record.resolveClose();
    });

    return { jobId, status: snapshot.status, startedAt: snapshot.startedAt };
  }

  poll(jobId: string): CommandJobSnapshot | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    return { ...record.snapshot };
  }

  async settleCancellation(signal: AbortSignal): Promise<void> {
    await Promise.all([...this.jobs.values()].filter(record => record.signal === signal && record.closeRequested).map(record => record.closePromise));
  }

  /** Kill active process trees and release all in-memory job state. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.jobs.values()].filter((record) => !record.snapshot.finishedAt);
    for (const record of active) {
      record.closeRequested = true;
      clearTimeout(record.timer);
      record.snapshot.status = 'killed';
      killProcessTree(record.child.pid, process.platform === 'win32');
    }
    await Promise.all(active.map((record) => record.closePromise));
    this.jobs.clear();
  }
}

function normalizeTimeout(value: number | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_COMMAND_JOB_TIMEOUT_MS;
  return Math.min(Math.floor(value!), MAX_COMMAND_JOB_TIMEOUT_MS);
}

function normalizeMaxOutput(value: number | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_COMMAND_JOB_MAX_OUTPUT_BYTES;
  return Math.min(Math.floor(value!), MAX_COMMAND_JOB_OUTPUT_BYTES);
}

function appendOutput(snapshot: CommandJobSnapshot, stream: 'stdout' | 'stderr', chunk: Buffer) {
  const currentBytes = Buffer.byteLength(snapshot.stdout, 'utf8') + Buffer.byteLength(snapshot.stderr, 'utf8');
  const available = snapshot.maxOutputBytes - currentBytes;
  if (available <= 0) {
    snapshot.truncated = true;
    return;
  }
  if (chunk.length > available) snapshot.truncated = true;
  const kept = chunk.subarray(0, available);
  snapshot[stream] += kept.toString('utf8');
}

function killProcessTree(pid: number | undefined, isWin: boolean): Promise<void> {
  // The pid comes from our own spawned child, and taskkill gets a strict
  // argument array (no shell, no string building) so nothing user-supplied
  // can reach the command line.
  if (!pid || !Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  try {
    if (isWin) {
      return new Promise(resolve => {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('close', () => resolve()); killer.once('error', () => resolve());
      });
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    return Promise.resolve();
  } catch {
    // Ignore kill races; close/error events determine the final state.
    return Promise.resolve();
  }
}
