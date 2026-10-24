import { describe, expect, it } from 'vitest';
import { baseName, displayPath, isWorkspaceRoot, summarizePath } from './paths';

describe('paths', () => {
  describe('isWorkspaceRoot', () => {
    it('recognises the two spellings of the workspace root', () => {
      expect(isWorkspaceRoot('.')).toBe(true);
      expect(isWorkspaceRoot('./')).toBe(true);
    });

    it('does not mistake a dotfile or a nested dot path for the root', () => {
      expect(isWorkspaceRoot('.gitignore')).toBe(false);
      expect(isWorkspaceRoot('./src')).toBe(false);
      expect(isWorkspaceRoot('..')).toBe(false);
      expect(isWorkspaceRoot('')).toBe(false);
    });
  });

  describe('displayPath', () => {
    it('names the workspace root instead of printing a bare dot', () => {
      expect(displayPath('.')).toBe('当前目录');
      expect(displayPath('./')).toBe('当前目录');
    });

    it('leaves real paths alone', () => {
      expect(displayPath('src/App.tsx')).toBe('src/App.tsx');
      expect(displayPath('C:\\proj\\src\\main.ts')).toBe('C:\\proj\\src\\main.ts');
    });
  });

  describe('baseName', () => {
    it('returns the last segment for POSIX and Windows paths', () => {
      expect(baseName('src/components/ToolCard.tsx')).toBe('ToolCard.tsx');
      expect(baseName('C:\\proj\\src\\main.ts')).toBe('main.ts');
    });

    it('ignores a trailing separator', () => {
      expect(baseName('src/components/')).toBe('components');
      expect(baseName('C:\\proj\\src\\')).toBe('src');
    });

    it('returns a bare name unchanged', () => {
      expect(baseName('README.md')).toBe('README.md');
    });
  });

  describe('summarizePath', () => {
    it('summarizes the workspace root by name and files by base name', () => {
      expect(summarizePath('.')).toBe('当前目录');
      expect(summarizePath('src/lib/paths.ts')).toBe('paths.ts');
    });
  });
});
