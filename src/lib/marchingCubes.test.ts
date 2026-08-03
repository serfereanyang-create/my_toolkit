import { describe, expect, it } from 'vitest';

import { extractIsoSurface, type ScalarField } from './marchingCubes';

function sampleField(
  resolution: number,
  evaluate: (x: number, y: number, z: number) => number,
  range = { min: -1, max: 1 },
): ScalarField {
  const values = new Float64Array(resolution ** 3);
  let cursor = 0;
  for (let zIndex = 0; zIndex < resolution; zIndex += 1) {
    const z = (1 - zIndex / (resolution - 1)) * range.min
      + (zIndex / (resolution - 1)) * range.max;
    for (let yIndex = 0; yIndex < resolution; yIndex += 1) {
      const y = (1 - yIndex / (resolution - 1)) * range.min
        + (yIndex / (resolution - 1)) * range.max;
      for (let xIndex = 0; xIndex < resolution; xIndex += 1) {
        const x = (1 - xIndex / (resolution - 1)) * range.min
          + (xIndex / (resolution - 1)) * range.max;
        values[cursor] = evaluate(x, y, z);
        cursor += 1;
      }
    }
  }

  return {
    nx: resolution,
    ny: resolution,
    nz: resolution,
    values,
    xMin: range.min,
    xMax: range.max,
    yMin: range.min,
    yMax: range.max,
    zMin: range.min,
    zMax: range.max,
  };
}

function expectValidTriangles(surface: ReturnType<typeof extractIsoSurface>) {
  expect(surface.positions.length).toBeGreaterThan(0);
  expect(surface.positions.length % 9).toBe(0);
  expect(surface.normals.length).toBe(surface.positions.length);
  expect(Array.from(surface.positions).every(Number.isFinite)).toBe(true);
  expect(Array.from(surface.normals).every(Number.isFinite)).toBe(true);

  for (let triangle = 0; triangle < surface.positions.length; triangle += 9) {
    const ax = surface.positions[triangle];
    const ay = surface.positions[triangle + 1];
    const az = surface.positions[triangle + 2];
    const abx = surface.positions[triangle + 3] - ax;
    const aby = surface.positions[triangle + 4] - ay;
    const abz = surface.positions[triangle + 5] - az;
    const acx = surface.positions[triangle + 6] - ax;
    const acy = surface.positions[triangle + 7] - ay;
    const acz = surface.positions[triangle + 8] - az;
    const area2 = Math.hypot(
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    );
    expect(area2).toBeGreaterThan(0);
  }
}

describe('extractIsoSurface', () => {
  it('rejects coordinate ranges outside finite Float32 output', () => {
    const field = sampleField(2, (x) => x, { min: -1e39, max: 1e39 });

    expect(() => extractIsoSurface(field, 0)).toThrow(/float32|rendered coordinate/i);
  });

  it('skips triangles that collapse during Float32 conversion', () => {
    const field = sampleField(2, (x) => x - (1e20 + 5e11), {
      min: 1e20,
      max: 1e20 + 1e12,
    });
    const surface = extractIsoSurface(field, 0);

    expect(surface.positions.length).toBe(0);
    expect(Array.from(surface.positions).every(Number.isFinite)).toBe(true);
  });

  it('uses the true interpolation ratio for tiny finite scalar deltas', () => {
    const field = sampleField(2, (x) => 1e-15 * (x - 0.2), { min: 0, max: 1 });
    const surface = extractIsoSurface(field, 0);

    expectValidTriangles(surface);
    for (let index = 0; index < surface.positions.length; index += 3) {
      expect(surface.positions[index]).toBeCloseTo(0.2, 5);
    }
  });

  it('preserves scalar detail above Float32 precision', () => {
    const field = sampleField(4, (x) => 1e8 + x);
    const surface = extractIsoSurface(field, 1e8);

    expect(field.values).toBeInstanceOf(Float64Array);
    expectValidTriangles(surface);
    for (let index = 0; index < surface.positions.length; index += 3) {
      expect(surface.positions[index]).toBeCloseTo(0, 6);
    }
  });

  it.each([
    ['very large', 1e46],
    ['very small', 1e-46],
  ])('extracts a plane from %s finite scalar samples', (_label, scale) => {
    const field = sampleField(4, (x) => scale * x);
    const surface = extractIsoSurface(field, 0);

    expect(Array.from(field.values).every(Number.isFinite)).toBe(true);
    expectValidTriangles(surface);
    for (let index = 0; index < surface.positions.length; index += 3) {
      expect(surface.positions[index]).toBeCloseTo(0, 6);
    }
  });

  it('scales interpolation operands when a finite scalar delta overflows', () => {
    const field = sampleField(2, (x) => 1e308 * x);
    const surface = extractIsoSurface(field, 0);

    expect(Array.from(field.values).every(Number.isFinite)).toBe(true);
    expectValidTriangles(surface);
    for (let index = 0; index < surface.positions.length; index += 3) {
      expect(surface.positions[index]).toBeCloseTo(0, 6);
    }
  });

  it('orients a plane toward increasing field values with unit +X normals', () => {
    const surface = extractIsoSurface(sampleField(5, (x) => x), 0);

    expectValidTriangles(surface);
    for (let index = 0; index < surface.normals.length; index += 3) {
      const nx = surface.normals[index];
      const ny = surface.normals[index + 1];
      const nz = surface.normals[index + 2];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
      expect(nx).toBeGreaterThan(0.999);
    }
  });

  it('emits a nondegenerate sphere near the level set with outward unit normals', () => {
    const resolution = 12;
    const surface = extractIsoSurface(
      sampleField(resolution, (x, y, z) => x * x + y * y + z * z - 0.5 ** 2),
      0,
    );

    expectValidTriangles(surface);
    const gridStep = 2 / (resolution - 1);
    for (let index = 0; index < surface.positions.length; index += 3) {
      const x = surface.positions[index];
      const y = surface.positions[index + 1];
      const z = surface.positions[index + 2];
      const nx = surface.normals[index];
      const ny = surface.normals[index + 1];
      const nz = surface.normals[index + 2];
      expect(Math.abs(Math.hypot(x, y, z) - 0.5)).toBeLessThan(gridStep);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
      expect(x * nx + y * ny + z * nz).toBeGreaterThan(0);
    }
  });

  it('aborts a max-resolution adversarial field at the configured output budget', () => {
    const field = sampleField(48, (x, y, z) => {
      const xi = Math.round((x + 1) * 47 / 2);
      const yi = Math.round((y + 1) * 47 / 2);
      const zi = Math.round((z + 1) * 47 / 2);
      return (xi + yi + zi) % 2 === 0 ? -1 : 1;
    });

    expect(() => extractIsoSurface(field, 0, { maxOutputBytes: 4_096 })).toThrow(
      /output budget.*4096|4096.*output budget/i,
    );
  });
});
