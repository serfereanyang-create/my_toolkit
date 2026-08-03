import { describe, expect, it } from 'vitest';

import {
  compileConstraint,
  compileScalarExpression,
  parseFixedVariables,
} from './mathEngine';

describe('compileScalarExpression', () => {
  it('evaluates common math functions and exponentiation', () => {
    const evaluate = compileScalarExpression('sin(x)^2 + cos(x)^2 + y');

    expect(evaluate({ x: 0, y: 3 })).toBe(4);
  });

  it('supports safe constants, grouping, and common scalar functions', () => {
    const evaluate = compileScalarExpression('(sqrt(abs(x)) + log(e) + cos(pi)) * 2');

    expect(evaluate({ x: -4 })).toBe(4);
  });

  it('rejects empty expressions', () => {
    expect(() => compileScalarExpression('   ')).toThrow(/empty/i);
  });

  it.each([
    ['assignment', 'x = 2'],
    ['function assignment', 'f(x) = x'],
    ['array access', 'x[0]'],
    ['property access', 'x.constructor'],
    ['arrays', '[1, 2]'],
    ['objects', '{ x: 1 }'],
  ])('rejects %s nodes', (_label, expression) => {
    expect(() => compileScalarExpression(expression)).toThrow();
  });

  it.each(['unsafe', 'import', 'evaluate', 'parse', 'compile', 'createUnit'])(
    'rejects unsafe function %s',
    (name) => {
      expect(() => compileScalarExpression(`${name}(x)`)).toThrow(/not allowed/i);
    },
  );

  it('rejects functions outside the allowlist', () => {
    expect(() => compileScalarExpression('mystery(x)')).toThrow(/not allowed/i);
  });

  it('requires variables to come from the numeric scope', () => {
    const evaluate = compileScalarExpression('x + pi');

    expect(() => evaluate({})).toThrow(/scope/i);
    expect(evaluate({ x: 1 })).toBeCloseTo(1 + Math.PI);
  });

  it.each(['pi', 'e', 'sin', 'constructor', 'prototype', '__proto__'])(
    'rejects reserved scope variable %s',
    (name) => {
      const evaluate = compileScalarExpression('x + 1');
      const scope = Object.create(null) as Record<string, number>;
      scope.x = 1;
      scope[name] = 2;

      expect(() => evaluate(scope)).toThrow(/scope variable.*reserved/i);
    },
  );

  it('ignores inherited reserved scope keys', () => {
    const evaluate = compileScalarExpression('x + 1');
    const scope = Object.create({ pi: 2, sin: 3, constructor: 4 }) as Record<string, number>;
    scope.x = 2;

    expect(evaluate(scope)).toBe(3);
  });

  it('ignores unrelated non-reserved scope keys', () => {
    const evaluate = compileScalarExpression('x + 1');

    expect(evaluate({ x: 2, unrelated: Number.NaN })).toBe(3);
  });

  it('reuses its private scope without retaining stale required values', () => {
    const evaluate = compileScalarExpression('x + y');
    const scope: Record<string, number> = { x: 1, y: 2 };

    expect(evaluate(scope)).toBe(3);
    scope.x = 4;
    expect(evaluate(scope)).toBe(6);
    delete scope.y;
    expect(() => evaluate(scope)).toThrow(/scope.*"y".*finite number/i);
  });

  it('rejects non-finite and non-number results', () => {
    expect(() => compileScalarExpression('1 / 0')({})).toThrow(/finite number/i);
    expect(() => compileScalarExpression('2 < 3')({})).toThrow(/finite number/i);
  });

  it.each(['Infinity', 'NaN', '1e999'])(
    'rejects non-finite numeric constant %s',
    (constant) => {
      expect(() => compileScalarExpression(constant)).toThrow(
        /scalar expression.*finite numeric constant/i,
      );
    },
  );

  it('rejects expressions over the source length limit contextually', () => {
    const expression = `${'x + '.repeat(1_100)}1`;

    expect(() => compileScalarExpression(expression)).toThrow(
      /scalar expression.*source length/i,
    );
  });

  it('rejects expressions over the AST node limit contextually', () => {
    const expression = `${'x < '.repeat(520)}1`;

    expect(() => compileScalarExpression(expression)).toThrow(
      /scalar expression.*ast node count/i,
    );
  });

  it('rejects expressions over the nesting depth limit contextually', () => {
    const expression = `${'('.repeat(80)}x${')'.repeat(80)}`;

    expect(() => compileScalarExpression(expression)).toThrow(
      /scalar expression.*nesting depth/i,
    );
  });

  it('normalizes mathjs parser stack overflows to contextual errors', () => {
    const expression = `${'('.repeat(500)}x${')'.repeat(500)}`;

    try {
      compileScalarExpression(expression);
      throw new Error('Expected deeply nested expression to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/scalar expression.*parse.*complex/i);
    }
  });

  it('reports disallowed nodes with scalar expression context', () => {
    expect(() => compileScalarExpression('[1, 2]')).toThrow(
      /scalar expression.*node.*not allowed/i,
    );
  });

  it('preserves stable mathjs errors for wrong function arity', () => {
    const evaluate = compileScalarExpression('sin()');

    expect(() => evaluate({})).toThrow(/too few arguments.*sin/i);
  });

  it('accepts only finite numeric scope values with safe names', () => {
    const evaluate = compileScalarExpression('x + 1');

    expect(() => evaluate({ x: Number.NaN })).toThrow(/finite number/i);
    expect(() => evaluate({ x: '2' } as unknown as Record<string, number>)).toThrow(
      /finite number/i,
    );

    const pollutedScope = Object.create(null) as Record<string, number>;
    pollutedScope.x = 1;
    pollutedScope.__proto__ = 2;
    expect(() => evaluate(pollutedScope)).toThrow(/not allowed/i);
  });
});

describe('compileConstraint', () => {
  it('returns true for an empty constraint', () => {
    expect(compileConstraint('')({})).toBe(true);
    expect(compileConstraint('   ')({ x: 1 })).toBe(true);
  });

  it('evaluates boolean constraints with JavaScript-style logical operators', () => {
    const predicate = compileConstraint('x^2 + y^2 < 4 && z >= 0');

    expect(predicate({ x: 1, y: 1, z: 0 })).toBe(true);
    expect(predicate({ x: 2, y: 1, z: 0 })).toBe(false);
    expect(predicate({ x: 1, y: 1, z: -1 })).toBe(false);
  });

  it('also supports mathjs logical operator syntax', () => {
    const predicate = compileConstraint('x > 0 or y > 0');

    expect(predicate({ x: -1, y: 2 })).toBe(true);
  });

  it('supports equal and unequal comparison operators', () => {
    const equals = compileConstraint('x == y');
    const unequal = compileConstraint('x != y');

    expect(equals({ x: 2, y: 2 })).toBe(true);
    expect(equals({ x: 2, y: 3 })).toBe(false);
    expect(unequal({ x: 2, y: 3 })).toBe(true);
    expect(unequal({ x: 2, y: 2 })).toBe(false);
  });

  it('supports chained comparisons', () => {
    const predicate = compileConstraint('-1 < x < 1');

    expect(predicate({ x: 0 })).toBe(true);
    expect(predicate({ x: -1 })).toBe(false);
    expect(predicate({ x: 1 })).toBe(false);
  });

  it('supports mixed chained comparisons and validates every parameter', () => {
    const predicate = compileConstraint('a < b >= c != d');

    expect(predicate({ a: 1, b: 3, c: 2, d: 4 })).toBe(true);
    expect(predicate({ a: 1, b: 3, c: 2, d: 2 })).toBe(false);
    expect(() => predicate({ a: 1, b: 3, c: 2 })).toThrow(
      /scope.*"d".*finite number/i,
    );
  });

  it.each(['Infinity', 'NaN', '1e999'])(
    'rejects non-finite constraint constant %s',
    (constant) => {
      expect(() => compileConstraint(`x < ${constant}`)).toThrow(
        /constraint.*finite numeric constant/i,
      );
    },
  );

  it('rejects non-boolean results instead of coercing them', () => {
    const predicate = compileConstraint('x + 1');

    expect(() => predicate({ x: 1 })).toThrow(/boolean/i);
  });

  it('applies the same syntax and function restrictions as scalar expressions', () => {
    expect(() => compileConstraint('x[0] > 1')).toThrow();
    expect(() => compileConstraint('evaluate(x)')).toThrow(/not allowed/i);
  });
});

describe('parseFixedVariables', () => {
  it('parses comma-separated fixed variables', () => {
    expect(parseFixedVariables('w=1, t=-2.5')).toEqual({ w: 1, t: -2.5 });
    expect(parseFixedVariables('  ')).toEqual({});
  });

  it.each([
    ['missing assignment', 'w'],
    ['missing name', '=1'],
    ['missing value', 'w='],
    ['malformed name', '1w=2'],
    ['extra equals delimiter', 'w=1=2'],
    ['empty entry', 'w=1,,t=2'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseFixedVariables(input)).toThrow();
  });

  it('rejects duplicate assignments', () => {
    expect(() => parseFixedVariables('w=1, w=2')).toThrow(/duplicate/i);
  });

  it.each(['NaN', 'Infinity', '-Infinity', '1e999'])(
    'rejects non-finite value %s',
    (value) => {
      expect(() => parseFixedVariables(`w=${value}`)).toThrow(/finite/i);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects prototype-pollution name %s',
    (name) => {
      expect(() => parseFixedVariables(`${name}=1`)).toThrow(/not allowed/i);
    },
  );

  it.each(['pi', 'e', 'sin'])('rejects math namespace name %s', (name) => {
    expect(() => parseFixedVariables(`${name}=1`)).toThrow(/reserved/i);
  });
});
