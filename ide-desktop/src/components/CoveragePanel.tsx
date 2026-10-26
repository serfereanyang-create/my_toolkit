/**
 * CoveragePanel.tsx — 测试覆盖率面板
 * 
 * 桌面端测试覆盖率 UI
 * - 项目覆盖率概览
 * - 文件覆盖率排名
 * - 未覆盖行高亮跳转
 * - 覆盖率门禁状态
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

interface CoveragePanelProps {
  visible: boolean;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}

interface FileCoverage {
  path: string;
  totalLines: number;
  coveredLines: number;
  lineCoverage: number;
  totalBranches: number;
  coveredBranches: number;
  branchCoverage: number;
  totalFunctions: number;
  coveredFunctions: number;
  functionCoverage: number;
  uncoveredLines: number[];
  uncoveredFunctions: Array<{ name: string; line: number }>;
}

interface ProjectCoverage {
  files: FileCoverage[];
  summary: {
    totalFiles: number;
    totalLines: number;
    coveredLines: number;
    lineCoverage: number;
    totalBranches: number;
    coveredBranches: number;
    branchCoverage: number;
    totalFunctions: number;
    coveredFunctions: number;
    functionCoverage: number;
  };
  worstFiles: Array<{ path: string; coverage: number }>;
  uncoveredFiles: string[];
}

export const CoveragePanel: React.FC<CoveragePanelProps> = ({
  visible,
  onClose,
  onOpenFile,
}) => {
  const [loading, setLoading] = useState(false);
  const [coverage, setCoverage] = useState<ProjectCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pattern, setPattern] = useState('src/**/*.{ts,tsx}');
  const [lcovFile, setLcovFile] = useState('');
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [gateThresholds] = useState({ line: 80, branch: 70, func: 80 });
  // Workspace revision guard: flag results as stale once the workspace moves on.
  const { capture, current, stale } = useQualityRevision(visible && !loading);

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await invokeTool('analyze_coverage', {
        pattern,
        lcovFile: lcovFile || undefined,
      }, current?.label);

      if (response.ok) {
        setCoverage(response.data);
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
    if (visible && !coverage) {
      handleAnalyze();
    }
  }, [visible]);
  
  const getCoverageColor = (percent: number) => {
    if (percent >= 80) return 'var(--ok)';
    if (percent >= 60) return 'var(--warn)';
    return 'var(--danger)';
  };
  
  const getCoverageIcon = (percent: number) => {
    if (percent >= 80) return '🟢';
    if (percent >= 60) return '🟡';
    return '🔴';
  };
  
  const renderProgressBar = (percent: number) => (
    <div className="progress-bar">
      <div
        className="progress-fill"
        style={{
          width: `${Math.min(100, percent)}%`,
          backgroundColor: getCoverageColor(percent),
        }}
      />
    </div>
  );
  
  const gateStatus = coverage ? {
    line: coverage.summary.lineCoverage >= gateThresholds.line,
    branch: coverage.summary.branchCoverage >= gateThresholds.branch,
    func: coverage.summary.functionCoverage >= gateThresholds.func,
  } : null;
  
  const allGatesPass = gateStatus && gateStatus.line && gateStatus.branch && gateStatus.func;
  
  if (!visible) return null;
  
  return (
    <div className="coverage-panel-overlay">
      <div className="coverage-panel">
        <div className="coverage-panel-header">
          <h2>测试覆盖率</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        {stale && (
          <div className="quality-stale-banner">
            <span>工作区在分析后已变更，覆盖率结果可能过期。</span>
            <button onClick={handleAnalyze} disabled={loading}>重新分析</button>
          </div>
        )}
        
        <div className="coverage-panel-content">
          {/* 分析选项 */}
          <div className="coverage-options">
            <div className="option-group">
              <label>文件模式:</label>
              <input
                type="text"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="src/**/*.{ts,tsx}"
              />
            </div>
            
            <div className="option-group">
              <label>lcov 报告（可选）:</label>
              <input
                type="text"
                value={lcovFile}
                onChange={(e) => setLcovFile(e.target.value)}
                placeholder="coverage/lcov.info"
              />
            </div>
            
            <button onClick={handleAnalyze} disabled={loading} className="analyze-btn">
              {loading ? '分析中...' : '刷新分析'}
            </button>
          </div>
          
          {/* 错误信息 */}
          {error && (
            <div className="error-message">
              <strong>错误:</strong> {error}
            </div>
          )}
          
          {/* 覆盖率结果 */}
          {coverage && (
            <div className="coverage-result">
              {/* 门禁状态 */}
              <div className={`gate-banner ${allGatesPass ? 'pass' : 'fail'}`}>
                {allGatesPass ? '✅ 覆盖率门禁通过' : '❌ 覆盖率门禁未通过'}
              </div>
              
              {/* 总览指标 */}
              <div className="summary-grid">
                <div className="summary-card">
                  <div className="summary-title">行覆盖率</div>
                  <div className="summary-value" style={{ color: getCoverageColor(coverage.summary.lineCoverage) }}>
                    {coverage.summary.lineCoverage.toFixed(1)}%
                  </div>
                  <div className="summary-detail">
                    {coverage.summary.coveredLines} / {coverage.summary.totalLines} 行
                  </div>
                  {renderProgressBar(coverage.summary.lineCoverage)}
                  <div className="gate-indicator">
                    门禁 ≥ {gateThresholds.line}% {gateStatus?.line ? '✅' : '❌'}
                  </div>
                </div>
                
                <div className="summary-card">
                  <div className="summary-title">分支覆盖率</div>
                  <div className="summary-value" style={{ color: getCoverageColor(coverage.summary.branchCoverage) }}>
                    {coverage.summary.branchCoverage.toFixed(1)}%
                  </div>
                  <div className="summary-detail">
                    {coverage.summary.coveredBranches} / {coverage.summary.totalBranches} 分支
                  </div>
                  {renderProgressBar(coverage.summary.branchCoverage)}
                  <div className="gate-indicator">
                    门禁 ≥ {gateThresholds.branch}% {gateStatus?.branch ? '✅' : '❌'}
                  </div>
                </div>
                
                <div className="summary-card">
                  <div className="summary-title">函数覆盖率</div>
                  <div className="summary-value" style={{ color: getCoverageColor(coverage.summary.functionCoverage) }}>
                    {coverage.summary.functionCoverage.toFixed(1)}%
                  </div>
                  <div className="summary-detail">
                    {coverage.summary.coveredFunctions} / {coverage.summary.totalFunctions} 函数
                  </div>
                  {renderProgressBar(coverage.summary.functionCoverage)}
                  <div className="gate-indicator">
                    门禁 ≥ {gateThresholds.func}% {gateStatus?.func ? '✅' : '❌'}
                  </div>
                </div>
              </div>
              
              {/* 未覆盖文件警告 */}
              {coverage.uncoveredFiles.length > 0 && (
                <div className="uncovered-warning">
                  ⚠️ {coverage.uncoveredFiles.length} 个文件完全没有测试覆盖
                </div>
              )}
              
              {/* 覆盖率最低的文件 */}
              {coverage.worstFiles.length > 0 && (
                <div className="worst-files-section">
                  <h3>需要关注的文件</h3>
                  
                  {coverage.worstFiles.map((file, i) => {
                    const fileDetail = coverage.files.find(f => f.path === file.path);
                    const isExpanded = expandedFile === file.path;
                    
                    return (
                      <div key={i} className="file-coverage-item">
                        <div
                          className="file-coverage-header"
                          onClick={() => setExpandedFile(isExpanded ? null : file.path)}
                        >
                          <span className="file-icon">{getCoverageIcon(file.coverage)}</span>
                          <span className="file-path">{file.path}</span>
                          <span className="file-percent" style={{ color: getCoverageColor(file.coverage) }}>
                            {file.coverage.toFixed(1)}%
                          </span>
                          <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                        </div>
                        
                        {isExpanded && fileDetail && (
                          <div className="file-coverage-detail">
                            <div className="detail-stats">
                              <span>行: {fileDetail.coveredLines}/{fileDetail.totalLines}</span>
                              <span>函数: {fileDetail.coveredFunctions}/{fileDetail.totalFunctions}</span>
                            </div>
                            
                            {fileDetail.uncoveredFunctions.length > 0 && (
                              <div className="uncovered-functions">
                                <strong>未覆盖的函数:</strong>
                                <div className="function-chips">
                                  {fileDetail.uncoveredFunctions.map((func, j) => (
                                    <button
                                      key={j}
                                      className="function-chip"
                                      onClick={() => onOpenFile?.(fileDetail.path, func.line)}
                                    >
                                      {func.name} :{func.line}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {fileDetail.uncoveredLines.length > 0 && (
                              <div className="uncovered-lines">
                                <strong>未覆盖的行 ({fileDetail.uncoveredLines.length}):</strong>
                                <div className="line-chips">
                                  {fileDetail.uncoveredLines.slice(0, 30).map((line, j) => (
                                    <button
                                      key={j}
                                      className="line-chip"
                                      onClick={() => onOpenFile?.(fileDetail.path, line)}
                                    >
                                      {line}
                                    </button>
                                  ))}
                                  {fileDetail.uncoveredLines.length > 30 && (
                                    <span className="more-lines">
                                      +{fileDetail.uncoveredLines.length - 30} 更多
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            <button
                              className="generate-tests-btn"
                              onClick={async () => {
                                await invokeTool('generate_tests', {
                                  file: fileDetail.path,
                                  framework: 'vitest',
                                });
                              }}
                            >
                              🧪 为此文件生成测试
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .coverage-panel-overlay {
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
        
        .coverage-panel {
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
        
        .coverage-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
        }
        
        .coverage-panel-header h2 {
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
        }
        
        .close-btn:hover {
          color: var(--blue);
        }
        
        .coverage-panel-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }
        
        .coverage-options {
          background: var(--bg-elevated);
          padding: 20px;
          border-radius: 8px;
          border: 1px solid var(--border);
          margin-bottom: 24px;
        }
        
        .option-group {
          margin-bottom: 16px;
        }
        
        .option-group label {
          display: block;
          margin-bottom: 8px;
          font-size: 14px;
          font-weight: 500;
          color: var(--fg);
        }
        
        .option-group input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          font-size: 14px;
          font-family: var(--font-mono);
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
        }
        
        .analyze-btn:hover:not(:disabled) {
          background: var(--blue);
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
        }
        
        .gate-banner {
          padding: 16px;
          border-radius: 8px;
          text-align: center;
          font-weight: 600;
          font-size: 16px;
          margin-bottom: 24px;
        }
        
        .gate-banner.pass {
          background: color-mix(in srgb, var(--ok) 12%, transparent);
          color: var(--ok);
        }
        
        .gate-banner.fail {
          background: var(--danger-soft);
          color: var(--danger);
        }
        
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }
        
        .summary-card {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          text-align: center;
        }
        
        .summary-title {
          font-size: 14px;
          color: var(--fg-muted);
          margin-bottom: 8px;
        }
        
        .summary-value {
          font-size: 32px;
          font-weight: bold;
          font-family: var(--font-ui);
          margin-bottom: 4px;
        }
        
        .summary-detail {
          font-size: 12px;
          color: var(--fg-muted);
          margin-bottom: 12px;
        }
        
        .progress-bar {
          height: 8px;
          background: var(--border);
          border-radius: 999px;
          overflow: hidden;
          margin-bottom: 8px;
        }
        
        .progress-fill {
          height: 100%;
          border-radius: 999px;
          transition: width 0.3s;
        }
        
        .gate-indicator {
          font-size: 12px;
          color: var(--fg-muted);
        }
        
        .uncovered-warning {
          background: color-mix(in srgb, var(--warn) 12%, transparent);
          border-left: 3px solid var(--warn);
          padding: 12px 16px;
          margin-bottom: 24px;
          border-radius: 4px;
          font-size: 14px;
        }
        
        .worst-files-section h3 {
          margin: 0 0 16px 0;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .file-coverage-item {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 8px;
          margin-bottom: 8px;
          overflow: hidden;
        }
        
        .file-coverage-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          cursor: pointer;
          transition: background 0.2s;
        }
        
        .file-coverage-header:hover {
          background: var(--bg-hover);
        }
        
        .file-path {
          flex: 1;
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--fg);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        
        .file-percent {
          font-weight: 600;
          font-size: 14px;
        }
        
        .expand-icon {
          color: var(--fg-muted);
          font-size: 12px;
        }
        
        .file-coverage-detail {
          padding: 16px;
          border-top: 1px solid var(--border);
          background: var(--bg-hover);
        }
        
        .detail-stats {
          display: flex;
          gap: 24px;
          font-size: 13px;
          color: var(--fg-muted);
          margin-bottom: 12px;
        }
        
        .uncovered-functions,
        .uncovered-lines {
          margin-bottom: 12px;
          font-size: 13px;
        }
        
        .function-chips,
        .line-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }
        
        .function-chip,
        .line-chip {
          padding: 4px 10px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-elevated);
          font-size: 12px;
          font-family: var(--font-mono);
          cursor: pointer;
          color: var(--blue);
        }
        
        .function-chip:hover,
        .line-chip:hover {
          border-color: var(--blue);
          background: color-mix(in srgb, var(--warn) 8%, var(--bg-elevated));
        }
        
        .more-lines {
          font-size: 12px;
          color: var(--fg-muted);
          align-self: center;
        }
        
        .generate-tests-btn {
          padding: 8px 16px;
          border: 1px solid var(--blue);
          border-radius: 999px;
          background: var(--bg-elevated);
          color: var(--blue);
          font-size: 13px;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .generate-tests-btn:hover {
          background: var(--blue);
          color: var(--accent-fg);
        }
      `}</style>
    </div>
  );
};
