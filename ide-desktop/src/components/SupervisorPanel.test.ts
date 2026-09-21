import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupervisorPanel } from './SupervisorPanel';
import type { SupervisorSnapshot } from '../types';

function snapshot(overrides: Partial<SupervisorSnapshot> = {}): SupervisorSnapshot {
  return {
    units: [],
    running: 0,
    done: 0,
    failed: 0,
    steps: 0,
    ...overrides,
  };
}

function render(value: SupervisorSnapshot | null): string {
  return renderToStaticMarkup(createElement(SupervisorPanel, { snapshot: value }));
}

describe('SupervisorPanel', () => {
  it('shows an empty state before anything runs', () => {
    const markup = render(null);
    expect(markup).toContain('暂无工作单元');
  });

  it('renders each unit with its kind, steps and status', () => {
    const markup = render(snapshot({
      units: [{
        id: 'worker',
        kind: 'subagent',
        label: '重构 tasks 模块',
        status: 'running',
        steps: 12,
        startedAt: Date.now() - 5_000,
        updatedAt: Date.now(),
      }],
      running: 1,
      steps: 12,
      longestRunningMs: 5_000,
    }));
    expect(markup).toContain('子智能体');
    expect(markup).toContain('重构 tasks 模块');
    expect(markup).toContain('12 步');
    expect(markup).toContain('运行中');
  });

  it('flags a rollover segment so one unit with several sessions makes sense', () => {
    const markup = render(snapshot({
      units: [{
        id: 'worker',
        kind: 'subagent',
        label: '长任务',
        status: 'running',
        segment: 2,
        steps: 40,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }],
      running: 1,
      steps: 40,
    }));
    expect(markup).toContain('第 2 段');
  });

  it('omits the segment badge for a first segment', () => {
    const markup = render(snapshot({
      units: [{
        id: 'worker',
        kind: 'subagent',
        label: '任务',
        status: 'running',
        segment: 1,
        steps: 1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }],
      running: 1,
      steps: 1,
    }));
    expect(markup).not.toContain('第 1 段');
  });

  it('surfaces a failure and its error text', () => {
    const markup = render(snapshot({
      units: [{
        id: 'task_1',
        kind: 'task',
        label: '补测试',
        status: 'failed',
        steps: 4,
        startedAt: 0,
        updatedAt: 0,
        error: '工具失败',
      }],
      failed: 1,
      steps: 4,
    }));
    expect(markup).toContain('失败');
    expect(markup).toContain('工具失败');
  });

  it('does not show the longest-running line when nothing runs', () => {
    const markup = render(snapshot({ units: [], steps: 0 }));
    expect(markup).toContain('暂无工作单元');
    expect(markup).not.toContain('最久的运行中单元');
  });
});
