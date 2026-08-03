import { compileConstraint, compileScalarExpression } from './mathEngine';
import { extractIsoSurface } from './marchingCubes';
import type {
  ExplicitConfig,
  GeneratedGeometry,
  ImplicitConfig,
  NumericRange,
  ParametricConfig,
  PointsConfig,
  RangeMap,
  VisualizerConfig,
} from './types';

type Vec3 = [number, number, number];
type SampleGrid = Array<Array<Vec3 | null>>;
type NumericScope = Record<string, number>;

const FLOAT32_MAX = 3.4028234663852886e38;
export const MAX_MANUAL_POINTS = 10_000;

function clampResolution(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    throw new Error('Surface resolution must be finite.');
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function requiredRange(
  ranges: RangeMap,
  name: string,
  renderedCoordinate = false,
): NumericRange {
  const range = ranges[name];
  if (
    !range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.max <= range.min
  ) {
    throw new Error(`Invalid ${name} range: finite min and max are required, with max > min.`);
  }
  if (
    renderedCoordinate
    && (Math.abs(range.min) > FLOAT32_MAX || Math.abs(range.max) > FLOAT32_MAX)
  ) {
    throw new Error(`Invalid ${name} range: rendered coordinates must fit finite Float32.`);
  }
  return range;
}

function interpolateRange(range: NumericRange, index: number, resolution: number) {
  const t = index / (resolution - 1);
  return (1 - t) * range.min + t * range.max;
}

function isFiniteFloat32(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isSkippableScalarDomainError(error: unknown) {
  return errorMessage(error) === 'Scalar expression must evaluate to a finite number';
}

function rethrowUnlessScalarDomainError(error: unknown) {
  if (!isSkippableScalarDomainError(error)) {
    throw error;
  }
}

function isInRange(value: number, range: NumericRange) {
  return value >= range.min && value <= range.max;
}

function triangleHasPositiveArea(a: Vec3, b: Vec3, c: Vec3) {
  const outputA: Vec3 = [Math.fround(a[0]), Math.fround(a[1]), Math.fround(a[2])];
  const outputB: Vec3 = [Math.fround(b[0]), Math.fround(b[1]), Math.fround(b[2])];
  const outputC: Vec3 = [Math.fround(c[0]), Math.fround(c[1]), Math.fround(c[2])];
  const abx = outputB[0] - outputA[0];
  const aby = outputB[1] - outputA[1];
  const abz = outputB[2] - outputA[2];
  const acx = outputC[0] - outputA[0];
  const acy = outputC[1] - outputA[1];
  const acz = outputC[2] - outputA[2];
  const area2 = Math.hypot(
    aby * acz - abz * acy,
    abz * acx - abx * acz,
    abx * acy - aby * acx,
  );
  const edgeScale = Math.max(
    Math.hypot(abx, aby, abz),
    Math.hypot(acx, acy, acz),
    Math.hypot(
      outputC[0] - outputB[0],
      outputC[1] - outputB[1],
      outputC[2] - outputB[2],
    ),
  );
  return Number.isFinite(area2)
    && Number.isFinite(edgeScale)
    && edgeScale > 0
    && area2 > Number.EPSILON * edgeScale * edgeScale;
}

function buildIndexedGridMesh(points: SampleGrid): GeneratedGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexIndices = points.map((row) =>
    row.map((point) => {
      if (!point || !point.every(isFiniteFloat32)) {
        return -1;
      }
      const index = positions.length / 3;
      positions.push(point[0], point[1], point[2]);
      return index;
    }),
  );

  const addTriangle = (a: number, b: number, c: number) => {
    if (a < 0 || b < 0 || c < 0 || a === b || a === c || b === c) {
      return;
    }
    const pointA: Vec3 = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
    const pointB: Vec3 = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
    const pointC: Vec3 = [positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]];
    if (triangleHasPositiveArea(pointA, pointB, pointC)) {
      indices.push(a, b, c);
    }
  };

  for (let row = 0; row < points.length - 1; row += 1) {
    for (let column = 0; column < points[row].length - 1; column += 1) {
      const topLeft = vertexIndices[row][column];
      const topRight = vertexIndices[row][column + 1];
      const bottomLeft = vertexIndices[row + 1][column];
      const bottomRight = vertexIndices[row + 1][column + 1];

      addTriangle(topLeft, topRight, bottomLeft);
      addTriangle(topRight, bottomRight, bottomLeft);
    }
  }

  if (indices.length === 0) {
    throw new Error('No valid surface triangles were generated.');
  }

  return {
    kind: 'mesh',
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    message: `${positions.length / 3} vertices and ${indices.length / 3} triangles generated.`,
  };
}

export function generateExplicitSurface(config: ExplicitConfig): GeneratedGeometry {
  const xRange = requiredRange(config.ranges, 'x', true);
  const yRange = requiredRange(config.ranges, 'y', true);
  const zRange = config.ranges.z;
  if (zRange) {
    requiredRange(config.ranges, 'z', true);
  }

  const resolution = clampResolution(config.resolution, 4, 160);
  const evaluateZ = compileScalarExpression(config.zExpression);
  const satisfiesConstraint = compileConstraint(config.constraint);
  const points: SampleGrid = [];

  for (let yIndex = 0; yIndex < resolution; yIndex += 1) {
    const y = interpolateRange(yRange, yIndex, resolution);
    const row: Array<Vec3 | null> = [];

    for (let xIndex = 0; xIndex < resolution; xIndex += 1) {
      const x = interpolateRange(xRange, xIndex, resolution);
      const baseScope = { ...config.fixedVariables, x, y };

      try {
        const z = evaluateZ(baseScope);
        const scope = { ...baseScope, z };
        const valid = isFiniteFloat32(z)
          && (!zRange || isInRange(z, zRange))
          && satisfiesConstraint(scope);
        row.push(valid ? [x, y, z] : null);
      } catch (error) {
        rethrowUnlessScalarDomainError(error);
        row.push(null);
      }
    }
    points.push(row);
  }

  return buildIndexedGridMesh(points);
}

export function generateParametricSurface(config: ParametricConfig): GeneratedGeometry {
  const uRange = requiredRange(config.ranges, 'u');
  const vRange = requiredRange(config.ranges, 'v');
  const xRange = requiredRange(config.ranges, 'x', true);
  const yRange = requiredRange(config.ranges, 'y', true);
  const zRange = requiredRange(config.ranges, 'z', true);
  const resolution = clampResolution(config.resolution, 4, 160);
  const evaluateX = compileScalarExpression(config.xExpression);
  const evaluateY = compileScalarExpression(config.yExpression);
  const evaluateZ = compileScalarExpression(config.zExpression);
  const satisfiesConstraint = compileConstraint(config.constraint);
  const points: SampleGrid = [];

  for (let vIndex = 0; vIndex < resolution; vIndex += 1) {
    const v = interpolateRange(vRange, vIndex, resolution);
    const row: Array<Vec3 | null> = [];

    for (let uIndex = 0; uIndex < resolution; uIndex += 1) {
      const u = interpolateRange(uRange, uIndex, resolution);
      const baseScope = { ...config.fixedVariables, u, v };

      try {
        const x = evaluateX(baseScope);
        const y = evaluateY(baseScope);
        const z = evaluateZ(baseScope);
        const scope = { ...baseScope, x, y, z };
        const inRanges = [x, y, z].every(isFiniteFloat32)
          && isInRange(x, xRange)
          && isInRange(y, yRange)
          && isInRange(z, zRange);
        row.push(inRanges && satisfiesConstraint(scope) ? [x, y, z] : null);
      } catch (error) {
        rethrowUnlessScalarDomainError(error);
        row.push(null);
      }
    }
    points.push(row);
  }

  return buildIndexedGridMesh(points);
}

export function generateImplicitSurface(config: ImplicitConfig): GeneratedGeometry {
  const xRange = requiredRange(config.ranges, 'x', true);
  const yRange = requiredRange(config.ranges, 'y', true);
  const zRange = requiredRange(config.ranges, 'z', true);
  if (!Number.isFinite(config.isoValue)) {
    throw new Error('Implicit iso value must be finite.');
  }

  const resolution = clampResolution(config.resolution, 8, 48);
  const evaluateField = compileScalarExpression(config.fExpression);
  const satisfiesConstraint = compileConstraint(config.constraint);
  const values = new Float64Array(resolution ** 3);
  values.fill(Number.NaN);
  let cursor = 0;

  for (let zIndex = 0; zIndex < resolution; zIndex += 1) {
    const z = interpolateRange(zRange, zIndex, resolution);
    for (let yIndex = 0; yIndex < resolution; yIndex += 1) {
      const y = interpolateRange(yRange, yIndex, resolution);
      for (let xIndex = 0; xIndex < resolution; xIndex += 1) {
        const x = interpolateRange(xRange, xIndex, resolution);
        try {
          const value = evaluateField({ ...config.fixedVariables, x, y, z });
          if (Number.isFinite(value)) {
            values[cursor] = value;
          }
        } catch (error) {
          rethrowUnlessScalarDomainError(error);
          // NaN marks a domain-failed sample; tetrahedra touching it are skipped.
        }
        cursor += 1;
      }
    }
  }

  const surface = extractIsoSurface(
    {
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
    },
    config.isoValue,
  );

  if (surface.positions.length === 0) {
    throw new Error('No implicit surface was found in the selected range.');
  }

  if (!config.constraint.trim()) {
    return {
      kind: 'mesh',
      positions: surface.positions,
      normals: surface.normals,
      message: `${surface.positions.length / 3} implicit vertices generated.`,
    };
  }

  const positions: number[] = [];
  const normals: number[] = [];
  for (let triangle = 0; triangle < surface.positions.length; triangle += 9) {
    let accepted = true;
    for (let offset = 0; offset < 9; offset += 3) {
      const scope: NumericScope = {
        ...config.fixedVariables,
        x: surface.positions[triangle + offset],
        y: surface.positions[triangle + offset + 1],
        z: surface.positions[triangle + offset + 2],
      };
      try {
        if (!satisfiesConstraint(scope)) {
          accepted = false;
          break;
        }
      } catch (error) {
        rethrowUnlessScalarDomainError(error);
        accepted = false;
        break;
      }
    }

    if (accepted) {
      for (let offset = 0; offset < 9; offset += 1) {
        positions.push(surface.positions[triangle + offset]);
        normals.push(surface.normals[triangle + offset]);
      }
    }
  }

  if (positions.length === 0) {
    throw new Error('No implicit surface remained after applying constraints.');
  }

  return {
    kind: 'mesh',
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    message: `${positions.length / 3} constrained implicit vertices generated.`,
  };
}

export function generatePointCloud(config: PointsConfig): GeneratedGeometry {
  const xRange = requiredRange(config.ranges, 'x', true);
  const yRange = requiredRange(config.ranges, 'y', true);
  const zRange = requiredRange(config.ranges, 'z', true);
  const satisfiesConstraint = compileConstraint(config.constraint);
  const positions: number[] = [];
  const lines = config.pointText.split(/\r?\n/);
  const nonemptyLineCount = lines.reduce(
    (count, line) => count + (line.trim() ? 1 : 0),
    0,
  );
  if (nonemptyLineCount > MAX_MANUAL_POINTS) {
    throw new Error(`Manual point limit of ${MAX_MANUAL_POINTS} was exceeded.`);
  }
  let skippedCount = 0;

  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      continue;
    }

    let parts: string[];
    if (text.includes(',')) {
      parts = text.split(',').map((part) => part.trim());
      if (parts.length !== 3 || parts.some((part) => !part || /\s/.test(part))) {
        skippedCount += 1;
        continue;
      }
    } else {
      parts = text.split(/\s+/);
      if (parts.length !== 3) {
        skippedCount += 1;
        continue;
      }
    }

    const [x, y, z] = parts.map(Number);
    if (![x, y, z].every(isFiniteFloat32)) {
      skippedCount += 1;
      continue;
    }

    const scope = { ...config.fixedVariables, x, y, z };
    const inRanges =
      isInRange(x, xRange) && isInRange(y, yRange) && isInRange(z, zRange);
    try {
      if (inRanges && satisfiesConstraint(scope)) {
        positions.push(x, y, z);
      }
    } catch (error) {
      rethrowUnlessScalarDomainError(error);
      skippedCount += 1;
    }
  }

  if (positions.length === 0) {
    throw new Error('No valid points were generated.');
  }

  return {
    kind: 'points',
    positions: new Float32Array(positions),
    pointSize: 0.08,
    message: `${positions.length / 3} points generated${skippedCount > 0 ? `; ${skippedCount} skipped` : ''}.`,
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
  }
}
