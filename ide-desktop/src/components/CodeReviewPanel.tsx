/**
 * CodeReviewPanel.tsx — 代码审查面板
 * 
 * 桌面端 AI 代码审查 UI
 * - 显示审查结果
 * - 按严重级别分类
 * - 静态分析集成
 * - 一键修复建议
 */

import React, { useState, useEffect } from 'react';
import { desktop } from '../lib/ipc';

/**
 * 质量工具网关：read-only 分析工具经由主进程 allowlist 调用 CLI 无头模式。
 * write 风险工具（生成测试、重构应用）会被网关与 CLI 双侧拒绝。
 */
async function invokeTool(name: string, input: unknown): Promise<{ ok: boolean; data: any; output: any }> {
  const result = await desktop.quality.invoke(name, (input ?? {}) as Record<string, unknown>);
  if (!result.ok && result.error) throw new Error(result.error);
  return { ok: Boolean(result.ok), data: result.data, output: result.output };
}

interface CodeReviewPanelProps {
  visible: boolean;
  onClose: () => void;
  file?: string;
  code?: string;
}

interface ReviewComment {
  category: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  line: number;
  message: string;
  suggestion?: string;
  example?: string;
}

interface ReviewResult {
  score: number;
  summary: string;
  comments: ReviewComment[];
  strengths: string[];
  improvements: string[];
  staticAnalysis?: any;
}

export const CodeReviewPanel: React.FC<CodeReviewPanelProps> = ({
  visible,
  onClose,
  file,
  code,
}) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([
    'security',
    'performance',
    'maintainability',
    'correctness',
    'style',
    'best-practice',
  ]);
  const [includeStaticAnalysis, setIncludeStaticAnalysis] = useState(true);
  
  const handleReview = async () => {
    if (!file && !code) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await invokeTool('review_code', {
        file,
        code,
        categories: selectedCategories,
        includeStaticAnalysis,
      });
      
      if (response.ok) {
        setResult(response.data);
      } else {
        setError(response.output);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    if (visible && (file || code)) {
      handleReview();
    }
  }, [visible, file, code]);
  
  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical': return '🔴';
      case 'error': return '🟠';
      case 'warning': return '🟡';
      case 'info': return 'ℹ️';
      default: return '•';
    }
  };
  
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'var(--danger)';
      case 'error': return 'var(--danger)';
      case 'warning': return 'var(--warn)';
      case 'info': return 'var(--blue)';
      default: return 'var(--fg-muted)';
    }
  };
  
  const getCategoryName = (category: string) => {
    const names: Record<string, string> = {
      security: '安全性',
      performance: '性能',
      maintainability: '可维护性',
      correctness: '正确性',
      style: '代码风格',
      'best-practice': '最佳实践',
    };
    return names[category] || category;
  };
  
  if (!visible) return null;
  
  return (
    <div className="code-review-panel-overlay">
      <div className="code-review-panel">
        <div className="code-review-panel-header">
          <h2>AI 代码审查</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="code-review-panel-content">
          {/* 配置选项 */}
          <div className="review-options">
            <div className="option-group">
              <label>审查类别:</label>
              <div className="category-checkboxes">
                {['security', 'performance', 'maintainability', 'correctness', 'style', 'best-practice'].map(cat => (
                  <label key={cat} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedCategories.includes(cat)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedCategories([...selectedCategories, cat]);
                        } else {
                          setSelectedCategories(selectedCategories.filter(c => c !== cat));
                        }
                      }}
                    />
                    {getCategoryName(cat)}
                  </label>
                ))}
              </div>
            </div>
            
            <div className="option-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={includeStaticAnalysis}
                  onChange={(e) => setIncludeStaticAnalysis(e.target.checked)}
                />
                包含静态分析
              </label>
            </div>
            
            <button onClick={handleReview} disabled={loading} className="review-btn">
              {loading ? '审查中...' : '开始审查'}
            </button>
          </div>
          
          {/* 错误信息 */}
          {error && (
            <div className="error-message">
              <strong>错误:</strong> {error}
            </div>
          )}
          
          {/* 审查结果 */}
          {result && (
            <div className="review-result">
              {/* 评分 */}
              <div className="score-section">
                <div className="score-circle" style={{
                  background: `conic-gradient(var(--blue) ${result.score * 3.6}deg, var(--border) 0deg)`
                }}>
                  <div className="score-inner">
                    <span className="score-value">{result.score}</span>
                    <span className="score-label">/ 100</span>
                  </div>
                </div>
                <div className="score-summary">
                  <h3>整体评价</h3>
                  <p>{result.summary}</p>
                </div>
              </div>
              
              {/* 优点 */}
              {result.strengths.length > 0 && (
                <div className="strengths-section">
                  <h3>✅ 优点</h3>
                  <ul>
                    {result.strengths.map((strength, i) => (
                      <li key={i}>{strength}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* 需要改进 */}
              {result.improvements.length > 0 && (
                <div className="improvements-section">
                  <h3>🔧 需要改进</h3>
                  <ul>
                    {result.improvements.map((improvement, i) => (
                      <li key={i}>{improvement}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* 具体问题 */}
              {result.comments.length > 0 && (
                <div className="comments-section">
                  <h3>📝 具体问题 ({result.comments.length})</h3>
                  
                  {/* 按类别分组 */}
                  {Array.from(new Set(result.comments.map(c => c.category))).map(category => {
                    const categoryComments = result.comments.filter(c => c.category === category);
                    
                    return (
                      <div key={category} className="category-group">
                        <h4>{getCategoryName(category)}</h4>
                        
                        {categoryComments.map((comment, i) => (
                          <div key={i} className="comment-item">
                            <div className="comment-header">
                              <span className="severity-badge" style={{
                                backgroundColor: getSeverityColor(comment.severity),
                              }}>
                                {getSeverityIcon(comment.severity)} {comment.severity}
                              </span>
                              <span className="comment-line">行 {comment.line}</span>
                            </div>
                            
                            <div className="comment-message">
                              {comment.message}
                            </div>
                            
                            {comment.suggestion && (
                              <div className="comment-suggestion">
                                <strong>💡 建议:</strong> {comment.suggestion}
                              </div>
                            )}
                            
                            {comment.example && (
                              <div className="comment-example">
                                <strong>示例:</strong>
                                <pre><code>{comment.example}</code></pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              
              {/* 静态分析摘要 */}
              {result.staticAnalysis && (
                <div className="static-analysis-section">
                  <h3>📊 静态分析</h3>
                  
                  {result.staticAnalysis.complexity && (
                    <div className="analysis-group">
                      <h4>复杂度</h4>
                      <div className="stat-row">
                        <span>平均圈复杂度:</span>
                        <span>{result.staticAnalysis.complexity.averageCyclomatic?.toFixed(2)}</span>
                      </div>
                      <div className="stat-row">
                        <span>平均认知复杂度:</span>
                        <span>{result.staticAnalysis.complexity.averageCognitive?.toFixed(2)}</span>
                      </div>
                      <div className="stat-row">
                        <span>高风险函数:</span>
                        <span>{result.staticAnalysis.complexity.highRiskCount || 0} 个</span>
                      </div>
                    </div>
                  )}
                  
                  {result.staticAnalysis.smells && (
                    <div className="analysis-group">
                      <h4>代码异味</h4>
                      <div className="stat-row">
                        <span>Critical:</span>
                        <span>{result.staticAnalysis.smells.severityCounts?.critical || 0}</span>
                      </div>
                      <div className="stat-row">
                        <span>Major:</span>
                        <span>{result.staticAnalysis.smells.severityCounts?.major || 0}</span>
                      </div>
                      <div className="stat-row">
                        <span>Minor:</span>
                        <span>{result.staticAnalysis.smells.severityCounts?.minor || 0}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .code-review-panel-overlay {
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
        
        .code-review-panel {
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
        
        .code-review-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
        }
        
        .code-review-panel-header h2 {
          margin: 0;
          font-family: var(--font-ui);
          font-size: 24px;
          color: var(--fg);
        }
        
        .code-review-panel-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }
        
        .review-options {
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
        
        .option-group > label {
          display: block;
          margin-bottom: 8px;
          font-size: 14px;
          font-weight: 500;
          color: var(--fg);
        }
        
        .category-checkboxes {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }
        
        .checkbox-label {
          display: flex;
          align-items: center;
          font-size: 14px;
          color: var(--fg);
          cursor: pointer;
        }
        
        .checkbox-label input[type="checkbox"] {
          margin-right: 8px;
        }
        
        .review-btn {
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
        
        .review-btn:hover:not(:disabled) {
          background: var(--blue);
          transform: translateY(-1px);
        }
        
        .review-btn:disabled {
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
        
        .review-result {
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
        
        .score-circle {
          width: 120px;
          height: 120px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        
        .score-inner {
          width: 100px;
          height: 100px;
          border-radius: 50%;
          background: var(--bg-elevated);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
        }
        
        .score-value {
          font-size: 36px;
          font-weight: bold;
          color: var(--blue);
          font-family: var(--font-ui);
        }
        
        .score-label {
          font-size: 14px;
          color: var(--fg-muted);
        }
        
        .score-summary {
          flex: 1;
        }
        
        .score-summary h3 {
          margin: 0 0 8px 0;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .score-summary p {
          margin: 0;
          color: var(--fg-muted);
          line-height: 1.6;
        }
        
        .strengths-section,
        .improvements-section,
        .comments-section,
        .static-analysis-section {
          margin-bottom: 24px;
        }
        
        .strengths-section h3,
        .improvements-section h3,
        .comments-section h3,
        .static-analysis-section h3 {
          margin: 0 0 12px 0;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .strengths-section ul,
        .improvements-section ul {
          margin: 0;
          padding-left: 24px;
        }
        
        .strengths-section li,
        .improvements-section li {
          margin-bottom: 8px;
          color: var(--fg);
          line-height: 1.6;
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
        
        .comment-item {
          background: var(--bg-hover);
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 12px;
        }
        
        .comment-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
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
        
        .comment-line {
          font-size: 12px;
          color: var(--fg-muted);
          font-family: var(--font-mono);
        }
        
        .comment-message {
          color: var(--fg);
          line-height: 1.6;
          margin-bottom: 8px;
        }
        
        .comment-suggestion {
          background: var(--bg-elevated);
          padding: 12px;
          border-radius: 4px;
          border-left: 3px solid var(--blue);
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .comment-example {
          margin-top: 8px;
        }
        
        .comment-example pre {
          background: var(--fg);
          color: var(--bg-hover);
          padding: 12px;
          border-radius: 4px;
          overflow-x: auto;
          margin-top: 8px;
          font-size: 13px;
        }
        
        .analysis-group {
          background: var(--bg-hover);
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        
        .analysis-group h4 {
          margin: 0 0 12px 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--fg);
        }
        
        .stat-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .stat-row:last-child {
          margin-bottom: 0;
        }
        
        .stat-row span:first-child {
          color: var(--fg-muted);
        }
        
        .stat-row span:last-child {
          color: var(--fg);
          font-weight: 500;
          font-family: var(--font-mono);
        }
      `}</style>
    </div>
  );
};
