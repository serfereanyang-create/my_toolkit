import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refName, toTypeName, generateTypes } from '../src/openapi/openapiTypes.js';

const SPEC = {
  components: {
    schemas: {
      pet_tag: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: '标签名' },
          color: { type: 'string' },
        },
      },
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          tag: { $ref: '#/components/schemas/pet_tag' },
          status: { enum: ['available', 'sold'], nullable: true },
          nickname: { type: 'string', nullable: true },
          tags: { type: 'array', items: { $ref: '#/components/schemas/pet_tag' } },
          'weird-key': { type: 'string' },
        },
      },
      PetGroup: {
        type: 'object',
        properties: {
          leader: { $ref: '#/components/schemas/Pet' },
          members: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
        },
      },
      Named: { type: 'object', properties: { name: { type: 'string' } } },
      Owned: { type: 'object', properties: { owner: { type: 'string' } } },
      Cat: { allOf: [{ $ref: '#/components/schemas/Named' }, { $ref: '#/components/schemas/Owned' }] },
      Arbitrary: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
};

test('refName and toTypeName normalize identifiers', () => {
  assert.equal(refName('#/components/schemas/pet_tag'), 'pet_tag');
  assert.equal(toTypeName('pet_tag'), 'PetTag');
  assert.equal(toTypeName('2fast'), 'Type2fast');
});

test('generateTypes emits dependency-ordered interfaces with JSDoc and enums', () => {
  const result = generateTypes(SPEC);
  assert.equal(result.ok, true);
  const src = result.source;

  // 依赖顺序：pet_tag 在 Pet 之前，Pet 在 PetGroup 之前
  assert.ok(src.indexOf('export interface PetTag') < src.indexOf('export interface Pet '), 'pet_tag 应先输出');
  assert.ok(src.indexOf('export interface Pet ') < src.indexOf('export interface PetGroup'));

  // 必填 vs 可选
  assert.match(src, /id: number;/);
  assert.match(src, /color\?: string;/);
  // nullable
  assert.match(src, /nickname\?: string \| null;/);
  // enum + nullable
  assert.match(src, /status\?: 'available' \| 'sold' \| null;/);
  // 非法属性名加引号
  assert.match(src, /'weird-key'\?: string;/);
  // JSDoc
  assert.match(src, /\/\*\*\n\s+\* 标签名/);
  // allOf 交叉类型
  assert.match(src, /export interface Cat \{\n  Named & Owned\n\}|export type Cat = Named & Owned;/);
  // additionalProperties
  assert.match(src, /Record<string, string>/);
  // 头部注释
  assert.match(src, /由 OpenAPI 规范自动生成/);
});

test('generateTypes reports missing schemas honestly', () => {
  const empty = generateTypes({ components: { schemas: {} } });
  assert.equal(empty.ok, false);
  assert.match(empty.errors[0]!, /没有 components\.schemas/);
  const none = generateTypes({});
  assert.equal(none.ok, false);
});
