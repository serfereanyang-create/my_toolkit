import type { ReasoningEffort } from '../providers/types.js';
import type { TaskComplexityAnalysis } from '../tasks/complexity.js';
import type { ResolvedToolScope } from './scope.js';

/**
 * Why the tool scope in force is what it is.
 *
 * Without it the picker can only say "当前：完整", which is the value but not the
 * news. The two causes mean opposite things: `task-board`/`reasoning`/`complexity`
 * are THIS turn's signals, while `floor` means an earlier turn in this session
 * widened the surface and it will never narrow again — the case a user is most
 * likely to be surprised by, and the one that must be nameable rather than
 * blamed on the current prompt.
 */
export type ToolScopeReason = 'explicit' | 'task-board' | 'reasoning' | 'complexity' | 'floor';

/**
 * Which signal decided `effective`, derived AFTER the fact.
 *
 * Deriving it from the answer, not from the inputs, is what keeps the label
 * honest. The first cut read the effort the user *requested*, which is `off` by
 * default — so every auto resolution came out labelled `complexity`, including
 * the board and reasoning cases the field exists to distinguish. Comparing the
 * answer against what each signal would have produced isolates the one that
 * actually decided it, with the same precedence as `resolveToolScopeForTurn`.
 *
 * Lives outside the bridge because two callers need it: the desktop bridge,
 * and `agent.ts` -- which reports the scope for turns the bridge never sees
 * (task-board actions, automation runs, sub-agents) and must not import the
 * bridge to do so.
 */
export function classifyToolScopeReason(input: {
  effective: ResolvedToolScope;
  taskBoard: boolean;
  effort: ReasoningEffort;
  complexity: TaskComplexityAnalysis['complexity'];
  floored: boolean;
}): ToolScopeReason {
  if (input.floored) return 'floor';
  // Board and large are the same branch in scope.ts (`shouldUseTaskBoard ||
  // complexity === 'large'`), and callers set `taskBoard` from exactly that
  // test, so 'task-board' is the honest name for a large prompt too: a large
  // task is what puts the agent on the task board.
  if (input.taskBoard) return 'task-board';
  if (input.effort === 'high' || input.effort === 'max') return 'reasoning';
  // Whatever is left was decided by the turn's own size — compact for a small
  // prompt, standard for the default.
  return 'complexity';
}
