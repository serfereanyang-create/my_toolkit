export type FunctionMode = 'explicit' | 'parametric' | 'implicit' | 'points';

export type AxisName = 'x' | 'y' | 'z' | 'u' | 'v' | 'w' | 't';

export type NumericRange = {
  min: number;
  max: number;
};

export type RangeMap = Record<string, NumericRange | undefined>;

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

type GeneratedGeometryBase = {
  positions: Float32Array;
  message: string;
};

export type GeneratedGeometry =
  | (GeneratedGeometryBase & {
      kind: 'mesh';
      indices?: Uint32Array;
      normals?: Float32Array;
    })
  | (GeneratedGeometryBase & {
      kind: 'points';
      pointSize?: number;
    });

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
