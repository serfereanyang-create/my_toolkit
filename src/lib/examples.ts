import type { VisualizerConfig } from './types';

export type VisualizerExample = {
  id: string;
  name: string;
  description: string;
  config: VisualizerConfig;
};

function createBaseRanges() {
  return {
    x: { min: -5, max: 5 },
    y: { min: -5, max: 5 },
    z: { min: -5, max: 5 },
  };
}

export function createDefaultConfig(): VisualizerConfig {
  return {
    mode: 'explicit',
    zExpression: 'sin(x) * cos(y)',
    constraint: '',
    fixedVariables: {},
    isoValue: 0,
    resolution: 72,
    ranges: {
      ...createBaseRanges(),
      z: { min: -1.5, max: 1.5 },
    },
  };
}

export const visualizerExamples: VisualizerExample[] = [
  {
    id: 'explicit-wave',
    name: '显式波面',
    description: 'z = sin(x) * cos(y)',
    config: createDefaultConfig(),
  },
  {
    id: 'parametric-sphere',
    name: '参数球面',
    description: 'x=2sin(u)cos(v), y=2sin(u)sin(v), z=2cos(u)',
    config: {
      mode: 'parametric',
      xExpression: '2*sin(u)*cos(v)',
      yExpression: '2*sin(u)*sin(v)',
      zExpression: '2*cos(u)',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 64,
      ranges: {
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -3, max: 3 },
        u: { min: 0, max: Math.PI },
        v: { min: 0, max: Math.PI * 2 },
      },
    },
  },
  {
    id: 'implicit-sphere',
    name: '隐式球面',
    description: 'x^2 + y^2 + z^2 - 4 = 0',
    config: {
      mode: 'implicit',
      fExpression: 'x^2 + y^2 + z^2 - 4',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 32,
      ranges: {
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -3, max: 3 },
      },
    },
  },
  {
    id: 'upper-hemisphere',
    name: '约束上半球',
    description: '隐式球面，并仅保留 z >= 0 的采样区域',
    config: {
      mode: 'implicit',
      fExpression: 'x^2 + y^2 + z^2 - 4',
      constraint: 'z >= 0',
      fixedVariables: {},
      isoValue: 0,
      resolution: 32,
      ranges: {
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -3, max: 3 },
      },
    },
  },
  {
    id: 'point-cloud',
    name: '离散点云',
    description: '七个离散三维采样点',
    config: {
      mode: 'points',
      pointText: '-2,-2,0\n-1,-1,1\n0,0,2\n1,1,1\n2,2,0\n2,-2,1\n-2,2,1',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 16,
      ranges: createBaseRanges(),
    },
  },
];

export const defaultConfig: VisualizerConfig = createDefaultConfig();
