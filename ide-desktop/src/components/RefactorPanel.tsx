/**
 * RefactorPanel.tsx — 重构预览面板
 * 
 * 桌面端重构工具 UI
 * - Extract Method 预览
 * - Rename Symbol 预览
 * - 代码 Diff 展示
 * - 一键应用
 */

import React, { useId, useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, GitBranch, LoaderCircle, X } from 'lucide-react';
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

/** 对齐 cli/src/refactor/extract-method.ts 的请求/结果形状（桌面 tsconfig 不含 cli 源码，本地声明）。 */
interface ExtractMethodOptions {
  methodName: string;
  startLine: number;
  endLine: number;
  useArrowFunction?: boolean;
  addTypeAnnotations?: boolean;
}
/** 对齐 cli/src/refactor/rename.ts 的请求/结果形状。 */
interface RenameOptions {
  file: string;
  line: number;
  column: number;
  newName: string;
  updateStringLiterals?: boolean;
}
interface RefactorPanelProps {
  visible: boolean;
  onClose: () => void;
  selectedCode?: {
    file: string;
    startLine: number;
    endLine: number;
    startColumn?: number;
    content: string;
  };
  onAskAgent?: (prompt: string) => void;
}

type RefactorType = 'extract-method' | 'rename' | null;

export const RefactorPanel: React.FC<RefactorPanelProps> = ({
  visible,
  onClose,
  selectedCode,
  onAskAgent,
}) => {
  const [refactorType, setRefactorType] = useState<RefactorType>(null);
  // 表单里的 <label> 一直没有 htmlFor，输入框对屏幕阅读器是无名控件；
  // 光标位置的两个数字框共用一个 label，只能给各自一条 aria-label。
  const uid = useId();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Extract Method 表单
  const [methodName, setMethodName] = useState('extractedMethod');
  const [useArrowFunction, setUseArrowFunction] = useState(false);
  const [addTypeAnnotations, setAddTypeAnnotations] = useState(true);
  
  // Rename 表单
  const [newName, setNewName] = useState('');
  const [cursorPosition, setCursorPosition] = useState<{ line: number; column: number } | null>(null);
  
  const selectionKey = selectedCode
    ? `${selectedCode.file}:${selectedCode.startLine}:${selectedCode.endLine}:${selectedCode.startColumn ?? 1}`
    : '';

  useEffect(() => {
    if (!visible) return;
    setResult(null);
    setError(null);
    if (!selectedCode) {
      setRefactorType(null);
      setCursorPosition(null);
      return;
    }
    if (selectedCode.startLine !== selectedCode.endLine) {
      setRefactorType('extract-method');
      setCursorPosition(null);
    } else {
      setRefactorType('rename');
      setCursorPosition({ line: selectedCode.startLine, column: selectedCode.startColumn ?? 1 });
    }
  }, [visible, selectionKey]);
  
  const handleExtractMethod = async () => {
    if (!selectedCode) return;
    
    setLoading(true);
    setError(null);
    setResult(null);
    
    try {
      const options: ExtractMethodOptions = {
        methodName,
        startLine: selectedCode.startLine,
        endLine: selectedCode.endLine,
        useArrowFunction,
        addTypeAnnotations,
      };
      
      // 调用 CLI 工具
      const response = await invokeTool('refactor_preview', {
        file: selectedCode.file,
        operations: [{ type: 'extract', name: options.methodName, ...options }],
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
  
  const handleRename = async () => {
    if (!selectedCode || !cursorPosition) return;
    
    setLoading(true);
    setError(null);
    setResult(null);
    
    try {
      const options: RenameOptions = {
        file: selectedCode.file,
        line: cursorPosition.line,
        column: cursorPosition.column,
        newName,
      };
      
      const response = await invokeTool('refactor_preview', {
        ...options,
        operations: [{ type: 'rename', ...options }],
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
  
  const handleAskAgent = () => {
    if (!result || !selectedCode || !onAskAgent) return;
    const prompt = refactorType === 'extract-method'
      ? `请在工作区文件 ${selectedCode.file} 中应用刚才的 Extract Method 预览：第 ${selectedCode.startLine}-${selectedCode.endLine} 行提取为 ${methodName}，使用${useArrowFunction ? '箭头函数' : '普通函数'}，${addTypeAnnotations ? '添加' : '不添加'}类型注解。先展示变更并请求确认。`
      : `请在工作区文件 ${selectedCode.file} 中应用刚才的 Rename Symbol 预览：第 ${cursorPosition?.line ?? selectedCode.startLine} 行第 ${cursorPosition?.column ?? 1} 列改名为 ${newName}。先展示变更并请求确认。`;
    onAskAgent(prompt);
    onClose();
  };
  
  if (!visible) return null;
  
  return (
    <div className="refactor-panel-overlay">
      <div className="refactor-panel">
        <div className="refactor-panel-header">
          <h2>代码重构</h2>
          <button onClick={onClose} className="close-btn" aria-label="关闭重构面板"><X size={16} /></button>
        </div>
        
        <div className="refactor-panel-content">
          {!selectedCode && !loading && !error && (
            <div className="refactor-empty" role="status">
              <GitBranch size={22} />
              <strong>还没有选中的代码</strong>
              <span>请先在编辑器中选择代码，或定位到要重命名的符号。</span>
            </div>
          )}
          {loading && (
            <div className="refactor-loading" role="status" aria-busy="true">
              <LoaderCircle size={18} className="refactor-spin" />正在生成重构预览…
            </div>
          )}
          {/* 重构类型选择 */}
          <div className="refactor-type-selector">
            <button
              type="button"
              className={refactorType === 'extract-method' ? 'active' : ''}
              onClick={() => setRefactorType('extract-method')}
              disabled={!selectedCode || selectedCode.startLine === selectedCode.endLine}
            >
              提取方法
            </button>
            <button
              type="button"
              className={refactorType === 'rename' ? 'active' : ''}
              onClick={() => setRefactorType('rename')}
            >
              重命名符号
            </button>
          </div>
          
          {/* Extract Method 表单 */}
          {refactorType === 'extract-method' && (
            <div className="refactor-form">
              <div className="form-group">
                <label htmlFor={`${uid}-method-name`}>方法名称</label>
                <input
                  id={`${uid}-method-name`}
                  type="text"
                  value={methodName}
                  onChange={(e) => setMethodName(e.target.value)}
                  placeholder="extractedMethod"
                />
              </div>
              
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={useArrowFunction}
                    onChange={(e) => setUseArrowFunction(e.target.checked)}
                  />
                  使用箭头函数
                </label>
              </div>
              
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={addTypeAnnotations}
                    onChange={(e) => setAddTypeAnnotations(e.target.checked)}
                  />
                  添加类型注解
                </label>
              </div>
              
              <button
                onClick={handleExtractMethod}
                disabled={loading || !methodName}
                className="preview-btn"
              >
                {loading ? '分析中...' : '预览重构'}
              </button>
            </div>
          )}
          
          {/* Rename 表单 */}
          {refactorType === 'rename' && (
            <div className="refactor-form">
              <div className="form-group">
                <label htmlFor={`${uid}-new-name`}>新名称</label>
                <input
                  id={`${uid}-new-name`}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="newSymbolName"
                />
              </div>
              
              <div className="form-group">
                <label>光标位置</label>
                <div className="cursor-position">
                  <input
                    type="number"
                    aria-label="光标位置·行号"
                    value={cursorPosition?.line || ''}
                    onChange={(e) => setCursorPosition({
                      line: parseInt(e.target.value),
                      column: cursorPosition?.column || 1,
                    })}
                    placeholder="行号"
                  />
                  <input
                    type="number"
                    aria-label="光标位置·列号"
                    value={cursorPosition?.column || ''}
                    onChange={(e) => setCursorPosition({
                      line: cursorPosition?.line || 1,
                      column: parseInt(e.target.value),
                    })}
                    placeholder="列号"
                  />
                </div>
              </div>
              
              <button
                onClick={handleRename}
                disabled={loading || !newName || !cursorPosition}
                className="preview-btn"
              >
                {loading ? '分析中...' : '预览重构'}
              </button>
            </div>
          )}
          
          {/* 错误信息 */}
          {error && (
            <div className="error-message" role="alert">
              <AlertCircle size={16} />
              <span><strong>重构失败：</strong>{error}</span>
              <button type="button" onClick={refactorType === 'rename' ? handleRename : handleExtractMethod}>重试</button>
            </div>
          )}
          
          {/* 预览结果 */}
          {result && refactorType === 'extract-method' && (
            <div className="refactor-preview">
              <h3>重构预览</h3>
              
              {/* 变量分析 */}
              <div className="variable-analysis">
                <h4>变量分析</h4>
                <div className="analysis-row">
                  <span className="label">输入参数:</span>
                  <span className="value">
                    {result.result.variableAnalysis.inputs.join(', ') || '无'}
                  </span>
                </div>
                <div className="analysis-row">
                  <span className="label">返回值:</span>
                  <span className="value">
                    {result.result.variableAnalysis.outputs.join(', ') || '无'}
                  </span>
                </div>
                <div className="analysis-row">
                  <span className="label">内部变量:</span>
                  <span className="value">
                    {result.result.variableAnalysis.internal.join(', ') || '无'}
                  </span>
                </div>
              </div>
              
              {/* 安全性 */}
              <div className={`safety-indicator ${result.result.isSafe ? 'safe' : 'unsafe'}`}>
                {result.result.isSafe ? <><CheckCircle2 size={15} />重构安全</> : <><AlertCircle size={15} />重构不安全</>}
              </div>
              
              {/* 警告 */}
              {result.result.warnings.length > 0 && (
                <div className="warnings">
                  <h4>警告</h4>
                  <ul>
                    {result.result.warnings.map((warning: string, i: number) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* 代码预览 */}
              <div className="code-preview">
                <h4>提取的方法</h4>
                <pre><code>{result.result.extractedMethod}</code></pre>
                
                <h4>调用代码</h4>
                <pre><code>{result.result.callSite}</code></pre>
              </div>
              
              {/* 应用按钮 */}
              {result.result.isSafe && (
                <button type="button" onClick={handleAskAgent} className="apply-btn" disabled={loading || !onAskAgent}>
                  交给智能体应用
                </button>
              )}
            </div>
          )}
          
          {/* Rename 预览结果 */}
          {result && refactorType === 'rename' && (
            <div className="refactor-preview">
              <h3>重命名预览</h3>
              
              <div className="rename-summary">
                <div className="summary-row">
                  <span className="label">旧名称:</span>
                  <span className="value">{result.oldName}</span>
                </div>
                <div className="summary-row">
                  <span className="label">新名称:</span>
                  <span className="value">{result.newName}</span>
                </div>
                <div className="summary-row">
                  <span className="label">影响文件:</span>
                  <span className="value">{result.files.length} 个</span>
                </div>
                <div className="summary-row">
                  <span className="label">替换次数:</span>
                  <span className="value">{result.totalReplacements} 处</span>
                </div>
              </div>
              
              {/* 安全性 */}
              <div className={`safety-indicator ${result.isSafe ? 'safe' : 'unsafe'}`}>
                {result.isSafe ? <><CheckCircle2 size={15} />重命名安全</> : <><AlertCircle size={15} />重命名不安全</>}
              </div>
              
              {/* 错误 */}
              {result.errors.length > 0 && (
                <div className="errors">
                  <h4>错误</h4>
                  <ul>
                    {result.errors.map((error: string, i: number) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* 警告 */}
              {result.warnings.length > 0 && (
                <div className="warnings">
                  <h4>警告</h4>
                  <ul>
                    {result.warnings.map((warning: string, i: number) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* 文件变更列表 */}
              <div className="file-changes">
                <h4>文件变更</h4>
                {result.files.map((file: any, i: number) => (
                  <div key={i} className="file-change">
                    <div className="file-path">
                      {file.path} ({file.replacementCount} 处替换)
                    </div>
                    <div className="replacements">
                      {file.replacements.slice(0, 5).map((replacement: any, j: number) => (
                        <div key={j} className="replacement">
                          行 {replacement.line}: {replacement.oldText} → {replacement.newText}
                        </div>
                      ))}
                      {file.replacements.length > 5 && (
                        <div className="more">... 还有 {file.replacements.length - 5} 处</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              
              {/* 应用按钮 */}
              {result.isSafe && (
                <button type="button" onClick={handleAskAgent} className="apply-btn" disabled={loading || !onAskAgent}>
                  交给智能体应用
                </button>
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
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: var(--blue);
        }
        
        .refactor-empty,
        .refactor-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 180px;
          margin-bottom: 20px;
          padding: 24px;
          border: 1px dashed var(--border);
          border-radius: 8px;
          color: var(--fg-muted);
          text-align: center;
        }
        .refactor-empty strong { color: var(--fg); }
        .refactor-empty span { max-width: 360px; font-size: var(--fs-5); line-height: 1.6; }
        .refactor-loading { flex-direction: row; min-height: 72px; border-style: solid; background: var(--bg-elevated); }
        .refactor-spin { animation: refactor-spin 900ms linear infinite; }
        @keyframes refactor-spin { to { transform: rotate(360deg); } }

        .refactor-type-selector {
          display: flex;
          gap: 12px;
          margin-bottom: 24px;
        }
        
        .refactor-type-selector button {
          flex: 1;
          padding: 12px 24px;
          border: 1px solid var(--border);
          border-radius: var(--r-lg);
          background: var(--bg-elevated);
          color: var(--fg);
          font-size: var(--fs-5);
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .refactor-type-selector button:hover:not(:disabled) {
          border-color: var(--border-strong);
          transform: translateY(-1px);
        }

        .refactor-type-selector button.active {
          background: var(--accent);
          color: var(--accent-fg);
          border-color: var(--accent);
        }

        .refactor-type-selector button.active:hover:not(:disabled) {
          background: color-mix(in srgb, var(--accent) 86%, var(--accent-fg));
          border-color: var(--accent);
        }

        .refactor-type-selector button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .form-group {
          margin-bottom: 16px;
        }
        
        .form-group:last-child {
          margin-bottom: 0;
        }
        
        .form-group label {
          display: block;
          margin-bottom: 8px;
          font-size: var(--fs-5);
          font-weight: 500;
          color: var(--fg);
        }
        
        .form-group input[type="text"],
        .form-group input[type="number"] {
          width: 100%;
          padding: 10px 12px;
          /* 边框是输入框唯一的识别边界（1.4.11 要 3:1）：--border 1.24:1、
             --border-strong 1.37:1 都不够，取 --fg 60%。 */
          border: 1px solid color-mix(in srgb, var(--fg) 60%, transparent);
          border-radius: 6px;
          font-size: var(--fs-5);
          font-family: var(--font-mono);
        }
        
        .form-group input[type="checkbox"] {
          margin-right: 8px;
        }
        
        .cursor-position {
          display: flex;
          gap: 12px;
        }
        
        .cursor-position input {
          flex: 1;
        }
        
        .preview-btn,
        .apply-btn {
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

        .preview-btn:hover:not(:disabled),
        .apply-btn:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .preview-btn:disabled,
        .apply-btn:disabled {
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
        
        .refactor-preview h3,
        .refactor-preview h4 {
          margin-top: 0;
          margin-bottom: 16px;
          font-family: var(--font-ui);
          color: var(--fg);
        }
        
        .variable-analysis,
        .rename-summary {
          background: var(--bg-hover);
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        
        .analysis-row,
        .summary-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: var(--fs-5);
        }
        
        .analysis-row:last-child,
        .summary-row:last-child {
          margin-bottom: 0;
        }
        
        .analysis-row .label,
        .summary-row .label {
          color: var(--fg-muted);
          font-weight: 500;
        }
        
        .analysis-row .value,
        .summary-row .value {
          color: var(--fg);
          font-family: var(--font-mono);
        }
        
        .safety-indicator {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 12px;
          border-radius: 6px;
          margin-bottom: 16px;
          font-weight: 500;
          text-align: center;
        }
        
        .safety-indicator.safe {
          background: color-mix(in srgb, var(--ok) 12%, transparent);
          color: var(--ok-ink);
        }
        
        .safety-indicator.unsafe {
          background: var(--danger-soft);
          color: var(--danger-ink);
        }
        
        .warnings,
        .errors {
          background: color-mix(in srgb, var(--warn) 12%, transparent);
          border-left: 3px solid var(--warn);
          padding: 12px 16px;
          margin-bottom: 16px;
        }
        
        .errors {
          background: var(--danger-soft);
          border-left-color: var(--danger);
        }
        
        .warnings h4,
        .errors h4 {
          margin-top: 0;
          margin-bottom: 8px;
          font-size: var(--fs-5);
        }
        
        .warnings ul,
        .errors ul {
          margin: 0;
          padding-left: 20px;
        }
        
        .warnings li,
        .errors li {
          font-size: var(--fs-4);
          margin-bottom: 4px;
        }
        
        .code-preview pre {
          /* 同上：反色代码块的字要用背景实色，--bg-hover 是 5% 覆盖色。 */
          background: var(--fg);
          color: var(--bg-app);
          padding: 16px;
          border-radius: 6px;
          overflow-x: auto;
          font-family: var(--font-mono);
          font-size: var(--fs-4);
          line-height: 1.5;
        }
        
        .file-changes {
          margin-top: 16px;
        }
        
        .file-change {
          background: var(--bg-hover);
          padding: 12px;
          border-radius: 6px;
          margin-bottom: 12px;
        }
        
        .file-path {
          font-weight: 500;
          margin-bottom: 8px;
          color: var(--fg);
        }
        
        .replacements {
          font-size: var(--fs-4);
          color: var(--fg-muted);
        }
        
        .replacement {
          padding: 4px 0;
          font-family: var(--font-mono);
        }
        
        .more {
          color: var(--blue);
          font-style: italic;
          margin-top: 4px;
        }
      `}</style>
    </div>
  );
};
