import { useMemo } from 'react';
import { Drawer, Empty } from 'antd';
import type { Paper } from '../../types/paperApp';
import { buildPaperStats, type PaperStats } from '../../lib/paperStats';
import { StatsChart } from './StatsChart';

export type StatsDrawerProps = {
  open: boolean;
  onClose: () => void;
  papers: Paper[];
  accentColor: string;
  textColor: string;
  borderColor: string;
};

type ChartColors = {
  accentColor: string;
  textColor: string;
  borderColor: string;
};

function pieColors(accentColor: string): string[] {
  const raw = accentColor.trim().replace(/^#/, '');
  const normalized = raw.length === 3
    ? raw.split('').map((channel) => `${channel}${channel}`).join('')
    : raw;

  if (/^[\da-f]{6}$/i.test(normalized)) {
    const rgb = [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
    return [0, 0.18, 0.36, 0.54, 0.72].map((mix) =>
      `rgb(${rgb.map((channel) => Math.round(channel + (255 - channel) * mix)).join(', ')})`,
    );
  }

  return [accentColor, '#6f8fe8', '#9db2f2', '#becbf8', '#dce4fc'];
}

function createStatusOption(stats: PaperStats, colors: ChartColors) {
  const shades = pieColors(colors.accentColor);

  return {
    backgroundColor: 'transparent',
    textStyle: { color: colors.textColor },
    tooltip: { trigger: 'item' },
    legend: {
      type: 'scroll',
      bottom: 0,
      textStyle: { color: colors.textColor },
    },
    series: [
      {
        name: '阅读状态',
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '42%'],
        avoidLabelOverlap: true,
        label: { color: colors.textColor },
        itemStyle: { borderColor: 'transparent', borderWidth: 2 },
        data: stats.byStatus.map((item, index) => ({
          name: item.status,
          value: item.count,
          itemStyle: { color: shades[index % shades.length] },
        })),
      },
    ],
    color: shades,
  };
}

function createReliabilityOption(stats: PaperStats, colors: ChartColors) {
  const axisLine = { lineStyle: { color: colors.borderColor } };
  const splitLine = { lineStyle: { color: colors.borderColor } };

  return {
    backgroundColor: 'transparent',
    textStyle: { color: colors.textColor },
    tooltip: { trigger: 'axis' },
    grid: { left: 12, right: 16, top: 16, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: stats.byReliability.map((item) => item.level),
      axisLine,
      splitLine,
      axisLabel: { color: colors.textColor },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLine,
      splitLine,
      axisLabel: { color: colors.textColor },
    },
    series: [
      {
        name: '证据可靠性',
        type: 'bar',
        data: stats.byReliability.map((item) => item.count),
        itemStyle: { color: colors.accentColor },
        barMaxWidth: 42,
      },
    ],
  };
}

function createYearOption(stats: PaperStats, colors: ChartColors) {
  const axisLine = { lineStyle: { color: colors.borderColor } };
  const splitLine = { lineStyle: { color: colors.borderColor } };

  return {
    backgroundColor: 'transparent',
    textStyle: { color: colors.textColor },
    tooltip: { trigger: 'axis' },
    grid: { left: 12, right: 16, top: 16, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: stats.byYear.map((item) => item.year),
      axisLine,
      splitLine,
      axisLabel: { color: colors.textColor },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLine,
      splitLine,
      axisLabel: { color: colors.textColor },
    },
    series: [
      {
        name: '发表年份',
        type: 'bar',
        data: stats.byYear.map((item) => item.count),
        itemStyle: { color: colors.accentColor },
        barMaxWidth: 42,
      },
    ],
  };
}

function createTagOption(stats: PaperStats, colors: ChartColors) {
  const axisLine = { lineStyle: { color: colors.borderColor } };
  const splitLine = { lineStyle: { color: colors.borderColor } };

  return {
    backgroundColor: 'transparent',
    textStyle: { color: colors.textColor },
    tooltip: { trigger: 'axis' },
    grid: { left: 12, right: 16, top: 8, bottom: 12, containLabel: true },
    xAxis: {
      type: 'value',
      min: 0,
      axisLine,
      splitLine,
      axisLabel: { color: colors.textColor },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: stats.topTags.map((item) => item.tag),
      axisLine,
      splitLine,
      axisLabel: { color: colors.textColor },
    },
    series: [
      {
        name: '标签',
        type: 'bar',
        data: stats.topTags.map((item) => item.count),
        itemStyle: { color: colors.accentColor },
        barMaxWidth: 24,
      },
    ],
  };
}

function EmptyChart({ description }: { description: string }) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={description}
      style={{ margin: '12px 0 16px' }}
    />
  );
}

export function StatsDrawer({
  open,
  onClose,
  papers,
  accentColor,
  textColor,
  borderColor,
}: StatsDrawerProps) {
  const stats = useMemo(() => buildPaperStats(papers), [papers]);
  const colors = useMemo(
    () => ({ accentColor, textColor, borderColor }),
    [accentColor, textColor, borderColor],
  );
  const statusOption = useMemo(
    () => createStatusOption(stats, colors),
    [stats, colors],
  );
  const reliabilityOption = useMemo(
    () => createReliabilityOption(stats, colors),
    [stats, colors],
  );
  const yearOption = useMemo(
    () => createYearOption(stats, colors),
    [stats, colors],
  );
  const tagOption = useMemo(
    () => createTagOption(stats, colors),
    [stats, colors],
  );

  return (
    <Drawer
      title="统计概览"
      placement="right"
      width={480}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      className="drawer-shell"
    >
      <div className="quality-panel" style={{ borderLeft: 0, height: 'auto', overflow: 'auto' }}>
        {stats.total === 0 ? (
          <div className="inspector-block">
            <EmptyChart description="还没有论文，先新建或导入" />
          </div>
        ) : (
          <>
            <div className="inspector-block">
              <div className="stats-inline" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                <div className="stat-chip">
                  <strong>{stats.total}</strong>
                  <span>论文</span>
                </div>
                <div className="stat-chip">
                  <strong>{stats.evidenceTotal}</strong>
                  <span>证据</span>
                </div>
                <div className="stat-chip">
                  <strong>{stats.issueTotal}</strong>
                  <span>待修</span>
                </div>
                <div className="stat-chip">
                  <strong>{Math.round(stats.checklistCompletion * 100)}%</strong>
                  <span>自查</span>
                </div>
              </div>
            </div>

            <div className="inspector-block">
              <div className="inspector-title">阅读状态分布</div>
              <StatsChart option={statusOption} height={200} ariaLabel="阅读状态分布" />
            </div>

            <div className="inspector-block">
              <div className="inspector-title">证据可靠性</div>
              {stats.evidenceTotal === 0 ? (
                <EmptyChart description="暂无证据数据" />
              ) : (
                <StatsChart option={reliabilityOption} height={200} ariaLabel="证据可靠性" />
              )}
            </div>

            <div className="inspector-block">
              <div className="inspector-title">发表年份分布</div>
              <StatsChart option={yearOption} height={200} ariaLabel="发表年份分布" />
            </div>

            <div className="inspector-block">
              <div className="inspector-title">标签 Top 10</div>
              {stats.topTags.length === 0 ? (
                <EmptyChart description="暂无标签数据" />
              ) : (
                <StatsChart option={tagOption} height={200} ariaLabel="标签 Top 10" />
              )}
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}
