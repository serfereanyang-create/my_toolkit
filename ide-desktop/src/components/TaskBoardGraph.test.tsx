import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskBoardCard } from './TaskBoardCard';
import type { TaskBoard } from '../types';
import { inspectTaskGraph } from '../lib/taskGraph';

function board(tasks: TaskBoard['tasks']): TaskBoard { return { id: 'graph', title: 'Task graph', goal: 'Dependency review', status: 'active', runtimeMode: 'paused', tasks }; }
const render = (value: TaskBoard) => renderToStaticMarkup(createElement(TaskBoardCard, { board: value, onAction() {} }));
describe('task graph recovery UI', () => {
  it('a saved dependency cycle renders a readable error without crashing the application', () => {
    const cycle = board([{ id: 'a', title: 'A', status: 'pending', dependsOn: ['b'] }, { id: 'b', title: 'B', status: 'pending', dependsOn: ['a'] }]);
    expect(() => render(cycle)).not.toThrow();
    const markup = render(cycle);
    expect(markup).toContain('循环依赖'); expect(markup).not.toContain('继续任务计划');
  });
  it('a missing dependency is named and never presented as a runnable plan', () => {
    const markup = render(board([{ id: 'a', title: 'A', status: 'pending', dependsOn: ['ghost'] }]));
    expect(markup).toContain('依赖任务不存在'); expect(markup).toContain('ghost'); expect(markup).not.toContain('继续任务计划');
  });
  it('long and dense saved graphs use iterative levels without mutating stored dependencies', () => {
    const chain = Array.from({ length: 5000 }, (_entry, index) => ({ id: `c${index}`, title: String(index), status: 'pending', dependsOn: index ? [`c${index - 1}`] : [] }));
    expect(inspectTaskGraph(chain).levels.get('c4999')).toBe(5000);
    const dense = Array.from({ length: 80 }, (_entry, index) => ({ id: `d${index}`, title: String(index), status: 'pending', dependsOn: Array.from({ length: index }, (_parent, parent) => `d${parent}`) }));
    expect(inspectTaskGraph(dense).levels.get('d79')).toBe(80); expect(dense[79].dependsOn).toHaveLength(79);
  });
  it('bad task records show a local error while the plan card remains usable', () => {
    for (const tasks of [null, [null], [{ id: 'a', title: 'A', status: 'pending', dependsOn: 'wrong' }], [{ id: 'a', title: 'A', status: 'pending', dependsOn: [] }, { id: 'a', title: 'Duplicate', status: 'pending', dependsOn: [] }]]) {
      const markup = render(board(tasks as TaskBoard['tasks'])); expect(markup).toContain('任务依赖需要处理'); expect(markup).not.toContain('继续任务计划');
    }
  });
});
