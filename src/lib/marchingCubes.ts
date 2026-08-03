export type ScalarField = {
  nx: number;
  ny: number;
  nz: number;
  values: Float64Array;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
};

export type IsoSurface = {
  positions: Float32Array;
  normals: Float32Array;
};

export type IsoSurfaceOptions = {
  maxOutputBytes?: number;
};

type Vec3 = [number, number, number];

type GridPoint = {
  position: Vec3;
  value: number;
};

const FLOAT32_MAX = 3.4028234663852886e38;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BYTES_PER_TRIANGLE = 3 * 3 * Float32Array.BYTES_PER_ELEMENT * 2;

const TETRAHEDRA = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
] as const;

const CUBE_CORNERS: readonly Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

function fieldIndex(field: ScalarField, x: number, y: number, z: number) {
  return x + field.nx * (y + field.ny * z);
}

function interpolate(a: GridPoint, b: GridPoint, isoValue: number): Vec3 {
  if (a.value === isoValue) {
    return [...a.position];
  }
  if (b.value === isoValue) {
    return [...b.position];
  }

  const denominator = b.value - a.value;
  let rawT = denominator === 0 ? 0.5 : (isoValue - a.value) / denominator;
  if (!Number.isFinite(denominator) || !Number.isFinite(rawT)) {
    const scale = Math.max(Math.abs(a.value), Math.abs(b.value), Math.abs(isoValue));
    rawT = scale === 0
      ? 0.5
      : (isoValue / scale - a.value / scale) / (b.value / scale - a.value / scale);
  }
  const t = Math.max(0, Math.min(1, Number.isFinite(rawT) ? rawT : 0.5));

  return [
    (1 - t) * a.position[0] + t * b.position[0],
    (1 - t) * a.position[1] + t * b.position[1],
    (1 - t) * a.position[2] + t * b.position[2],
  ];
}

function polygonizeTetra(points: GridPoint[], isoValue: number): Vec3[][] {
  if (points.some((point) => !Number.isFinite(point.value))) {
    return [];
  }

  const inside = points.filter((point) => point.value <= isoValue);
  const outside = points.filter((point) => point.value > isoValue);

  if (inside.length === 0 || inside.length === 4) {
    return [];
  }

  if (inside.length === 1) {
    const point = inside[0];
    return [[
      interpolate(point, outside[0], isoValue),
      interpolate(point, outside[1], isoValue),
      interpolate(point, outside[2], isoValue),
    ]];
  }

  if (inside.length === 3) {
    const point = outside[0];
    return [[
      interpolate(point, inside[2], isoValue),
      interpolate(point, inside[1], isoValue),
      interpolate(point, inside[0], isoValue),
    ]];
  }

  const [insideA, insideB] = inside;
  const [outsideA, outsideB] = outside;
  const aToA = interpolate(insideA, outsideA, isoValue);
  const aToB = interpolate(insideA, outsideB, isoValue);
  const bToA = interpolate(insideB, outsideA, isoValue);
  const bToB = interpolate(insideB, outsideB, isoValue);

  return [
    [aToA, aToB, bToA],
    [bToA, aToB, bToB],
  ];
}

function tetraGradient(points: GridPoint[]): Vec3 | null {
  const origin = points[0];
  const m00 = points[1].position[0] - origin.position[0];
  const m01 = points[1].position[1] - origin.position[1];
  const m02 = points[1].position[2] - origin.position[2];
  const m10 = points[2].position[0] - origin.position[0];
  const m11 = points[2].position[1] - origin.position[1];
  const m12 = points[2].position[2] - origin.position[2];
  const m20 = points[3].position[0] - origin.position[0];
  const m21 = points[3].position[1] - origin.position[1];
  const m22 = points[3].position[2] - origin.position[2];
  const d0 = points[1].value - origin.value;
  const d1 = points[2].value - origin.value;
  const d2 = points[3].value - origin.value;
  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;
  const determinant = m00 * c00 + m01 * c01 + m02 * c02;

  if (!Number.isFinite(determinant) || determinant === 0) {
    return null;
  }

  return [
    (d0 * c00
      + d1 * (m02 * m21 - m01 * m22)
      + d2 * (m01 * m12 - m02 * m11)) / determinant,
    (d0 * c01
      + d1 * (m00 * m22 - m02 * m20)
      + d2 * (m02 * m10 - m00 * m12)) / determinant,
    (d0 * c02
      + d1 * (m01 * m20 - m00 * m21)
      + d2 * (m00 * m11 - m01 * m10)) / determinant,
  ];
}

function pushTriangle(
  positions: number[],
  normals: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  gradient: Vec3 | null,
) {
  const outputA: Vec3 = [Math.fround(a[0]), Math.fround(a[1]), Math.fround(a[2])];
  const outputB: Vec3 = [Math.fround(b[0]), Math.fround(b[1]), Math.fround(b[2])];
  const outputC: Vec3 = [Math.fround(c[0]), Math.fround(c[1]), Math.fround(c[2])];
  const abx = outputB[0] - outputA[0];
  const aby = outputB[1] - outputA[1];
  const abz = outputB[2] - outputA[2];
  const acx = outputC[0] - outputA[0];
  const acy = outputC[1] - outputA[1];
  const acz = outputC[2] - outputA[2];
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  const edgeScale = Math.max(
    Math.hypot(abx, aby, abz),
    Math.hypot(acx, acy, acz),
    Math.hypot(outputC[0] - outputB[0], outputC[1] - outputB[1], outputC[2] - outputB[2]),
  );

  if (
    !Number.isFinite(length)
    || !Number.isFinite(edgeScale)
    || edgeScale === 0
    || length <= Number.EPSILON * edgeScale * edgeScale
  ) {
    return;
  }

  let pointB = outputB;
  let pointC = outputC;
  if (gradient && nx * gradient[0] + ny * gradient[1] + nz * gradient[2] < 0) {
    pointB = outputC;
    pointC = outputB;
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const normal: Vec3 = [nx / length, ny / length, nz / length];
  for (const point of [outputA, pointB, pointC]) {
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
  }
}

function assertFiniteFloat32Coordinate(value: number, label: string) {
  if (!Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX) {
    throw new Error(`${label} must be a finite Float32 rendered coordinate.`);
  }
}

export function extractIsoSurface(
  field: ScalarField,
  isoValue: number,
  options: IsoSurfaceOptions = {},
): IsoSurface {
  for (const [label, value] of [
    ['xMin', field.xMin],
    ['xMax', field.xMax],
    ['yMin', field.yMin],
    ['yMax', field.yMax],
    ['zMin', field.zMin],
    ['zMax', field.zMax],
  ] as const) {
    assertFiniteFloat32Coordinate(value, label);
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < BYTES_PER_TRIANGLE) {
    throw new Error(`Iso-surface output budget must be at least ${BYTES_PER_TRIANGLE} bytes.`);
  }

  const positions: number[] = [];
  const normals: number[] = [];

  for (let z = 0; z < field.nz - 1; z += 1) {
    for (let y = 0; y < field.ny - 1; y += 1) {
      for (let x = 0; x < field.nx - 1; x += 1) {
        const corners = CUBE_CORNERS.map(([dx, dy, dz]): GridPoint => {
          const cornerX = x + dx;
          const cornerY = y + dy;
          const cornerZ = z + dz;
          const tx = cornerX / (field.nx - 1);
          const ty = cornerY / (field.ny - 1);
          const tz = cornerZ / (field.nz - 1);
          return {
            position: [
              (1 - tx) * field.xMin + tx * field.xMax,
              (1 - ty) * field.yMin + ty * field.yMax,
              (1 - tz) * field.zMin + tz * field.zMax,
            ],
            value: field.values[fieldIndex(field, cornerX, cornerY, cornerZ)],
          };
        });

        for (const tetrahedron of TETRAHEDRA) {
          const points = tetrahedron.map((corner) => corners[corner]);
          const gradient = tetraGradient(points);
          for (const triangle of polygonizeTetra(points, isoValue)) {
            if ((positions.length / 9 + 1) * BYTES_PER_TRIANGLE > maxOutputBytes) {
              throw new Error(
                `Iso-surface output budget of ${maxOutputBytes} bytes was exceeded.`,
              );
            }
            pushTriangle(
              positions,
              normals,
              triangle[0],
              triangle[1],
              triangle[2],
              gradient,
            );
          }
        }
      }
    }
  }

  if (
    positions.some((value) => !Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX)
    || normals.some((value) => !Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX)
  ) {
    throw new Error('Iso-surface output contains a value outside finite Float32 range.');
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
  };
}
