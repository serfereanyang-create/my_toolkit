/**
 * openapiRobustness.test.ts — malformed and hostile specs.
 *
 * A hand-written or third-party OpenAPI file can contain null schema entries,
 * non-string $ref values, union values that need escaping, or two schema names
 * that normalise to the same TS identifier. None of these may throw out of the
 * generator (the tool call would die) and none may emit syntactically invalid
 * TypeScript.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { generateTypes } from '../src/openapi/openapiTypes.js';

function parseErrors(source: string): string[] {
  // transpileModule reports syntactically invalid TS without needing type info.
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('cyclic $ref between two schemas is ordered, not infinite', () => {
  const result = generateTypes({
    components: {
      schemas: {
        A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.typeCount, 2);
  assert.deepEqual(parseErrors(result.source), []);
});

test('self-referential schema terminates', () => {
  const result = generateTypes({
    components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } },
  });
  assert.equal(result.ok, true);
  assert.match(result.source, /next\?: Node;/);
});

test('null / array / scalar schema entries degrade to unknown instead of throwing', () => {
  const specs = [
    { components: { schemas: { X: null, Y: { type: 'string' } } } },
    { components: { schemas: { X: [], Y: { type: 'string' } } } },
    { components: { schemas: { X: 42, Y: { type: 'string' } } } },
    { components: { schemas: { X: { properties: { bad: null } } } } },
    { components: { schemas: { X: { allOf: [null, { type: 'string' }] } } } },
  ];
  for (const spec of specs) {
    const result = generateTypes(spec);
    assert.equal(result.ok, true, JSON.stringify(spec));
    assert.doesNotThrow(() => parseErrors(result.source));
    assert.deepEqual(parseErrors(result.source), [], `invalid TS for ${JSON.stringify(spec)}:\n${result.source}`);
  }
});

test('non-string $ref is ignored, not a crash', () => {
  const result = generateTypes({ components: { schemas: { X: { $ref: { bad: 1 } } } } });
  assert.equal(result.ok, true);
  assert.match(result.source, /export type X = unknown;/);
});

test('enum strings are escaped so the output parses', () => {
  const values = ["it's", 'line\nbreak', 'back\\slash', 'u2028 sep', 'tab\there'];
  const result = generateTypes({ components: { schemas: { E: { enum: values } } } });
  assert.deepEqual(parseErrors(result.source), []);
  const file = ts.createSourceFile('generated.ts', result.source, ts.ScriptTarget.Latest, true);
  const typeAlias = file.statements.find((node) => ts.isTypeAliasDeclaration(node)) as ts.TypeAliasDeclaration;
  assert.ok(typeAlias, result.source);
  const literals = (typeAlias.type as ts.UnionTypeNode).types
    .map((node) => (ts.isLiteralTypeNode(node) ? node.literal : undefined))
    .filter((node): node is ts.StringLiteral => Boolean(node) && ts.isStringLiteral(node!))
    .map((node) => node.text);
  assert.deepEqual(literals, values, 'round-tripped enum values must match the spec');
});

test('property names with quotes and newlines stay valid', () => {
  const result = generateTypes({
    components: { schemas: { X: { type: 'object', properties: { "we'ird\nname": { type: 'string' } } } } },
  });
  assert.deepEqual(parseErrors(result.source), []);
});

test('schema names that normalise to the same identifier are disambiguated', () => {
  const result = generateTypes({
    components: {
      schemas: {
        'pet-tag': { type: 'object', properties: { a: { type: 'string' } } },
        pet_tag: { type: 'object', properties: { b: { type: 'string' } } },
        PetTag: { type: 'object', properties: { c: { type: 'string' } } },
      },
    },
  });
  assert.equal(result.typeCount, 3);
  const declarations = result.source.match(/export interface \w+/g) ?? [];
  assert.equal(new Set(declarations).size, 3, `duplicate declarations:\n${result.source}`);
  assert.ok(result.errors.length >= 2, 'collisions must be reported');
  assert.deepEqual(parseErrors(result.source), []);
});

test('missing paths / non-object spec / empty schemas report honestly', () => {
  assert.equal(generateTypes({ openapi: '3.0.0', paths: {} }).ok, false);
  assert.equal(generateTypes(null).ok, false);
  assert.equal(generateTypes('nope').ok, false);
  assert.equal(generateTypes({ components: { schemas: [] } }).ok, false);
});
