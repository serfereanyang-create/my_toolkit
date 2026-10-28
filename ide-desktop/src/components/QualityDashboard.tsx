/**
 * QualityDashboard.tsx — 代码质量仪表盘
 * 
 * 整合展示项目代码质量指标：
 * - 复杂度分布与热点
 * - 代码异味统计
 * - 依赖健康度（循环依赖、上帝模块）
 * - 质量趋势与综合评分
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import { useQualityRevision } from '../lib/qualityRevision';

/**
 * 质量工具网关：read-only 分析工具经由主进程 allowlist 调用 CLI 无头模式。
 * write 风险工具（生成测试、重构应用）会被网关与 CLI 双侧拒绝。
 */
async function invokeTool(name: string, input: unknown, revision?: string): Promise<{ ok: boolean; data: any; output: any }> {
  const result = await desktop.quality.invoke(name, (input ?? {}) as Record<string, unknown>, revision);
  if (!result.ok && result.error) throw new Error(result.error);
  return { ok: Boolean(result.ok), data: result.data, output: result.output };
}

interface QualityDashboardProps {
  visible: boolean;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}

interface ComplexityHotspot {
  name: string;
  kind: string;
  line: number;
  metrics: {
    cyclomatic: number;
    cognitive: number;
    maxNesting: number;
    parameters: number;
    loc: number;
  };
  risk: 'low' | 'moderate' | 'high' | 'critical';
}

interface ComplexityData {
  totalFiles: number;
  totalFunctions: number;
  averageCyclomatic: number;
  averageCognitive: number;
  hotspots: ComplexityHotspot[];
  distribution: { low: number; moderate: number; high: number; critical: number };
  files: Array<{ path: string; highRiskCount: number; functions: ComplexityHotspot[] }>;
}

interface SmellData {
  totalSmells: number;
  byType: Record<string, number>;
  bySeverity: { info: number; minor: number; major: number; critical: number };
  topSmells: Array<{
    type: string;
    severity: string;
    message: string;
    file: string;
    line: number;
    symbol: string;
  }>;
}

interface DependencyData {
  totalModules: number;
  externalDependencies: number;
  circularDependencies: Array<{ cycle: string[]; severity: string }>;
  godModules: Array<{ module: string; dependentCount: number }>;
  isolatedModules: string[];
}

/** 严重程度的中文标签：面板里不再出现裸的 low / critical / major 英文单词。 */
const RISK_LABEL: Record<string, string> = {
  low: '低',
  moderate: '中',
  high: '高',
  critical: '严重',
  info: '提示',
  minor: '次要',
  major: '主要',
};

export function riskLabel(risk: string): string {
  return RISK_LABEL[risk] ?? risk;
}

/** 异味类型的读法：检测器给出的是 id，面板不该把它原样丢给用户。 */
const SMELL_TYPE_LABEL: Record<string, string> = {
  'magic-number': '魔法数字',
  'long-parameter-list': '参数列表过长',
  'long-method': '超长方法',
  'long-function': '超长函数',
  'large-class': '过大类',
  'duplicated-code': '重复代码',
  'duplicate-code': '重复代码',
  'dead-code': '死代码',
  'commented-code': '注释掉的代码',
  'complex-condition': '复杂条件',
  'nested-callback': '嵌套回调',
  'deep-nesting': '深层嵌套',
  'god-class': '上帝类',
  'feature-envy': '依恋情结',
  'data-clump': '数据泥团',
};

export function smellTypeLabel(type: string): string {
  return SMELL_TYPE_LABEL[type] ?? type;
}

export const QUALITY_TABS = [
  { key: 'overview', label: '总览' },
  { key: 'complexity', label: '复杂度' },
  { key: 'smells', label: '代码异味' },
  { key: 'dependencies', label: '依赖关系' },
] as const;

export type QualityTabKey = (typeof QUALITY_TABS)[number]['key'];

export type ScoreBreakdown = {
  score: number;
  /** 三项各自扣掉的分（已四舍五入到 0.1），面板直接展示，评分不再是黑箱。 */
  complexity: number;
  smells: number;
  dependencies: number;
};

/** 每 100 个函数（或每 100 个模块）里有多少条，与仓库规模无关。 */
function ratePer(count: number, total: number): number {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(total) || total <= 0) return 0;
  return (count / total) * 100;
}

/**
 * 综合质量评分（0-100）：三项惩罚都按"出现率"计算。
 *
 * 旧实现按绝对条数扣分（critical 函数 ×5、high ×2、异味 ×4/×2、循环依赖 ×3…），
 * 于是任何真实仓库都会被扣到 0：388 个函数里 7 个严重函数加 14 个异味就等于
 * “0 分 / F / 需要重构”，评分从信息变成噪声，也把正常的项目渲染成红色告警。
 * 改成按比例后，同一个仓库落在 B 段，代码规模翻倍也不会无故恶化。
 */
export function scoreBreakdown(
  complexity: ComplexityData | null,
  smells: SmellData | null,
  dependencies: DependencyData | null,
): ScoreBreakdown | null {
  if (!complexity || !smells || !dependencies) return null;
  const functions = complexity.totalFunctions;
  const modules = dependencies.totalModules;
  // 没有可分析的函数就没有分母，任何分数都是编出来的：直接不评分。
  if (!Number.isFinite(functions) || functions <= 0) return null;
  const distribution = complexity.distribution ?? { low: 0, moderate: 0, high: 0, critical: 0 };
  const severity = smells.bySeverity ?? { info: 0, minor: 0, major: 0, critical: 0 };

  const complexityPenalty = ratePer(distribution.critical, functions) * 2 + ratePer(distribution.high, functions) * 0.6;
  const smellsPenalty =
    ratePer(severity.critical, functions) * 2
    + ratePer(severity.major, functions) * 0.8
    + ratePer(severity.minor, functions) * 0.2;
  const dependenciesPenalty =
    ratePer(dependencies.circularDependencies?.length ?? 0, modules) * 4
    + ratePer(dependencies.godModules?.length ?? 0, modules) * 2.5;

  const round = (value: number) => Math.round(value * 10) / 10;
  const total = complexityPenalty + smellsPenalty + dependenciesPenalty;
  return {
    score: Math.max(0, Math.min(100, Math.round(100 - total))),
    complexity: round(complexityPenalty),
    smells: round(smellsPenalty),
    dependencies: round(dependenciesPenalty),
  };
}

export const QualityDashboard: React.FC<QualityDashboardProps> = ({
  visible,
  onClose,
  onOpenFile,
}) => {
  const [loading, setLoading] = useState(false);
  const [pattern, setPattern] = useState('src/**/*.{ts,tsx}');
  const [complexity, setComplexity] = useState<ComplexityData | null>(null);
  const [smells, setSmells] = useState<SmellData | null>(null);
  const [dependencies, setDependencies] = useState<DependencyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<QualityTabKey>('overview');
  // 上一次持久化记录的综合评分与时间（.aicode/quality，gateway 自动写入）。
  const [previous, setPrevious] = useState<{ score: number | null; capturedAt?: string } | null>(null);
  // Workspace revision guard: results are stamped at analyze time and flagged
  // as stale when branch/HEAD/dirty-state move on afterwards.
  const { capture, current, stale } = useQualityRevision(visible && !loading);

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);

    try {
      // 运行前读取上一次持久化记录（gateway 在运行后写入，先读才能拿到"上次"）。
      const [prevComplexity, prevSmells, prevDeps] = await Promise.all([
        desktop.quality.latest('analyze_complexity'),
        desktop.quality.latest('detect_code_smells'),
        desktop.quality.latest('analyze_dependencies'),
      ]);
      const prevScore = scoreBreakdown(
        (prevComplexity?.result?.data as ComplexityData | undefined) ?? null,
        (prevSmells?.result?.data as SmellData | undefined) ?? null,
        (prevDeps?.result?.data as DependencyData | undefined) ?? null,
      );
      setPrevious({ score: prevScore?.score ?? null, capturedAt: prevComplexity?.capturedAt });

      const revisionLabel = current?.label;
      // 并行执行三项分析
      const [complexityRes, smellsRes, depsRes] = await Promise.all([
        invokeTool('analyze_complexity', { pattern }, revisionLabel),
        invokeTool('detect_code_smells', { pattern }, revisionLabel),
        invokeTool('analyze_dependencies', { pattern }, revisionLabel),
      ]);

      if (complexityRes.ok) setComplexity(complexityRes.data);
      if (smellsRes.ok) setSmells(smellsRes.data);
      if (depsRes.ok) setDependencies(depsRes.data);

      if (!complexityRes.ok && !smellsRes.ok && !depsRes.ok) {
        setError('所有分析均失败，请检查文件模式');
      }
      await capture();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    if (visible && !complexity && !loading) {
      handleAnalyze();
    }
  }, [visible]);
  
  // 综合质量评分（0-100）与扣分明细
  const summary = useMemo(
    () => scoreBreakdown(complexity, smells, dependencies),
    [complexity, smells, dependencies],
  );
  const scoreValue = summary?.score ?? null;

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'critical': return 'var(--danger)';
      // 高/主要比严重低一档：同一档红色会让分布图里“高”和“严重”合成一段。
      case 'high': case 'major': return 'color-mix(in srgb, var(--danger) 55%, var(--warn))';
      case 'moderate': case 'minor': return 'var(--warn)';
      default: return 'var(--ok)';
    }
  };

  // The badge ring is a 3px border and keeps the accent; the letter inside is
  // 26px/700 text. --warn measures 3.00:1 on the card — 2.999 to be exact, a
  // hair under the 3:1 large-text floor — so the letter takes --warn-ink
  // (6.27:1). The ink twins are the accents wherever they already pass.
  const getScoreGrade = (score: number) => {
    if (score >= 90) return { grade: 'A', color: 'var(--ok)', ink: 'var(--ok-ink)', text: '优秀' };
    if (score >= 75) return { grade: 'B', color: 'var(--ok)', ink: 'var(--ok-ink)', text: '良好' };
    if (score >= 60) return { grade: 'C', color: 'var(--warn)', ink: 'var(--warn-ink)', text: '一般' };
    if (score >= 40) return { grade: 'D', color: 'var(--danger)', ink: 'var(--danger-ink)', text: '较差' };
    return { grade: 'F', color: 'var(--danger)', ink: 'var(--danger-ink)', text: '需要重构' };
  };

  /** 首屏还没拿到任何结果：显示加载状态，而不是一个空壳面板。 */
  const hasResults = Boolean(complexity || smells || dependencies);
  const urgentItems: string[] = [];
  if (complexity && (complexity.distribution?.critical ?? 0) > 0) {
    urgentItems.push(`有 ${complexity.distribution.critical} 个函数复杂度达到严重级别，建议立即重构`);
  }
  if (smells && (smells.bySeverity?.critical ?? 0) > 0) {
    urgentItems.push(`发现 ${smells.bySeverity.critical} 个严重代码异味（如上帝类）`);
  }
  if (dependencies && (dependencies.circularDependencies?.length ?? 0) > 0) {
    urgentItems.push(`存在 ${dependencies.circularDependencies.length} 组循环依赖，影响模块化和测试`);
  }
  const highRiskFunctions = complexity
    ? (complexity.distribution?.critical ?? 0) + (complexity.distribution?.high ?? 0)
    : 0;
  // 分母保护：没有任何可分析函数时不能算出 NaN%，条形图也就没有分段。
  const distribution = complexity?.distribution ?? { low: 0, moderate: 0, high: 0, critical: 0 };
  const functionTotal = complexity?.totalFunctions ?? 0;
  const distributionTotal = Math.max(1, functionTotal);

  if (!visible) return null;
  
  return (
    <div className="quality-dashboard-overlay">
      <div className="quality-dashboard" role="dialog" aria-modal="true" aria-label="代码质量仪表盘">
        <div className="dashboard-header">
          <h2>代码质量仪表盘</h2>
          <div className="header-actions">
            <label className="pattern-field">
              <span className="pattern-label">分析范围</span>
              <input
                type="text"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(event) => {
                  // 回车即分析：glob 是唯一的输入项，不该逼用户先去点按钮。
                  if (event.key === 'Enter' && !loading) {
                    event.preventDefault();
                    void handleAnalyze();
                  }
                }}
                placeholder="src/**/*.{ts,tsx}"
                className="pattern-input"
                aria-label="分析范围（glob 模式，回车开始分析）"
                title="分析范围：glob 模式，回车开始分析"
                spellCheck={false}
                disabled={loading}
              />
            </label>
            <button
              type="button"
              onClick={() => void handleAnalyze()}
              disabled={loading}
              className="refresh-btn"
              aria-busy={loading}
            >
              {loading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              {loading ? '分析中…' : '重新分析'}
            </button>
            <button type="button" onClick={onClose} className="close-btn" title="关闭" aria-label="关闭代码质量仪表盘">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* 标签页：listbox 语义 + 方向键切换，和搜索面板、编辑器标签保持一致 */}
        <div className="dashboard-tabs" role="tablist" aria-label="质量分析视图">
          {QUALITY_TABS.map((tab, index) => (
            <button
              key={tab.key}
              type="button"
              id={`quality-tab-${tab.key}`}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`quality-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              className={activeTab === tab.key ? 'tab active' : 'tab'}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={(event) => {
                if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home' ? 0
                    : event.key === 'End' ? QUALITY_TABS.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : -1) + QUALITY_TABS.length) % QUALITY_TABS.length;
                const target = QUALITY_TABS[next]!;
                setActiveTab(target.key);
                document.getElementById(`quality-tab-${target.key}`)?.focus();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {stale && (
          <div className="quality-stale-banner" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>工作区在分析后已变更（分支 / 提交 / 文件状态），以下结果可能过期。</span>
            <button type="button" onClick={() => void handleAnalyze()} disabled={loading}>重新分析</button>
          </div>
        )}

        <div
          className="dashboard-content"
          id={`quality-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`quality-tab-${activeTab}`}
          aria-busy={loading}
        >
          {error && (
            <div className="error-message" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
              <button type="button" onClick={() => void handleAnalyze()} disabled={loading}>重试</button>
            </div>
          )}

          {/* 首次加载 / 空结果：面板不该只剩一个空的告警框 */}
          {loading && !hasResults && (
            <div className="quality-empty" role="status" aria-busy="true">
              <Loader2 size={16} className="spin" aria-hidden="true" />
              正在分析 {pattern}…
            </div>
          )}
          {!loading && !hasResults && !error && (
            <div className="quality-empty" role="status">
              <BarChart3 size={22} aria-hidden="true" />
              还没有分析结果。设好范围后点“重新分析”。
            </div>
          )}

          {/* 总览标签页 */}
          {activeTab === 'overview' && hasResults && (
            <div className="overview-tab">
              {summary && scoreValue !== null && (() => {
                const grade = getScoreGrade(scoreValue);
                return (
                  <section className="score-hero" aria-label="综合质量评分">
                    <div className="score-badge" style={{ borderColor: grade.color }}>
                      <span className="grade-letter" style={{ color: grade.ink }}>{grade.grade}</span>
                      <span className="grade-score">{scoreValue} 分</span>
                    </div>
                    <div className="grade-text">
                      <h3>综合质量：{grade.text}</h3>
                      <p className="score-basis">复杂度、代码异味、依赖健康度按出现率加权</p>
                      <ul className="score-breakdown" aria-label="扣分明细">
                        <li>
                          <span className="breakdown-label">复杂度</span>
                          <span className="breakdown-value">−{summary.complexity.toFixed(1)}</span>
                        </li>
                        <li>
                          <span className="breakdown-label">代码异味</span>
                          <span className="breakdown-value">−{summary.smells.toFixed(1)}</span>
                        </li>
                        <li>
                          <span className="breakdown-label">依赖健康</span>
                          <span className="breakdown-value">−{summary.dependencies.toFixed(1)}</span>
                        </li>
                      </ul>
                      {previous?.score != null && previous.score !== scoreValue && (
                        <p className="score-compare">
                          上次评分 {previous.score} 分
                          {previous.capturedAt ? `（${new Date(previous.capturedAt).toLocaleString()}）` : ''}
                          {' → '}
                          {scoreValue > previous.score
                            ? `提升 ${scoreValue - previous.score} 分`
                            : `下降 ${previous.score - scoreValue} 分`}
                        </p>
                      )}
                    </div>
                  </section>
                );
              })()}
              {!summary && !loading && (
                <p className="quality-note">
                  {complexity && functionTotal === 0
                    ? '当前范围内没有可分析的函数，暂不给出评分。'
                    : '部分分析未返回，综合评分暂不可用。'}
                </p>
              )}

              <div className="metric-cards">
                {complexity && (
                  <button
                    type="button"
                    className="metric-card"
                    onClick={() => setActiveTab('complexity')}
                    aria-label={`查看复杂度详情：平均圈复杂度 ${complexity.averageCyclomatic.toFixed(1)}，${highRiskFunctions} 个高风险函数`}
                  >
                    <span className="metric-title">复杂度</span>
                    <span className="metric-value">{complexity.averageCyclomatic.toFixed(1)}</span>
                    <span className="metric-label">平均圈复杂度</span>
                    <span className="metric-detail">{highRiskFunctions} 个高风险函数</span>
                    <ChevronRight size={14} className="metric-chevron" aria-hidden="true" />
                  </button>
                )}

                {smells && (
                  <button
                    type="button"
                    className="metric-card"
                    onClick={() => setActiveTab('smells')}
                    aria-label={`查看代码异味详情：共 ${smells.totalSmells} 个，其中 ${smells.bySeverity?.critical ?? 0} 个严重`}
                  >
                    <span className="metric-title">代码异味</span>
                    <span className="metric-value">{smells.totalSmells}</span>
                    <span className="metric-label">异味总数</span>
                    <span className="metric-detail">
                      {smells.bySeverity?.critical ?? 0} 严重 / {smells.bySeverity?.major ?? 0} 主要
                    </span>
                    <ChevronRight size={14} className="metric-chevron" aria-hidden="true" />
                  </button>
                )}

                {dependencies && (
                  <button
                    type="button"
                    className="metric-card"
                    onClick={() => setActiveTab('dependencies')}
                    aria-label={`查看依赖关系详情：${dependencies.circularDependencies?.length ?? 0} 组循环依赖，${dependencies.totalModules} 个模块`}
                  >
                    <span className="metric-title">依赖健康</span>
                    <span className="metric-value">{dependencies.circularDependencies?.length ?? 0}</span>
                    <span className="metric-label">循环依赖</span>
                    <span className="metric-detail">
                      {dependencies.totalModules} 模块 / {dependencies.godModules?.length ?? 0} 上帝模块
                    </span>
                    <ChevronRight size={14} className="metric-chevron" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* 需要立即关注的问题：没有严重问题时不再挂一个空的告警标题 */}
              {urgentItems.length > 0 ? (
                <section className="urgent-section">
                  <h3><AlertTriangle size={15} className="section-icon" aria-hidden="true" />需要立即关注</h3>
                  <ul className="urgent-list">
                    {urgentItems.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </section>
              ) : functionTotal === 0 ? (
                <section className="urgent-section is-neutral">
                  <h3><Info size={15} className="section-icon" aria-hidden="true" />没有可分析的内容</h3>
                  <p className="urgent-clear">当前范围没有匹配到源文件，换一个分析范围再试。</p>
                </section>
              ) : (
                <section className="urgent-section is-clear">
                  <h3><CheckCircle2 size={15} className="section-icon" aria-hidden="true" />没有严重问题</h3>
                  <p className="urgent-clear">未发现严重复杂函数、严重异味或循环依赖。</p>
                </section>
              )}
            </div>
          )}
          
          {/* 复杂度标签页 */}
          {activeTab === 'complexity' && complexity && (
            <div className="complexity-tab">
              {/* 分布图 */}
              <div className="distribution-section">
                <h3>风险分布（{functionTotal} 个函数）</h3>
                {functionTotal === 0 ? (
                  <p className="quality-empty">当前范围内没有可分析的函数。</p>
                ) : (
                  <>
                    <div className="distribution-bar" role="img" aria-label={
                      ['low', 'moderate', 'high', 'critical']
                        .map((level) => `${riskLabel(level)} ${distribution[level as keyof typeof distribution]}`)
                        .join('，')
                    }>
                      {(['low', 'moderate', 'high', 'critical'] as const).map(level => {
                        const count = distribution[level];
                        const percent = (count / distributionTotal) * 100;
                        return percent > 0 ? (
                          <div
                            key={level}
                            className="distribution-segment"
                            style={{ width: `${percent}%`, backgroundColor: getRiskColor(level) }}
                            title={`${riskLabel(level)}：${count} 个函数（${percent.toFixed(1)}%）`}
                          />
                        ) : null;
                      })}
                    </div>
                    <div className="distribution-legend">
                      {(['low', 'moderate', 'high', 'critical'] as const).map((level) => (
                        <span key={level}>
                          <i className="legend-dot" style={{ background: getRiskColor(level) }} aria-hidden="true" />
                          {riskLabel(level)} {distribution[level]}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* 热点列表 */}
              <div className="hotspots-section">
                <h3>复杂度热点 Top 10</h3>
                {complexity.hotspots.length === 0 ? (
                  <p className="quality-empty">没有超过阈值的复杂函数。</p>
                ) : (
                  <table className="hotspots-table">
                    <thead>
                      <tr>
                        <th>函数</th>
                        <th className="num">圈复杂度</th>
                        <th className="num">认知复杂度</th>
                        <th className="num">嵌套</th>
                        <th className="num">行数</th>
                        <th>风险</th>
                      </tr>
                    </thead>
                    <tbody>
                      {complexity.hotspots.map((hotspot, i) => (
                        <tr key={`${hotspot.name}-${hotspot.line}-${i}`}>
                          <td className="func-name">{hotspot.name} <span className="func-kind">({hotspot.kind})</span></td>
                          <td className="num">{hotspot.metrics.cyclomatic}</td>
                          <td className="num">{hotspot.metrics.cognitive}</td>
                          <td className="num">{hotspot.metrics.maxNesting}</td>
                          <td className="num">{hotspot.metrics.loc}</td>
                          <td>
                            <span
                              className="risk-badge"
                              style={{ backgroundColor: getRiskColor(hotspot.risk) }}
                              title={hotspot.risk}
                            >
                              {riskLabel(hotspot.risk)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
          
          {/* 异味标签页 */}
          {activeTab === 'smells' && smells && (
            <div className="smells-tab">
              {smells.totalSmells === 0 && (
                <p className="quality-empty">没有检测到代码异味。</p>
              )}
              {Object.keys(smells.byType ?? {}).length > 0 && (
                <div className="smell-types-section">
                  <h3>异味类型分布</h3>
                  <div className="smell-type-bars">
                    {Object.entries(smells.byType)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 8)
                      .map(([type, count]) => {
                        // 分母至少为 1：空统计时 Math.max() 是 -Infinity，条形会变成 NaN 宽度。
                        const maxCount = Math.max(1, ...Object.values(smells.byType));
                        return (
                          <div key={type} className="smell-type-row">
                            <span className="smell-type-name" title={type}>{smellTypeLabel(type)}</span>
                            <div className="smell-type-bar-track">
                              <div
                                className="smell-type-bar-fill"
                                style={{ width: `${(count / maxCount) * 100}%` }}
                              />
                            </div>
                            <span className="smell-type-count">{count}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              <div className="top-smells-section">
                <h3>最严重的异味</h3>
                {(smells.topSmells?.length ?? 0) === 0 ? (
                  <p className="quality-empty">没有需要优先处理的异味。</p>
                ) : smells.topSmells.slice(0, 10).map((smell, i) => (
                  <button
                    key={`${smell.file}-${smell.line}-${i}`}
                    type="button"
                    className="smell-item"
                    onClick={() => onOpenFile?.(smell.file, smell.line)}
                    aria-label={`打开 ${smell.file} 第 ${smell.line} 行：${smell.message}`}
                    title={`${smell.file}:${smell.line}`}
                  >
                    <span
                      className="smell-severity"
                      style={{ backgroundColor: getRiskColor(smell.severity) }}
                    >
                      {riskLabel(smell.severity)}
                    </span>
                    <span className="smell-info">
                      <span className="smell-message">{smell.message}</span>
                      <span className="smell-location">{smell.file}:{smell.line}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          
          {/* 依赖标签页 */}
          {activeTab === 'dependencies' && dependencies && (
            <div className="dependencies-tab">
              <div className="dep-stats">
                <div className="dep-stat">
                  <span className="dep-stat-value">{dependencies.totalModules}</span>
                  <span className="dep-stat-label">内部模块</span>
                </div>
                <div className="dep-stat">
                  <span className="dep-stat-value">{dependencies.externalDependencies}</span>
                  <span className="dep-stat-label">外部依赖</span>
                </div>
                <div className="dep-stat">
                  <span className="dep-stat-value" style={{
                    color: (dependencies.circularDependencies?.length ?? 0) > 0 ? 'var(--danger)' : 'var(--ok)'
                  }}>
                    {dependencies.circularDependencies?.length ?? 0}
                  </span>
                  <span className="dep-stat-label">循环依赖</span>
                </div>
                <div className="dep-stat">
                  <span className="dep-stat-value">{dependencies.isolatedModules?.length ?? 0}</span>
                  <span className="dep-stat-label">孤岛模块</span>
                </div>
              </div>
              
              {dependencies.circularDependencies.length > 0 && (
                <div className="cycles-section">
                  <h3><AlertTriangle size={15} className="section-icon" aria-hidden="true" />循环依赖</h3>
                  {dependencies.circularDependencies.slice(0, 5).map((cycle, i) => (
                    <div key={i} className="cycle-item">
                      <div className="cycle-path">
                        {cycle.cycle.map((mod, j) => (
                          <React.Fragment key={j}>
                            <span className="cycle-module" title={mod}>{mod.split('/').pop()}</span>
                            {j < cycle.cycle.length - 1 && <span className="cycle-arrow" aria-hidden="true">→</span>}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                  {dependencies.circularDependencies.length > 5 && (
                    <p className="section-footnote">另有 {dependencies.circularDependencies.length - 5} 组未列出。</p>
                  )}
                </div>
              )}

              {dependencies.godModules.length > 0 && (
                <div className="god-modules-section">
                  <h3>上帝模块（被依赖最多）</h3>
                  {dependencies.godModules.map((god, i) => (
                    <div key={i} className="god-module-row">
                      <span className="god-module-path">{god.module}</span>
                      <span className="god-module-count">{god.dependentCount} 个依赖者</span>
                    </div>
                  ))}
                </div>
              )}

              {(dependencies.circularDependencies?.length ?? 0) === 0 && (dependencies.godModules?.length ?? 0) === 0 && (
                <p className="quality-empty">依赖关系干净：没有循环依赖，也没有过大的上帝模块。</p>
              )}
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .quality-dashboard-overlay {
          position: fixed;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .pattern-input {
          padding: 8px 12px;
          /* 输入框边框是它唯一的识别边界（1.4.11 要 3:1）：--border 实测 1.24:1、
             --border-strong 1.37:1 都不够，取 --fg 60%（在 dashboard-header 的
             --bg-side 上也还有 3.4:1）。 */
          border: 1px solid color-mix(in srgb, var(--fg) 60%, transparent);
          font-family: var(--font-mono);
          font-size: var(--fs-4);
          width: 220px;
        }

        .refresh-btn {
          padding: 8px 20px;
          border: none;
          font-size: var(--fs-5);
          cursor: pointer;
        }

        .refresh-btn:disabled { opacity: 0.5; }

        .close-btn {
          background: none;
          border: none;
          font-size: var(--fs-10);
          color: var(--fg-muted);
          cursor: pointer;
        }

        .tab {
          padding: 14px 24px;
          border: none;
          background: none;
          font-size: var(--fs-5);
          color: var(--fg-muted);
          cursor: pointer;
          border-bottom: 2px solid transparent;
        }

        .tab.active {
          color: var(--blue);
          border-bottom-color: var(--blue);
          font-weight: 600;
        }

        .error-message {
          display: flex;
          align-items: center;
          gap: 8px;
          background: var(--danger-soft);
          border-radius: 6px;
          padding: 12px;
          color: var(--danger-ink);
          margin-bottom: 16px;
        }
        .error-message > svg { flex: none; }
        .error-message > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        .error-message > button:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 10%, transparent); }
        .error-message > button:disabled { opacity: .55; cursor: default; }
        .quality-empty > svg { color: var(--fg-dim); }
        
        .score-hero {
          display: flex;
          align-items: center;
          gap: 18px;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px 20px;
          margin-bottom: 16px;
        }

        /* 评分徽章比原来的 120px 圆环小一半：分数是抬头信息，不该占掉半屏 */
        .score-badge {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          border: 3px solid;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1px;
          flex-shrink: 0;
        }

        .grade-letter {
          font-size: 26px;
          font-weight: 700;
          font-family: var(--font-ui);
          line-height: 1;
        }

        .grade-score {
          font-size: var(--fs-2);
          color: var(--fg-muted);
          font-variant-numeric: tabular-nums;
        }

        .grade-text { min-width: 0; }

        .grade-text h3 {
          margin: 0;
          font-family: var(--font-ui);
          font-size: var(--fs-6);
          font-weight: 650;
          color: var(--fg);
        }

        .grade-text p { margin: 0; color: var(--fg-muted); }

        .score-basis { font-size: var(--fs-3); margin-top: 2px; }

        /* 扣分明细：让“0 分 / F”这种看不懂的结论变成可核对的三个数 */
        .score-breakdown {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 8px 0 0;
          padding: 0;
          list-style: none;
        }

        .score-breakdown li {
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          padding: 2px 9px;
          border-radius: 999px;
          background: var(--bg-side);
          border: 1px solid var(--border-subtle);
          font-size: var(--fs-3);
          color: var(--fg-muted);
        }

        .score-breakdown .breakdown-value {
          color: var(--fg);
          font-variant-numeric: tabular-nums;
        }

        .metric-cards {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin-bottom: 16px;
        }
        
        /* 指标卡现在是真正的按钮：可聚焦、可回车，右侧带一个进入箭标 */
        .metric-card {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          width: 100%;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px 20px;
          font: inherit;
          color: inherit;
          text-align: center;
          cursor: pointer;
          transition: border-color 0.15s ease, transform 0.15s ease;
        }

        .metric-card:focus-visible {
          outline: 2px solid var(--blue);
          outline-offset: 2px;
        }

        .metric-chevron {
          position: absolute;
          top: 10px;
          right: 10px;
          color: var(--fg-muted);
        }

        .metric-card:hover .metric-chevron { color: var(--blue); }

        .metric-title { font-size: var(--fs-4); color: var(--fg-muted); margin-bottom: 4px; }
        .metric-value { font-size: var(--fs-10); font-weight: 650; font-family: var(--font-ui); color: var(--fg); line-height: 1.1; }
        .metric-label { font-size: var(--fs-3); color: var(--fg-muted); margin: 2px 0 6px; }
        .metric-detail { font-size: var(--fs-3); color: var(--fg-muted); }

        .urgent-section {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px 20px;
        }

        .urgent-section h3 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 10px;
          font-size: var(--fs-5);
          color: var(--fg);
        }

        .urgent-section h3 .section-icon { color: var(--danger); }
        .urgent-section.is-clear { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
        .urgent-section.is-clear h3 { color: var(--ok-ink); }
        .urgent-section.is-clear h3 .section-icon { color: var(--ok); }
        .urgent-clear { margin: 0; font-size: var(--fs-4); color: var(--fg-muted); }

        .urgent-list { margin: 0; padding-left: 20px; }
        .urgent-list li { margin-bottom: 6px; line-height: 1.6; color: var(--fg); font-size: var(--fs-4); }
        .urgent-list li:last-child { margin-bottom: 0; }
        
        .distribution-section, .hotspots-section,
        .smell-types-section, .top-smells-section,
        .cycles-section, .god-modules-section {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 20px;
        }
        
        .distribution-section h3, .hotspots-section h3,
        .smell-types-section h3, .top-smells-section h3,
        .cycles-section h3, .god-modules-section h3 {
          margin: 0 0 16px 0;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .distribution-bar {
          display: flex;
          height: 24px;
          border-radius: 999px;
          overflow: hidden;
          margin-bottom: 12px;
          background: var(--border);
        }
        
        .distribution-legend {
          display: flex;
          gap: 20px;
          font-size: var(--fs-4);
          color: var(--fg-muted);
        }
        
        .hotspots-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--fs-4);
        }
        
        .hotspots-table th {
          text-align: left;
          padding: 8px 12px;
          border-bottom: 2px solid var(--border);
          color: var(--fg-muted);
          font-weight: 500;
        }
        
        .hotspots-table td {
          padding: 8px 12px;
          border-bottom: 1px solid var(--border-subtle);
        }
        
        .func-name { font-family: var(--font-mono); }
        .func-kind { color: var(--fg-muted); font-size: var(--fs-2); }
        
        .risk-badge {
          padding: 2px 10px;
          border-radius: 999px;
          color: var(--bg-elevated);
          font-size: var(--fs-2);
          text-transform: uppercase;
        }
        
        .smell-type-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 8px;
        }
        
        .smell-type-name {
          width: 180px;
          font-size: var(--fs-4);
          font-family: var(--font-mono);
          color: var(--fg);
        }
        
        .smell-type-bar-track {
          flex: 1;
          height: 12px;
          background: var(--border-subtle);
          border-radius: 999px;
          overflow: hidden;
        }
        
        .smell-type-bar-fill {
          height: 100%;
          background: var(--blue);
          border-radius: 999px;
        }
        
        .smell-type-count {
          width: 40px;
          text-align: right;
          font-size: var(--fs-4);
          color: var(--fg-muted);
        }
        
        .smell-item {
          display: flex;
          gap: 12px;
          align-items: flex-start;
          padding: 12px;
          border-radius: 6px;
          cursor: pointer;
          margin-bottom: 8px;
          background: var(--bg-hover);
        }
        
        .smell-item:hover { background: var(--border-subtle); }
        
        .smell-severity {
          padding: 2px 10px;
          border-radius: 999px;
          color: var(--bg-elevated);
          font-size: var(--fs-2);
          flex-shrink: 0;
        }
        
        .smell-message { font-size: var(--fs-5); color: var(--fg); margin-bottom: 4px; }
        .smell-location { font-size: var(--fs-3); color: var(--fg-muted); font-family: var(--font-mono); }
        
        .dep-stats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          margin-bottom: 20px;
        }
        
        .dep-stat {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        
        .dep-stat-value {
          font-size: var(--fs-10);
          font-weight: bold;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .dep-stat-label { font-size: var(--fs-4); color: var(--fg-muted); margin-top: 4px; }
        
        .cycle-item {
          background: color-mix(in srgb, var(--warn) 12%, transparent);
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 8px;
        }
        
        .cycle-path {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }
        
        .cycle-module {
          font-family: var(--font-mono);
          font-size: var(--fs-4);
          background: var(--bg-elevated);
          padding: 4px 10px;
          border-radius: 4px;
          color: var(--fg);
        }
        
        .cycle-arrow { color: var(--warn-ink); }
        
        .god-module-row {
          display: flex;
          justify-content: space-between;
          padding: 10px 12px;
          border-bottom: 1px solid var(--border-subtle);
          font-size: var(--fs-4);
        }
        
        .god-module-path { font-family: var(--font-mono); color: var(--fg); }
        .god-module-count { color: var(--blue); font-weight: 500; }

        /* —— 输入区、图例、空状态与窄窗口 —— */
        .pattern-field { display: inline-flex; align-items: center; gap: 8px; }
        .pattern-label { font-size: var(--fs-3); color: var(--fg-muted); white-space: nowrap; }
        .pattern-input:disabled { opacity: 0.6; }

        .refresh-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-weight: 500;
        }
        .refresh-btn:hover:not(:disabled) { filter: brightness(1.06); }

        .close-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .close-btn:hover { background: var(--bg-hover); color: var(--fg); }

        .distribution-legend span { display: inline-flex; align-items: center; gap: 6px; }
        .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .hotspots-table .num { text-align: right; font-variant-numeric: tabular-nums; }
        .section-icon { color: var(--danger); flex-shrink: 0; }
        .section-footnote { margin: 6px 0 0; font-size: var(--fs-3); color: var(--fg-muted); }

        .quality-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          margin: 0;
          padding: 28px 16px;
          text-align: center;
          font-size: var(--fs-4);
          color: var(--fg-muted);
          border: 1px dashed var(--border);
          border-radius: 12px;
          background: var(--bg-elevated);
        }
        .dashboard-content > .quality-empty { margin-bottom: 16px; }
        .quality-note { margin: 0 0 16px; font-size: var(--fs-4); color: var(--fg-muted); }
        .urgent-section.is-neutral { border-color: var(--border); }
        .urgent-section.is-neutral h3 { color: var(--fg); }
        .urgent-section.is-neutral h3 .section-icon { color: var(--fg-muted); }
        .distribution-section .quality-empty,
        .hotspots-section .quality-empty,
        .top-smells-section .quality-empty {
          border: none;
          background: none;
          padding: 10px 0;
          align-items: flex-start;
        }

        /* 异味条目：原来的可点击 div 改成按钮，键盘可达、有焦点环 */
        .smell-item {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          width: 100%;
          padding: 10px 12px;
          border: 1px solid transparent;
          border-radius: 8px;
          background: var(--bg-hover);
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
          margin-bottom: 8px;
        }
        .smell-item:hover { border-color: var(--blue); background: var(--bg-elevated); }
        .smell-item:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
        .smell-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .smell-message { display: block; font-size: var(--fs-4); color: var(--fg); }
        .smell-location { display: block; font-size: var(--fs-3); color: var(--fg-muted); font-family: var(--font-mono); }
        .smell-severity { color: var(--bg-elevated); white-space: nowrap; }

        @media (max-width: 880px) {
          .metric-cards { grid-template-columns: 1fr; }
          .dep-stats { grid-template-columns: repeat(2, 1fr); }
          .score-hero { flex-wrap: wrap; }
          .pattern-label { display: none; }
          .pattern-input { width: 180px; }
        }
      `}</style>
    </div>
  );
};
