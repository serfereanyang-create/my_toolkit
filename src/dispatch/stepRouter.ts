import type { DispatchTier } from './tierRouter.js';
import type { TaskComplexity } from '../tasks/complexity.js';

/**
 * stepRouter.ts — which tier a single model call runs on.
 *
 * The old behaviour was all-or-nothing: a turn either ran on the tier a user
 * had configured for a *delegated* sub-agent, or on one fixed model. Nothing
 * looked at what the call was actually doing, so the expensive model wrote
 * "done, I edited three files" boilerplate and the cheap model never got the
 * mechanical half of the work — which is where the money is.
 *
 * The rule set below is the whole policy, and it is a pure function on purpose:
 * every branch is a case a test can pin, and the loop stays readable.
 */

export type StepTierInput = {
  /** A planning turn (`/plan`, the task board): nothing but a plan comes out. */
  planning: boolean;
  complexity: TaskComplexity;
  /** 0-based step index within the turn. */
  step: number;
  /** Present when the turn has a step budget; used to spot the last call. */
  stepBudget?: number;
  /** Whether a tool has run successfully earlier in this turn. */
  ranTool: boolean;
  /** Whether the immediately preceding step ended in a tool failure. */
  lastStepFailed: boolean;
  /** Consecutive tool failures, for escalation. */
  consecutiveFailures: number;
};

/**
 * Pick the tier for the next model call.
 *
 * Order matters and is the policy:
 *   1. Planning → expensive. A plan is the cheapest place to buy judgement.
 *   2. Recovery after a failure → one rung up: the model is stuck, and the
 *      cheap model that got stuck is the last thing to ask again.
 *   3. The last budgeted call → expensive: whatever it says is what the user
 *      gets, and a rushed cheap summary of real work is the worst trade in the
 *      table.
 *   4. Step 0 of a turn → by task complexity (a one-line question does not
 *      need the flagship).
 *   5. Following through on tool results → cheap: this is the "read this output,
 *      now write the patch / say what happened" half. It is the bulk of the
 *      calls and the part a small model does well.
 *   6. Otherwise → standard.
 */
export function pickStepTier(input: StepTierInput): DispatchTier {
  if (input.planning) return 'expensive';

  if (input.lastStepFailed) {
    // One failure: give it a better model than the one that just failed.
    // Repeated failure: it is not a competence problem, buy the top model.
    return input.consecutiveFailures >= 2 ? 'expensive' : 'standard';
  }

  if (typeof input.stepBudget === 'number' && input.stepBudget > 0 && input.step >= input.stepBudget - 1) {
    return 'expensive';
  }

  if (input.step === 0) {
    switch (input.complexity) {
      case 'large':
        return 'expensive';
      case 'standard':
        return 'standard';
      case 'small':
        return 'cheap';
    }
  }

  if (input.ranTool) return 'cheap';
  return 'standard';
}
