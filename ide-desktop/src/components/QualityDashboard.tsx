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

/**
 * 草案面板桥接：invokeTool 工具桥尚未在 preload 落地（ZCodeDesktopApi 无此方法），
 * 面板未挂载到 App。运行时若桥接缺失会抛出明确错误。
 */
async function invokeTool(name: string, input: unknown): Promise<{ ok: boolean; data: any; output: any }> {
  const api = (window as unknown as {
    electronAPI?: { invokeTool(name: string, input: unknown): Promise<{ ok: boolean; data: unknown; output: string }> };
  }).electronAPI;
  if (!api) throw new Error('invokeTool 桥接未实现：preload 缺少 electronAPI（草案面板）');
  return api.invokeTool(name, input) as Promise<{ ok: boolean; data: any; output: any }>;
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
  const [activeTab, setActiveTab] = useState<'overview' | 'complexity' | 'smells' | 'dependencies'>('overview');
  
  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // 并行执行三项分析
      const [complexityRes, smellsRes, depsRes] = await Promise.all([
        invokeTool('analyze_complexity', { pattern }),
        invokeTool('detect_code_smells', { pattern }),
        invokeTool('analyze_dependencies', { pattern }),
      ]);
      
      if (complexityRes.ok) setComplexity(complexityRes.data);
      if (smellsRes.ok) setSmells(smellsRes.data);
      if (depsRes.ok) setDependencies(depsRes.data);
      
      if (!complexityRes.ok && !smellsRes.ok && !depsRes.ok) {
        setError('所有分析均失败，请检查文件模式');
      }
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
  
  // 综合质量评分（0-100）
  const overallScore = useMemo(() => {
    if (!complexity || !smells || !dependencies) return null;
    
    let score = 100;
    
    // 复杂度扣分
    score -= complexity.distribution.critical * 5;
    score -= complexity.distribution.high * 2;
    
    // 异味扣分
    score -= smells.bySeverity.critical * 4;
    score -= smells.bySeverity.major * 2;
    score -= smells.bySeverity.minor * 0.5;
    
    // 依赖扣分
    score -= dependencies.circularDependencies.length * 3;
    score -= dependencies.godModules.length * 1;
    
    return Math.max(0, Math.round(score));
  }, [complexity, smells, dependencies]);
  
  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'critical': return '#CC0000';
      case 'high': case 'major': return '#FF6B00';
      case 'moderate': case 'minor': return '#FF9800';
      default: return '#2E7D32';
    }
  };
  
  const getScoreGrade = (score: number) => {
    if (score >= 90) return { grade: 'A', color: '#2E7D32', text: '优秀' };
    if (score >= 75) return { grade: 'B', color: '#7CB342', text: '良好' };
    if (score >= 60) return { grade: 'C', color: '#FF9800', text: '一般' };
    if (score >= 40) return { grade: 'D', color: '#FF6B00', text: '较差' };
    return { grade: 'F', color: '#CC0000', text: '需要重构' };
  };
  
  if (!visible) return null;
  
  return (
    <div className="quality-dashboard-overlay">
      <div className="quality-dashboard">
        <div className="dashboard-header">
          <h2>代码质量仪表盘</h2>
          <div className="header-actions">
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="src/**/*.ts"
              className="pattern-input"
            />
            <button onClick={handleAnalyze} disabled={loading} className="refresh-btn">
              {loading ? '分析中...' : '刷新'}
            </button>
            <button onClick={onClose} className="close-btn">×</button>
          </div>
        </div>
        
        {/* 标签页 */}
        <div className="dashboard-tabs">
          {(['overview', 'complexity', 'smells', 'dependencies'] as const).map(tab => (
            <button
              key={tab}
              className={activeTab === tab ? 'tab active' : 'tab'}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'overview' ? '总览' :
               tab === 'complexity' ? '复杂度' :
               tab === 'smells' ? '代码异味' : '依赖关系'}
            </button>
          ))}
        </div>
        
        <div className="dashboard-content">
          {error && (
            <div className="error-message">{error}</div>
          )}
          
          {/* 总览标签页 */}
          {activeTab === 'overview' && (
            <div className="overview-tab">
              {overallScore !== null && (
                <div className="score-hero">
                  <div className="grade-circle" style={{ borderColor: getScoreGrade(overallScore).color }}>
                    <span className="grade-letter" style={{ color: getScoreGrade(overallScore).color }}>
                      {getScoreGrade(overallScore).grade}
                    </span>
                    <span className="grade-score">{overallScore} 分</span>
                  </div>
                  <div className="grade-text">
                    <h3>综合质量: {getScoreGrade(overallScore).text}</h3>
                    <p>基于复杂度、代码异味和依赖健康度综合评估</p>
                  </div>
                </div>
              )}
              
              <div className="metric-cards">
                {complexity && (
                  <div className="metric-card" onClick={() => setActiveTab('complexity')}>
                    <div className="metric-title">复杂度</div>
                    <div className="metric-value">{complexity.averageCyclomatic.toFixed(1)}</div>
                    <div className="metric-label">平均圈复杂度</div>
                    <div className="metric-detail">
                      {complexity.distribution.critical + complexity.distribution.high} 个高风险函数
                    </div>
                  </div>
                )}
                
                {smells && (
                  <div className="metric-card" onClick={() => setActiveTab('smells')}>
                    <div className="metric-title">代码异味</div>
                    <div className="metric-value">{smells.totalSmells}</div>
                    <div className="metric-label">异味总数</div>
                    <div className="metric-detail">
                      {smells.bySeverity.critical} critical / {smells.bySeverity.major} major
                    </div>
                  </div>
                )}
                
                {dependencies && (
                  <div className="metric-card" onClick={() => setActiveTab('dependencies')}>
                    <div className="metric-title">依赖健康</div>
                    <div className="metric-value">{dependencies.circularDependencies.length}</div>
                    <div className="metric-label">循环依赖</div>
                    <div className="metric-detail">
                      {dependencies.totalModules} 模块 / {dependencies.godModules.length} 上帝模块
                    </div>
                  </div>
                )}
              </div>
              
              {/* 需要立即关注的问题 */}
              <div className="urgent-section">
                <h3>🚨 需要立即关注</h3>
                <ul className="urgent-list">
                  {complexity && complexity.distribution.critical > 0 && (
                    <li>有 {complexity.distribution.critical} 个函数复杂度达到严重级别，建议立即重构</li>
                  )}
                  {smells && smells.bySeverity.critical > 0 && (
                    <li>发现 {smells.bySeverity.critical} 个严重代码异味（如上帝类）</li>
                  )}
                  {dependencies && dependencies.circularDependencies.length > 0 && (
                    <li>存在 {dependencies.circularDependencies.length} 组循环依赖，影响模块化和测试</li>
                  )}
                  {complexity && complexity.distribution.critical === 0 &&
                   smells && smells.bySeverity.critical === 0 &&
                   dependencies && dependencies.circularDependencies.length === 0 && (
                    <li className="all-good">✅ 无严重问题，代码质量保持良好</li>
                  )}
                </ul>
              </div>
            </div>
          )}
          
          {/* 复杂度标签页 */}
          {activeTab === 'complexity' && complexity && (
            <div className="complexity-tab">
              {/* 分布图 */}
              <div className="distribution-section">
                <h3>风险分布 ({complexity.totalFunctions} 个函数)</h3>
                <div className="distribution-bar">
                  {(['low', 'moderate', 'high', 'critical'] as const).map(level => {
                    const count = complexity.distribution[level];
                    const percent = (count / complexity.totalFunctions) * 100;
                    return percent > 0 ? (
                      <div
                        key={level}
                        className="distribution-segment"
                        style={{
                          width: `${percent}%`,
                          backgroundColor: getRiskColor(level === 'low' ? 'low' : level === 'moderate' ? 'moderate' : level),
                        }}
                        title={`${level}: ${count}`}
                      />
                    ) : null;
                  })}
                </div>
                <div className="distribution-legend">
                  <span>🟢 低 {complexity.distribution.low}</span>
                  <span>🟡 中 {complexity.distribution.moderate}</span>
                  <span>🟠 高 {complexity.distribution.high}</span>
                  <span>🔴 严重 {complexity.distribution.critical}</span>
                </div>
              </div>
              
              {/* 热点列表 */}
              <div className="hotspots-section">
                <h3>复杂度热点 Top 10</h3>
                <table className="hotspots-table">
                  <thead>
                    <tr>
                      <th>函数</th>
                      <th>圈复杂度</th>
                      <th>认知复杂度</th>
                      <th>嵌套</th>
                      <th>行数</th>
                      <th>风险</th>
                    </tr>
                  </thead>
                  <tbody>
                    {complexity.hotspots.map((hotspot, i) => (
                      <tr key={i}>
                        <td className="func-name">{hotspot.name} <span className="func-kind">({hotspot.kind})</span></td>
                        <td>{hotspot.metrics.cyclomatic}</td>
                        <td>{hotspot.metrics.cognitive}</td>
                        <td>{hotspot.metrics.maxNesting}</td>
                        <td>{hotspot.metrics.loc}</td>
                        <td>
                          <span className="risk-badge" style={{ backgroundColor: getRiskColor(hotspot.risk) }}>
                            {hotspot.risk}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          
          {/* 异味标签页 */}
          {activeTab === 'smells' && smells && (
            <div className="smells-tab">
              <div className="smell-types-section">
                <h3>异味类型分布</h3>
                <div className="smell-type-bars">
                  {Object.entries(smells.byType)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([type, count]) => {
                      const maxCount = Math.max(...Object.values(smells.byType));
                      return (
                        <div key={type} className="smell-type-row">
                          <span className="smell-type-name">{type}</span>
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
              
              <div className="top-smells-section">
                <h3>最严重的异味</h3>
                {smells.topSmells.slice(0, 10).map((smell, i) => (
                  <div
                    key={i}
                    className="smell-item"
                    onClick={() => onOpenFile?.(smell.file, smell.line)}
                  >
                    <span className="smell-severity" style={{ backgroundColor: getRiskColor(smell.severity) }}>
                      {smell.severity}
                    </span>
                    <div className="smell-info">
                      <div className="smell-message">{smell.message}</div>
                      <div className="smell-location">{smell.file}:{smell.line}</div>
                    </div>
                  </div>
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
                    color: dependencies.circularDependencies.length > 0 ? '#CC0000' : '#2E7D32'
                  }}>
                    {dependencies.circularDependencies.length}
                  </span>
                  <span className="dep-stat-label">循环依赖</span>
                </div>
                <div className="dep-stat">
                  <span className="dep-stat-value">{dependencies.isolatedModules.length}</span>
                  <span className="dep-stat-label">孤岛模块</span>
                </div>
              </div>
              
              {dependencies.circularDependencies.length > 0 && (
                <div className="cycles-section">
                  <h3>⚠️ 循环依赖</h3>
                  {dependencies.circularDependencies.slice(0, 5).map((cycle, i) => (
                    <div key={i} className="cycle-item">
                      <div className="cycle-path">
                        {cycle.cycle.map((mod, j) => (
                          <React.Fragment key={j}>
                            <span className="cycle-module">{mod.split('/').pop()}</span>
                            {j < cycle.cycle.length - 1 && <span className="cycle-arrow">→</span>}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
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
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .quality-dashboard-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        
        .quality-dashboard {
          background: #FBF9F5;
          border-radius: 8px;
          width: 92%;
          max-width: 1100px;
          max-height: 92vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
        }
        
        .dashboard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid #E7E1D7;
        }
        
        .dashboard-header h2 {
          margin: 0;
          font-family: 'DM Serif Display', serif;
          font-size: 24px;
          color: #1F2421;
        }
        
        .header-actions {
          display: flex;
          gap: 12px;
          align-items: center;
        }
        
        .pattern-input {
          padding: 8px 12px;
          border: 1px solid #E7E1D7;
          border-radius: 6px;
          font-family: 'Monaco', monospace;
          font-size: 13px;
          width: 220px;
        }
        
        .refresh-btn {
          padding: 8px 20px;
          border: none;
          border-radius: 999px;
          background: #C4612F;
          color: white;
          font-size: 14px;
          cursor: pointer;
        }
        
        .refresh-btn:disabled { opacity: 0.5; }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 28px;
          color: #5C635D;
          cursor: pointer;
        }
        
        .dashboard-tabs {
          display: flex;
          gap: 4px;
          padding: 0 24px;
          border-bottom: 1px solid #E7E1D7;
          background: white;
        }
        
        .tab {
          padding: 14px 24px;
          border: none;
          background: none;
          font-size: 14px;
          color: #5C635D;
          cursor: pointer;
          border-bottom: 2px solid transparent;
        }
        
        .tab.active {
          color: #C4612F;
          border-bottom-color: #C4612F;
          font-weight: 600;
        }
        
        .dashboard-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }
        
        .error-message {
          background: #FFE5E5;
          border-radius: 6px;
          padding: 12px;
          color: #CC0000;
          margin-bottom: 16px;
        }
        
        .score-hero {
          display: flex;
          align-items: center;
          gap: 32px;
          background: white;
          border: 1px solid #E7E1D7;
          border-radius: 8px;
          padding: 32px;
          margin-bottom: 24px;
        }
        
        .grade-circle {
          width: 120px;
          height: 120px;
          border-radius: 50%;
          border: 6px solid;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        
        .grade-letter {
          font-size: 48px;
          font-weight: bold;
          font-family: 'DM Serif Display', serif;
          line-height: 1;
        }
        
        .grade-score {
          font-size: 13px;
          color: #5C635D;
        }
        
        .grade-text h3 {
          margin: 0 0 8px 0;
          font-family: 'DM Serif Display', serif;
          color: #1F2421;
        }
        
        .grade-text p { margin: 0; color: #5C635D; }
        
        .metric-cards {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }
        
        .metric-card {
          background: white;
          border: 1px solid #E7E1D7;
          border-radius: 8px;
          padding: 20px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .metric-card:hover {
          border-color: #C4612F;
          transform: translateY(-2px);
        }
        
        .metric-title { font-size: 13px; color: #5C635D; margin-bottom: 8px; }
        .metric-value { font-size: 32px; font-weight: bold; font-family: 'DM Serif Display', serif; color: #1F2421; }
        .metric-label { font-size: 12px; color: #5C635D; margin: 4px 0 8px; }
        .metric-detail { font-size: 12px; color: #C4612F; }
        
        .urgent-section {
          background: white;
          border: 1px solid #E7E1D7;
          border-radius: 8px;
          padding: 20px;
        }
        
        .urgent-section h3 { margin: 0 0 12px 0; color: #1F2421; }
        .urgent-list { margin: 0; padding-left: 24px; }
        .urgent-list li { margin-bottom: 8px; line-height: 1.6; color: #1F2421; }
        .urgent-list li.all-good { list-style: none; margin-left: -24px; color: #2E7D32; }
        
        .distribution-section, .hotspots-section,
        .smell-types-section, .top-smells-section,
        .cycles-section, .god-modules-section {
          background: white;
          border: 1px solid #E7E1D7;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 20px;
        }
        
        .distribution-section h3, .hotspots-section h3,
        .smell-types-section h3, .top-smells-section h3,
        .cycles-section h3, .god-modules-section h3 {
          margin: 0 0 16px 0;
          font-family: 'DM Serif Display', serif;
          color: #1F2421;
        }
        
        .distribution-bar {
          display: flex;
          height: 24px;
          border-radius: 999px;
          overflow: hidden;
          margin-bottom: 12px;
          background: #E7E1D7;
        }
        
        .distribution-legend {
          display: flex;
          gap: 20px;
          font-size: 13px;
          color: #5C635D;
        }
        
        .hotspots-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        
        .hotspots-table th {
          text-align: left;
          padding: 8px 12px;
          border-bottom: 2px solid #E7E1D7;
          color: #5C635D;
          font-weight: 500;
        }
        
        .hotspots-table td {
          padding: 8px 12px;
          border-bottom: 1px solid #F0EBE3;
        }
        
        .func-name { font-family: 'Monaco', monospace; }
        .func-kind { color: #5C635D; font-size: 11px; }
        
        .risk-badge {
          padding: 2px 10px;
          border-radius: 999px;
          color: white;
          font-size: 11px;
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
          font-size: 13px;
          font-family: 'Monaco', monospace;
          color: #1F2421;
        }
        
        .smell-type-bar-track {
          flex: 1;
          height: 12px;
          background: #F0EBE3;
          border-radius: 999px;
          overflow: hidden;
        }
        
        .smell-type-bar-fill {
          height: 100%;
          background: #C4612F;
          border-radius: 999px;
        }
        
        .smell-type-count {
          width: 40px;
          text-align: right;
          font-size: 13px;
          color: #5C635D;
        }
        
        .smell-item {
          display: flex;
          gap: 12px;
          align-items: flex-start;
          padding: 12px;
          border-radius: 6px;
          cursor: pointer;
          margin-bottom: 8px;
          background: #F7F4EF;
        }
        
        .smell-item:hover { background: #F0EBE3; }
        
        .smell-severity {
          padding: 2px 10px;
          border-radius: 999px;
          color: white;
          font-size: 11px;
          flex-shrink: 0;
        }
        
        .smell-message { font-size: 14px; color: #1F2421; margin-bottom: 4px; }
        .smell-location { font-size: 12px; color: #5C635D; font-family: 'Monaco', monospace; }
        
        .dep-stats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          margin-bottom: 20px;
        }
        
        .dep-stat {
          background: white;
          border: 1px solid #E7E1D7;
          border-radius: 8px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        
        .dep-stat-value {
          font-size: 28px;
          font-weight: bold;
          font-family: 'DM Serif Display', serif;
          color: #1F2421;
        }
        
        .dep-stat-label { font-size: 13px; color: #5C635D; margin-top: 4px; }
        
        .cycle-item {
          background: #FFF3E0;
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
          font-family: 'Monaco', monospace;
          font-size: 13px;
          background: white;
          padding: 4px 10px;
          border-radius: 4px;
          color: #1F2421;
        }
        
        .cycle-arrow { color: #FF9800; }
        
        .god-module-row {
          display: flex;
          justify-content: space-between;
          padding: 10px 12px;
          border-bottom: 1px solid #F0EBE3;
          font-size: 13px;
        }
        
        .god-module-path { font-family: 'Monaco', monospace; color: #1F2421; }
        .god-module-count { color: #C4612F; font-weight: 500; }
      `}</style>
    </div>
  );
};
