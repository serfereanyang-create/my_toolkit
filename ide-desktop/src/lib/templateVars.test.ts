import { describe, expect, it } from 'vitest';
import { expandTemplate, firstPlaceholderRange, parseTemplate } from './templateVars';

describe('parseTemplate', () => {
  it('finds nothing in plain text', () => {
    const parsed = parseTemplate('把这段代码重构一下');
    expect(parsed.hasPlaceholders).toBe(false);
    expect(parsed.variables).toEqual([]);
  });

  it('extracts a required variable with offsets', () => {
    const text = '实现 {{module}} 模块';
    const parsed = parseTemplate(text);
    expect(parsed.hasPlaceholders).toBe(true);
    expect(parsed.variables).toHaveLength(1);
    const [v] = parsed.variables;
    expect(v.name).toBe('module');
    expect(v.optional).toBe(false);
    expect(v.fallback).toBeNull();
    // Offsets match the literal placeholder span in the source.
    const [occ] = v.occurrences;
    expect(text.slice(occ.start, occ.end)).toBe('{{module}}');
  });

  it('marks piped variables optional and captures the fallback', () => {
    const parsed = parseTemplate('日志级别 {{level|info}} 输出');
    expect(parsed.variables[0].optional).toBe(true);
    expect(parsed.variables[0].fallback).toBe('info');
  });

  it('treats an empty fallback as optional-with-empty-default', () => {
    const parsed = parseTemplate('标题：{{title|}}');
    expect(parsed.variables[0].optional).toBe(true);
    expect(parsed.variables[0].fallback).toBe('');
  });

  it('deduplicates names and keeps every occurrence', () => {
    const parsed = parseTemplate('{{a}} 和 {{a|fallback}} 和 {{b}}');
    expect(parsed.variables).toHaveLength(2);
    const a = parsed.variables[0];
    expect(a.occurrences).toHaveLength(2);
    expect(a.optional).toBe(true); // second occurrence declared a default
    expect(a.fallback).toBe('fallback');
  });

  it('accepts CJK and dash/dot variable names', () => {
    const parsed = parseTemplate('{{文件名}} {{my-var.v2}}');
    expect(parsed.variables.map((v) => v.name)).toEqual(['文件名', 'my-var.v2']);
  });

  it('ignores malformed or escaped placeholders', () => {
    // Unbalanced / not-name / escaped.
    expect(parseTemplate('{{ missing end').hasPlaceholders).toBe(false);
    expect(parseTemplate('{{123bad}}').hasPlaceholders).toBe(false);
    expect(parseTemplate('代码里的 \\{{literal}} 写法').hasPlaceholders).toBe(false);
  });

  it('allows newlines in fallbacks', () => {
    const parsed = parseTemplate('{{note|行1\n行2}}');
    expect(parsed.variables[0].fallback).toBe('行1\n行2');
  });
});

describe('expandTemplate', () => {
  it('substitutes all supplied values', () => {
    const out = expandTemplate('给 {{module}} 加 {{feature}} 测试', { module: 'auth', feature: 'retry' });
    expect(out.text).toBe('给 auth 加 retry 测试');
    expect(out.missing).toEqual([]);
  });

  it('applies fallbacks for optional variables', () => {
    const out = expandTemplate('级别 {{level|warn}}', {});
    expect(out.text).toBe('级别 warn');
  });

  it('prefers a supplied value over the fallback', () => {
    const out = expandTemplate('级别 {{level|warn}}', { level: 'error' });
    expect(out.text).toBe('级别 error');
  });

  it('reports required variables as missing and keeps the placeholder', () => {
    const out = expandTemplate('部署到 {{env}} 环境', {});
    expect(out.missing).toEqual(['env']);
    expect(out.text).toContain('{{env}}');
  });

  it('empty-string values do not count as supplied (use fallback)', () => {
    const out = expandTemplate('{{x|d}}', { x: '' });
    expect(out.text).toBe('d');
  });

  it('expands repeated variables consistently', () => {
    const out = expandTemplate('{{n}}+{{n}}', { n: '1' });
    expect(out.text).toBe('1+1');
  });

  it('leaves escaped braces renderable as literals', () => {
    const out = expandTemplate('写法 \\{{literal}}', {});
    expect(out.text).toBe('写法 \\{{literal}}');
    expect(out.missing).toEqual([]);
  });

  it('degrades gracefully on malformed syntax', () => {
    const out = expandTemplate('{{{ weird }} and {{ok}}', { ok: 'x' });
    expect(out.text).toContain('x');
  });
});

describe('firstPlaceholderRange', () => {
  it('returns null for templates without placeholders', () => {
    expect(firstPlaceholderRange('plain')).toBeNull();
  });

  it('points at the earliest span even when repeated', () => {
    const text = 'a {{b}} c {{b}} d {{a}}';
    const range = firstPlaceholderRange(text)!;
    expect(text.slice(range.start, range.end)).toBe('{{b}}');
  });
});
