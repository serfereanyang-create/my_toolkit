import type { CommandPlan, ExtractionResult, PlannedToolStep } from './types.js';

const READONLY_EXECUTE_TOOLS = new Set([
  'disk_info',
  'disk_growth',
  'project_status',
  'project_index',
  'search_text',
  'read_file',
  'environment_info',
  'process_memory',
  'recent_activity',
]);

export function planCommand(extraction: ExtractionResult): CommandPlan {
  switch (extraction.intent) {
    case 'disk_capacity':
      return executeOrStrategy(extraction, [{ tool: 'disk_info', input: { drive: extraction.slots.drive ?? 'C' } }], ['disk_info'], ['run_command'], 'Disk capacity request.');
    case 'disk_growth':
      return executeOrStrategy(extraction, [{
        tool: 'disk_growth',
        input: {
          path: extraction.slots.path ?? '.',
          hours: extraction.slots.hours ?? 48,
          minMb: extraction.slots.minMb ?? 16,
          maxFiles: extraction.slots.limit ?? 30,
        },
      }], ['disk_growth'], ['list_files', 'run_command'], 'Disk growth request.');
    case 'file_read':
      if (!extraction.slots.path) {
        return strategy(extraction, ['read_file', 'project_index', 'search_text'], ['run_command'], 'Read intent missing path.');
      }
      return executeOrStrategy(extraction, [{ tool: 'read_file', input: { path: extraction.slots.path, maxBytes: 20000 } }], ['read_file'], ['run_command'], 'Explicit file read.');
    case 'code_search': {
      if (!extraction.slots.query && !extraction.slots.path) {
        return executeOrStrategy(
          { ...extraction, confidence: 'high' },
          [{ tool: 'project_index', input: { path: '.', maxFiles: 1000 } }],
          ['project_index', 'search_text', 'read_file'],
          ['list_files for broad discovery'],
          'Search intent missing query; start with project_index.',
        );
      }
      const steps: PlannedToolStep[] = [];
      const query = [extraction.slots.path, extraction.slots.query]
        .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index)
        .join(' ')
        .trim();
      if (query) {
        steps.push({
          tool: 'search_text',
          input: {
            query,
            path: '.',
            maxMatches: 20,
          },
        });
      }
      steps.push({ tool: 'project_index', input: { path: '.', maxFiles: 1000 } });
      return executeOrStrategy(extraction, steps, ['search_text', 'project_index', 'read_file'], ['list_files for broad discovery'], 'Code search request.');
    }
    case 'project_index':
      return executeOrStrategy(extraction, [{ tool: 'project_index', input: { path: extraction.slots.path ?? '.', maxFiles: 1000 } }], ['project_index'], ['run_command'], 'Project index request.');
    case 'project_status':
      return executeOrStrategy(extraction, [{ tool: 'project_status', input: {} }], ['project_status', 'project_index'], ['run_command'], 'Project status request.');
    case 'runtime_info':
      return executeOrStrategy(extraction, [{ tool: 'environment_info', input: { includeVersions: true } }], ['environment_info'], ['run_command'], 'Runtime info request.');
    case 'process_memory':
      return executeOrStrategy(extraction, [{ tool: 'process_memory', input: { limit: extraction.slots.limit ?? 10 } }], ['process_memory'], ['run_command'], 'Process memory request.');
    case 'recent_activity':
      return executeOrStrategy(extraction, [{ tool: 'recent_activity', input: { maxSessions: extraction.slots.limit ?? 5, maxFiles: 10 } }], ['recent_activity'], ['run_command'], 'Recent activity request.');
    case 'code_edit':
      return strategy(
        extraction,
        ['project_index', 'search_text', 'read_file', 'apply_patch', 'write_file'],
        ['run_command before inspection', 'write_file before reading target files'],
        'Code edit requests remain model-driven with inspect-first strategy.',
      );
    case 'shell_command':
      return strategy(
        extraction,
        ['project_status', 'run_command'],
        ['run_command when a dedicated tool exists'],
        'Shell requests remain approval-bound and model-driven.',
      );
    default:
      return strategy(extraction, [], ['run_command when a dedicated tool exists'], 'No strong executable intent.');
  }
}

function executeOrStrategy(
  extraction: ExtractionResult,
  steps: PlannedToolStep[],
  recommendedTools: string[],
  avoidTools: string[],
  reason: string,
): CommandPlan {
  const readonly = steps.every((step) => READONLY_EXECUTE_TOOLS.has(step.tool));
  if (extraction.confidence === 'high' && readonly && steps.length > 0) {
    return {
      mode: 'execute',
      steps,
      recommendedTools,
      avoidTools,
      reason,
    };
  }
  return {
    mode: 'strategy',
    steps: [],
    recommendedTools,
    avoidTools,
    reason,
  };
}

function strategy(
  extraction: ExtractionResult,
  recommendedTools: string[],
  avoidTools: string[],
  reason: string,
): CommandPlan {
  return {
    mode: 'strategy',
    steps: [],
    recommendedTools,
    avoidTools,
    reason: `${reason} confidence=${extraction.confidence}`,
  };
}
