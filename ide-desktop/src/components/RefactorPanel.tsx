/**
 * RefactorPanel.tsx — 重构预览面板
 * 
 * 桌面端重构工具 UI
 * - Extract Method 预览
 * - Rename Symbol 预览
 * - 代码 Diff 展示
 * - 一键应用
 */

import React, { useState, useEffect } from 'react';

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

async function refreshEditorBridge(): Promise<void> {
  const api = (window as unknown as { electronAPI?: { refreshEditor(): Promise<void> } }).electronAPI;
  if (!api) throw new Error('refreshEditor 桥接未实现（草案面板）');
  return api.refreshEditor();
}

/** 对齐 cli/src/refactor/extract-method.ts 的请求/结果形状（桌面 tsconfig 不含 cli 源码，本地声明）。 */
interface ExtractMethodOptions {
  methodName: string;
  startLine: number;
  endLine: number;
  useArrowFunction?: boolean;
  addTypeAnnotations?: boolean;
}
interface ExtractMethodResult {
  extractedMethod: string;
  callSite: string;
  signature: { name: string; parameters: Array<{ name: string; type?: string }>; returnType?: string };
  variableAnalysis: Record<string, unknown>;
}

/** 对齐 cli/src/refactor/rename.ts 的请求/结果形状。 */
interface RenameOptions {
  file: string;
  line: number;
  column: number;
  newName: string;
  updateStringLiterals?: boolean;
}
interface RenameResult {
  oldName: string;
  newName: string;
  files: Array<{ path: string; replacements: number }>;
  totalReplacements: number;
  isSafe: boolean;
}

interface RefactorPanelProps {
  visible: boolean;
  onClose: () => void;
  selectedCode?: {
    file: string;
    startLine: number;
    endLine: number;
    content: string;
  };
}

type RefactorType = 'extract-method' | 'rename' | null;

export const RefactorPanel: React.FC<RefactorPanelProps> = ({
  visible,
  onClose,
  selectedCode,
}) => {
  const [refactorType, setRefactorType] = useState<RefactorType>(null);
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
  
  useEffect(() => {
    if (visible && selectedCode) {
      // 自动检测重构类型
      if (selectedCode.startLine !== selectedCode.endLine) {
        setRefactorType('extract-method');
      }
    }
  }, [visible, selectedCode]);
  
  const handleExtractMethod = async () => {
    if (!selectedCode) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const options: ExtractMethodOptions = {
        methodName,
        startLine: selectedCode.startLine,
        endLine: selectedCode.endLine,
        useArrowFunction,
        addTypeAnnotations,
      };
      
      // 调用 CLI 工具
      const response = await invokeTool('extract_method', {
        file: selectedCode.file,
        ...options,
        preview: true,
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
    
    try {
      const options: RenameOptions = {
        file: selectedCode.file,
        line: cursorPosition.line,
        column: cursorPosition.column,
        newName,
      };
      
      const response = await invokeTool('rename_symbol', {
        ...options,
        preview: true,
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
  
  const handleApply = async () => {
    if (!result) return;
    
    setLoading(true);
    
    try {
      if (refactorType === 'extract-method') {
        await invokeTool('extract_method', {
          file: selectedCode!.file,
          startLine: selectedCode!.startLine,
          endLine: selectedCode!.endLine,
          methodName,
          useArrowFunction,
          addTypeAnnotations,
          preview: false,
        });
      } else if (refactorType === 'rename') {
        await invokeTool('rename_symbol', {
          file: selectedCode!.file,
          line: cursorPosition!.line,
          column: cursorPosition!.column,
          newName,
          preview: false,
        });
      }
      
      // 刷新编辑器
      await refreshEditorBridge();
      
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  
  if (!visible) return null;
  
  return (
    <div className="refactor-panel-overlay">
      <div className="refactor-panel">
        <div className="refactor-panel-header">
          <h2>代码重构</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="refactor-panel-content">
          {/* 重构类型选择 */}
          <div className="refactor-type-selector">
            <button
              className={refactorType === 'extract-method' ? 'active' : ''}
              onClick={() => setRefactorType('extract-method')}
              disabled={!selectedCode || selectedCode.startLine === selectedCode.endLine}
            >
              Extract Method
            </button>
            <button
              className={refactorType === 'rename' ? 'active' : ''}
              onClick={() => setRefactorType('rename')}
            >
              Rename Symbol
            </button>
          </div>
          
          {/* Extract Method 表单 */}
          {refactorType === 'extract-method' && (
            <div className="refactor-form">
              <div className="form-group">
                <label>方法名称</label>
                <input
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
                <label>新名称</label>
                <input
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
                    value={cursorPosition?.line || ''}
                    onChange={(e) => setCursorPosition({
                      line: parseInt(e.target.value),
                      column: cursorPosition?.column || 1,
                    })}
                    placeholder="行号"
                  />
                  <input
                    type="number"
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
            <div className="error-message">
              <strong>错误:</strong> {error}
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
                {result.result.isSafe ? '✅ 重构安全' : '⚠️ 重构不安全'}
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
                <button onClick={handleApply} className="apply-btn" disabled={loading}>
                  应用重构
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
                {result.isSafe ? '✅ 重命名安全' : '⚠️ 重命名不安全'}
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
                <button onClick={handleApply} className="apply-btn" disabled={loading}>
                  应用重命名
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .refactor-panel-overlay {
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
        
        .refactor-panel {
          background: #FBF9F5;
          border-radius: 8px;
          width: 90%;
          max-width: 900px;
          max-height: 90vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
        }
        
        .refactor-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid #E7E1D7;
        }
        
        .refactor-panel-header h2 {
          margin: 0;
          font-family: 'DM Serif Display', serif;
          font-size: 24px;
          color: #1F2421;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 32px;
          color: #5C635D;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: #C4612F;
        }
        
        .refactor-panel-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }
        
        .refactor-type-selector {
          display: flex;
          gap: 12px;
          margin-bottom: 24px;
        }
        
        .refactor-type-selector button {
          flex: 1;
          padding: 12px 24px;
          border: 1px solid #E7E1D7;
          border-radius: 999px;
          background: white;
          color: #1F2421;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .refactor-type-selector button:hover:not(:disabled) {
          border-color: #C4612F;
          transform: translateY(-1px);
        }
        
        .refactor-type-selector button.active {
          background: #C4612F;
          color: white;
          border-color: #C4612F;
        }
        
        .refactor-type-selector button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .refactor-form {
          background: white;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #E7E1D7;
          margin-bottom: 24px;
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
          font-size: 14px;
          font-weight: 500;
          color: #1F2421;
        }
        
        .form-group input[type="text"],
        .form-group input[type="number"] {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #E7E1D7;
          border-radius: 6px;
          font-size: 14px;
          font-family: 'Monaco', 'Courier New', monospace;
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
          border-radius: 999px;
          background: #C4612F;
          color: white;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 16px;
        }
        
        .preview-btn:hover:not(:disabled),
        .apply-btn:hover:not(:disabled) {
          background: #A94E22;
          transform: translateY(-1px);
        }
        
        .preview-btn:disabled,
        .apply-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .error-message {
          background: #FFE5E5;
          border: 1px solid #FF4444;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 16px;
          color: #CC0000;
          font-size: 14px;
        }
        
        .refactor-preview {
          background: white;
          border: 1px solid #E7E1D7;
          border-radius: 8px;
          padding: 20px;
        }
        
        .refactor-preview h3,
        .refactor-preview h4 {
          margin-top: 0;
          margin-bottom: 16px;
          font-family: 'DM Serif Display', serif;
          color: #1F2421;
        }
        
        .variable-analysis,
        .rename-summary {
          background: #F7F4EF;
          padding: 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        
        .analysis-row,
        .summary-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .analysis-row:last-child,
        .summary-row:last-child {
          margin-bottom: 0;
        }
        
        .analysis-row .label,
        .summary-row .label {
          color: #5C635D;
          font-weight: 500;
        }
        
        .analysis-row .value,
        .summary-row .value {
          color: #1F2421;
          font-family: 'Monaco', 'Courier New', monospace;
        }
        
        .safety-indicator {
          padding: 12px;
          border-radius: 6px;
          margin-bottom: 16px;
          font-weight: 500;
          text-align: center;
        }
        
        .safety-indicator.safe {
          background: #E8F5E9;
          color: #2E7D32;
        }
        
        .safety-indicator.unsafe {
          background: #FFE5E5;
          color: #CC0000;
        }
        
        .warnings,
        .errors {
          background: #FFF3E0;
          border-left: 3px solid #FF9800;
          padding: 12px 16px;
          margin-bottom: 16px;
        }
        
        .errors {
          background: #FFE5E5;
          border-left-color: #FF4444;
        }
        
        .warnings h4,
        .errors h4 {
          margin-top: 0;
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .warnings ul,
        .errors ul {
          margin: 0;
          padding-left: 20px;
        }
        
        .warnings li,
        .errors li {
          font-size: 13px;
          margin-bottom: 4px;
        }
        
        .code-preview pre {
          background: #1F2421;
          color: #F7F4EF;
          padding: 16px;
          border-radius: 6px;
          overflow-x: auto;
          font-family: 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          line-height: 1.5;
        }
        
        .file-changes {
          margin-top: 16px;
        }
        
        .file-change {
          background: #F7F4EF;
          padding: 12px;
          border-radius: 6px;
          margin-bottom: 12px;
        }
        
        .file-path {
          font-weight: 500;
          margin-bottom: 8px;
          color: #1F2421;
        }
        
        .replacements {
          font-size: 13px;
          color: #5C635D;
        }
        
        .replacement {
          padding: 4px 0;
          font-family: 'Monaco', 'Courier New', monospace;
        }
        
        .more {
          color: #C4612F;
          font-style: italic;
          margin-top: 4px;
        }
      `}</style>
    </div>
  );
};
