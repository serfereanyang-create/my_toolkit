import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refactorPreviewTool } from './tools.js';

const context = (workspaceRoot: string) => ({ workspaceRoot, approval: 'deny' as const });

describe('refactor_preview', () => {
  it('previews Extract Method without writing the source file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'aicode-refactor-preview-'));
    try {
      const source = [
        'export function calculate(value: number) {',
        '  const doubled = value * 2;',
        '  return doubled + 1;',
        '}',
      ].join('\n');
      await writeFile(join(workspaceRoot, 'sample.ts'), source, 'utf8');

      const input = refactorPreviewTool.validate({
        file: 'sample.ts',
        operations: [{ type: 'extract', startLine: 2, endLine: 3, name: 'computeResult' }],
      });
      const result = await refactorPreviewTool.execute(input, context(workspaceRoot));

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ original: source });
      expect((result.data as { modified: string }).modified).toContain('computeResult');
      expect(await readFile(join(workspaceRoot, 'sample.ts'), 'utf8')).toBe(source);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('previews Rename Symbol and keeps the write behind the approval flow', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'aicode-refactor-preview-'));
    try {
      const source = ['const count = 1;', 'console.log(count);'].join('\n');
      await writeFile(join(workspaceRoot, 'sample.ts'), source, 'utf8');

      const input = refactorPreviewTool.validate({
        file: 'sample.ts',
        operations: [{ type: 'rename', line: 1, column: 7, newName: 'totalCount' }],
      });
      const result = await refactorPreviewTool.execute(input, context(workspaceRoot));

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ oldName: 'count', newName: 'totalCount' });
      expect(await readFile(join(workspaceRoot, 'sample.ts'), 'utf8')).toBe(source);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
