import { useEffect, useRef, useState } from 'react';

export type StatsChartProps = {
  option: unknown;
  height?: number;
  ariaLabel?: string;
};

type ChartInstance = {
  setOption: (option: unknown, notMerge?: boolean) => void;
  resize: () => void;
  dispose: () => void;
};

export function StatsChart({ option, height = 220, ariaLabel }: StatsChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);
  const optionRef = useRef(option);
  const [hasLoadError, setHasLoadError] = useState(false);

  optionRef.current = option;

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const container = containerRef.current;

    if (!container) {
      return () => {
        disposed = true;
      };
    }

    setHasLoadError(false);

    void Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ])
      .then(([core, charts, components, renderers]) => {
        if (disposed) return;

        core.use([
          charts.PieChart,
          charts.BarChart,
          components.GridComponent,
          components.TooltipComponent,
          components.LegendComponent,
          renderers.CanvasRenderer,
        ]);

        if (disposed) return;

        const chart = core.init(container) as unknown as ChartInstance;
        if (disposed) {
          chart.dispose();
          return;
        }

        chartRef.current = chart;
        chart.setOption(optionRef.current, true);

        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (!disposed) chart.resize();
          });
          resizeObserver.observe(container);
        }
      })
      .catch(() => {
        if (disposed) return;

        resizeObserver?.disconnect();
        resizeObserver = null;
        const chart = chartRef.current;
        chartRef.current = null;
        chart?.dispose();
        setHasLoadError(true);
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      const chart = chartRef.current;
      chartRef.current = null;
      chart?.dispose();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      style={{ width: '100%', height }}
    >
      {hasLoadError ? '图表加载失败' : null}
    </div>
  );
}
