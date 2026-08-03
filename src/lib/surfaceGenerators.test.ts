import { describe, expect, it } from 'vitest';

import {
  MAX_MANUAL_POINTS,
  generateExplicitSurface,
  generateGeometry,
  generateImplicitSurface,
  generateParametricSurface,
  generatePointCloud,
} from './surfaceGenerators';
import type {
  ExplicitConfig,
  GeneratedGeometry,
  ImplicitConfig,
  ParametricConfig,
  PointsConfig,
} from './types';

const xyzRanges = {
  x: { min: -3, max: 3 },
  y: { min: -3, max: 3 },
  z: { min: -3, max: 3 },
};

function explicitConfig(overrides: Partial<ExplicitConfig> = {}): ExplicitConfig {
  return {
    mode: 'explicit',
    zExpression: 'sin(x) * cos(y)',
    constraint: '',
    fixedVariables: {},
    isoValue: 0,
    resolution: 12,
    ranges: xyzRanges,
    ...overrides,
  };
}

function parametricConfig(
  overrides: Partial<ParametricConfig> = {},
): ParametricConfig {
  return {
    mode: 'parametric',
    xExpression: '2*sin(u)*cos(v)',
    yExpression: '2*sin(u)*sin(v)',
    zExpression: '2*cos(u)',
    constraint: '',
    fixedVariables: {},
    isoValue: 0,
    resolution: 12,
    ranges: {
      ...xyzRanges,
      u: { min: 0, max: Math.PI },
      v: { min: 0, max: 2 * Math.PI },
    },
    ...overrides,
  };
}

function implicitConfig(overrides: Partial<ImplicitConfig> = {}): ImplicitConfig {
  return {
    mode: 'implicit',
    fExpression: 'x^2 + y^2 + z^2 - 4',
    constraint: '',
    fixedVariables: {},
    isoValue: 0,
    resolution: 12,
    ranges: xyzRanges,
    ...overrides,
  };
}

function pointsConfig(overrides: Partial<PointsConfig> = {}): PointsConfig {
  return {
    mode: 'points',
    pointText: '0,0,0\n1,1,1\n-1,1,1',
    constraint: '',
    fixedVariables: {},
    isoValue: 0,
    resolution: 10,
    ranges: xyzRanges,
    ...overrides,
  };
}

function expectValidIndexedMesh(geometry: GeneratedGeometry) {
  expect(geometry.kind).toBe('mesh');
  if (geometry.kind !== 'mesh' || !geometry.indices) {
    throw new Error('Expected indexed mesh geometry');
  }

  const vertexCount = geometry.positions.length / 3;
  expect(geometry.indices.length % 3).toBe(0);
  for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
    const a = geometry.indices[triangle];
    const b = geometry.indices[triangle + 1];
    const c = geometry.indices[triangle + 2];
    expect([a, b, c].every(Number.isInteger)).toBe(true);
    expect(a).toBeLessThan(vertexCount);
    expect(b).toBeLessThan(vertexCount);
    expect(c).toBeLessThan(vertexCount);
    expect(new Set([a, b, c]).size).toBe(3);

    const ax = geometry.positions[a * 3];
    const ay = geometry.positions[a * 3 + 1];
    const az = geometry.positions[a * 3 + 2];
    const abx = geometry.positions[b * 3] - ax;
    const aby = geometry.positions[b * 3 + 1] - ay;
    const abz = geometry.positions[b * 3 + 2] - az;
    const acx = geometry.positions[c * 3] - ax;
    const acy = geometry.positions[c * 3 + 1] - ay;
    const acz = geometry.positions[c * 3 + 2] - az;
    expect(Math.hypot(
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    )).toBeGreaterThan(0);
  }
}

function expectFiniteGeometry(geometry: GeneratedGeometry) {
  expect(geometry.positions.length).toBeGreaterThan(0);
  expect(Array.from(geometry.positions).every(Number.isFinite)).toBe(true);

  if (geometry.kind === 'mesh') {
    if (geometry.normals) {
      expect(geometry.normals.length).toBe(geometry.positions.length);
      expect(Array.from(geometry.normals).every(Number.isFinite)).toBe(true);
    }
    if (geometry.indices) {
      const vertexCount = geometry.positions.length / 3;
      expect(Array.from(geometry.indices).every((index) => index < vertexCount)).toBe(true);
    }
  }
}

describe('explicit surface generation', () => {
  it('generates an indexed mesh for sin(x) * cos(y)', () => {
    const geometry = generateExplicitSurface(explicitConfig());

    expect(geometry.kind).toBe('mesh');
    if (geometry.kind !== 'mesh') throw new Error('Expected mesh geometry');
    expect(geometry.indices?.length).toBeGreaterThan(0);
    expectFiniteGeometry(geometry);
  });

  it('removes all vertices with negative x when constrained to x >= 0', () => {
    const geometry = generateExplicitSurface(
      explicitConfig({ constraint: 'x >= 0', zExpression: 'x + y' }),
    );

    for (let index = 0; index < geometry.positions.length; index += 3) {
      expect(geometry.positions[index]).toBeGreaterThanOrEqual(-1e-8);
    }
  });

  it('skips domain errors without producing invalid vertices or triangles', () => {
    const geometry = generateExplicitSurface(
      explicitConfig({
        zExpression: 'sqrt(x)',
        ranges: { ...xyzRanges, x: { min: -1, max: 1 } },
      }),
    );

    expectFiniteGeometry(geometry);
    const xValues = Array.from(geometry.positions).filter((_, index) => index % 3 === 0);
    expect(Math.min(...xValues)).toBeGreaterThanOrEqual(0);
  });

  it('uses fixed variables in expression and constraint scopes', () => {
    const geometry = generateExplicitSurface(
      explicitConfig({
        zExpression: 'x + offset',
        constraint: 'offset == 2 && z <= 3',
        fixedVariables: { offset: 2 },
      }),
    );

    expectFiniteGeometry(geometry);
  });

  it('clamps resolution to the explicit minimum', () => {
    const geometry = generateExplicitSurface(explicitConfig({ resolution: 1 }));

    expect(geometry.positions.length / 3).toBe(16);
  });

  it('winds z = 0 toward +Z and emits only valid positive-area triangles', () => {
    const geometry = generateExplicitSurface(explicitConfig({ zExpression: '0' }));

    expectValidIndexedMesh(geometry);
    if (geometry.kind !== 'mesh' || !geometry.indices) return;
    for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
      const a = geometry.indices[triangle] * 3;
      const b = geometry.indices[triangle + 1] * 3;
      const c = geometry.indices[triangle + 2] * 3;
      const abx = geometry.positions[b] - geometry.positions[a];
      const aby = geometry.positions[b + 1] - geometry.positions[a + 1];
      const acx = geometry.positions[c] - geometry.positions[a];
      const acy = geometry.positions[c + 1] - geometry.positions[a + 1];
      expect(abx * acy - aby * acx).toBeGreaterThan(0);
    }
  });

  it('rejects non-finite resolution and nonrepresentable rendered ranges', () => {
    expect(() =>
      generateExplicitSurface(explicitConfig({ resolution: Number.NaN })),
    ).toThrow(/resolution.*finite/i);
    expect(() =>
      generateExplicitSurface(explicitConfig({ ranges: {
        ...xyzRanges,
        x: { min: -1e39, max: 1e39 },
      } })),
    ).toThrow(/float32|rendered coordinate/i);
  });

  it('rejects meshes whose triangles collapse during Float32 conversion', () => {
    expect(() => generateExplicitSurface(explicitConfig({
      zExpression: '0',
      ranges: {
        x: { min: 1e20, max: 1e20 + 1e12 },
        y: { min: 1e20, max: 1e20 + 1e12 },
        z: { min: -1, max: 1 },
      },
    }))).toThrow(/no valid surface|no triangles/i);
  });

  it('surfaces unknown symbols instead of reporting no geometry', () => {
    expect(() =>
      generateExplicitSurface(explicitConfig({ zExpression: 'x + mystery' })),
    ).toThrow(/mystery/i);
  });

  it('surfaces wrong function arity instead of reporting no geometry', () => {
    expect(() =>
      generateExplicitSurface(explicitConfig({ zExpression: 'sin()' })),
    ).toThrow(/too few arguments.*sin/i);
  });

  it('compiles malformed constraints before sampling', () => {
    expect(() =>
      generateExplicitSurface(explicitConfig({ constraint: 'x >' })),
    ).toThrow(/constraint.*pars/i);
  });

  it('throws when filtering leaves no triangles', () => {
    expect(() =>
      generateExplicitSurface(explicitConfig({ constraint: 'x > 100' })),
    ).toThrow(/no valid surface|no triangles/i);
  });
});

describe('parametric surface generation', () => {
  it('generates an indexed sphere mesh', () => {
    const geometry = generateParametricSurface(parametricConfig());

    expect(geometry.kind).toBe('mesh');
    if (geometry.kind !== 'mesh') throw new Error('Expected mesh geometry');
    expect(geometry.indices?.length).toBeGreaterThan(0);
    expectFiniteGeometry(geometry);
  });

  it('uses conventional du cross dv orientation for the grid ordering', () => {
    const geometry = generateParametricSurface(parametricConfig({
      xExpression: 'u',
      yExpression: 'v',
      zExpression: '0',
      ranges: {
        ...xyzRanges,
        u: { min: -1, max: 1 },
        v: { min: -1, max: 1 },
      },
    }));

    expectValidIndexedMesh(geometry);
    if (geometry.kind !== 'mesh' || !geometry.indices) return;
    const a = geometry.indices[0] * 3;
    const b = geometry.indices[1] * 3;
    const c = geometry.indices[2] * 3;
    const abx = geometry.positions[b] - geometry.positions[a];
    const aby = geometry.positions[b + 1] - geometry.positions[a + 1];
    const acx = geometry.positions[c] - geometry.positions[a];
    const acy = geometry.positions[c + 1] - geometry.positions[a + 1];
    expect(abx * acy - aby * acx).toBeGreaterThan(0);
  });

  it('omits zero-area triangles created by duplicated sphere poles', () => {
    const geometry = generateParametricSurface(parametricConfig({ resolution: 24 }));

    expectValidIndexedMesh(geometry);
  });

  it('enforces required xyz ranges', () => {
    expect(() =>
      generateParametricSurface(
        parametricConfig({ ranges: { ...parametricConfig().ranges, z: undefined } }),
      ),
    ).toThrow(/z range/i);

    const geometry = generateParametricSurface(
      parametricConfig({
        ranges: { ...parametricConfig().ranges, z: { min: 0, max: 3 } },
      }),
    );
    for (let index = 2; index < geometry.positions.length; index += 3) {
      expect(geometry.positions[index]).toBeGreaterThanOrEqual(-1e-8);
    }
  });

  it('surfaces wrong function arity instead of reporting no geometry', () => {
    expect(() => generateParametricSurface(parametricConfig({
      xExpression: 'sin()',
    }))).toThrow(/too few arguments.*sin/i);
  });
});

describe('implicit surface generation', () => {
  it('extracts a sphere with one normal component per position component', () => {
    const geometry = generateImplicitSurface(implicitConfig());

    expect(geometry.kind).toBe('mesh');
    if (geometry.kind !== 'mesh') throw new Error('Expected mesh geometry');
    expect(geometry.normals?.length).toBe(geometry.positions.length);
    expectFiniteGeometry(geometry);
  });

  it('applies z >= 0 at triangle level', () => {
    const geometry = generateImplicitSurface(implicitConfig({ constraint: 'z >= 0' }));

    for (let index = 2; index < geometry.positions.length; index += 3) {
      expect(geometry.positions[index]).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it('skips invalid scalar samples without generating NaN vertices', () => {
    const geometry = generateImplicitSurface(
      implicitConfig({
        fExpression: 'sqrt(x) + y^2 + z^2',
        isoValue: 1,
        ranges: {
          x: { min: -1, max: 2 },
          y: { min: -2, max: 2 },
          z: { min: -2, max: 2 },
        },
      }),
    );

    expectFiniteGeometry(geometry);
  });

  it.each([
    ['offset detail', '1e8 + x', 1e8],
    ['very large samples', '1e46 * x', 0],
    ['very small samples', '1e-46 * x', 0],
  ])('extracts x = 0 using %s in double-precision scalar storage', (
    _label,
    fExpression,
    isoValue,
  ) => {
    const geometry = generateImplicitSurface(implicitConfig({
      fExpression,
      isoValue,
      ranges: {
        x: { min: -1, max: 1 },
        y: { min: -1, max: 1 },
        z: { min: -1, max: 1 },
      },
    }));

    expectFiniteGeometry(geometry);
    for (let index = 0; index < geometry.positions.length; index += 3) {
      expect(geometry.positions[index]).toBeCloseTo(0, 5);
    }
  });

  it('surfaces wrong function arity instead of reporting no geometry', () => {
    expect(() => generateImplicitSurface(implicitConfig({
      fExpression: 'sin()',
    }))).toThrow(/too few arguments.*sin/i);
  });

  it('supports the standard sphere at resolution 48 within the production budget', () => {
    const geometry = generateImplicitSurface(implicitConfig({ resolution: 48 }));

    expectFiniteGeometry(geometry);
  });

  it('surfaces malformed constraints before no-surface extraction', () => {
    expect(() => generateImplicitSurface(implicitConfig({
      isoValue: -100,
      constraint: 'z >',
    }))).toThrow(/constraint.*pars/i);
  });

  it('surfaces unknown constraint symbols instead of no constrained surface', () => {
    expect(() => generateImplicitSurface(implicitConfig({
      constraint: 'mystery > 0',
    }))).toThrow(/mystery/i);
  });

  it('distinguishes no surface from no constrained surface', () => {
    expect(() =>
      generateImplicitSurface(implicitConfig({ isoValue: -100 })),
    ).toThrow(/no implicit surface.*selected range/i);
    expect(() =>
      generateImplicitSurface(implicitConfig({ constraint: 'z > 100' })),
    ).toThrow(/no implicit surface.*constraints/i);
  });
});

describe('point cloud generation', () => {
  it('parses supported separators, skips malformed lines, and keeps expected constrained points', () => {
    const geometry = generatePointCloud(
      pointsConfig({
        pointText: '0,0,0\n1\t1\t1\n-1 1 1\nbad line\n2,2\n4,0,0',
        constraint: 'x >= 0 && limit == 2',
        fixedVariables: { limit: 2 },
      }),
    );

    expect(geometry.kind).toBe('points');
    if (geometry.kind !== 'points') throw new Error('Expected point geometry');
    expect(Array.from(geometry.positions)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(geometry.pointSize).toBeCloseTo(0.08);
  });

  it('rejects mixed and empty delimiters while reporting skipped lines', () => {
    const geometry = generatePointCloud(pointsConfig({
      pointText: '0,0,0\n1 1 1\n1,,2,,3\n1, 2 3',
    }));

    expect(Array.from(geometry.positions)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(geometry.message).toMatch(/2 skipped/i);
  });

  it('enforces the manual point count cap', () => {
    const lines = Array.from(
      { length: MAX_MANUAL_POINTS + 1 },
      () => '0,0,0',
    ).join('\n');

    expect(() => generatePointCloud(pointsConfig({ pointText: lines }))).toThrow(
      new RegExp(`point.*limit.*${MAX_MANUAL_POINTS}|${MAX_MANUAL_POINTS}.*point.*limit`, 'i'),
    );
  });

  it('requires valid xyz ranges and errors when no points remain', () => {
    expect(() =>
      generatePointCloud(pointsConfig({ ranges: { ...xyzRanges, y: undefined } })),
    ).toThrow(/y range/i);
    expect(() =>
      generatePointCloud(pointsConfig({ constraint: 'x > 100' })),
    ).toThrow(/no valid points/i);
  });
});

describe('validation and dispatch', () => {
  it.each([
    ['explicit', () => generateExplicitSurface(explicitConfig({ constraint: 'x + 1' }))],
    ['parametric', () => generateParametricSurface(parametricConfig({ constraint: 'x + 1' }))],
    ['implicit', () => generateImplicitSurface(implicitConfig({ constraint: 'x + 1' }))],
    ['points', () => generatePointCloud(pointsConfig({ constraint: 'x + 1' }))],
  ])('preserves the math engine boolean constraint error for %s mode', (_mode, generate) => {
    expect(generate).toThrow(/constraint must evaluate to a boolean/i);
  });

  it.each([
    ['missing', undefined],
    ['non-finite', { min: 0, max: Number.POSITIVE_INFINITY }],
    ['reversed', { min: 1, max: -1 }],
    ['empty', { min: 1, max: 1 }],
  ])('rejects a %s required range', (_label, xRange) => {
    expect(() =>
      generateExplicitSurface(explicitConfig({ ranges: { ...xyzRanges, x: xRange } })),
    ).toThrow(/invalid x range/i);
  });

  it('dispatches every visualizer mode', () => {
    expect(generateGeometry(explicitConfig()).kind).toBe('mesh');
    expect(generateGeometry(parametricConfig()).kind).toBe('mesh');
    expect(generateGeometry(implicitConfig()).kind).toBe('mesh');
    expect(generateGeometry(pointsConfig()).kind).toBe('points');
  });
});
