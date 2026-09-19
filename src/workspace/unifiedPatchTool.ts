import type { ToolDefinition } from '../tools/types.js';
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
    if (input.dryRun !== true) {
      const store = context.checkpoints;
      if (store) {
        const cp = await store.beforeWrite(context.workspaceRoot);
        checkpointId = cp?.id;
      }
    }

    const result = await applyUnifiedPatch({
      workspaceRoot: context.workspaceRoot,
      patchText: input.patch,
      dryRun: input.dryRun === true,
      atomic: input.atomic !== false,
    });

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
