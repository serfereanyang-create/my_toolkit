/**
 * CodeReviewPanel.tsx — 代码审查面板
 * 
 * 桌面端 AI 代码审查 UI
 * - 显示审查结果
 * - 按严重级别分类
 * - 静态分析集成
 * - 一键修复建议
 */

import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, BarChart3, CheckCircle2, Lightbulb, ListChecks, LoaderCircle, X } from 'lucide-react';
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
  onOpenFile?: (path: string, line?: number) => void;
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
  onOpenFile,
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
  const requestIdRef = useRef(0);
  
  const handleReview = async () => {
    if (!file && !code) return;
    const requestId = ++requestIdRef.current;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await invokeTool('review_code', {
        file,
        code,
        categories: selectedCategories,
        includeStaticAnalysis,
      });
      
      if (requestId !== requestIdRef.current) return;
      if (response.ok) {
        setResult(response.data);
      } else {
        setError(response.output);
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };
  
  useEffect(() => {
    if (!visible) {
      requestIdRef.current += 1;
      setLoading(false);
      return;
    }
    setResult(null);
    setError(null);
    if (file || code) void handleReview();
    return () => { requestIdRef.current += 1; };
  }, [visible, file, code]);
  
  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical': return <AlertCircle size={13} aria-hidden="true" />;
      case 'error': return <AlertCircle size={13} aria-hidden="true" />;
      case 'warning': return <AlertCircle size={13} aria-hidden="true" />;
      case 'info': return <ListChecks size={13} aria-hidden="true" />;
      default: return <AlertCircle size={13} aria-hidden="true" />;
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

  /* 徽章文字是 --accent-fg（浅色白、深色近黑）。--danger 和 --blue 都够深，
     白字有 4.8 / 5.9:1；--warn（#e07b00）上的白字只有 3.00:1，AA 要 4.5 —
     橙色压不到 4.5 又不发褐（见 styles.css 里 --warn-edge 的注释），所以这一档
     直接用深色主题原本就在用的黑（--accent-fg 在深色下就是 #000）：橙底在两个
     主题里都够亮，实测 7.0 / 8.9:1，深色主题的观感完全不变。 */
  const getSeverityInk = (severity: string) => (severity === 'warning' ? '#000' : undefined);
  
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
          <button onClick={onClose} className="close-btn" aria-label="关闭代码审查"><X size={16} /></button>
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
          
          {!file && !code && !loading && !error && (
            <div className="review-empty" role="status">
              <ListChecks size={22} />
              <strong>还没有审查对象</strong>
              <span>请先从编辑器选择文件，或打开一个代码文件后再开始审查。</span>
            </div>
          )}
          {loading && (
            <div className="review-loading" role="status" aria-busy="true">
              <LoaderCircle size={18} className="review-spin" />正在分析代码…
            </div>
          )}
          {/* 错误信息 */}
          {error && (
            <div className="error-message" role="alert">
              <AlertCircle size={16} />
              <span><strong>审查失败：</strong>{error}</span>
              <button type="button" onClick={handleReview}>重试</button>
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
                  <h3><CheckCircle2 size={15} /> 优点</h3>
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
                  <h3><AlertCircle size={15} /> 需要改进</h3>
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
                  <h3><ListChecks size={15} /> 具体问题 ({result.comments.length})</h3>
                  
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
                                color: getSeverityInk(comment.severity),
                              }}>
                                {getSeverityIcon(comment.severity)} {comment.severity}
                              </span>
                              <button
                                type="button"
                                className="comment-line comment-line-button"
                                onClick={() => file && onOpenFile?.(file, comment.line)}
                                disabled={!file || !onOpenFile}
                                title={file && onOpenFile ? '打开对应代码行' : '当前没有可定位的文件'}
                              >
                                行 {comment.line}
                              </button>
                            </div>
                            
                            <div className="comment-message">
                              {comment.message}
                            </div>
                            
                            {comment.suggestion && (
                              <div className="comment-suggestion">
                                <strong><Lightbulb size={14} /> 建议：</strong> {comment.suggestion}
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
                  <h3><BarChart3 size={15} /> 静态分析</h3>
                  
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
                        <span>严重：</span>
                        <span>{result.staticAnalysis.smells.severityCounts?.critical || 0}</span>
                      </div>
                      <div className="stat-row">
                        <span>重要：</span>
                        <span>{result.staticAnalysis.smells.severityCounts?.major || 0}</span>
                      </div>
                      <div className="stat-row">
                        <span>次要：</span>
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
        .category-checkboxes {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }
        
        .checkbox-label {
          display: flex;
          align-items: center;
          font-size: var(--fs-5);
          color: var(--fg);
          cursor: pointer;
        }
        
        .checkbox-label input[type="checkbox"] {
          margin-right: 8px;
        }

        .close-btn {
          background: none;
          border: none;
          font-size: 32px;
          color: var(--fg-muted);
          cursor: pointer;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .close-btn:hover {
          color: var(--blue);
        }

        .review-btn {
          width: 100%;
          padding: 12px 24px;
          border: none;
          color: var(--accent-fg);
          font-size: var(--fs-5);
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 16px;
        }

        .review-btn:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .review-btn:disabled {
          cursor: not-allowed;
        }
        
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
          font-size: var(--fs-5);
        }
        
        .error-message > span { flex: 1; min-width: 0; }
        .review-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 180px;
          padding: 24px;
          border: 1px dashed var(--border);
          border-radius: 8px;
          color: var(--fg-muted);
          text-align: center;
        }
        .review-loading { flex-direction: row; min-height: 80px; border-style: solid; background: var(--bg-elevated); }
        .review-spin { animation: code-review-spin 900ms linear infinite; }
        @keyframes code-review-spin { to { transform: rotate(360deg); } }
        .review-result {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 24px;
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
          font-size: var(--fs-5);
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
          display: flex;
          align-items: center;
          gap: 7px;
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
        
        
        .comment-line {
          font-size: var(--fs-3);
          color: var(--fg-muted);
          font-family: var(--font-mono);
        }

        .comment-line-button {
          border: 0;
          padding: 0;
          background: transparent;
          cursor: pointer;
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        .comment-line-button:hover:not(:disabled) { color: var(--accent); }
        .comment-line-button:disabled { cursor: default; text-decoration: none; }
        
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
          font-size: var(--fs-5);
        }
        
        .comment-example {
          margin-top: 8px;
        }
        
        .comment-example pre {
          /* 反色代码块：底用 --fg，字必须是背景那一档的实色。原先写的是
             --bg-hover（5% 覆盖色），浅色主题等于深底上 5% 黑字，实测 1.02:1。 */
          background: var(--fg);
          color: var(--bg-app);
          padding: 12px;
          border-radius: 4px;
          overflow-x: auto;
          margin-top: 8px;
          font-size: var(--fs-4);
        }
        
        .analysis-group {
          background: var(--bg-hover);
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        
        .analysis-group h4 {
          margin: 0 0 12px 0;
          font-size: var(--fs-5);
          font-weight: 600;
          color: var(--fg);
        }
        
        .stat-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: var(--fs-5);
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
