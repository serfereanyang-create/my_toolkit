/**
 * CoveragePanel.tsx — 测试覆盖率面板
 * 
 * 桌面端测试覆盖率 UI
 * - 项目覆盖率概览
 * - 文件覆盖率排名
 * - 未覆盖行高亮跳转
 * - 覆盖率门禁状态
 */

import React, { useId, useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Circle, FileWarning, Gauge, LoaderCircle, X } from 'lucide-react';
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
  onAskAgent?: (prompt: string) => void;
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
  onAskAgent,
}) => {
  const [loading, setLoading] = useState(false);
  const [coverage, setCoverage] = useState<ProjectCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pattern, setPattern] = useState('src/**/*.{ts,tsx}');
  const [lcovFile, setLcovFile] = useState('');
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [gateThresholds] = useState({ line: 80, branch: 70, func: 80 });
  // 输入框的 <label> 只写在旁边、没有 htmlFor：屏幕阅读器读到的是一个没有名字的
  // 文本框（占位符不参与可访问名）。两个输入框各绑一条。
  const uid = useId();
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
  
  // Two ramps off the same thresholds, because a bar fill and a label have
  // different contrast floors. The accents measure 3.00:1 (--warn) to 4.41:1
  // (--ok) on the card surface and 2.70-4.33:1 on the hovered row: fine for the
  // 8px progress fill, under the 4.5:1 body floor for the 14px/600 percentage
  // text that reads them. Every label branch takes its --*-ink twin
  // (--ok-ink 6.26:1, --warn-ink 6.27:1, --danger-ink 6.55:1 on the card,
  // 5.64-5.90:1 once the row is hovered).
  const getCoverageBarColor = (percent: number) => {
    if (percent >= 80) return 'var(--ok)';
    if (percent >= 60) return 'var(--warn)';
    return 'var(--danger)';
  };

  const getCoverageInk = (percent: number) => {
    if (percent >= 80) return 'var(--ok-ink)';
    if (percent >= 60) return 'var(--warn-ink)';
    return 'var(--danger-ink)';
  };
  
  const getCoverageIcon = (percent: number) => {
    if (percent >= 80) return <CheckCircle2 size={14} aria-hidden="true" />;
    if (percent >= 60) return <Circle size={14} aria-hidden="true" />;
    return <AlertCircle size={14} aria-hidden="true" />;
  };
  
  const renderProgressBar = (percent: number) => (
    <div className="progress-bar">
      <div
        className="progress-fill"
        style={{
          width: `${Math.min(100, percent)}%`,
          backgroundColor: getCoverageBarColor(percent),
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
          <button onClick={onClose} className="close-btn" aria-label="关闭覆盖率面板"><X size={16} /></button>
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
              <label htmlFor={`${uid}-pattern`}>文件模式:</label>
              <input
                id={`${uid}-pattern`}
                type="text"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="src/**/*.{ts,tsx}"
              />
            </div>

            <div className="option-group">
              <label htmlFor={`${uid}-lcov`}>lcov 报告（可选）:</label>
              <input
                id={`${uid}-lcov`}
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
          
          {loading && (
            <div className="coverage-loading" role="status" aria-busy="true">
              <LoaderCircle size={18} className="coverage-spin" />正在分析覆盖率…
            </div>
          )}
          {/* 错误信息 */}
          {error && (
            <div className="error-message" role="alert">
              <AlertCircle size={16} />
              <span><strong>分析失败：</strong>{error}</span>
              <button type="button" onClick={handleAnalyze}>重试</button>
            </div>
          )}
          {!loading && !error && !coverage && (
            <div className="coverage-empty" role="status">
              <Gauge size={22} />
              <strong>还没有覆盖率数据</strong>
              <span>设好文件模式后点「刷新分析」，或指定 lcov 报告直接读取已有结果。</span>
            </div>
          )}

          {/* 覆盖率结果 */}
          {coverage && (
            <div className="coverage-result">
              {/* 门禁状态 */}
              <div className={`gate-banner ${allGatesPass ? 'pass' : 'fail'}`}>
                {allGatesPass ? <><CheckCircle2 size={15} />覆盖率门禁通过</> : <><AlertCircle size={15} />覆盖率门禁未通过</>}
              </div>
              
              {/* 总览指标 */}
              <div className="summary-grid">
                <div className="summary-card">
                  <div className="summary-title">行覆盖率</div>
                  <div className="summary-value" style={{ color: getCoverageInk(coverage.summary.lineCoverage) }}>
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
                  <div className="summary-value" style={{ color: getCoverageInk(coverage.summary.branchCoverage) }}>
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
                  <div className="summary-value" style={{ color: getCoverageInk(coverage.summary.functionCoverage) }}>
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
                  <FileWarning size={15} />{coverage.uncoveredFiles.length} 个文件完全没有测试覆盖
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
                          <span className="file-percent" style={{ color: getCoverageInk(file.coverage) }}>
                            {file.coverage.toFixed(1)}%
                          </span>
                          <span className="expand-icon">{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
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
                              type="button"
                              className="generate-tests-btn"
                              disabled={!onAskAgent}
                              onClick={() => onAskAgent?.(`请为工作区文件 ${fileDetail.path} 生成 Vitest 测试，优先覆盖当前报告中的未覆盖函数和未覆盖行。先检查现有测试结构，展示将要新增或修改的文件，并在写入前请求确认。`)}
                            >
                              交给智能体生成测试
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
        
        .option-group input {
          width: 100%;
          padding: 10px 12px;
          /* 输入框是白底、卡片也是白底，边框就是它唯一的识别边界，1.4.11 要 3:1。
             --border（10%）实测 1.24:1、--border-strong（15%）只有 1.37:1，所以
             这里取 --fg 60%：浅色 #777 / 深色 #8c8c8c 一档，实测 3.9–5.1:1，
             粗细仍是 1px。 */
          border: 1px solid color-mix(in srgb, var(--fg) 60%, transparent);
          border-radius: 6px;
          font-size: var(--fs-5);
          font-family: var(--font-mono);
        }
        
        .analyze-btn {
          width: 100%;
          padding: 12px 24px;
          border: none;
          color: var(--accent-fg);
          font-size: var(--fs-5);
          font-weight: 500;
          cursor: pointer;
        }

        .analyze-btn:disabled {
          cursor: not-allowed;
        }
        
        .coverage-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 72px;
          margin-bottom: 16px;
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--fg-muted);
          background: var(--bg-elevated);
        }
        .coverage-spin { animation: coverage-spin 900ms linear infinite; }
        @keyframes coverage-spin { to { transform: rotate(360deg); } }
        .coverage-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 96px;
          margin-bottom: 16px;
          padding: 24px 16px;
          border: 1px dashed var(--border);
          border-radius: 8px;
          color: var(--fg-muted);
          background: var(--bg-elevated);
          text-align: center;
        }
        .coverage-empty svg { color: var(--fg-dim); }
        .coverage-empty strong { color: var(--fg); font-size: var(--fs-5); }
        .coverage-empty span { max-width: 360px; font-size: var(--fs-4); line-height: 1.6; }
        .error-message {
          display: flex;
          align-items: center;
          gap: 8px;
          background: var(--danger-soft);
          border: 1px solid var(--danger);
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 16px;
          color: var(--danger-ink);
        }
        .error-message > span { flex: 1; min-width: 0; }
        
        .gate-banner {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 16px;
          border-radius: 8px;
          text-align: center;
          font-weight: 600;
          font-size: var(--fs-7);
          margin-bottom: 24px;
        }
        
        .gate-banner.pass {
          background: color-mix(in srgb, var(--ok) 12%, transparent);
          color: var(--ok-ink);
        }
        
        .gate-banner.fail {
          background: var(--danger-soft);
          color: var(--danger-ink);
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
          font-size: var(--fs-5);
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
          font-size: var(--fs-3);
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
          font-size: var(--fs-3);
          color: var(--fg-muted);
        }
        
        .uncovered-warning {
          display: flex;
          align-items: center;
          gap: 7px;
          background: color-mix(in srgb, var(--warn) 12%, transparent);
          border-left: 3px solid var(--warn);
          padding: 12px 16px;
          margin-bottom: 24px;
          border-radius: 4px;
          font-size: var(--fs-5);
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
          font-size: var(--fs-4);
          color: var(--fg);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        
        .file-percent {
          font-weight: 600;
          font-size: var(--fs-5);
        }
        
        .expand-icon {
          color: var(--fg-muted);
          font-size: var(--fs-3);
        }
        
        .file-coverage-detail {
          padding: 16px;
          border-top: 1px solid var(--border);
          background: var(--bg-hover);
        }
        
        .detail-stats {
          display: flex;
          gap: 24px;
          font-size: var(--fs-4);
          color: var(--fg-muted);
          margin-bottom: 12px;
        }
        
        .uncovered-functions,
        .uncovered-lines {
          margin-bottom: 12px;
          font-size: var(--fs-4);
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
          font-size: var(--fs-3);
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
          font-size: var(--fs-3);
          color: var(--fg-muted);
          align-self: center;
        }
        
        .generate-tests-btn {
          padding: 8px 16px;
          border: 1px solid var(--blue);
          border-radius: 999px;
          background: var(--bg-elevated);
          color: var(--blue);
          font-size: var(--fs-4);
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
