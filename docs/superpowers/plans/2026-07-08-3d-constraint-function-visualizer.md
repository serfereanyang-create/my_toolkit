# 3D Constraint Function Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current React page with an interactive 3D/high-dimensional constraint function visualizer that can render explicit, parametric, implicit, and discrete data shapes.

**Architecture:** Keep rendering and math generation separate. Pure TypeScript modules parse expressions, validate ranges, generate geometry data, and apply constraints; React components collect user input and pass generated data into a Three.js viewport. The first implementation focuses on reliable 3D shape rendering with basic lighting and a coordinate carrier.

**Tech Stack:** React, TypeScript, Vite, Three.js, OrbitControls, mathjs, Vitest.

---

## File Structure

Create or modify these files:

- Modify: `package.json` - add `three`, `mathjs`, `vitest`, and test script.
- Create: `src/lib/types.ts` - shared mode, range, geometry, and render result types.
- Create: `src/lib/mathEngine.ts` - safe expression compilation/evaluation and constraint evaluation.
- Create: `src/lib/surfaceGenerators.ts` - explicit, parametric, implicit, and point-cloud geometry generation.
- Create: `src/lib/marchingCubes.ts` - compact Marching Cubes-style iso extraction for implicit surfaces.
- Create: `src/lib/examples.ts` - built-in examples for each function mode.
- Create: `src/components/ControlPanel.tsx` - form controls, examples, render trigger, and status display.
- Create: `src/components/ThreeViewport.tsx` - Three.js renderer, coordinate carrier, geometry display, controls, and picking.
- Replace: `src/App.tsx` - app state orchestration for the visualizer.
- Replace: `src/styles.css` - visualizer layout and technical graphing UI styles.
- Create: `src/lib/mathEngine.test.ts` - expression and constraint tests.
- Create: `src/lib/surfaceGenerators.test.ts` - geometry generation tests.

This workspace is not a git repository, so commit steps are documented but expected to be skipped unless a git repository is initialized before execution.

---

### Task 1: Dependencies and Test Harness

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update dependencies and scripts**

Edit `package.json` so the relevant sections contain these entries:

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc -b && vite build",
    "preview": "vite preview --host 127.0.0.1",
    "test": "vitest run",
    "desktop:run": "npm run build && electron .",
    "desktop:dir": "npm run build && electron-builder --dir",
    "desktop:build": "npm run build && electron-builder --win nsis"
  },
  "dependencies": {
    "@ant-design/icons": "^6.3.2",
    "@vitejs/plugin-react": "latest",
    "antd": "^6.5.0",
    "lucide-react": "latest",
    "mathjs": "^14.8.0",
    "react": "latest",
    "react-dom": "latest",
    "three": "^0.178.0",
    "typescript": "latest",
    "vite": "latest"
  },
  "devDependencies": {
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@types/three": "^0.178.1",
    "electron": "latest",
    "electron-builder": "latest",
    "vitest": "^3.2.4"
  }
}
```

Keep the existing `build` metadata below those sections unchanged.

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: install completes and `package-lock.json` updates.

- [ ] **Step 3: Verify empty test command behavior**

Run:

```bash
npm test
```

Expected: Vitest starts and reports no tests found or exits non-zero because no test files exist yet. This is acceptable before adding tests.

- [ ] **Step 4: Commit or skip**

If inside a git repository, run:

```bash
git add package.json package-lock.json
git commit -m "chore: add 3d visualizer dependencies"
```

Expected in this workspace: skip because `git status` reports `fatal: not a git repository`.

---

### Task 2: Shared Types

**Files:**
- Create: `src/lib/types.ts`

- [ ] **Step 1: Create shared types**

Create `src/lib/types.ts` with:

```ts
export type FunctionMode = 'explicit' | 'parametric' | 'implicit' | 'points';

export type AxisName = 'x' | 'y' | 'z' | 'u' | 'v' | 'w' | 't';

export type NumericRange = {
  min: number;
  max: number;
};

export type RangeMap = Record<string, NumericRange>;

export type FixedVariableMap = Record<string, number>;

export type RenderSettings = {
  mode: FunctionMode;
  resolution: number;
  isoValue: number;
  ranges: RangeMap;
  constraint: string;
  fixedVariables: FixedVariableMap;
};

export type ExplicitConfig = RenderSettings & {
  mode: 'explicit';
  zExpression: string;
};

export type ParametricConfig = RenderSettings & {
  mode: 'parametric';
  xExpression: string;
  yExpression: string;
  zExpression: string;
};

export type ImplicitConfig = RenderSettings & {
  mode: 'implicit';
  fExpression: string;
};

export type PointsConfig = RenderSettings & {
  mode: 'points';
  pointText: string;
};

export type VisualizerConfig = ExplicitConfig | ParametricConfig | ImplicitConfig | PointsConfig;

export type GeometryKind = 'mesh' | 'points';

export type GeneratedGeometry = {
  kind: GeometryKind;
  positions: Float32Array;
  indices?: Uint32Array;
  normals?: Float32Array;
  pointSize?: number;
  message: string;
};

export type RenderFailure = {
  ok: false;
  error: string;
};

export type RenderSuccess = {
  ok: true;
  geometry: GeneratedGeometry;
};

export type RenderResult = RenderSuccess | RenderFailure;

export type PickedPoint = {
  x: number;
  y: number;
  z: number;
};
```

- [ ] **Step 2: Run type check**

Run:

```bash
npm run build
```

Expected: build may still pass because the new file is unused, or fail only if dependencies were not installed. Fix dependency issues before proceeding.

- [ ] **Step 3: Commit or skip**

If inside a git repository, run:

```bash
git add src/lib/types.ts
git commit -m "feat: add visualizer shared types"
```

Expected in this workspace: skip because this is not a git repository.

---

### Task 3: Math Engine With Tests

**Files:**
- Create: `src/lib/mathEngine.ts`
- Create: `src/lib/mathEngine.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/mathEngine.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { compileScalarExpression, compileConstraint, parseFixedVariables } from './mathEngine';

describe('mathEngine', () => {
  it('evaluates scalar expressions with common math syntax', () => {
    const expression = compileScalarExpression('sin(x)^2 + cos(x)^2 + y');
    expect(expression({ x: 0, y: 3 })).toBeCloseTo(4, 8);
  });

  it('returns false for an empty constraint', () => {
    const constraint = compileConstraint('');
    expect(constraint({ x: 1, y: 2, z: 3 })).toBe(true);
  });

  it('evaluates boolean constraints', () => {
    const constraint = compileConstraint('x^2 + y^2 < 4 && z >= 0');
    expect(constraint({ x: 1, y: 1, z: 0.5 })).toBe(true);
    expect(constraint({ x: 3, y: 0, z: 0.5 })).toBe(false);
  });

  it('parses fixed variable assignments', () => {
    expect(parseFixedVariables('w=1, t=-2.5')).toEqual({ w: 1, t: -2.5 });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- src/lib/mathEngine.test.ts
```

Expected: FAIL because `src/lib/mathEngine.ts` does not exist.

- [ ] **Step 3: Implement math engine**

Create `src/lib/mathEngine.ts` with:

```ts
import { all, create, MathNode } from 'mathjs';

const math = create(all, {});

type Scope = Record<string, number>;

type CompiledExpression = {
  evaluate: (scope: Scope) => unknown;
};

function normalizeExpression(expression: string) {
  return expression.trim();
}

function assertSafeNode(node: MathNode) {
  node.traverse((child) => {
    if (child.type === 'AssignmentNode' || child.type === 'FunctionAssignmentNode') {
      throw new Error('Assignments are not allowed in expressions.');
    }

    if (child.type === 'AccessorNode' || child.type === 'IndexNode') {
      throw new Error('Property and index access are not allowed.');
    }
  });
}

function compileExpression(expression: string): CompiledExpression {
  const normalized = normalizeExpression(expression);

  if (!normalized) {
    throw new Error('Expression is required.');
  }

  const node = math.parse(normalized);
  assertSafeNode(node);
  return node.compile() as CompiledExpression;
}

export function compileScalarExpression(expression: string) {
  const compiled = compileExpression(expression);

  return (scope: Scope) => {
    const value = compiled.evaluate(scope);

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Expression did not produce a finite number.');
    }

    return value;
  };
}

export function compileConstraint(expression: string) {
  const trimmed = expression.trim();

  if (!trimmed) {
    return () => true;
  }

  const compiled = compileExpression(trimmed);

  return (scope: Scope) => Boolean(compiled.evaluate(scope));
}

export function parseFixedVariables(input: string) {
  const fixed: Scope = {};
  const trimmed = input.trim();

  if (!trimmed) return fixed;

  for (const part of trimmed.split(',')) {
    const [rawName, rawValue] = part.split('=').map((item) => item.trim());

    if (!rawName || rawValue === undefined) {
      throw new Error('Fixed variables must use name=value pairs.');
    }

    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(rawName)) {
      throw new Error(`Invalid variable name: ${rawName}`);
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
      throw new Error(`Invalid fixed value for ${rawName}.`);
    }

    fixed[rawName] = value;
  }

  return fixed;
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
npm test -- src/lib/mathEngine.test.ts
```

Expected: PASS for all math engine tests.

- [ ] **Step 5: Commit or skip**

If inside a git repository, run:

```bash
git add src/lib/mathEngine.ts src/lib/mathEngine.test.ts
git commit -m "feat: add expression math engine"
```

Expected in this workspace: skip because this is not a git repository.

---

### Task 4: Surface Generators and Tests

**Files:**
- Create: `src/lib/surfaceGenerators.ts`
- Create: `src/lib/marchingCubes.ts`
- Create: `src/lib/surfaceGenerators.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/surfaceGenerators.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { generateExplicitSurface, generateImplicitSurface, generateParametricSurface, generatePointCloud } from './surfaceGenerators';

describe('surfaceGenerators', () => {
  it('generates an explicit mesh', () => {
    const geometry = generateExplicitSurface({
      mode: 'explicit',
      zExpression: 'sin(x) * cos(y)',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 20,
      ranges: {
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -2, max: 2 },
      },
    });

    expect(geometry.kind).toBe('mesh');
    expect(geometry.positions.length).toBeGreaterThan(0);
    expect(geometry.indices?.length).toBeGreaterThan(0);
  });

  it('applies explicit constraints', () => {
    const geometry = generateExplicitSurface({
      mode: 'explicit',
      zExpression: 'x + y',
      constraint: 'x >= 0',
      fixedVariables: {},
      isoValue: 0,
      resolution: 10,
      ranges: {
        x: { min: -1, max: 1 },
        y: { min: -1, max: 1 },
        z: { min: -3, max: 3 },
      },
    });

    for (let i = 0; i < geometry.positions.length; i += 3) {
      expect(geometry.positions[i]).toBeGreaterThanOrEqual(-1e-8);
    }
  });

  it('generates a parametric mesh', () => {
    const geometry = generateParametricSurface({
      mode: 'parametric',
      xExpression: '2*sin(u)*cos(v)',
      yExpression: '2*sin(u)*sin(v)',
      zExpression: '2*cos(u)',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 18,
      ranges: {
        u: { min: 0, max: 3.1415926535 },
        v: { min: 0, max: 6.283185307 },
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -3, max: 3 },
      },
    });

    expect(geometry.kind).toBe('mesh');
    expect(geometry.positions.length).toBeGreaterThan(0);
  });

  it('generates an implicit mesh for a sphere', () => {
    const geometry = generateImplicitSurface({
      mode: 'implicit',
      fExpression: 'x^2 + y^2 + z^2 - 4',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 12,
      ranges: {
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -3, max: 3 },
      },
    });

    expect(geometry.kind).toBe('mesh');
    expect(geometry.positions.length).toBeGreaterThan(0);
    expect(geometry.normals?.length).toBe(geometry.positions.length);
  });

  it('generates a constrained point cloud', () => {
    const geometry = generatePointCloud({
      mode: 'points',
      pointText: '0,0,0\n1,1,1\n-1,1,1',
      constraint: 'x >= 0',
      fixedVariables: {},
      isoValue: 0,
      resolution: 10,
      ranges: {
        x: { min: -2, max: 2 },
        y: { min: -2, max: 2 },
        z: { min: -2, max: 2 },
      },
    });

    expect(geometry.kind).toBe('points');
    expect(Array.from(geometry.positions)).toEqual([0, 0, 0, 1, 1, 1]);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- src/lib/surfaceGenerators.test.ts
```

Expected: FAIL because generator files do not exist.

- [ ] **Step 3: Implement implicit extraction helper**

Create `src/lib/marchingCubes.ts` with this marching-tetrahedra implementation. It serves the Marching Cubes requirement by extracting an iso-surface from a sampled 3D grid while avoiding a large lookup table.

```ts
export type ScalarField = {
  nx: number;
  ny: number;
  nz: number;
  values: Float32Array;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
};

type Vec3 = [number, number, number];

type GridPoint = {
  position: Vec3;
  value: number;
};

const tetrahedra = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

const cubeCorners: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

function indexOf(field: ScalarField, i: number, j: number, k: number) {
  return i + field.nx * (j + field.ny * k);
}

function interpolate(a: GridPoint, b: GridPoint, isoValue: number): Vec3 {
  const denominator = b.value - a.value;
  const t = Math.abs(denominator) < 1e-12 ? 0.5 : (isoValue - a.value) / denominator;

  return [
    a.position[0] + (b.position[0] - a.position[0]) * t,
    a.position[1] + (b.position[1] - a.position[1]) * t,
    a.position[2] + (b.position[2] - a.position[2]) * t,
  ];
}

function polygonizeTetra(points: GridPoint[], isoValue: number) {
  const inside = points.filter((point) => point.value <= isoValue);
  const outside = points.filter((point) => point.value > isoValue);

  if (inside.length === 0 || inside.length === 4) return [] as Vec3[][];

  if (inside.length === 1) {
    const a = inside[0];
    return [[
      interpolate(a, outside[0], isoValue),
      interpolate(a, outside[1], isoValue),
      interpolate(a, outside[2], isoValue),
    ]];
  }

  if (inside.length === 3) {
    const a = outside[0];
    return [[
      interpolate(a, inside[2], isoValue),
      interpolate(a, inside[1], isoValue),
      interpolate(a, inside[0], isoValue),
    ]];
  }

  const [a, b] = inside;
  const [c, d] = outside;
  const p0 = interpolate(a, c, isoValue);
  const p1 = interpolate(a, d, isoValue);
  const p2 = interpolate(b, c, isoValue);
  const p3 = interpolate(b, d, isoValue);

  return [
    [p0, p1, p2],
    [p2, p1, p3],
  ];
}

function pushTriangle(positions: number[], normals: number[], a: Vec3, b: Vec3, c: Vec3) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  const normal: Vec3 = [nx / length, ny / length, nz / length];

  for (const point of [a, b, c]) {
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
  }
}

export function extractIsoSurface(field: ScalarField, isoValue: number) {
  const positions: number[] = [];
  const normals: number[] = [];
  const xStep = (field.xMax - field.xMin) / (field.nx - 1);
  const yStep = (field.yMax - field.yMin) / (field.ny - 1);
  const zStep = (field.zMax - field.zMin) / (field.nz - 1);

  for (let k = 0; k < field.nz - 1; k += 1) {
    for (let j = 0; j < field.ny - 1; j += 1) {
      for (let i = 0; i < field.nx - 1; i += 1) {
        const corners = cubeCorners.map(([dx, dy, dz]) => {
          const cx = i + dx;
          const cy = j + dy;
          const cz = k + dz;

          return {
            position: [
              field.xMin + cx * xStep,
              field.yMin + cy * yStep,
              field.zMin + cz * zStep,
            ] as Vec3,
            value: field.values[indexOf(field, cx, cy, cz)],
          };
        });

        for (const tetra of tetrahedra) {
          const triangles = polygonizeTetra(tetra.map((cornerIndex) => corners[cornerIndex]), isoValue);

          for (const triangle of triangles) {
            pushTriangle(positions, normals, triangle[0], triangle[1], triangle[2]);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
  };
}
```

- [ ] **Step 4: Implement surface generators**

Create `src/lib/surfaceGenerators.ts` with:

```ts
import { ExplicitConfig, GeneratedGeometry, ImplicitConfig, NumericRange, ParametricConfig, PointsConfig, VisualizerConfig } from './types';
import { compileConstraint, compileScalarExpression } from './mathEngine';
import { extractIsoSurface } from './marchingCubes';

function clampResolution(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function requiredRange(ranges: Record<string, NumericRange>, name: string) {
  const range = ranges[name];

  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) {
    throw new Error(`Invalid ${name} range.`);
  }

  return range;
}

function inDisplayRanges(scope: Record<string, number>, ranges: Record<string, NumericRange>) {
  for (const name of ['x', 'y', 'z']) {
    const range = ranges[name];
    const value = scope[name];

    if (range && Number.isFinite(value) && (value < range.min || value > range.max)) {
      return false;
    }
  }

  return true;
}

function pushVertex(positions: number[], point: [number, number, number]) {
  const index = positions.length / 3;
  positions.push(point[0], point[1], point[2]);
  return index;
}

function buildGridMesh(points: ([number, number, number] | null)[][]) {
  const positions: number[] = [];
  const indices: number[] = [];
  const indexGrid = points.map((row) => row.map((point) => (point ? pushVertex(positions, point) : -1)));

  for (let y = 0; y < points.length - 1; y += 1) {
    for (let x = 0; x < points[y].length - 1; x += 1) {
      const a = indexGrid[y][x];
      const b = indexGrid[y][x + 1];
      const c = indexGrid[y + 1][x];
      const d = indexGrid[y + 1][x + 1];

      if (a >= 0 && b >= 0 && c >= 0) indices.push(a, c, b);
      if (b >= 0 && c >= 0 && d >= 0) indices.push(b, c, d);
    }
  }

  if (positions.length === 0 || indices.length === 0) {
    throw new Error('No valid surface points were generated.');
  }

  return {
    kind: 'mesh',
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    message: `${positions.length / 3} vertices generated.`,
  } satisfies GeneratedGeometry;
}

export function generateExplicitSurface(config: ExplicitConfig): GeneratedGeometry {
  const xRange = requiredRange(config.ranges, 'x');
  const yRange = requiredRange(config.ranges, 'y');
  const zRange = config.ranges.z;
  const resolution = clampResolution(config.resolution, 4, 160);
  const expression = compileScalarExpression(config.zExpression);
  const constraint = compileConstraint(config.constraint);
  const points: ([number, number, number] | null)[][] = [];

  for (let yi = 0; yi < resolution; yi += 1) {
    const y = yRange.min + (yRange.max - yRange.min) * (yi / (resolution - 1));
    const row: ([number, number, number] | null)[] = [];

    for (let xi = 0; xi < resolution; xi += 1) {
      const x = xRange.min + (xRange.max - xRange.min) * (xi / (resolution - 1));
      const scope = { ...config.fixedVariables, x, y };

      try {
        const z = expression(scope);
        const fullScope = { ...scope, z };
        const validZ = !zRange || (z >= zRange.min && z <= zRange.max);
        row.push(validZ && constraint(fullScope) ? [x, y, z] : null);
      } catch {
        row.push(null);
      }
    }

    points.push(row);
  }

  return buildGridMesh(points);
}

export function generateParametricSurface(config: ParametricConfig): GeneratedGeometry {
  const uRange = requiredRange(config.ranges, 'u');
  const vRange = requiredRange(config.ranges, 'v');
  const resolution = clampResolution(config.resolution, 4, 160);
  const xExpression = compileScalarExpression(config.xExpression);
  const yExpression = compileScalarExpression(config.yExpression);
  const zExpression = compileScalarExpression(config.zExpression);
  const constraint = compileConstraint(config.constraint);
  const points: ([number, number, number] | null)[][] = [];

  for (let vi = 0; vi < resolution; vi += 1) {
    const v = vRange.min + (vRange.max - vRange.min) * (vi / (resolution - 1));
    const row: ([number, number, number] | null)[] = [];

    for (let ui = 0; ui < resolution; ui += 1) {
      const u = uRange.min + (uRange.max - uRange.min) * (ui / (resolution - 1));
      const baseScope = { ...config.fixedVariables, u, v };

      try {
        const x = xExpression(baseScope);
        const y = yExpression(baseScope);
        const z = zExpression(baseScope);
        const scope = { ...baseScope, x, y, z };
        row.push(inDisplayRanges(scope, config.ranges) && constraint(scope) ? [x, y, z] : null);
      } catch {
        row.push(null);
      }
    }

    points.push(row);
  }

  return buildGridMesh(points);
}

export function generateImplicitSurface(config: ImplicitConfig): GeneratedGeometry {
  const xRange = requiredRange(config.ranges, 'x');
  const yRange = requiredRange(config.ranges, 'y');
  const zRange = requiredRange(config.ranges, 'z');
  const resolution = clampResolution(config.resolution, 8, 48);
  const expression = compileScalarExpression(config.fExpression);
  const values = new Float32Array(resolution * resolution * resolution);
  let cursor = 0;

  for (let zi = 0; zi < resolution; zi += 1) {
    const z = zRange.min + (zRange.max - zRange.min) * (zi / (resolution - 1));

    for (let yi = 0; yi < resolution; yi += 1) {
      const y = yRange.min + (yRange.max - yRange.min) * (yi / (resolution - 1));

      for (let xi = 0; xi < resolution; xi += 1) {
        const x = xRange.min + (xRange.max - xRange.min) * (xi / (resolution - 1));

        try {
          values[cursor] = expression({ ...config.fixedVariables, x, y, z });
        } catch {
          values[cursor] = Number.POSITIVE_INFINITY;
        }

        cursor += 1;
      }
    }
  }

  const surface = extractIsoSurface({
    nx: resolution,
    ny: resolution,
    nz: resolution,
    values,
    xMin: xRange.min,
    xMax: xRange.max,
    yMin: yRange.min,
    yMax: yRange.max,
    zMin: zRange.min,
    zMax: zRange.max,
  }, config.isoValue);

  if (surface.positions.length === 0) {
    throw new Error('No implicit surface was found in the selected range.');
  }

  const constraint = compileConstraint(config.constraint);

  if (config.constraint.trim()) {
    const filteredPositions: number[] = [];
    const filteredNormals: number[] = [];

    for (let i = 0; i < surface.positions.length; i += 9) {
      const triangle = [0, 3, 6].map((offset) => ({
        x: surface.positions[i + offset],
        y: surface.positions[i + offset + 1],
        z: surface.positions[i + offset + 2],
      }));

      if (triangle.every((point) => constraint({ ...config.fixedVariables, ...point }))) {
        for (let offset = 0; offset < 9; offset += 1) {
          filteredPositions.push(surface.positions[i + offset]);
          filteredNormals.push(surface.normals[i + offset]);
        }
      }
    }

    if (filteredPositions.length === 0) {
      throw new Error('No implicit surface remained after applying constraints.');
    }

    return {
      kind: 'mesh',
      positions: new Float32Array(filteredPositions),
      normals: new Float32Array(filteredNormals),
      message: `${filteredPositions.length / 3} implicit vertices generated.`,
    };
  }

  return {
    kind: 'mesh',
    positions: surface.positions,
    normals: surface.normals,
    message: `${surface.positions.length / 3} implicit vertices generated.`,
  };
}

export function generatePointCloud(config: PointsConfig): GeneratedGeometry {
  const constraint = compileConstraint(config.constraint);
  const positions: number[] = [];

  for (const line of config.pointText.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const values = trimmed.split(/[,	 ]+/).map(Number);
    if (values.length < 3 || values.some((value) => !Number.isFinite(value))) continue;

    const [x, y, z] = values;
    const scope = { ...config.fixedVariables, x, y, z };

    if (inDisplayRanges(scope, config.ranges) && constraint(scope)) {
      positions.push(x, y, z);
    }
  }

  if (positions.length === 0) {
    throw new Error('No valid points were generated.');
  }

  return {
    kind: 'points',
    positions: new Float32Array(positions),
    pointSize: 0.08,
    message: `${positions.length / 3} points generated.`,
  };
}

export function generateGeometry(config: VisualizerConfig): GeneratedGeometry {
  switch (config.mode) {
    case 'explicit':
      return generateExplicitSurface(config);
    case 'parametric':
      return generateParametricSurface(config);
    case 'implicit':
      return generateImplicitSurface(config);
    case 'points':
      return generatePointCloud(config);
    default:
      throw new Error('Unsupported function mode.');
  }
}
```

- [ ] **Step 5: Run generator tests**

Run:

```bash
npm test -- src/lib/surfaceGenerators.test.ts
```

Expected: PASS for all generator tests.

- [ ] **Step 6: Commit or skip**

If inside a git repository, run:

```bash
git add src/lib/surfaceGenerators.ts src/lib/marchingCubes.ts src/lib/surfaceGenerators.test.ts
git commit -m "feat: generate constrained 3d geometry"
```

Expected in this workspace: skip because this is not a git repository.

---

### Task 5: Examples and Control Panel

**Files:**
- Create: `src/lib/examples.ts`
- Create: `src/components/ControlPanel.tsx`

- [ ] **Step 1: Create examples**

Create `src/lib/examples.ts` with:

```ts
import { VisualizerConfig } from './types';

export type VisualizerExample = {
  id: string;
  name: string;
  description: string;
  config: VisualizerConfig;
};

const baseRanges = {
  x: { min: -5, max: 5 },
  y: { min: -5, max: 5 },
  z: { min: -5, max: 5 },
};

export const visualizerExamples: VisualizerExample[] = [
  {
    id: 'explicit-wave',
    name: '显式波面',
    description: 'z = sin(x) * cos(y)',
    config: {
      mode: 'explicit',
      zExpression: 'sin(x) * cos(y)',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 72,
      ranges: { ...baseRanges, z: { min: -1.5, max: 1.5 } },
    },
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
        ...baseRanges,
        u: { min: 0, max: Math.PI },
        v: { min: 0, max: Math.PI * 2 },
        x: { min: -3, max: 3 },
        y: { min: -3, max: 3 },
        z: { min: -3, max: 3 },
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
    description: '隐式球面 + z >= 0',
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
    description: '离散采样点',
    config: {
      mode: 'points',
      pointText: '-2,-2,0\n-1,-1,1\n0,0,2\n1,1,1\n2,2,0\n2,-2,1\n-2,2,1',
      constraint: '',
      fixedVariables: {},
      isoValue: 0,
      resolution: 16,
      ranges: baseRanges,
    },
  },
];

export const defaultConfig = visualizerExamples[0].config;
```

- [ ] **Step 2: Create control panel component**

Create `src/components/ControlPanel.tsx` with:

```tsx
import { VisualizerExample, visualizerExamples } from '../lib/examples';
import { FunctionMode, NumericRange, PickedPoint, VisualizerConfig } from '../lib/types';

type ControlPanelProps = {
  config: VisualizerConfig;
  status: string;
  error: string;
  pickedPoint: PickedPoint | null;
  onChange: (config: VisualizerConfig) => void;
  onRender: () => void;
  onExample: (example: VisualizerExample) => void;
};

const modeLabels: Record<FunctionMode, string> = {
  explicit: '显式 z=f(x,y)',
  parametric: '参数曲面',
  implicit: '隐式 F(x,y,z)=0',
  points: '离散点云',
};

function numberValue(value: number) {
  return Number.isFinite(value) ? String(value) : '0';
}

function updateRange(config: VisualizerConfig, axis: string, side: keyof NumericRange, value: string): VisualizerConfig {
  return {
    ...config,
    ranges: {
      ...config.ranges,
      [axis]: {
        ...(config.ranges[axis] ?? { min: -5, max: 5 }),
        [side]: Number(value),
      },
    },
  };
}

function setMode(config: VisualizerConfig, mode: FunctionMode): VisualizerConfig {
  if (mode === config.mode) return config;

  if (mode === 'explicit') {
    return { ...config, mode, zExpression: 'sin(x) * cos(y)' };
  }

  if (mode === 'parametric') {
    return {
      ...config,
      mode,
      xExpression: '2*sin(u)*cos(v)',
      yExpression: '2*sin(u)*sin(v)',
      zExpression: '2*cos(u)',
      ranges: {
        ...config.ranges,
        u: { min: 0, max: Math.PI },
        v: { min: 0, max: Math.PI * 2 },
      },
    };
  }

  if (mode === 'implicit') {
    return { ...config, mode, fExpression: 'x^2 + y^2 + z^2 - 4' };
  }

  return {
    ...config,
    mode,
    pointText: '-2,-2,0\n-1,-1,1\n0,0,2\n1,1,1\n2,2,0',
  };
}

function RangeRow({ axis, config, onChange }: { axis: string; config: VisualizerConfig; onChange: (config: VisualizerConfig) => void }) {
  const range = config.ranges[axis] ?? { min: -5, max: 5 };

  return (
    <div className="range-row">
      <span>{axis}</span>
      <input aria-label={`${axis} min`} type="number" value={numberValue(range.min)} onChange={(event) => onChange(updateRange(config, axis, 'min', event.target.value))} />
      <input aria-label={`${axis} max`} type="number" value={numberValue(range.max)} onChange={(event) => onChange(updateRange(config, axis, 'max', event.target.value))} />
    </div>
  );
}

export function ControlPanel({ config, status, error, pickedPoint, onChange, onRender, onExample }: ControlPanelProps) {
  const commonAxes = config.mode === 'parametric' ? ['x', 'y', 'z', 'u', 'v'] : ['x', 'y', 'z'];

  return (
    <aside className="control-panel">
      <div className="panel-title">
        <div>
          <h1>3D 函数可视化器</h1>
          <p>输入函数、范围和约束，生成可旋转的 3D 形状。</p>
        </div>
      </div>

      <section className="panel-section">
        <label>函数类型</label>
        <select value={config.mode} onChange={(event) => onChange(setMode(config, event.target.value as FunctionMode))}>
          {Object.entries(modeLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </section>

      <section className="panel-section expression-stack">
        {config.mode === 'explicit' && (
          <label>
            z =
            <input value={config.zExpression} onChange={(event) => onChange({ ...config, zExpression: event.target.value })} />
          </label>
        )}

        {config.mode === 'parametric' && (
          <>
            <label>x(u,v)<input value={config.xExpression} onChange={(event) => onChange({ ...config, xExpression: event.target.value })} /></label>
            <label>y(u,v)<input value={config.yExpression} onChange={(event) => onChange({ ...config, yExpression: event.target.value })} /></label>
            <label>z(u,v)<input value={config.zExpression} onChange={(event) => onChange({ ...config, zExpression: event.target.value })} /></label>
          </>
        )}

        {config.mode === 'implicit' && (
          <label>
            F(x,y,z) =
            <input value={config.fExpression} onChange={(event) => onChange({ ...config, fExpression: event.target.value })} />
          </label>
        )}

        {config.mode === 'points' && (
          <label>
            点数据
            <textarea value={config.pointText} onChange={(event) => onChange({ ...config, pointText: event.target.value })} />
          </label>
        )}
      </section>

      <section className="panel-section">
        <label>约束条件</label>
        <input placeholder="例如 z >= 0 && x^2 + y^2 < 9" value={config.constraint} onChange={(event) => onChange({ ...config, constraint: event.target.value })} />
      </section>

      <section className="panel-section range-grid">
        <div className="range-head"><span>变量</span><span>最小</span><span>最大</span></div>
        {commonAxes.map((axis) => <RangeRow key={axis} axis={axis} config={config} onChange={onChange} />)}
      </section>

      <section className="panel-section two-inputs">
        <label>精度<input type="number" min="4" max="160" value={config.resolution} onChange={(event) => onChange({ ...config, resolution: Number(event.target.value) })} /></label>
        <label>等值<input type="number" value={config.isoValue} onChange={(event) => onChange({ ...config, isoValue: Number(event.target.value) })} /></label>
      </section>

      <section className="panel-section examples">
        <label>示例</label>
        <div className="example-list">
          {visualizerExamples.map((example) => (
            <button key={example.id} type="button" onClick={() => onExample(example)} title={example.description}>{example.name}</button>
          ))}
        </div>
      </section>

      <button className="render-button" type="button" onClick={onRender}>渲染 3D 形状</button>

      <section className="status-box">
        {error ? <p className="error-text">{error}</p> : <p>{status}</p>}
        {pickedPoint && (
          <p className="picked-text">选中: x={pickedPoint.x.toFixed(3)}, y={pickedPoint.y.toFixed(3)}, z={pickedPoint.z.toFixed(3)}</p>
        )}
      </section>
    </aside>
  );
}
```

- [ ] **Step 3: Run type check**

Run:

```bash
npm run build
```

Expected: PASS, or fail only because `App.tsx` has not been replaced yet. If the failure is due to these new files, fix it before proceeding.

- [ ] **Step 4: Commit or skip**

If inside a git repository, run:

```bash
git add src/lib/examples.ts src/components/ControlPanel.tsx
git commit -m "feat: add visualizer controls"
```

Expected in this workspace: skip because this is not a git repository.

---

### Task 6: Three.js Viewport

**Files:**
- Create: `src/components/ThreeViewport.tsx`

- [ ] **Step 1: Create Three.js viewport component**

Create `src/components/ThreeViewport.tsx` with:

```tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GeneratedGeometry, PickedPoint } from '../lib/types';

type ThreeViewportProps = {
  geometry: GeneratedGeometry | null;
  onPick: (point: PickedPoint | null) => void;
};

function createTextSprite(text: string, position: THREE.Vector3, size = 72) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');

  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#555555';
  context.font = `700 ${size}px Inter, Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(position);
  sprite.scale.set(0.75, 0.36, 1);
  return sprite;
}

function addCoordinateCarrier(scene: THREE.Scene) {
  const carrier = new THREE.Group();
  const box = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
  const helper = new THREE.Box3Helper(box, new THREE.Color('#b7bcc5'));
  carrier.add(helper);

  const grid = new THREE.GridHelper(10, 20, '#6f7682', '#d6d9df');
  grid.rotation.x = Math.PI / 2;
  carrier.add(grid);

  const axisMaterial = new THREE.LineBasicMaterial({ color: '#9ca3af', linewidth: 2 });
  const axes: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(-5.4, 0, 0), new THREE.Vector3(5.6, 0, 0)],
    [new THREE.Vector3(0, -5.4, 0), new THREE.Vector3(0, 5.6, 0)],
    [new THREE.Vector3(0, 0, -5.4), new THREE.Vector3(0, 0, 5.6)],
  ];

  for (const [start, end] of axes) {
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    carrier.add(new THREE.Line(geometry, axisMaterial));
  }

  const labels = [
    createTextSprite('X', new THREE.Vector3(5.95, 0, 0), 84),
    createTextSprite('Y', new THREE.Vector3(0, 5.95, 0), 84),
    createTextSprite('Z', new THREE.Vector3(0, 0, 5.95), 84),
  ];

  labels.forEach((label) => label && carrier.add(label));

  for (const value of [-4, -2, 2, 4]) {
    const xLabel = createTextSprite(String(value), new THREE.Vector3(value, -0.28, 0), 42);
    const yLabel = createTextSprite(String(value), new THREE.Vector3(0.32, value, 0), 42);
    const zLabel = createTextSprite(String(value), new THREE.Vector3(-0.35, 0, value), 42);
    if (xLabel) carrier.add(xLabel);
    if (yLabel) carrier.add(yLabel);
    if (zLabel) carrier.add(zLabel);
  }

  scene.add(carrier);
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();

    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

function createRenderable(geometryData: GeneratedGeometry) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(geometryData.positions, 3));

  if (geometryData.indices) {
    geometry.setIndex(new THREE.BufferAttribute(geometryData.indices, 1));
  }

  if (geometryData.normals) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(geometryData.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }

  geometry.computeBoundingSphere();

  if (geometryData.kind === 'points') {
    const material = new THREE.PointsMaterial({ color: '#2563eb', size: geometryData.pointSize ?? 0.08, sizeAttenuation: true });
    return new THREE.Points(geometry, material);
  }

  const material = new THREE.MeshStandardMaterial({
    color: '#2f80ed',
    roughness: 0.38,
    metalness: 0.04,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
  });

  return new THREE.Mesh(geometry, material);
}

export function ThreeViewport({ geometry, onPick }: ThreeViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderableRef = useRef<THREE.Object3D | null>(null);
  const markerRef = useRef<THREE.Mesh | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f7f9fc');
    const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(8, -10, 7);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight('#ffffff', 0.72));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.1);
    keyLight.position.set(5, -6, 8);
    keyLight.castShadow = true;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#b9d7ff', 0.45);
    fillLight.position.set(-6, 4, 6);
    scene.add(fillLight);

    addCoordinateCarrier(scene);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const handlePointerDown = (event: PointerEvent) => {
      const currentRenderable = renderableRef.current;
      if (!currentRenderable) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObject(currentRenderable, true);

      if (!intersections[0]) return;

      const point = intersections[0].point;
      onPick({ x: point.x, y: point.y, z: point.z });

      if (!markerRef.current) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 16, 16),
          new THREE.MeshStandardMaterial({ color: '#e11d48', roughness: 0.3 }),
        );
        markerRef.current = marker;
        scene.add(marker);
      }

      markerRef.current.position.copy(point);
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);

    const resizeObserver = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      scene.traverse((object) => disposeObject(object));
    };
  }, [onPick]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (renderableRef.current) {
      scene.remove(renderableRef.current);
      disposeObject(renderableRef.current);
      renderableRef.current = null;
    }

    if (!geometry) return;

    const renderable = createRenderable(geometry);
    renderable.castShadow = true;
    renderable.receiveShadow = true;
    renderableRef.current = renderable;
    scene.add(renderable);
  }, [geometry]);

  return <div className="viewport" ref={containerRef} />;
}
```

- [ ] **Step 2: Run type check**

Run:

```bash
npm run build
```

Expected: PASS, or fail only because `App.tsx` has not been replaced yet. Fix viewport-specific TypeScript errors before proceeding.

- [ ] **Step 3: Commit or skip**

If inside a git repository, run:

```bash
git add src/components/ThreeViewport.tsx
git commit -m "feat: add interactive three viewport"
```

Expected in this workspace: skip because this is not a git repository.

---

### Task 7: App Orchestration and Styles

**Files:**
- Replace: `src/App.tsx`
- Replace: `src/styles.css`

- [ ] **Step 1: Replace app shell**

Replace `src/App.tsx` with:

```tsx
import { useCallback, useMemo, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { ThreeViewport } from './components/ThreeViewport';
import { defaultConfig, VisualizerExample } from './lib/examples';
import { generateGeometry } from './lib/surfaceGenerators';
import { GeneratedGeometry, PickedPoint, VisualizerConfig } from './lib/types';

function cloneConfig(config: VisualizerConfig): VisualizerConfig {
  return JSON.parse(JSON.stringify(config)) as VisualizerConfig;
}

export function App() {
  const [config, setConfig] = useState<VisualizerConfig>(() => cloneConfig(defaultConfig));
  const [geometry, setGeometry] = useState<GeneratedGeometry | null>(() => generateGeometry(cloneConfig(defaultConfig)));
  const [status, setStatus] = useState('示例曲面已渲染。拖拽旋转，滚轮缩放，点击曲面查看坐标。');
  const [error, setError] = useState('');
  const [pickedPoint, setPickedPoint] = useState<PickedPoint | null>(null);

  const handleRender = useCallback(() => {
    try {
      const nextGeometry = generateGeometry(config);
      setGeometry(nextGeometry);
      setStatus(nextGeometry.message);
      setError('');
      setPickedPoint(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '渲染失败。';
      setError(message);
    }
  }, [config]);

  const handleExample = useCallback((example: VisualizerExample) => {
    const nextConfig = cloneConfig(example.config);
    setConfig(nextConfig);

    try {
      const nextGeometry = generateGeometry(nextConfig);
      setGeometry(nextGeometry);
      setStatus(`${example.name}: ${nextGeometry.message}`);
      setError('');
      setPickedPoint(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '示例渲染失败。';
      setError(message);
    }
  }, []);

  const geometryLabel = useMemo(() => {
    if (!geometry) return '无图形';
    return geometry.kind === 'points' ? `${geometry.positions.length / 3} 个点` : `${geometry.positions.length / 3} 个顶点`;
  }, [geometry]);

  return (
    <main className="visualizer-app">
      <ControlPanel
        config={config}
        status={`${status} 当前图形: ${geometryLabel}`}
        error={error}
        pickedPoint={pickedPoint}
        onChange={setConfig}
        onRender={handleRender}
        onExample={handleExample}
      />
      <section className="scene-shell">
        <div className="scene-toolbar">
          <div>
            <strong>3D 坐标载体</strong>
            <span>透明坐标盒 / 网格 / 轴线 / 基础高光</span>
          </div>
          <span className="mode-pill">{config.mode}</span>
        </div>
        <ThreeViewport geometry={geometry} onPick={setPickedPoint} />
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Replace styles**

Replace `src/styles.css` with:

```css
:root {
  color: #172033;
  background: #eef2f7;
  font-family: Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

button,
input,
textarea,
select {
  font: inherit;
}

.visualizer-app {
  display: grid;
  grid-template-columns: 380px minmax(0, 1fr);
  width: 100vw;
  height: 100vh;
  background: #eef2f7;
}

.control-panel {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  overflow: auto;
  border-right: 1px solid #d8dee9;
  background: #fbfcff;
  padding: 18px;
}

.panel-title h1 {
  margin: 0 0 6px;
  color: #111827;
  font-size: 24px;
  line-height: 1.15;
}

.panel-title p,
.scene-toolbar span,
.status-box {
  color: #64748b;
}

.panel-title p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.panel-section {
  display: grid;
  gap: 8px;
}

.panel-section label {
  display: grid;
  gap: 6px;
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

input,
textarea,
select {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: #ffffff;
  color: #172033;
  outline: none;
}

input,
select {
  height: 36px;
  padding: 0 10px;
}

textarea {
  min-height: 110px;
  resize: vertical;
  padding: 10px;
  line-height: 1.45;
}

input:focus,
textarea:focus,
select:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.13);
}

.expression-stack {
  gap: 10px;
}

.range-grid {
  gap: 6px;
}

.range-head,
.range-row {
  display: grid;
  grid-template-columns: 42px 1fr 1fr;
  align-items: center;
  gap: 8px;
}

.range-head {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.range-row span {
  color: #334155;
  font-weight: 800;
  text-transform: uppercase;
}

.two-inputs {
  grid-template-columns: 1fr 1fr;
}

.example-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.example-list button,
.render-button {
  border: 0;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
}

.example-list button {
  border-radius: 7px;
  background: #e8eef8;
  color: #1f3a5f;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 700;
}

.example-list button:hover {
  background: #dbe7fb;
}

.render-button {
  min-height: 44px;
  border-radius: 8px;
  background: #2563eb;
  color: #ffffff;
  font-weight: 800;
  box-shadow: 0 12px 24px rgba(37, 99, 235, 0.22);
}

.render-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 30px rgba(37, 99, 235, 0.27);
}

.status-box {
  border: 1px solid #d8dee9;
  border-radius: 8px;
  background: #f7f9fc;
  padding: 11px;
  font-size: 13px;
  line-height: 1.45;
}

.status-box p {
  margin: 0;
}

.status-box p + p {
  margin-top: 8px;
}

.error-text {
  color: #b42318;
  font-weight: 700;
}

.picked-text {
  color: #1d4ed8;
  font-weight: 700;
}

.scene-shell {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 64px minmax(0, 1fr);
  padding: 16px;
}

.scene-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #d8dee9;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: rgba(255, 255, 255, 0.88);
  padding: 0 16px;
}

.scene-toolbar strong {
  display: block;
  color: #111827;
  font-size: 16px;
}

.scene-toolbar span {
  display: block;
  margin-top: 3px;
  font-size: 12px;
}

.mode-pill {
  border-radius: 999px;
  background: #e0ecff;
  color: #1d4ed8 !important;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 800;
}

.viewport {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid #d8dee9;
  border-radius: 0 0 8px 8px;
  background: #f7f9fc;
}

.viewport canvas {
  display: block;
}

@media (max-width: 920px) {
  .visualizer-app {
    grid-template-columns: 1fr;
    grid-template-rows: 45vh 55vh;
  }

  .control-panel {
    grid-row: 2;
    border-top: 1px solid #d8dee9;
    border-right: 0;
  }

  .scene-shell {
    grid-row: 1;
    padding: 10px;
  }
}
```

- [ ] **Step 3: Run type check and build**

Run:

```bash
npm run build
```

Expected: PASS. If TypeScript reports missing module types for Three.js, verify `@types/three` is installed.

- [ ] **Step 4: Commit or skip**

If inside a git repository, run:

```bash
git add src/App.tsx src/styles.css
git commit -m "feat: replace app with 3d visualizer"
```

Expected in this workspace: skip because this is not a git repository.

---

### Task 8: End-to-End Verification

**Files:**
- No new files expected.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm test
```

Expected: PASS for `mathEngine.test.ts` and `surfaceGenerators.test.ts`.

- [ ] **Step 2: Run production build**

Run:

```bash
npm run build
```

Expected: PASS and Vite writes `dist/`.

- [ ] **Step 3: Start dev server**

Run:

```bash
npm run dev
```

Expected: Vite serves the app on `http://127.0.0.1:5173/` or another available port.

- [ ] **Step 4: Manual browser verification**

Open the served URL and verify:

- Default `z = sin(x) * cos(y)` shows a shaded surface.
- Dragging rotates the scene.
- Mouse wheel zooms the scene.
- The coordinate box, grid, X/Y/Z labels, and tick labels are visible.
- Clicking the surface updates the selected coordinate readout.
- The `参数球面` example renders a sphere-like surface.
- The `隐式球面` example renders an approximate sphere.
- The `约束上半球` example renders only the upper half.
- Entering an invalid expression shows an error and does not crash the page.

- [ ] **Step 5: Final commit or skip**

If inside a git repository, run:

```bash
git status --short
git add package.json package-lock.json src docs
git commit -m "feat: build 3d constraint function visualizer"
```

Expected in this workspace: skip because this is not a git repository.

---

## Self-Review

Spec coverage:

- Explicit surface: Task 4 and Task 7.
- Parametric surface: Task 4, Task 5, and Task 7.
- Implicit surface with iso extraction: Task 4.
- Discrete points: Task 4 and Task 5.
- Constraint filtering: Task 3 and Task 4.
- Variable ranges and resolution: Task 5 and Task 7.
- Coordinate carrier, axes, grid, ticks, labels: Task 6.
- Basic lighting and highlights: Task 6.
- Picking/coordinate inspection: Task 6 and Task 7.
- Error handling: Task 3, Task 4, and Task 7.
- Verification: Task 8.

Placeholder scan: no TBD/TODO placeholders are intentionally left in the implementation tasks.

Type consistency: `VisualizerConfig`, `GeneratedGeometry`, `PickedPoint`, and mode names are defined in Task 2 and reused consistently in later tasks.
