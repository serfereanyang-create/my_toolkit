import type { ToolDefinition } from '../tools/types.js';
import type { CheckpointEntry } from '../session/checkpoint.js';
import { applyUnifiedPatch } from './unifiedPatch.js';

export const applyUnifiedDiffTool: ToolDefinition<{
  patch: string;
  dryRun?: boolean;
  atomic?: boolean;
}> = {
  name: 'apply_unified_diff',
  description: 'Apply a unified diff text to the workspace (multi-file, dry-run supported, atomic rollback on failure).',
  inputHint: '{ "patch": "<diff text>", "dryRun": true, "atomic": true }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.patch !== 'string' || !r.patch.trim()) throw new Error('missing patch text');
    return {
      patch: r.patch,
      dryRun: r.dryRun === true,
      atomic: r.atomic !== false,
    };
  },

  async execute(input, context) {
    let checkpointId: string | undefined;
    let checkpoint: CheckpointEntry | undefined;
    if (input.dryRun !== true) {
      checkpoint = await context.checkpoints?.beforeWrite(context.workspaceRoot);
      checkpointId = checkpoint?.id;
    }

    const result = await applyUnifiedPatch({
      workspaceRoot: context.workspaceRoot,
      patchText: input.patch,
      dryRun: input.dryRun === true,
      atomic: input.atomic !== false,
    });

    // Only a patch that actually applied counts as having edited anything; a
    // dry run or a rejected patch must not land in the global edit record.
    if (result.ok) await context.checkpoints?.confirm(checkpoint);

    const headerLines: string[] = [
      input.dryRun === true ? '## Dry run result' : '## Apply result',
      '',
      `- files affected: ${result.filesAffected}`,
      `- ok: ${result.ok}`,
    ];
    for (const s of result.summary) {
      headerLines.push(`- [${s.action}] ${s.file} (+${s.bytesAdded} / -${s.bytesRemoved} bytes)`);
    }
    if (result.errors.length > 0) {
      headerLines.push('', '### Errors');
      for (const e of result.errors) headerLines.push(`- ${e}`);
    }
    return {
      ok: result.ok,
      output: headerLines.join('\n'),
      data: { ...result, checkpointId },
    };
  },
};

export const unifiedPatchTools = [applyUnifiedDiffTool];
