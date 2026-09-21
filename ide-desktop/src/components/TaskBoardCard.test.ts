import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskBoardCard } from './TaskBoardCard';
import type { TaskBoard } from '../types';

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    id: 'board_1',
    title: '任务板规划落地',
    goal: '把大任务的规划权交给模型',
    status: 'draft',
    runtimeMode: 'awaiting_confirm',
    tasks: [
      { id: 'task_1', title: '实现 propose_plan 工具', status: 'pending', dependsOn: [] },
    ],
    ...overrides,
  };
}

function render(value: TaskBoard): string {
  return renderToStaticMarkup(createElement(TaskBoardCard, { board: value, onAction: () => {} }));
}

describe('TaskBoardCard', () => {
  it('renders an acceptance sentence sent as a string', () => {
    // The CLI declares `acceptance?: string`. The card used to treat it as a
    // list and call `.map()` on it, which threw here — and because the
    // ErrorBoundary wraps the app root, that white-screened the whole window.
    const markup = render(board({
      tasks: [{
        id: 'task_1',
        title: '实现 propose_plan 工具',
        status: 'pending',
        dependsOn: [],
        acceptance: '工具落盘并置为待批准',
      }],
    }));
    expect(markup).toContain('实现 propose_plan 工具');
  });

  it('renders an acceptance list from an older board shape', () => {
    const markup = render(board({
      tasks: [{
        id: 'task_1',
        title: '旧板',
        status: 'pending',
        dependsOn: [],
        acceptance: ['第一条', '第二条'] as unknown as string,
      }],
    }));
    expect(markup).toContain('旧板');
  });

  it('shows a finished task summary from resultSummary', () => {
    // The card read `task.result`, which the CLI never sends, so a completed
    // task's result was silently dropped.
    const markup = render(board({
      status: 'active',
      runtimeMode: 'executing',
      activeTaskId: 'task_1',
      tasks: [{
        id: 'task_1',
        title: '实现 propose_plan 工具',
        status: 'done',
        dependsOn: [],
        resultSummary: '已落盘 12 个用例',
      }],
    }));
    // The detail block only renders for the expanded task, and the active task
    // starts expanded.
    expect(markup).toContain('已落盘 12 个用例');
  });

  it('renders the plan document when the model wrote one', () => {
    const markup = render(board({ planMarkdown: '## 目标\n\n把规划权交给模型。' }));
    expect(markup).toContain('计划');
    expect(markup).toContain('把规划权交给模型。');
  });

  it('omits the plan section for a template board', () => {
    const markup = render(board());
    expect(markup).not.toContain('task-board-plan');
  });

  it('offers the full-plan toggle only when the plan is long', () => {
    const short = render(board({ planMarkdown: '## 目标\n短计划。' }));
    expect(short).not.toContain('查看完整计划');

    const long = render(board({
      planMarkdown: Array.from({ length: 14 }, (_, i) => `- 第 ${i + 1} 步：做点什么`).join('\n'),
    }));
    expect(long).toContain('查看完整计划');
  });

  it('shows the confirm button while the board waits for approval', () => {
    const markup = render(board());
    expect(markup).toContain('确认执行计划');
  });

  it('renders a board with no tasks without dividing by zero', () => {
    const markup = render(board({ tasks: [] }));
    expect(markup).toContain('0/0');
  });
});
