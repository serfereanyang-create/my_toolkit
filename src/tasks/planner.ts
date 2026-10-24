import { randomUUID } from 'node:crypto';
import { inspectTaskGraph } from './graph.js';
import { classifyTaskComplexity } from './complexity.js';
import type { TaskBoard, TaskItem } from './types.js';

/** Keep the task-board decision on the shared prompt-level complexity result. */
export function shouldUseTaskBoard(prompt: string): boolean {
  return classifyTaskComplexity(prompt) === 'large';
}

/**
 * Instruction appended to the newest user message of a planning turn.
 *
 * It lives here rather than in the system prompt because the system prompt is
 * the cached prefix: a per-turn instruction in it would invalidate the cache
 * from byte zero on every planning turn. The newest message sits after the
 * sliding cache breakpoint, so it costs nothing.
 */
export const PLANNING_TURN_INSTRUCTION = [
  '<planning-turn>',
  '这是一个多步骤任务，先写计划、不要动手改代码。',
  '',
  '1. 先调查，但要有度：读少量关键文件（大约 3-6 次工具调用）够写出落到真实路径的计划就停。',
  '   不要为了"看全"反复读同一批文件 —— 计划是可以修订的，写清楚已知部分比读全更重要。',
  '2. 调用 propose_plan 提交计划：planMarkdown 写计划正文，tasks 写可执行步骤。',
  '3. 提交后本轮结束，等用户批准。不要开始执行。',
  '',
  '计划正文要写清：目标、关键改动点与涉及文件、风险与取舍、验证方式。',
  '调查预算已用掉大半仍未提交计划时，就用手头的信息提交 —— 不要继续读文件。',
  '</planning-turn>',
].join('\n');

/**
 * Steps a planning turn may spend before it is cut off.
 *
 * Deliberately far below the normal turn budget: the survey only has to be good
 * enough to write a plan the user can review and ask to revise. A model left on
 * the full budget can loop on file reads and never propose, which silently
 * degrades the whole feature back to the template board.
 */
export const PLANNING_TURN_MAX_STEPS = 8;

/**
 * Last-call nudge appended once the planning turn is nearly out of budget.
 *
 * The model that ignores the step budget usually ignores it because it still
 * believes it is exploring. Telling it the budget is gone is what turns the
 * remaining step into a proposal instead of one more read.
 */
export const PLANNING_TURN_FINAL_CALL = [
  '<planning-turn-final-call>',
  '调查预算已经用完。立刻调用 propose_plan 提交计划 —— 用手上已有的信息写，',
  '不确定的地方在计划正文里标为待确认，不要再调用任何读取工具。',
  '</planning-turn-final-call>',
].join('\n');

export function planBoardFromGoal(goal: string, now = new Date()): TaskBoard {
  const createdAt = now.toISOString();
  const id = `board_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const titles = defaultTaskTitles(goal);
  const tasks: TaskItem[] = titles.map((title, index) => ({
    id: `task_${index + 1}`,
    title,
    detail: index === 0 ? `Goal: ${goal}` : undefined,
    status: 'pending',
    dependsOn: index === 0 ? [] : [`task_${index}`],
    acceptance: defaultAcceptance(title),
  }));

  return {
    id,
    title: summarizeTitle(goal),
    goal,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
    tasks,
  };
}

/** One task as the model proposed it in `propose_plan`. */
export type ProposedTask = {
  id?: string;
  title: string;
  detail?: string;
  acceptance?: string;
  dependsOn?: string[];
};

export type ProposedPlan = {
  title?: string;
  planMarkdown: string;
  tasks: ProposedTask[];
};

/**
 * Build a draft board from a plan the model actually wrote.
 *
 * Unlike `planBoardFromGoal` this carries the model's prose (`planMarkdown`) and
 * its own task decomposition, so the desktop can show a real plan document. The
 * board still starts as `draft` — nothing executes until the user approves it.
 */
export function planBoardFromModel(goal: string, proposal: ProposedPlan, now = new Date()): TaskBoard {
  const createdAt = now.toISOString();
  const id = `board_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const tasks = normalizeProposedTasks(proposal.tasks, goal);
  const graph = inspectTaskGraph(tasks);
  if (graph.issues.length) throw new Error(`计划依赖无效：${graph.issues.join('；')}`);

  return {
    id,
    title: summarizeTitle(proposal.title?.trim() || goal),
    goal,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
    planMarkdown: proposal.planMarkdown.trim(),
    tasks,
  };
}

/**
 * Resolve omitted ids without changing explicit dependency relationships.
 * The graph check rejects ambiguous references before a proposal is persisted.
 */
function normalizeProposedTasks(tasks: ProposedTask[], goal: string): TaskItem[] {
  const explicitIds = new Set<string>();
  for (const task of tasks) {
    const id = task.id?.trim();
    if (!id) continue;
    if (explicitIds.has(id)) throw new Error(`任务编号重复：${id}`);
    explicitIds.add(id);
  }
  const finalIds = new Set<string>();
  const resolved = tasks.map((task, index) => {
    let id = (task.id ?? '').trim() || `task_${index + 1}`;
    // A duplicate id would make `dependsOn` ambiguous and let one task's
    // completion satisfy two nodes.
    let suffix = 2;
    while (finalIds.has(id) || !task.id?.trim() && explicitIds.has(id)) id = `task_${index + 1}_${suffix++}`;
    finalIds.add(id);
    return { task, index, id };
  });

  return resolved.map(({ task, index, id }) => {
    const dependsOn = [...new Set((task.dependsOn ?? []).map(dep => dep.trim()))];
    return {
      id,
      title: task.title.trim() || `Step ${index + 1}`,
      detail: task.detail?.trim() || (index === 0 ? `Goal: ${goal}` : undefined),
      status: 'pending' as const,
      dependsOn,
      acceptance: task.acceptance?.trim() || undefined,
    };
  });
}

function defaultTaskTitles(goal: string): string[] {
  const normalized = goal.toLowerCase();
  if (hasAny(normalized, ['登录', 'login', 'auth'])) {
    return ['Inspect existing auth/login code', 'Implement login changes', 'Add or update tests', 'Verify login behavior'];
  }
  if (hasAny(normalized, ['任务板', 'task board', '看板'])) {
    return [
      'Design and persist task board model',
      'Implement plan confirm and auto-run loop',
      'Add /plan controls and resume support',
      'Cover with automated tests',
    ];
  }
  return [
    'Inspect relevant project context',
    'Implement the core change',
    'Add or update tests',
    'Verify the result and summarize',
  ];
}

function defaultAcceptance(title: string) {
  return `Done when: ${title.toLowerCase()} is complete and residual risks are noted.`;
}

function summarizeTitle(goal: string) {
  const compact = goal.replace(/\s+/g, ' ').trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

function countSteps(value: string) {
  return value.split(/[，。；;\n]|然后|接着|并|and then|then/).map((part) => part.trim()).filter(Boolean).length;
}

function normalizePlannerPrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return '';
  const attachmentIndex = trimmed.search(/\n\s*\[attachments\]\s*(?:\n|$)/i);
  const withoutAttachments = attachmentIndex >= 0 ? trimmed.slice(0, attachmentIndex) : trimmed;
  return withoutAttachments.trim().toLowerCase();
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}
