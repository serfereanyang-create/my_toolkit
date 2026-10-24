/**
 * PerformancePanel.tsx — 性能分析面板
 * 
 * 桌面端性能分析 UI
 * - 显示性能问题
 * - 算法复杂度展示
 * - 内存泄漏风险
 * - 优化建议
 */

import React, { useState, useEffect } from 'react';
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

interface PerformancePanelProps {
  visible: boolean;
  onClose: () => void;
  file?: string;
}

interface PerformanceIssue {
  category: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  line: number;
  column: number;
  message: string;
  explanation: string;
  suggestion: string;
  estimatedImpact?: string;
  example?: string;
}

interface AlgorithmComplexity {
  timeComplexity: string;
  spaceComplexity: string;
  reasoning: string;
}

interface MemoryLeakRisk {
  line: number;
  type: string;
  description: string;
}

interface PerformanceResult {
  issues: PerformanceIssue[];
  algorithmComplexities: Record<string, AlgorithmComplexity>;
  memoryLeakRisks: MemoryLeakRisk[];
  optimizationSuggestions: string[];
  estimatedScore: number;
}

export const PerformancePanel: React.FC<PerformancePanelProps> = ({
  visible,
  onClose,
  file,
}) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PerformanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPattern, setSelectedPattern] = useState('');
  const [minSeverity, setMinSeverity] = useState<string>('minor');
  // Workspace revision guard: flag results as stale once the workspace moves on.
  const { capture, current, stale } = useQualityRevision(visible && !loading);

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await invokeTool('analyze_performance', {
        file,
        pattern: selectedPattern || undefined,
        severity: minSeverity,
      }, current?.label);

      if (response.ok) {
        // 如果是多文件分析，取第一个结果
        const data = Array.isArray(response.data)
          ? response.data[0]?.result
          : response.data;
        setResult(data);
      } else {
        setError(response.output);
      }
      await capture();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    if (visible && file) {
      handleAnalyze();
    }
  }, [visible, file]);
  
  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical': return '🔴';
      case 'major': return '🟠';
      case 'minor': return '🟡';
      case 'info': return 'ℹ️';
      default: return '•';
    }
  };
  
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'var(--danger)';
      case 'major': return 'var(--danger)';
      case 'minor': return 'var(--warn)';
      case 'info': return 'var(--blue)';
      default: return 'var(--fg-muted)';
    }
  };
  
  const getCategoryName = (category: string) => {
    const names: Record<string, string> = {
      algorithm: '算法复杂度',
      memory: '内存使用',
      io: 'I/O 操作',
      computation: '计算密集',
      rendering: '渲染性能',
      'bundle-size': '打包大小',
    };
    return names[category] || category;
  };
  
  const getScoreColor = (score: number) => {
    if (score >= 80) return 'var(--ok)';
    if (score >= 60) return 'var(--warn)';
    return 'var(--danger)';
  };
  
  if (!visible) return null;
  
  return (
    <div className="performance-panel-overlay">
      <div className="performance-panel">
        <div className="performance-panel-header">
          <h2>性能分析</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        {stale && (
          <div className="quality-stale-banner">
            <span>工作区在分析后已变更，性能结果可能过期。</span>
            <button onClick={handleAnalyze} disabled={loading}>重新分析</button>
          </div>
        )}
        
        <div className="performance-panel-content">
          {/* 分析选项 */}
          <div className="analyze-options">
            {!file && (
              <div className="option-group">
                <label>文件模式 (Glob):</label>
                <input
                  type="text"
                  value={selectedPattern}
                  onChange={(e) => setSelectedPattern(e.target.value)}
                  placeholder="src/**/*.ts"
                />
              </div>
            )}
            
            <div className="option-group">
              <label>最低严重级别:</label>
              <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
                <option value="info">Info</option>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            
            <button onClick={handleAnalyze} disabled={loading} className="analyze-btn">
              {loading ? '分析中...' : '开始分析'}
            </button>
          </div>
          
          {/* 错误信息 */}
          {error && (
            <div className="error-message">
              <strong>错误:</strong> {error}
            </div>
          )}
          
          {/* 分析结果 */}
          {result && (
            <div className="performance-result">
              {/* 性能评分 */}
              <div className="score-section">
                <div className="score-gauge">
                  <svg width="160" height="80" viewBox="0 0 160 80">
                    <path
                      d="M 10 70 A 70 70 0 0 1 150 70"
                      fill="none"
                      stroke="var(--border)"
                      strokeWidth="12"
                    />
                    <path
                      d="M 10 70 A 70 70 0 0 1 150 70"
                      fill="none"
                      stroke={getScoreColor(result.estimatedScore)}
                      strokeWidth="12"
                      strokeDasharray={`${(result.estimatedScore / 100) * 220} 220`}
                    />
                  </svg>
                  <div className="score-value" style={{ color: getScoreColor(result.estimatedScore) }}>
                    {result.estimatedScore}
                  </div>
                </div>
                <div className="score-info">
                  <h3>性能评分</h3>
                  <p>
                    {result.estimatedScore >= 80 ? '✅ 性能良好' :
                     result.estimatedScore >= 60 ? '⚠️ 有改进空间' :
                     '❌ 存在严重性能问题'}
                  </p>
                </div>
              </div>
              
              {/* 算法复杂度 */}
              {Object.keys(result.algorithmComplexities).length > 0 && (
                <div className="complexity-section">
                  <h3>⏱ 算法复杂度</h3>
                  
                  {Object.entries(result.algorithmComplexities).map(([funcName, complexity]) => (
                    <div key={funcName} className="complexity-item">
                      <div className="complexity-header">
                        <strong>{funcName}</strong>
                      </div>
                      <div className="complexity-details">
                        <div className="complexity-row">
                          <span className="label">时间复杂度:</span>
                          <span className="value">{complexity.timeComplexity}</span>
                        </div>
                        <div className="complexity-row">
                          <span className="label">空间复杂度:</span>
                          <span className="value">{complexity.spaceComplexity}</span>
                        </div>
                        <div className="complexity-reason">
                          {complexity.reasoning}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* 性能问题 */}
              {result.issues.length > 0 && (
                <div className="issues-section">
                  <h3>⚠️ 性能问题 ({result.issues.length})</h3>
                  
                  {/* 按类别分组 */}
                  {Array.from(new Set(result.issues.map(i => i.category))).map(category => {
                    const categoryIssues = result.issues.filter(i => i.category === category);
                    
                    return (
                      <div key={category} className="category-group">
                        <h4>{getCategoryName(category)}</h4>
                        
                        {categoryIssues.map((issue, i) => (
                          <div key={i} className="issue-item">
                            <div className="issue-header">
                              <span className="severity-badge" style={{
                                backgroundColor: getSeverityColor(issue.severity),
                              }}>
                                {getSeverityIcon(issue.severity)} {issue.severity}
                              </span>
                              <span className="issue-location">
                                行 {issue.line}:{issue.column}
                              </span>
                            </div>
                            
                            <div className="issue-message">
                              {issue.message}
                            </div>
                            
                            <div className="issue-explanation">
                              <strong>问题:</strong> {issue.explanation}
                            </div>
                            
                            <div className="issue-suggestion">
                              <strong>💡 建议:</strong> {issue.suggestion}
                            </div>
                            
                            {issue.estimatedImpact && (
                              <div className="issue-impact">
                                <strong>影响:</strong> {issue.estimatedImpact}
                              </div>
                            )}
                            
                            {issue.example && (
                              <div className="issue-example">
                                <strong>示例:</strong>
                                <pre><code>{issue.example}</code></pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              
              {/* 内存泄漏风险 */}
              {result.memoryLeakRisks.length > 0 && (
                <div className="memory-risks-section">
                  <h3>🚨 内存泄漏风险 ({result.memoryLeakRisks.length})</h3>
                  
                  {result.memoryLeakRisks.map((risk, i) => (
                    <div key={i} className="risk-item">
                      <div className="risk-header">
                        <span className="risk-type">{risk.type}</span>
                        <span className="risk-location">行 {risk.line}</span>
                      </div>
                      <div className="risk-description">
                        {risk.description}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* 优化建议 */}
              {result.optimizationSuggestions.length > 0 && (
                <div className="suggestions-section">
                  <h3>💡 优化建议</h3>
                  <ul>
                    {result.optimizationSuggestions.map((suggestion, i) => (
                      <li key={i}>{suggestion}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .performance-panel-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        
        .performance-panel {
          background: var(--bg-app);
          border-radius: 8px;
          width: 90%;
          max-width: 1000px;
          max-height: 90vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
        }
        
        .performance-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
        }
        
        .performance-panel-header h2 {
          margin: 0;
          font-family: var(--font-ui);
          font-size: 24px;
          color: var(--fg);
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 32px;
          color: var(--fg-muted);
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: var(--blue);
        }
        
        .performance-panel-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }
        
        .analyze-options {
          background: var(--bg-elevated);
          padding: 20px;
          border-radius: 8px;
          border: 1px solid var(--border);
          margin-bottom: 24px;
        }
        
        .option-group {
          margin-bottom: 16px;
        }
        
        .option-group:last-child {
          margin-bottom: 0;
        }
        
        .option-group label {
          display: block;
          margin-bottom: 8px;
          font-size: 14px;
          font-weight: 500;
          color: var(--fg);
        }
        
        .option-group input,
        .option-group select {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          font-size: 14px;
        }
        
        .analyze-btn {
          width: 100%;
          padding: 12px 24px;
          border: none;
          border-radius: 999px;
          background: var(--blue);
          color: var(--accent-fg);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 16px;
        }
        
        .analyze-btn:hover:not(:disabled) {
          background: var(--blue);
          transform: translateY(-1px);
        }
        
        .analyze-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .error-message {
          background: var(--danger-soft);
          border: 1px solid var(--danger);
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 16px;
          color: var(--danger);
          font-size: 14px;
        }
        
        .performance-result {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 24px;
        }
        
        .score-section {
          display: flex;
          align-items: center;
          gap: 24px;
          padding-bottom: 24px;
          border-bottom: 1px solid var(--border);
          margin-bottom: 24px;
        }
        
        .score-gauge {
          position: relative;
          flex-shrink: 0;
        }
        
        .score-value {
          position: absolute;
          top: 45px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 36px;
          font-weight: bold;
          font-family: var(--font-ui);
        }
        
        .score-info {
          flex: 1;
        }
        
        .score-info h3 {
          margin: 0 0 8px 0;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .score-info p {
          margin: 0;
          color: var(--fg-muted);
        }
        
        .complexity-section,
        .issues-section,
        .memory-risks-section,
        .suggestions-section {
          margin-bottom: 24px;
        }
        
        .complexity-section h3,
        .issues-section h3,
        .memory-risks-section h3,
        .suggestions-section h3 {
          margin: 0 0 16px 0;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .complexity-item {
          background: var(--bg-hover);
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 12px;
        }
        
        .complexity-header {
          margin-bottom: 8px;
          font-weight: 600;
          color: var(--fg);
        }
        
        .complexity-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 4px;
          font-size: 14px;
        }
        
        .complexity-row .label {
          color: var(--fg-muted);
        }
        
        .complexity-row .value {
          font-family: var(--font-mono);
          color: var(--blue);
          font-weight: 500;
        }
        
        .complexity-reason {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--border);
          font-size: 13px;
          color: var(--fg-muted);
          font-style: italic;
        }
        
        .category-group {
          margin-bottom: 24px;
        }
        
        .category-group h4 {
          margin: 0 0 12px 0;
          font-size: 16px;
          color: var(--blue);
          font-weight: 600;
        }
        
        .issue-item,
        .risk-item {
          background: var(--bg-hover);
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 12px;
        }
        
        .issue-header,
        .risk-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        
        .severity-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 12px;
          border-radius: 999px;
          color: var(--accent-fg);
          font-size: 12px;
          font-weight: 500;
          text-transform: uppercase;
        }
        
        .issue-location,
        .risk-location {
          font-size: 12px;
          color: var(--fg-muted);
          font-family: var(--font-mono);
        }
        
        .risk-type {
          display: inline-block;
          padding: 4px 12px;
          border-radius: 999px;
          background: var(--danger-soft);
          color: var(--danger);
          font-size: 12px;
          font-weight: 500;
        }
        
        .issue-message {
          font-weight: 600;
          margin-bottom: 8px;
          color: var(--fg);
        }
        
        .issue-explanation,
        .issue-suggestion,
        .issue-impact,
        .risk-description {
          margin-bottom: 8px;
          font-size: 14px;
          line-height: 1.6;
          color: var(--fg);
        }
        
        .issue-example {
          margin-top: 12px;
        }
        
        .issue-example pre {
          background: var(--fg);
          color: var(--bg-hover);
          padding: 12px;
          border-radius: 4px;
          overflow-x: auto;
          margin-top: 8px;
          font-size: 13px;
        }
        
        .suggestions-section ul {
          margin: 0;
          padding-left: 24px;
        }
        
        .suggestions-section li {
          margin-bottom: 8px;
          color: var(--fg);
          line-height: 1.6;
        }
      `}</style>
    </div>
  );
};
