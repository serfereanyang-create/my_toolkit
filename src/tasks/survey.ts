import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { TaskComplexityAnalysis } from './complexity.js';

/**
 * Investigation-before-editing for ordinary coding turns.
 *
 * The task board (planner.ts) only covers `large` work: a `standard` request
 * like "把登录页的样式改一下" went straight to whatever tool the model named
 * first, usually a write, without ever reading the code it was about to
 * change. This is the lighter counterpart: the model may investigate freely,
 * must say in a couple of sentences what it intends to change, and cannot
 * write until it has read something.
 *
 * The rule itself is one line of the stable system prompt (providers/protocol.ts):
 * it is true for every turn, so it belongs in the cached prefix rather than in a
 * per-turn message the model would read as part of the request. What lives here
 * is the enforcement: mutating tools are refused while nothing has been read
 * this turn. Models do ignore instructions, and a blind write is exactly the
 * failure being fixed.
 */

/**
 * Tools whose whole purpose is to look at the code. Any successful one of these
 * counts as "the model has looked"; the tools below that only touch code after
 * an edit are not on the list (`git_status` gives context, `git_diff` shows a
 * change already made, and neither tells the model what the file contains).
 */
export const SURVEY_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'read_lines',
  'read_many_files',
  'read_json',
  'read_csv',
  'list_files',
  'list_dirs',
  'list_tree',
  'glob_files',
  'find_files',
  'filename_search',
  'search_text',
  'codebase_search',
  'semantic_search',
  'file_info',
  'project_index',
  'repo_map',
  'find_symbol',
  'find_references',
  'ts_goto_definition',
  'ts_hover',
  'impact_analysis',
  'dependency_tree',
  'count_files',
]);

/**
 * Tools that edit content that already exists. Always gated: there is nothing
 * they can do that does not depend on knowing what the file says.
 */
const ALWAYS_GATED: ReadonlySet<string> = new Set([
  'apply_patch',
  'apply_unified_diff',
  'edit_lines',
  'replace_text',
]);

/**
 * Tools that may either create something new or overwrite something existing.
 * Gated only when the target is already there — writing a brand-new file needs
 * nothing read first, and gating it taught the mock provider's "write this file,
 * then read it back" flow to trip over the gate instead of doing the task.
 */
const GATED_WHEN_TARGET_EXISTS: ReadonlySet<string> = new Set([
  'write_file',
  'append_file',
  'copy_file',
  'delete_path',
  'rename_file',
]);

/** Every name the gate can refuse, for callers that filter tool lists. */
export const SURVEY_MUTATING_TOOLS: ReadonlySet<string> = new Set([...ALWAYS_GATED, ...GATED_WHEN_TARGET_EXISTS]);

function primaryTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'file', 'target', 'destination', 'to']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Whether this call must wait until something has been read.
 *
 * Conservative only where it pays: a patch is refused outright, a plain write is
 * refused when it would overwrite an existing file. An input shape we cannot
 * read is left to the tool's own validation rather than refused here — the gate
 * exists to stop blind edits, not to become a second schema checker.
 */
export function surveyBlocksTool(tool: string, input: unknown, workspaceRoot?: string): boolean {
  if (ALWAYS_GATED.has(tool)) return true;
  if (!GATED_WHEN_TARGET_EXISTS.has(tool)) return false;
  const target = primaryTarget(input);
  if (!target) return false;
  try {
    const resolved = isAbsolute(target) ? target : resolve(workspaceRoot ?? '.', target);
    return existsSync(resolved);
  } catch {
    return false;
  }
}

/**
 * Whether this turn needs the survey gate.
 *
 * Read-only and small-talk turns do not: there is nothing to protect, and
 * adding an instruction to them only costs cache and attention. A planning turn
 * already carries a stricter contract (survey, then propose_plan), so the gate
 * stands down there instead of stacking two instructions.
 */
export function shouldSurveyFirst(
  analysis: Pick<TaskComplexityAnalysis, 'complexity' | 'hasWriteIntent'>,
  planActive = false,
): boolean {
  if (planActive) return false;
  if (!analysis.hasWriteIntent) return false;
  return analysis.complexity !== 'small';
}

/** Tool result returned when the model edits before reading. */
export function surveyRefusal(tool: string): string {
  return [
    `工具 ${tool} 已拒绝：本轮还没有读过任何代码。`,
    '先用 search_text / glob_files / read_file 找到相关文件并读懂现有写法，',
    '再在回复里说清要改哪些文件、怎么改、怎么验证，然后才动手。',
    '（只读任务不受影响；需要计划板请用 /plan。）',
  ].join('');
}
