import { Plus, ShieldCheck, ArrowUp, Square, Gauge, Terminal, AtSign, FileEdit } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppState, ReasoningEffort, ToolScope } from '../types';
import { PluginMenu, type PluginItem } from './PluginMenu';
import { ModelMenu } from './ModelMenu';
import { ThinkingMenu, effortLabel } from './ThinkingMenu';
import { ToolScopeMenu, toolScopeLabel } from './ToolScopeMenu';
import { ApprovalMenu, approvalMenuLabel } from './ApprovalMenu';
import { ContextStatsMenu } from './ContextStatsMenu';
import { FileAttachmentList } from './FileAttachmentCard';
import { SlashCommandMenu } from './SlashCommandMenu';
import { MentionPicker, type MentionItem } from './MentionPicker';
import { categorizeFile, getMediaType, getCategoryIcon, generateSmartPrompt, validateFile, MAX_FILE_COUNT, type DetectedFile } from '../lib/fileDetection';
import { sessionChangeTotals } from '../lib/state';
import { modelReasoningCapability } from '../lib/modelCapabilities';

// approvalLabel is imported from ApprovalMenu and used via approvalMenuLabel below.
// No local duplicate needed.

export function Composer({ state, prefill, onSubmit, onCancel, onPickApproval, onPickPlugin, onPickModel, onPickEffort, onPickToolScope, onManageModels, terminalOutput }: {
  state: AppState;
  prefill?: { text: string; nonce: number } | null;
  onSubmit: (text: string, files?: DetectedFile[], mentions?: MentionItem[]) => void;
  onCancel: () => void;
  onPickApproval: (mode: import('../types').ApprovalMode) => void;
  onPickPlugin: (plugin: PluginItem) => void;
  onPickModel: (providerId: string, model: string) => void;
  onPickEffort: (effort: ReasoningEffort) => void;
  onPickToolScope: (toolScope: ToolScope) => void;
  onManageModels: () => void;
  terminalOutput?: string;
}) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<DetectedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [toolScopeMenuOpen, setToolScopeMenuOpen] = useState(false);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionAtIndex, setMentionAtIndex] = useState(-1);
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill) setText(prefill.text);
  }, [prefill?.nonce]);

  // Bug-9 fix: depend on the full attachedFiles array reference (not just length)
  // so the effect fires when files are replaced or removed, not just added.
  // Guard: only auto-fill when the textarea is still empty, never overwrite user text.
  useEffect(() => {
    if (attachedFiles.length > 0 && !text.trim()) {
      setText(generateSmartPrompt(attachedFiles));
    }
  }, [attachedFiles]);

  const running = state.agentStatus === 'running' || state.agentStatus === 'starting';
  const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
  const model = provider?.model ?? 'mock-code-agent-v1';
  const modelLabel = provider && provider.type === 'custom' && provider.label
    ? `${provider.label}/${model}` : model;
  const effortKey = `${state.settings?.activeProviderId ?? ''}/${model}`;
  const reasoningCapability = modelReasoningCapability(provider);
  const effort = state.settings?.preferences?.reasoningEffortByModel?.[effortKey]
    ?? state.settings?.preferences?.reasoningEffort
    ?? reasoningCapability.options[0]
    ?? 'auto';
  const toolScope = (state.settings?.preferences?.toolScope as ToolScope | undefined) ?? 'auto';
  const taskExecutionMode = (state.settings?.preferences?.taskExecutionMode as 'auto' | 'plan' | undefined) ?? 'plan';
  const contextWindow = provider?.models?.find((entry) => entry.id === model)?.contextWindow;
  const contextRate = state.contextStats && contextWindow
    ? Math.min(100, (state.contextStats.inputTokens / contextWindow) * 100) : null;
  const contextTitle = state.contextStats
    ? `上下文与缓存：${state.contextStats.inputTokens.toLocaleString()} 输入 tokens${contextRate !== null ? ` / ${contextRate.toFixed(1)}%` : ''}`
    : '上下文与缓存（完成一次真实请求后显示）';
  const approval = state.settings?.approval ?? 'ask';
  const changeTotals = sessionChangeTotals(state.chat);

  function submit() {
    const value = text.trim();
    if (!value) return;
    setText('');
    const files = attachedFiles.length > 0 ? attachedFiles : undefined;
    const currentMentions = mentions.length > 0 ? mentions : undefined;
    setAttachedFiles([]);
    setMentions([]);
    onSubmit(value, files, currentMentions);
  }

  function handleTextChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const newText = event.target.value;
    setText(newText);

    // Slash command: open menu when input starts with '/' and has no space yet.
    // Bug-6 fix: the second branch `newText === '/'` was unreachable because the
    // first condition already matched it. Merged into a single branch.
    if (newText.startsWith('/') && !newText.includes(' ')) {
      setSlashQuery(newText.slice(1));
      setSlashMenuOpen(true);
    } else {
      if (slashMenuOpen) setSlashMenuOpen(false);
    }
    const cursorPos = event.target.selectionStart ?? newText.length;
    const textBeforeCursor = newText.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@([\w./\\-]*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1] ?? '');
      setMentionAtIndex(cursorPos - atMatch[0].length);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
    }
  }

  function handleMentionPick(item: MentionItem) {
    const atEnd = textareaRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, mentionAtIndex);
    const after  = text.slice(atEnd);
    setText(`${before}@${item.label}${after}`);
    setMentions((prev) => [...prev.filter((m) => m.id !== item.id), item]);
    setMentionOpen(false);
    setMentionQuery('');
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setIsDragging(false);
    const droppedFiles = Array.from(event.dataTransfer.files);
    const remaining = MAX_FILE_COUNT - attachedFiles.length;
    if (droppedFiles.length > remaining) {
      alert(`最多只能选择 ${MAX_FILE_COUNT} 个文件，当前已有 ${attachedFiles.length} 个`);
      return;
    }
    const newFiles: DetectedFile[] = [];
    for (const file of droppedFiles) {
      const validation = validateFile(file);
      if (!validation.valid) { alert(validation.error); continue; }
      const category = categorizeFile(file.name);
      newFiles.push({ path: file.path || '', name: file.name, size: file.size, category,
        mediaType: getMediaType(file.name), icon: getCategoryIcon(category) });
    }
    setAttachedFiles([...attachedFiles, ...newFiles]);
  }

  function handleDragOver(event: React.DragEvent) { event.preventDefault(); setIsDragging(true); }
  function handleDragLeave() { setIsDragging(false); }
  function removeFile(index: number) { setAttachedFiles(files => files.filter((_, i) => i !== index)); }
  function removeMention(id: string) {
    const item = mentions.find((m) => m.id === id);
    setMentions((prev) => prev.filter((m) => m.id !== id));
    if (item) setText((t) => t.replace(`@${item.label}`, ''));
  }

  async function handlePaste(event: React.ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    event.preventDefault();

    const remaining = MAX_FILE_COUNT - attachedFiles.length;
    if (imageItems.length > remaining) {
      alert(`最多只能选择 ${MAX_FILE_COUNT} 个文件，当前已有 ${attachedFiles.length} 个`);
      return;
    }

    const newFiles: DetectedFile[] = [];
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      // Generate unique filename with timestamp
      const ext = blob.type.split('/')[1] || 'png';
      const filename = `pasted-image-${Date.now()}.${ext}`;

      // Save to temporary directory via IPC
      try {
        const buffer = await blob.arrayBuffer();
        // Use FileReader to convert to base64 safely (avoids stack overflow on large images)
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            // dataUrl is "data:image/png;base64,XXXX..." — strip the prefix
            resolve(dataUrl.split(',')[1] ?? '');
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });

        // Use desktop API to save to temp
        const tempPath = await (window as any).zcodeDesktop.fs.saveTempImage(filename, base64);
        
        const category = categorizeFile(filename);
        newFiles.push({
          path: tempPath,
          name: filename,
          size: blob.size,
          category,
          mediaType: getMediaType(filename),
          icon: getCategoryIcon(category)
        });
      } catch (error) {
        console.error('Failed to save pasted image:', error);
        alert(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (newFiles.length > 0) {
      setAttachedFiles([...attachedFiles, ...newFiles]);
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {menuOpen && (
          <PluginMenu onClose={() => setMenuOpen(false)}
            onPick={(plugin) => { setMenuOpen(false); onPickPlugin(plugin); }} />
        )}
        {modelMenuOpen && state.settings && (
          <ModelMenu providers={state.settings.providers} activeProviderId={state.settings.activeProviderId}
            activeModel={model} onPick={onPickModel} onManage={onManageModels}
            onClose={() => setModelMenuOpen(false)} />
        )}
        {thinkingMenuOpen && (
          <ThinkingMenu value={effort} capability={reasoningCapability} onPick={onPickEffort} onClose={() => setThinkingMenuOpen(false)} />
        )}
        {toolScopeMenuOpen && (
          <ToolScopeMenu value={toolScope} onPick={onPickToolScope} onClose={() => setToolScopeMenuOpen(false)} />
        )}
        {approvalMenuOpen && (
          <ApprovalMenu value={approval} onPick={(v) => { onPickApproval(v); setApprovalMenuOpen(false); }} onClose={() => setApprovalMenuOpen(false)} />
        )}
        {contextMenuOpen && (
          <ContextStatsMenu stats={state.contextStats} provider={provider} onClose={() => setContextMenuOpen(false)} />
        )}
        {slashMenuOpen && (
          <SlashCommandMenu
            initialQuery={slashQuery}
            onPick={(command) => { setText(command + ' '); setSlashMenuOpen(false); setSlashQuery(''); }}
            onClose={() => { setSlashMenuOpen(false); setSlashQuery(''); }} />
        )}
        {mentionOpen && (
          <MentionPicker query={mentionQuery} tree={state.tree} terminalOutput={terminalOutput}
            onPick={handleMentionPick} onClose={() => setMentionOpen(false)} />
        )}
        <div className={`composer ${isDragging ? 'dragging' : ''}`}
          onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
          {mentions.length > 0 && (
            <div className="composer-mentions">
              {mentions.map((m) => (
                <span key={m.id} className="mention-chip" title={m.path ?? ''}>
                  @{m.label}
                  <button className="mention-chip-remove" onClick={() => removeMention(m.id)}>×</button>
                </span>
              ))}
            </div>
          )}
          {attachedFiles.length > 0 && <FileAttachmentList files={attachedFiles} onRemove={removeFile} />}
          <textarea ref={textareaRef} value={text} onChange={handleTextChange}
            onPaste={handlePaste}
            placeholder="随心输入，输入 @ 引用文件或符号，输入 / 使用指令" rows={1}
            onKeyDown={(event) => {
              if (mentionOpen) return;
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
            }} />
          <div className="composer-bar">
            <button className={`icon-button ${menuOpen ? 'active' : ''}`} title="插件与文件"
              onClick={() => setMenuOpen((o) => !o)}><Plus size={18} /></button>
            <button className={`icon-button ${mentionOpen ? 'active' : ''}`} title="引用文件/符号 (@)"
              onClick={() => { setText((t) => t + '@'); setMentionOpen(true); setMentionQuery(''); textareaRef.current?.focus(); }}>
              <AtSign size={15} /></button>
            <button
              className={`composer-access ${approvalMenuOpen ? 'active' : ''}`}
              title="审批模式"
              onClick={() => { setApprovalMenuOpen((o) => !o); setThinkingMenuOpen(false); setToolScopeMenuOpen(false); setModelMenuOpen(false); setContextMenuOpen(false); }}>
              <ShieldCheck size={15} />{approvalMenuLabel[approval] ?? approval}</button>
            <span className="composer-spacer" />
            <button type="button"
              className={`composer-context ${contextMenuOpen ? 'active' : ''} ${state.contextStats ? 'has-data' : ''}`}
              title={contextTitle}
              onClick={() => { setContextMenuOpen((o) => !o); setThinkingMenuOpen(false); setToolScopeMenuOpen(false); setModelMenuOpen(false); }}>
              <span className="composer-context-ring" style={{ '--context-pct': `${contextRate ?? 0}%` } as CSSProperties} />
            </button>
            <button type="button" className={`composer-model ${modelMenuOpen ? 'active' : ''}`} title="选择模型"
              onClick={() => { setModelMenuOpen((o) => !o); setThinkingMenuOpen(false); setToolScopeMenuOpen(false); setContextMenuOpen(false); }}>
              <span className="composer-model-label">{modelLabel}</span></button>
            <button type="button" className={`composer-effort ${thinkingMenuOpen ? 'active' : ''}`} title="思考强度"
              onClick={() => { setThinkingMenuOpen((o) => !o); setToolScopeMenuOpen(false); setModelMenuOpen(false); setContextMenuOpen(false); }}>
              <Gauge size={15} /><span>{effortLabel[effort]}</span></button>
            <button type="button" className={`icon-button ${slashMenuOpen ? 'active' : ''}`} title="斜杠命令"
              onClick={() => setSlashMenuOpen((o) => !o)}><Terminal size={15} /></button>
            {changeTotals && (
              <span className="composer-changes" title={`本次会话累计变更：+${changeTotals.added} -${changeTotals.removed}`}>
                <FileEdit size={13} />
                <span className="composer-changes-add">+{changeTotals.added}</span>
                <span className="composer-changes-del">-{changeTotals.removed}</span>
              </span>
            )}
            {running
              ? <button className="composer-send" title="停止" onClick={onCancel}><Square size={15} /></button>
              : <button className="composer-send" title="发送" onClick={submit} disabled={!text.trim()}><ArrowUp size={17} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}
