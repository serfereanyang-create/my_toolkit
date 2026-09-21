import type { AgentRuntime } from '../agent/agent.js';
import type { ToolDefinition, ToolResult } from '../tools/index.js';
import { planBoardFromModel, type ProposedPlan, type ProposedTask } from './planner.js';
import { formatBoard } from './runtime.js';
import { TaskBoardStore } from './store.js';
import type { TaskBoard } from './types.js';

/** Hard ceiling on proposed steps: a 60-step plan is a plan nobody reviews. */
const MAX_PROPOSED_TASKS = 30;

/**
 * Validate the model's `propose_plan` call.
 *
 * The body and the executable steps arrive in one call on purpose. Parsing the
 * Markdown back into steps would make the board depend on prose formatting the
 * model is free to vary, and a parse failure would leave a plan with no steps.
 */
export function validateProposePlanInput(raw: unknown): ProposedPlan {
  if (!raw || typeof raw !== 'object') {
    throw new Error('propose_plan: input must be an object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['planMarkdown'] !== 'string' || !obj['planMarkdown'].trim()) {
    throw new Error('propose_plan: "planMarkdown" must be a non-empty string');
  }
  if (!Array.isArray(obj['tasks'])) {
    throw new Error('propose_plan: "tasks" must be an array');
  }
  if (obj['tasks'].length === 0) {
    throw new Error('propose_plan: "tasks" must contain at least one step');
  }
  if (obj['tasks'].length > MAX_PROPOSED_TASKS) {
    throw new Error(`propose_plan: at most ${MAX_PROPOSED_TASKS} steps per plan`);
  }
  if (obj['title'] !== undefined && typeof obj['title'] !== 'string') {
    throw new Error('propose_plan: "title" must be a string or omitted');
  }

  const tasks: ProposedTask[] = (obj['tasks'] as unknown[]).map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`propose_plan: tasks[${index}] must be an object`);
    }
    const task = item as Record<string, unknown>;
    if (typeof task['title'] !== 'string' || !task['title'].trim()) {
      throw new Error(`propose_plan: tasks[${index}].title must be a non-empty string`);
    }
    if (task['id'] !== undefined && typeof task['id'] !== 'string') {
      throw new Error(`propose_plan: tasks[${index}].id must be a string or omitted`);
    }
    if (task['dependsOn'] !== undefined && !Array.isArray(task['dependsOn'])) {
      throw new Error(`propose_plan: tasks[${index}].dependsOn must be an array or omitted`);
    }
    return {
      id: typeof task['id'] === 'string' ? task['id'] : undefined,
      title: task['title'],
      detail: typeof task['detail'] === 'string' ? task['detail'] : undefined,
      acceptance: typeof task['acceptance'] === 'string' ? task['acceptance'] : undefined,
      dependsOn: Array.isArray(task['dependsOn'])
        ? (task['dependsOn'] as unknown[]).filter((dep): dep is string => typeof dep === 'string')
        : undefined,
    };
  });

  return {
    title: typeof obj['title'] === 'string' ? obj['title'] : undefined,
    planMarkdown: obj['planMarkdown'],
    tasks,
  };
}

/**
 * Create the `propose_plan` tool definition.
 *
 * Must be called after the runtime is assembled: it closes over the runtime to
 * persist the board, set the session's task runtime, and emit to the desktop.
 */
export function createProposePlanTool(runtime: AgentRuntime): ToolDefinition {
  return {
    name: 'propose_plan',
    description: [
      '为一个多步骤任务提交一份可执行的计划，交给用户审批。',
      '调用后本轮结束：用户看到计划书，批准后才开始执行。',
      '',
      '计划书正文和可执行步骤要一次给全：',
      '  planMarkdown  计划正文（Markdown）。写清目标、关键改动点、涉及文件、',
      '                风险与取舍、验证方式。这是用户真正读的东西，不要只写步骤清单。',
      '  tasks         可执行步骤。每步一个对象：',
      '                  id         步骤标识（省略则自动编号 task_1、task_2…）',
      '                  title      一句话说明这一步做什么',
      '                  detail     可选，这一步的具体做法',
      '                  acceptance 可选，判定这一步完成的依据',
      '                  dependsOn  可选，依赖的其他步骤 id（不填则与前面无依赖）',
      '',
      '先用只读工具把项目看清楚再写计划 —— 计划要落到真实文件上，不要泛泛而谈。',
      '步骤粒度按「一次可验证的改动」划分，不要把整个任务写成一步。',
    ].join('\n'),
    inputHint: JSON.stringify({
      title: '为登录流程加上记住我',
      planMarkdown: [
        '## 目标',
        '登录页增加「记住我」，勾选后 30 天内免登录。',
        '',
        '## 关键改动',
        '- `src/auth/session.ts`：签发长期 token，带 `remember` 声明',
        '- `src/pages/Login.tsx`：勾选框与提交参数',
        '',
        '## 风险',
        '长期 token 落在 localStorage 会被 XSS 读取，改为 httpOnly cookie。',
        '',
        '## 验证',
        '`npm test -- auth` 通过；手动勾选后重启应用仍在登录态。',
      ].join('\n'),
      tasks: [
        {
          id: 'session',
          title: '在 session.ts 签发带 remember 声明的长期 token',
          detail: '复用现有签发函数，新增 expiresIn 参数',
          acceptance: '单元测试覆盖 30 天有效期与默认 2 小时两种情况',
          dependsOn: [],
        },
        {
          id: 'ui',
          title: '登录页增加记住我勾选框并透传参数',
          acceptance: '勾选后请求体带 remember: true',
          dependsOn: ['session'],
        },
      ],
    }, null, 2),
    // The board lives under .aicode/, which is agent state rather than project
    // content — same class as the session record, so it needs no approval.
    risk: 'read',
    validate: validateProposePlanInput,
    async execute(input: ProposedPlan): Promise<ToolResult> {
      // Sub-agents work inside a step of an existing plan; letting one open a
      // new board would leave the user reviewing a plan for the wrong goal.
      if ((runtime.subAgentDepth ?? 0) > 0) {
        return {
          ok: false,
          output: 'propose_plan 只能由主智能体调用。请直接完成当前子任务并把结果作为回答返回。',
        };
      }

      try {
        const board = await persistProposal(runtime, input);
        runtime.planProposed = true;
        return {
          ok: true,
          output: [
            `计划已提交（boardId: ${board.id}，共 ${board.tasks.length} 步），当前状态：等待用户批准。`,
            '本轮到此为止：不要开始执行，也不要再调用写文件或运行命令的工具。',
            '用户批准后系统会自动把每一步派发给智能体执行。',
            '',
            '用一两句话向用户说明这份计划的核心判断，然后结束回复。',
          ].join('\n'),
          data: { boardId: board.id, taskCount: board.tasks.length, status: board.status },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `propose_plan 失败: ${message}` };
      }
    },
  };
}

/**
 * Persist the proposal and park the session on it.
 *
 * A re-proposal replaces the session's existing draft board in place rather than
 * creating a second one — otherwise asking the model to revise its plan would
 * leave the user with two cards, one of them stale.
 */
async function persistProposal(runtime: AgentRuntime, input: ProposedPlan): Promise<TaskBoard> {
  const store = new TaskBoardStore(runtime.config.workspaceRoot);
  const existingId = runtime.session.taskRuntime?.boardId;
  let previous: TaskBoard | undefined;
  if (existingId) {
    try {
      const loaded = await store.load(existingId);
      if (loaded.status === 'draft') previous = loaded;
    } catch {
      // A board id pointing at a deleted file is not an error: just make a new one.
    }
  }

  const board = planBoardFromModel(runtime.planGoal ?? previous?.goal ?? input.title ?? '', input);
  if (previous) {
    board.id = previous.id;
    board.createdAt = previous.createdAt;
  }

  await store.save(board);
  runtime.session.taskRuntime = {
    boardId: board.id,
    mode: 'awaiting_confirm',
    lastSyncAt: board.updatedAt,
  };
  await runtime.sessions.save(runtime.session);
  runtime.taskBoardEmit?.(board);
  runtime.ui.info(formatBoard(board));
  return board;
}
