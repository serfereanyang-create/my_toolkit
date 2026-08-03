import * as mathjs from 'mathjs';
import {
  isConstantNode,
  isFunctionNode,
  isOperatorNode,
  isParenthesisNode,
  isRelationalNode,
  isSymbolNode,
  parse,
  type MathNode,
} from 'mathjs';

const SAFE_FUNCTIONS = new Set([
  'abs',
  'acos',
  'acosh',
  'acot',
  'acoth',
  'acsc',
  'acsch',
  'asec',
  'asech',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'cos',
  'cosh',
  'cot',
  'coth',
  'csc',
  'csch',
  'exp',
  'expm1',
  'fix',
  'floor',
  'hypot',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'mod',
  'nthRoot',
  'pow',
  'round',
  'sec',
  'sech',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
]);

const SAFE_CONSTANTS = new Set(['e', 'pi', 'tau', 'phi', 'true', 'false']);
const SAFE_OPERATOR_FUNCTIONS = new Set([
  'add',
  'and',
  'divide',
  'equal',
  'larger',
  'largerEq',
  'mod',
  'multiply',
  'not',
  'notEqual',
  'or',
  'pow',
  'smaller',
  'smallerEq',
  'subtract',
  'unaryMinus',
  'unaryPlus',
  'unequal',
]);
const SAFE_RELATIONAL_FUNCTIONS = new Set([
  'equal',
  'larger',
  'largerEq',
  'smaller',
  'smallerEq',
  'unequal',
]);
const LANGUAGE_KEYWORDS = [
  'and',
  'end',
  'false',
  'in',
  'mod',
  'not',
  'null',
  'or',
  'to',
  'true',
  'undefined',
  'xor',
];
const RESERVED_NAMES = new Set([
  ...Object.keys(mathjs),
  ...SAFE_CONSTANTS,
  ...SAFE_FUNCTIONS,
  ...SAFE_OPERATOR_FUNCTIONS,
  ...LANGUAGE_KEYWORDS,
  'Infinity',
  'NaN',
  '__proto__',
  'constructor',
  'prototype',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FINITE_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_SOURCE_LENGTH = 4_096;
const MAX_AST_NODES = 512;
const MAX_AST_DEPTH = 64;
const HAS_OWN = Object.prototype.hasOwnProperty;

type NumericScope = Record<string, number>;
type ScalarEvaluator = (scope: NumericScope) => number;
type ConstraintEvaluator = (scope: NumericScope) => boolean;
type ExpressionContext = 'Scalar expression' | 'Constraint';
type SafeExpression = {
  compiled: ReturnType<MathNode['compile']>;
  requiredSymbols: string[];
};
type PendingNode = {
  node: MathNode;
  depth: number;
};

function assertSafeName(name: string, context: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`${context} name "${name}" is malformed`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`${context} name "${name}" is reserved and not allowed`);
  }
}

function normalizeLogicalOperators(expression: string): string {
  return expression.replace(/&&/g, ' and ').replace(/\|\|/g, ' or ');
}

function parseExpression(expression: string, context: ExpressionContext): MathNode {
  if (expression.length > MAX_SOURCE_LENGTH) {
    throw new Error(
      `${context} exceeds the source length limit of ${MAX_SOURCE_LENGTH} characters`,
    );
  }

  try {
    return parse(normalizeLogicalOperators(expression));
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`${context} could not be parsed because it is too complex`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${context} could not be parsed: ${detail}`);
  }
}

function validateNode(
  root: MathNode,
  requiredSymbols: Set<string>,
  context: ExpressionContext,
): void {
  const pending: PendingNode[] = [{ node: root, depth: 1 }];
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop() as PendingNode;
    const { node, depth } = current;
    nodeCount += 1;

    if (nodeCount > MAX_AST_NODES) {
      throw new Error(`${context} exceeds the AST node count limit of ${MAX_AST_NODES}`);
    }
    if (depth > MAX_AST_DEPTH) {
      throw new Error(`${context} exceeds the nesting depth limit of ${MAX_AST_DEPTH}`);
    }

    if (isConstantNode(node)) {
      if (typeof node.value === 'number') {
        if (!Number.isFinite(node.value)) {
          throw new Error(`${context} contains a non-finite numeric constant`);
        }
      } else if (typeof node.value !== 'boolean') {
        throw new Error(`${context} allows only numeric and boolean constants`);
      }
      continue;
    }

    if (isSymbolNode(node)) {
      if (SAFE_CONSTANTS.has(node.name)) {
        continue;
      }
      assertSafeName(node.name, `${context} symbol`);
      requiredSymbols.add(node.name);
      continue;
    }

    if (isOperatorNode(node)) {
      if (!SAFE_OPERATOR_FUNCTIONS.has(node.fn)) {
        throw new Error(`${context} operator "${node.op}" is not allowed`);
      }
      for (const argument of node.args) {
        pending.push({ node: argument, depth: depth + 1 });
      }
      continue;
    }

    if (isRelationalNode(node)) {
      if (node.params.length !== node.conditionals.length + 1) {
        throw new Error(`${context} contains a malformed chained comparison`);
      }
      for (const conditional of node.conditionals) {
        if (!SAFE_RELATIONAL_FUNCTIONS.has(conditional)) {
          throw new Error(
            `${context} comparison operator "${conditional}" is not allowed`,
          );
        }
      }
      for (const parameter of node.params) {
        pending.push({ node: parameter, depth: depth + 1 });
      }
      continue;
    }

    if (isParenthesisNode(node)) {
      pending.push({ node: node.content, depth: depth + 1 });
      continue;
    }

    if (isFunctionNode(node)) {
      const functionTarget: unknown = node.fn;
      if (!isSymbolNode(functionTarget) || !SAFE_FUNCTIONS.has(functionTarget.name)) {
        const name = isSymbolNode(functionTarget) ? functionTarget.name : String(functionTarget);
        throw new Error(`${context} function "${name}" is not allowed`);
      }
      nodeCount += 1;
      if (nodeCount > MAX_AST_NODES) {
        throw new Error(`${context} exceeds the AST node count limit of ${MAX_AST_NODES}`);
      }
      for (const argument of node.args) {
        pending.push({ node: argument, depth: depth + 1 });
      }
      continue;
    }

    throw new Error(`${context} node "${node.type}" is not allowed`);
  }
}

function compileSafeExpression(
  expression: string,
  context: ExpressionContext,
): SafeExpression {
  const node = parseExpression(expression, context);
  const requiredSymbols = new Set<string>();
  validateNode(node, requiredSymbols, context);

  try {
    return { compiled: node.compile(), requiredSymbols: [...requiredSymbols] };
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`${context} could not be compiled because it is too complex`);
    }
    throw error;
  }
}

function createScopeLoader(requiredSymbols: string[]): (scope: NumericScope) => Map<string, number> {
  const evaluationScope = new Map<string, number>();
  const stagedValues = new Array<number>(requiredSymbols.length);

  return (scope: NumericScope): Map<string, number> => {
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
      throw new Error('Expression scope must be an object of finite numbers');
    }

    for (const name of Object.keys(scope)) {
      if (RESERVED_NAMES.has(name)) {
        throw new Error(`Scope variable name "${name}" is reserved and not allowed`);
      }
    }

    for (let index = 0; index < requiredSymbols.length; index += 1) {
      const name = requiredSymbols[index];
      const value: unknown = HAS_OWN.call(scope, name) ? scope[name] : undefined;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Scope variable "${name}" must be a finite number`);
      }
      stagedValues[index] = value;
    }

    for (let index = 0; index < requiredSymbols.length; index += 1) {
      evaluationScope.set(requiredSymbols[index], stagedValues[index]);
    }
    return evaluationScope;
  };
}

export function compileScalarExpression(expression: string): ScalarEvaluator {
  if (!expression.trim()) {
    throw new Error('Scalar expression cannot be empty');
  }

  const { compiled, requiredSymbols } = compileSafeExpression(
    expression,
    'Scalar expression',
  );
  const loadScope = createScopeLoader(requiredSymbols);
  return (scope: NumericScope): number => {
    const value: unknown = compiled.evaluate(loadScope(scope));
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Scalar expression must evaluate to a finite number');
    }
    return value;
  };
}

export function compileConstraint(expression: string): ConstraintEvaluator {
  if (!expression.trim()) {
    return () => true;
  }

  const { compiled, requiredSymbols } = compileSafeExpression(expression, 'Constraint');
  const loadScope = createScopeLoader(requiredSymbols);
  return (scope: NumericScope): boolean => {
    const value: unknown = compiled.evaluate(loadScope(scope));
    if (typeof value !== 'boolean') {
      throw new Error('Constraint must evaluate to a boolean');
    }
    return value;
  };
}

export function parseFixedVariables(input: string): NumericScope {
  if (!input.trim()) {
    return {};
  }

  const variables: NumericScope = Object.create(null) as NumericScope;
  for (const assignment of input.split(',')) {
    const parts = assignment.split('=');
    if (parts.length !== 2) {
      throw new Error(`Invalid fixed variable assignment "${assignment.trim()}"`);
    }

    const name = parts[0].trim();
    const rawValue = parts[1].trim();
    assertSafeName(name, 'Fixed variable');
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      throw new Error(`Duplicate fixed variable "${name}"`);
    }
    if (!FINITE_NUMBER_PATTERN.test(rawValue)) {
      throw new Error(`Fixed variable "${name}" must be a finite number`);
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Fixed variable "${name}" must be a finite number`);
    }
    variables[name] = value;
  }

  return { ...variables };
}
