import { Plus, ShieldCheck, ArrowUp, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppState } from '../types';
import { PluginMenu, type PluginItem } from './PluginMenu';

const approvalLabel: Record<string, string> = {
  ask: '完全访问',
  auto: '自动执行',
  deny: '只读模式',
};

export function Composer({ state, prefill, onSubmit, onCancel, onCycleApproval, onPickPlugin }: {
  state: AppState;
  prefill?: { text: string; nonce: number } | null;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onCycleApproval: () => void;
  onPickPlugin: (plugin: PluginItem) => void;
}) {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  // When the user hits "edit" on a past message, refill the composer.
  useEffect(() => {
    if (prefill) setText(prefill.text);
  }, [prefill?.nonce]);
  const running = state.agentStatus === 'running' || state.agentStatus === 'starting';
  const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
  const model = provider?.model ?? 'mock-code-agent-v1';
  const approval = state.settings?.approval ?? 'ask';

  function submit() {
    const value = text.trim();
    if (!value) return;
    setText('');
    onSubmit(value);
  }

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {menuOpen && (
          <PluginMenu
            onClose={() => setMenuOpen(false)}
            onPick={(plugin) => { setMenuOpen(false); onPickPlugin(plugin); }}
          />
        )}
        <div className="composer">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="随心输入"
            rows={1}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-bar">
            <button
              className={`icon-button ${menuOpen ? 'active' : ''}`}
              title="插件与文件"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Plus size={18} />
            </button>
            <button className="composer-access" title="审批模式（点击切换）" onClick={onCycleApproval}>
              <ShieldCheck size={15} />
              {approvalLabel[approval] ?? approval}
            </button>
            <span className="composer-spacer" />
            <span className="composer-model">{model}</span>
            {running ? (
              <button className="composer-send" title="停止" onClick={onCancel}><Square size={15} /></button>
            ) : (
              <button className="composer-send" title="发送" onClick={submit} disabled={!text.trim()}><ArrowUp size={17} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
