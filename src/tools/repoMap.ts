import type { ToolDefinition } from './types.js';
import { loadOrBuildRepositoryMap } from '../nav/repoMap.js';

export const repoMapTool: ToolDefinition<{ refresh?: boolean }> = {
  name: 'repo_map',
  description: 'Generate a repository structure map: modules, exports, imports for TS/JS files. Use to understand project layout or find where functionality lives.',
  inputHint: '{ "refresh": false }',
  risk: 'read',
  validate(input) {
    const record = (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input as Record<string, unknown> : {};
    return {
      refresh: typeof record.refresh === 'boolean' ? record.refresh : false,
    };
  },
  async execute(input, context) {
    const map = await loadOrBuildRepositoryMap(context.workspaceRoot, input.refresh);
    
    const lines: string[] = [];
    lines.push(`# Repository Map (${map.modules.length} modules, ${map.summary.totalFiles} files, ${map.summary.totalLines.toLocaleString()} lines)`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- **Total files:** ${map.summary.totalFiles}`);
    lines.push(`- **Total lines:** ${map.summary.totalLines.toLocaleString()}`);
    lines.push(`- **Modules with exports:** ${map.modules.length}`);
    lines.push(`- **Languages:** ${Object.entries(map.summary.languages).slice(0, 10).map(([ext, count]) => `${ext}:${count}`).join(', ')}`);
    lines.push('');
    lines.push('## Modules');
    lines.push('');
    
    // Group by directory
    const byDir = new Map<string, typeof map.modules>();
    for (const mod of map.modules) {
      const dir = mod.path.includes('/') ? mod.path.split('/').slice(0, -1).join('/') : '.';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(mod);
    }
    
    // Output top directories first
    const sortedDirs = Array.from(byDir.entries()).sort((a, b) => {
      const aDepth = a[0].split('/').length;
      const bDepth = b[0].split('/').length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      return a[0].localeCompare(b[0]);
    });
    
    for (const [dir, mods] of sortedDirs.slice(0, 50)) { // Limit to 50 directories
      lines.push(`### ${dir || 'root'}`);
      lines.push('');
      for (const mod of mods.slice(0, 20)) { // Limit to 20 modules per dir
        const fileName = mod.path.split('/').pop() || mod.path;
        const exportsStr = mod.exports.length > 0 ? mod.exports.slice(0, 5).join(', ') : '(no exports)';
        const importsStr = mod.imports.length > 3 ? `${mod.imports.slice(0, 3).join(', ')}, ...` : mod.imports.join(', ');
        lines.push(`**${fileName}** (${mod.lines} lines)`);
        lines.push(`- Exports: ${exportsStr}`);
        if (importsStr) lines.push(`- Imports: ${importsStr}`);
        lines.push('');
      }
    }
    
    if (map.summary.totalFiles >= 5000) {
      lines.push('');
      lines.push('⚠️  Reached file limit (5000). Some files may not be indexed.');
    }
    
    return {
      ok: true,
      output: lines.join('\n'),
      data: { 
        modules: map.modules.length, 
        files: map.summary.totalFiles, 
        cached: !input.refresh,
        map, // Full map for programmatic use
      },
    };
  },
};
