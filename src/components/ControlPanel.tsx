import { visualizerExamples } from '../lib/examples';
import type { VisualizerExample } from '../lib/examples';
import type {
  FunctionMode,
  NumericRange,
  PickedPoint,
  RangeMap,
  RenderSettings,
  VisualizerConfig,
} from '../lib/types';

export type ControlPanelProps = {
  config: VisualizerConfig;
  status: string;
  error: string;
  pickedPoint: PickedPoint | null;
  fixedVariableText: string;
  onChange: (config: VisualizerConfig) => void;
  onFixedVariableTextChange: (value: string) => void;
  onRender: () => void;
  onExample: (example: VisualizerExample) => void;
};

const modeLabels: Record<FunctionMode, string> = {
  explicit: '显式 z=f(x,y)',
  parametric: '参数曲面',
  implicit: '隐式 F(x,y,z)=等值',
  points: '离散点云',
};

const modeOptions = Object.entries(modeLabels) as Array<[FunctionMode, string]>;
const defaultRange: NumericRange = { min: -5, max: 5 };

function displayNumber(value: number) {
  return Number.isFinite(value) ? String(value) : '';
}

function parseNumberInput(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rangeOrDefault(ranges: RangeMap, axis: string): NumericRange {
  return ranges[axis] ?? defaultRange;
}

function ensureRange(ranges: RangeMap, axis: string, fallback: NumericRange = defaultRange) {
  return ranges[axis] ?? fallback;
}

function updateRange(
  config: VisualizerConfig,
  axis: string,
  side: keyof NumericRange,
  rawValue: string,
): VisualizerConfig {
  const value = parseNumberInput(rawValue);
  if (value === undefined) return config;

  return {
    ...config,
    ranges: {
      ...config.ranges,
      [axis]: {
        ...rangeOrDefault(config.ranges, axis),
        [side]: value,
      },
    },
  };
}

function commonSettings(config: VisualizerConfig): Omit<RenderSettings, 'mode'> {
  return {
    resolution: config.resolution,
    isoValue: config.isoValue,
    ranges: config.ranges,
    constraint: config.constraint,
    fixedVariables: config.fixedVariables,
  };
}

function withSpatialRanges(ranges: RangeMap): RangeMap {
  return {
    ...ranges,
    x: ensureRange(ranges, 'x'),
    y: ensureRange(ranges, 'y'),
    z: ensureRange(ranges, 'z'),
  };
}

function setMode(config: VisualizerConfig, mode: FunctionMode): VisualizerConfig {
  if (mode === config.mode) return config;

  const shared = commonSettings(config);
  const spatialRanges = withSpatialRanges(shared.ranges);

  switch (mode) {
    case 'explicit':
      return {
        ...shared,
        mode,
        ranges: spatialRanges,
        zExpression: 'sin(x) * cos(y)',
      };
    case 'parametric':
      return {
        ...shared,
        mode,
        ranges: {
          ...spatialRanges,
          u: ensureRange(shared.ranges, 'u', { min: 0, max: Math.PI }),
          v: ensureRange(shared.ranges, 'v', { min: 0, max: Math.PI * 2 }),
        },
        xExpression: '2*sin(u)*cos(v)',
        yExpression: '2*sin(u)*sin(v)',
        zExpression: '2*cos(u)',
      };
    case 'implicit':
      return {
        ...shared,
        mode,
        ranges: spatialRanges,
        fExpression: 'x^2 + y^2 + z^2 - 4',
      };
    case 'points':
      return {
        ...shared,
        mode,
        ranges: spatialRanges,
        pointText: '-2,-2,0\n-1,-1,1\n0,0,2\n1,1,1\n2,2,0',
      };
  }
}

type RangeRowProps = {
  axis: string;
  config: VisualizerConfig;
  onChange: (config: VisualizerConfig) => void;
};

function RangeRow({ axis, config, onChange }: RangeRowProps) {
  const range = rangeOrDefault(config.ranges, axis);

  return (
    <tr className="range-row">
      <th scope="row">{axis}</th>
      <td>
        <input
          aria-label={`${axis} 最小值`}
          type="number"
          value={displayNumber(range.min)}
          onChange={(event) => onChange(updateRange(config, axis, 'min', event.target.value))}
        />
      </td>
      <td>
        <input
          aria-label={`${axis} 最大值`}
          type="number"
          value={displayNumber(range.max)}
          onChange={(event) => onChange(updateRange(config, axis, 'max', event.target.value))}
        />
      </td>
    </tr>
  );
}

export function ControlPanel({
  config,
  status,
  error,
  pickedPoint,
  fixedVariableText,
  onChange,
  onFixedVariableTextChange,
  onRender,
  onExample,
}: ControlPanelProps) {
  const rangeAxes = config.mode === 'parametric'
    ? ['x', 'y', 'z', 'u', 'v']
    : ['x', 'y', 'z'];
  const resolutionMax = config.mode === 'implicit' ? 48 : 160;

  const updateResolution = (rawValue: string) => {
    const resolution = parseNumberInput(rawValue);
    if (resolution !== undefined) onChange({ ...config, resolution });
  };

  const updateIsoValue = (rawValue: string) => {
    const isoValue = parseNumberInput(rawValue);
    if (isoValue !== undefined) onChange({ ...config, isoValue });
  };

  return (
    <aside className="control-panel" aria-label="3D 函数控制面板">
      <header className="panel-title">
        <h1>3D 函数可视化器</h1>
      </header>

      <section className="panel-section">
        <label htmlFor="function-mode">函数类型</label>
        <select
          id="function-mode"
          value={config.mode}
          onChange={(event) => onChange(setMode(config, event.target.value as FunctionMode))}
        >
          {modeOptions.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </section>

      <section className="panel-section expression-stack" aria-label="函数表达式">
        {config.mode === 'explicit' && (
          <label>
            z =
            <input
              aria-label="显式函数 z 表达式"
              value={config.zExpression}
              onChange={(event) => onChange({ ...config, zExpression: event.target.value })}
            />
          </label>
        )}

        {config.mode === 'parametric' && (
          <>
            <label>
              x(u,v)
              <input
                aria-label="参数曲面 x 表达式"
                value={config.xExpression}
                onChange={(event) => onChange({ ...config, xExpression: event.target.value })}
              />
            </label>
            <label>
              y(u,v)
              <input
                aria-label="参数曲面 y 表达式"
                value={config.yExpression}
                onChange={(event) => onChange({ ...config, yExpression: event.target.value })}
              />
            </label>
            <label>
              z(u,v)
              <input
                aria-label="参数曲面 z 表达式"
                value={config.zExpression}
                onChange={(event) => onChange({ ...config, zExpression: event.target.value })}
              />
            </label>
          </>
        )}

        {config.mode === 'implicit' && (
          <label>
            F(x,y,z)
            <input
              aria-label="隐式函数表达式"
              value={config.fExpression}
              onChange={(event) => onChange({ ...config, fExpression: event.target.value })}
            />
          </label>
        )}

        {config.mode === 'points' && (
          <label>
            点数据（每行 x,y,z）
            <textarea
              aria-label="离散点数据"
              rows={6}
              value={config.pointText}
              onChange={(event) => onChange({ ...config, pointText: event.target.value })}
            />
          </label>
        )}
      </section>

      <section className="panel-section">
        <label htmlFor="constraint-expression">约束条件</label>
        <input
          id="constraint-expression"
          placeholder="例如 z >= 0 && x^2 + y^2 < 9"
          value={config.constraint}
          onChange={(event) => onChange({ ...config, constraint: event.target.value })}
        />
        <small className="constraint-hint">边界按离散采样精度近似。</small>
      </section>

      <section className="panel-section">
        <label htmlFor="fixed-variables">固定 / 切片变量</label>
        <input
          id="fixed-variables"
          placeholder="w=1, t=0"
          value={fixedVariableText}
          onChange={(event) => onFixedVariableTextChange(event.target.value)}
        />
      </section>

      <section className="panel-section range-grid" aria-labelledby="range-caption">
        <table>
          <caption id="range-caption">变量范围</caption>
          <thead>
            <tr className="range-head">
              <th scope="col">变量</th>
              <th scope="col">最小</th>
              <th scope="col">最大</th>
            </tr>
          </thead>
          <tbody>
            {rangeAxes.map((axis) => (
              <RangeRow key={axis} axis={axis} config={config} onChange={onChange} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel-section two-inputs">
        <label>
          采样精度
          <input
            aria-label="采样精度"
            type="number"
            min={config.mode === 'implicit' ? 8 : 4}
            max={resolutionMax}
            step={1}
            value={displayNumber(config.resolution)}
            onChange={(event) => updateResolution(event.target.value)}
          />
        </label>
        {config.mode === 'implicit' && (
          <label>
            等值
            <input
              aria-label="隐式曲面等值"
              type="number"
              value={displayNumber(config.isoValue)}
              onChange={(event) => updateIsoValue(event.target.value)}
            />
          </label>
        )}
      </section>

      <section className="panel-section examples" aria-labelledby="examples-label">
        <span id="examples-label">内置示例</span>
        <div className="example-list">
          {visualizerExamples.map((example) => (
            <button
              key={example.id}
              type="button"
              title={example.description}
              onClick={() => onExample(example)}
            >
              {example.name}
            </button>
          ))}
        </div>
      </section>

      <button className="render-button" type="button" onClick={onRender}>
        渲染 3D 形状
      </button>

      <section className="status-box" aria-label="渲染状态" aria-live="polite">
        {error ? <p className="error-text" role="alert">{error}</p> : <p>{status}</p>}
        {pickedPoint && (
          <p className="picked-text">
            选中坐标: x={pickedPoint.x.toFixed(3)}, y={pickedPoint.y.toFixed(3)}, z={pickedPoint.z.toFixed(3)}
          </p>
        )}
      </section>
    </aside>
  );
}
