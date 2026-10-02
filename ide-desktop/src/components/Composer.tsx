import { Plus, ShieldCheck, ArrowUp, Square, Gauge, Terminal, AtSign, FileEdit } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppState, QueuedMessage, ReasoningEffort, ToolScope } from '../types';
import { PluginMenu, type PluginItem } from './PluginMenu';
import { ModelMenu } from './ModelMenu';
import { ThinkingMenu, effortLabel } from './ThinkingMenu';
import { ToolScopeMenu, toolScopeLabel } from './ToolScopeMenu';
import { ApprovalMenu, approvalMenuLabel } from './ApprovalMenu';
import { ContextStatsMenu } from './ContextStatsMenu';
import { FileAttachmentList } from './FileAttachmentCard';
import { SlashCommandMenu } from './SlashCommandMenu';
import { MessageQueue } from './MessageQueue';
import { MentionPicker, type MentionItem } from './MentionPicker';
import { categorizeFile, getMediaType, getCategoryIcon, generateSmartPrompt, validateFile, MAX_FILE_COUNT, type DetectedFile } from '../lib/fileDetection';
import { sessionChangeTotals } from '../lib/state';
import { loadInputHistory, pushInputHistory } from '../lib/inputHistory';
import { modelReasoningCapability } from '../lib/modelCapabilities';
import { normalizeChains } from '../lib/dispatchChains';
import { contextBudget, estimateTokens, tokenBreakdown } from '../lib/tokenEstimate';

// approvalLabel is imported from ApprovalMenu and used via approvalMenuLabel below.
// No local duplicate needed.

export function Composer({ state, prefill, onSubmit, onCancel, onPickApproval, onPickPlugin, onPickModel, onPickEffort, onPickToolScope, onToggleDispatchTier, onToggleDispatchPick, onManageModels, terminalOutput, queue, onQueueSendNow, onQueueEdit, onQueueRemove }: {
  state: AppState;
  prefill?: { text: string; nonce: number } | null;
  onSubmit: (text: string, files?: DetectedFile[], mentions?: MentionItem[]) => void;
  onCancel: () => void;
  onPickApproval: (mode: import('../types').ApprovalMode) => void;
  onPickPlugin: (plugin: PluginItem) => void;
  onPickModel: (providerId: string, model: string) => void;
  onPickEffort: (effort: ReasoningEffort) => void;
  onPickToolScope: (toolScope: ToolScope) => void;
  /** Assign a model to a 省钱分级 tier (empty string clears it). */
  onToggleDispatchTier?: (tier: 'expensive' | 'standard' | 'cheap', value: string) => void;
  /** Check / uncheck a model in the dispatch set (multi-select). */
  onToggleDispatchPick?: (value: string) => void;
  onManageModels: () => void;
  terminalOutput?: string;
  /** Messages submitted while the agent was busy, oldest first. */
  queue?: QueuedMessage[];
  onQueueSendNow?: (id: string) => void;
  onQueueEdit?: (id: string, text: string) => void;
  onQueueRemove?: (id: string) => void;
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

  // Codex-style input history: persisted via localStorage, recalled with ↑/↓.
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  useEffect(() => { historyRef.current = loadInputHistory(); }, []);

  // 常规页开关的真实消费点：发送快捷键、上下文用量入口、插件入口。
  const prefs = state.settings?.preferences ?? {};
  const sendShortcut = typeof prefs['gen.sendShortcut'] === 'string' ? (prefs['gen.sendShortcut'] as string) : 'enter';
  const showContextUsage = prefs['gen.showContextUsage'] !== false;
  const pluginsEnabled = prefs['gen.plugins'] !== false;

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

  // Live token output speed while the agent streams — Reasonix-style: count
  // EVERYTHING the model streams this turn, not just the final answer. During
  // thinking the deltas land in the open turn's `think` step outputs; at answer
  // time the `assistant-live` bubble grows. Summing all of them keeps one
  // monotonic per-turn counter, so switching sources never resets the window.
  // Sampling the bubble alone read 0 tok/s for most of a turn. Tokens come
  // from the shared CJK-aware estimator (the API only reports real counts at
  // turn end). A window with zero growth renders '…' (idle between tool
  // calls), never a misleading 0.
  const liveStreamText = (() => {
    let text = '';
    for (const item of state.chat) {
      if (item.kind === 'turn') {
        for (const step of item.steps) {
          if (step.kind === 'tool' && step.tool === 'think') text += step.output ?? '';
        }
      }
      if (item.kind === 'assistant' && item.id === 'assistant-live') text += item.text;
    }
    return text;
  })();
  const liveTextRef = useRef(liveStreamText);
  liveTextRef.current = liveStreamText;
  const [tokenRate, setTokenRate] = useState<number | null>(null);
  useEffect(() => {
    if (!running) { setTokenRate(null); return; }
    let samples: Array<{ t: number; tokens: number }> = [];
    const timer = window.setInterval(() => {
      const now = Date.now();
      samples = samples.filter((s) => now - s.t <= 5000);
      samples.push({ t: now, tokens: estimateTokens(liveTextRef.current) });
      const first = samples[0];
      const latest = samples[samples.length - 1];
      const dt = (latest.t - first.t) / 1000;
      const growth = latest.tokens - first.tokens;
      if (dt >= 1) setTokenRate(growth > 0 ? Math.max(1, Math.round(growth / dt)) : null);
    }, 500);
    return () => window.clearInterval(timer);
  }, [running]);
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
  // Iteration 1: draft-token budget chip. Computed once per render; the
  // estimator is cheap enough (linear scan) for keystroke-rate updates.
  const draftTokens = estimateTokens(text);
  const draftBudget = contextBudget(draftTokens, contextWindow);
  const draftBreakdown = text.trim() ? tokenBreakdown(text) : null;

  // Esc = stop the running turn (the shortcut page already advertises it).
  // When any menu/picker is open, its own handler closes it — skip cancel so
  // one keypress never both closes a menu and kills a turn. A pending approval
  // card also wins: upstream approval_overlay consumes Esc as "deny".
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (menuOpen || modelMenuOpen || thinkingMenuOpen || toolScopeMenuOpen
        || approvalMenuOpen || contextMenuOpen || slashMenuOpen || mentionOpen) return;
      const hasPendingApproval = state.chat.some((item) => item.kind === 'approval' && !item.decided);
      if (hasPendingApproval) return;
      if (running) { event.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, modelMenuOpen, thinkingMenuOpen, toolScopeMenuOpen, approvalMenuOpen, contextMenuOpen, slashMenuOpen, mentionOpen, running, onCancel, state.chat]);

  function submit() {
    const value = text.trim();
    if (!value) return;
    setText('');
    setHistoryIndex(-1);
    historyRef.current = pushInputHistory(value);
    const files = attachedFiles.length > 0 ? attachedFiles : undefined;
    const currentMentions = mentions.length > 0 ? mentions : undefined;
    setAttachedFiles([]);
    setMentions([]);
    onSubmit(value, files, currentMentions);
  }

  function handleTextChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const newText = event.target.value;
    setText(newText);
    setHistoryIndex(-1);

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
        <MessageQueue
          items={queue ?? []}
          onSendNow={onQueueSendNow ?? (() => {})}
          onEdit={onQueueEdit ?? (() => {})}
          onRemove={onQueueRemove ?? (() => {})}
        />
        {menuOpen && (
          <PluginMenu prefs={prefs} onClose={() => setMenuOpen(false)}
            onPick={(plugin) => { setMenuOpen(false); onPickPlugin(plugin); }} />
        )}
        {modelMenuOpen && state.settings && (
          <ModelMenu providers={state.settings.providers} activeProviderId={state.settings.activeProviderId}
            activeModel={model} onPick={onPickModel} onManage={onManageModels}
            dispatchDefault={normalizeChains(state.settings.preferences?.dispatchDefault)}
            onToggleTier={onToggleDispatchTier}
            onTogglePick={onToggleDispatchPick}
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
          {/* chat_composer.rs: bold `›` prompt glyph at the input's left edge */}
          <div className="composer-input-row">
            <span className="composer-caret">›</span>
            <textarea ref={textareaRef} value={text} onChange={handleTextChange}
              onPaste={handlePaste}
              placeholder="随心输入，输入 @ 引用文件或符号，输入 / 使用指令" rows={1}
            onKeyDown={(event) => {
              if (mentionOpen) return;
              // ↑/↓ history recall (Codex CLI behavior): ↑ from an empty box or
              // caret-at-start walks back; ↓ walks forward; manual edit resets.
              if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey) {
                const h = historyRef.current;
                if (h.length > 0) {
                  const el = event.currentTarget;
                  const caretAtEdge = el.selectionStart === 0 && el.selectionEnd === 0;
                  if (event.key === 'ArrowUp') {
                    const target = historyIndex === -1
                      ? (caretAtEdge || !text.trim() ? h.length - 1 : -1)
                      : Math.max(0, historyIndex - 1);
                    if (target >= 0) {
                      event.preventDefault();
                      setHistoryIndex(target);
                      setText(h[target]!);
                      return;
                    }
                  } else if (historyIndex !== -1) {
                    event.preventDefault();
                    const next = historyIndex + 1;
                    if (next >= h.length) { setHistoryIndex(-1); setText(''); }
                    else { setHistoryIndex(next); setText(h[next]!); }
                    return;
                  }
                }
              }
              // gen.sendShortcut: 'enter' = Enter 发送 / Shift+Enter 换行；
              // 'mod-enter' = Ctrl/Cmd+Enter 发送，Enter 换行。
              if (sendShortcut === 'mod-enter') {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
            }} />
          </div>
          <div className="composer-bar">
            {pluginsEnabled && (
              <button className={`icon-button ${menuOpen ? 'active' : ''}`} title="插件与文件"
                onClick={() => setMenuOpen((o) => !o)}><Plus size={18} /></button>
            )}
            <button className={`icon-button ${mentionOpen ? 'active' : ''}`} title="引用文件/符号 (@)"
              onClick={() => { setText((t) => t + '@'); setMentionOpen(true); setMentionQuery(''); textareaRef.current?.focus(); }}>
              <AtSign size={15} /></button>
            <button
              className={`composer-access ${approvalMenuOpen ? 'active' : ''}`}
              title="审批模式"
              onClick={() => { setApprovalMenuOpen((o) => !o); setThinkingMenuOpen(false); setToolScopeMenuOpen(false); setModelMenuOpen(false); setContextMenuOpen(false); }}>
              <ShieldCheck size={15} />{approvalMenuLabel[approval] ?? approval}</button>
            <span className="composer-spacer" />
            {showContextUsage && (
              <button type="button"
                className={`composer-context ${contextMenuOpen ? 'active' : ''} ${state.contextStats ? 'has-data' : ''}`}
                title={contextTitle}
                onClick={() => { setContextMenuOpen((o) => !o); setThinkingMenuOpen(false); setToolScopeMenuOpen(false); setModelMenuOpen(false); }}>
                <span className="composer-context-ring" style={{ '--context-pct': `${contextRate ?? 0}%` } as CSSProperties} />
              </button>
            )}
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
            {text.trim() ? (
              <span
                className={`composer-budget composer-budget-${draftBudget.level}`}
                title={draftBreakdown
                  ? `草稿约 ${draftTokens} tokens / 可用 ${draftBudget.usable.toLocaleString()}（${(draftBudget.ratio * 100).toFixed(1)}%）\n`
                    + `中文 ${draftBreakdown.cjk} · 拉丁 ${draftBreakdown.latin} · 数字 ${draftBreakdown.digit} · 路径 ${draftBreakdown.dense} · 符号 ${draftBreakdown.symbol}`
                  : undefined}
              >
                {draftTokens.toLocaleString()} tk
              </span>
            ) : null}
            {running
              ? <button className="composer-send" title="停止" onClick={onCancel}><Square size={15} /></button>
              : <button className="composer-send" title="发送" onClick={submit} disabled={!text.trim()}><ArrowUp size={17} /></button>}
          </div>
          {/* footer.rs: while streaming show the live token output speed
              centered; idle state renders nothing (hints row removed). */}
          {running && (
            <div className="composer-hints composer-rate">
              <span className="composer-rate-value">{tokenRate === null ? '…' : tokenRate}</span>
              <span> tok/s</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
