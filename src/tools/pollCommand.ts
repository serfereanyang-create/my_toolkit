import type { CommandJobSnapshot } from '../safety/commandJobs.js';
import type { ToolDefinition } from './types.js';

type PollCommandInput = { jobId: string; waitMs?: number; maxBytes?: number };

export const pollCommandTool: ToolDefinition<PollCommandInput> = {
  name: 'poll_command',
  description: 'Poll an in-process background command job by jobId and return its current status and bounded output.',
  inputHint: '{ "jobId": "job_..." }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.jobId !== 'string' || record.jobId.trim() === '') throw new Error('jobId is required');
    if (record.waitMs !== undefined && (typeof record.waitMs !== 'number' || !Number.isFinite(record.waitMs) || record.waitMs < 0)) throw new Error('waitMs must be a non-negative number');
    if (record.maxBytes !== undefined && (typeof record.maxBytes !== 'number' || !Number.isFinite(record.maxBytes) || record.maxBytes <= 0)) throw new Error('maxBytes must be a positive number');
    return {
      jobId: record.jobId.trim(),
      waitMs: typeof record.waitMs === 'number' ? Math.min(Math.floor(record.waitMs), 5000) : undefined,
      maxBytes: typeof record.maxBytes === 'number' ? Math.min(Math.floor(record.maxBytes), 1024 * 1024) : undefined,
    };
  },
  async execute(input, context) {
    if (input.waitMs && input.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, input.waitMs));
    }
    const snapshot = context.commandJobs?.poll(input.jobId);
    if (!snapshot) {
      return {
        ok: false,
        output: `Background command job not found: ${input.jobId}. Jobs are in-process only and cannot be queried across processes.`,
        data: { jobId: input.jobId, status: 'not_found' },
      };
    }
    return {
      ok: true,
      output: formatPollOutput(snapshot, input.maxBytes),
      data: snapshot,
    };
  },
};

function formatPollOutput(snapshot: CommandJobSnapshot, maxBytes = 1024 * 1024) {
  const output = [snapshot.stdout.trim(), snapshot.stderr.trim()].filter(Boolean).join('\n').slice(0, maxBytes);
  const truncated = snapshot.truncated ? ' (output truncated)' : '';
  return [
    `Job ${snapshot.jobId}: ${snapshot.status}`,
    `exitCode=${snapshot.code ?? 'null'}${snapshot.signal ? ` signal=${snapshot.signal}` : ''}${truncated}`,
    output || '(no output)',
  ].join('\n');
}
