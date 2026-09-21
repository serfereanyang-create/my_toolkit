import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingsList, PriorityBadge, ReviewReport, findingLocation, groupByPriority } from './ReviewReport';
import type { ReviewFinding } from '../types';

/*
 * The review UI has one job that matters more than layout: it must never let a
 * review that FAILED, or whose reply could not be read, look like a review that
 * found nothing. Those three states are asserted separately below.
 */

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { title: 'Something is wrong', body: 'Because of reasons.', ...overrides };
}

function report(overrides: Partial<Parameters<typeof ReviewReport>[0]['review']> = {}) {
  return renderToStaticMarkup(createElement(ReviewReport, {
    review: { label: '未提交的改动', ok: true, findings: [], outcome: 'correct', ...overrides },
  }));
}

function render(value: Parameters<typeof ReviewReport>[0]['review']): string {
  return renderToStaticMarkup(createElement(ReviewReport, { review: value }));
}

describe('PriorityBadge', () => {
  it('labels 0-3 as P0-P3', () => {
    for (const [priority, label] of [[0, 'P0'], [1, 'P1'], [2, 'P2'], [3, 'P3']] as const) {
      expect(renderToStaticMarkup(createElement(PriorityBadge, { priority }))).toContain(label);
    }
  });

  it('shows 未分级 rather than inventing a level', () => {
    // Defaulting a missing priority to P2 would invent a severity the reviewer
    // never stated, and would sort an unknown finding among the known ones.
    const markup = renderToStaticMarkup(createElement(PriorityBadge, { priority: undefined }));
    expect(markup).toContain('未分级');
    expect(markup).not.toContain('P2');
  });
});

describe('groupByPriority', () => {
  it('orders groups worst first and puts unrated last', () => {
    const groups = groupByPriority([
      finding({ title: 'low', priority: 3 }),
      finding({ title: 'unrated' }),
      finding({ title: 'blocker', priority: 0 }),
      finding({ title: 'urgent', priority: 1 }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['p0', 'p1', 'p3', 'unrated']);
  });

  it('omits empty groups', () => {
    const groups = groupByPriority([finding({ title: 'only', priority: 2 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('p2');
  });

  it('returns nothing for no findings', () => {
    expect(groupByPriority([])).toEqual([]);
  });
});

describe('findingLocation', () => {
  it('renders file:line and file:start-end', () => {
    expect(findingLocation(finding({ filePath: 'src/a.ts' }))).toBe('src/a.ts');
    expect(findingLocation(finding({ filePath: 'src/a.ts', lineStart: 10 }))).toBe('src/a.ts:10');
    expect(findingLocation(finding({ filePath: 'src/a.ts', lineStart: 10, lineEnd: 14 }))).toBe('src/a.ts:10-14');
    // A single-line range must not render as "10-10".
    expect(findingLocation(finding({ filePath: 'src/a.ts', lineStart: 10, lineEnd: 10 }))).toBe('src/a.ts:10');
  });

  it('normalizes Windows separators so the path reads the same everywhere', () => {
    expect(findingLocation(finding({ filePath: 'src\\lib\\a.ts', lineStart: 3 }))).toBe('src/lib/a.ts:3');
  });

  it('returns undefined without a file', () => {
    expect(findingLocation(finding())).toBeUndefined();
  });
});

describe('ReviewReport', () => {
  it('renders findings with their priority, location and body', () => {
    const markup = report({
      findings: [finding({ title: 'Off by one', priority: 1, filePath: 'src/a.ts', lineStart: 12, lineEnd: 14, body: 'The loop runs past the end.' })],
      outcome: 'incorrect',
      explanation: 'One blocking defect.',
    });
    expect(markup).toContain('Off by one');
    expect(markup).toContain('P1');
    expect(markup).toContain('src/a.ts:12-14');
    expect(markup).toContain('The loop runs past the end.');
    expect(markup).toContain('补丁不正确');
    expect(markup).toContain('One blocking defect.');
  });

  it('says 未发现问题 only when the reviewer really returned no findings', () => {
    const markup = report({ findings: [], outcome: 'correct' });
    expect(markup).toContain('未发现问题');
    expect(markup).toContain('补丁正确');
  });

  it('does NOT claim no findings when the reply could not be read', () => {
    // The distinction the whole feature turns on: a reviewer whose output was
    // unparseable did not certify the change.
    const markup = render({ label: '未提交的改动', ok: true, unparsed: true, findings: [], outcome: 'unknown' });
    expect(markup).toContain('未返回结构化结果');
    expect(markup).not.toContain('未发现问题');
  });

  it('shows the failure reason when the review could not run', () => {
    const markup = render({ label: '相对 main', ok: false, error: '找不到提交：deadbee', findings: [] });
    expect(markup).toContain('代码审查失败');
    expect(markup).toContain('找不到提交：deadbee');
    // A failed review must not be dressed as a verdict.
    expect(markup).not.toContain('补丁正确');
  });

  it('falls back to a reason when the CLI sent none', () => {
    // Every failure must carry a reason; if one is somehow missing the UI says
    // so rather than rendering an empty error box.
    const markup = render({ label: 'x', ok: false, findings: [] });
    expect(markup).toContain('没有返回原因');
  });

  it('renders an unknown verdict without pretending to know', () => {
    const markup = report({ findings: [finding()], outcome: 'unknown' });
    expect(markup).toContain('未给出总体结论');
  });
});

describe('FindingsList', () => {
  it('makes a location clickable when a handler is present', () => {
    const markup = renderToStaticMarkup(createElement(FindingsList, {
      findings: [finding({ filePath: 'src/a.ts', lineStart: 4 })],
      onOpenFile: () => undefined,
    }));
    expect(markup).toContain('<button');
    expect(markup).toContain('src/a.ts:4');
  });

  it('renders a plain location when no handler is present', () => {
    // Clickable-looking but inert is worse than obviously static.
    const markup = renderToStaticMarkup(createElement(FindingsList, {
      findings: [finding({ filePath: 'src/a.ts', lineStart: 4 })],
    }));
    expect(markup).not.toContain('<button');
    expect(markup).toContain('src/a.ts:4');
  });

  it('renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(createElement(FindingsList, { findings: [] }))).toBe('');
  });
});
