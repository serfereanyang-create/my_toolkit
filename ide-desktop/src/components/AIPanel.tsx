import { Send, Square } from 'lucide-react';
import { useState } from 'react';
import type { AppState, ChatItem } from '../types';
import { ToolCard } from './ToolCard';

export function AIPanel({ state, onSubmit, onCancel, onApprove }: {
  state: AppState;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const [text, setText] = useState('');
  const running = state.agentStatus === 'running';

  function submit() {
    const value = text.trim();
    if (!value) return;
    setText('');
    onSubmit(value);
  }

  return (
    <section className="ai-panel">
      <div className="chat-log">
        {state.chat.map((item) => <ChatRow key={item.id} item={item} onApprove={onApprove} />)}
      </div>
      <div className="chat-input-row">
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Ask ZCode or type /help" onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit();
        }} />
        {running ? (
          <button title="Stop" onClick={onCancel}><Square size={17} /></button>
        ) : (
          <button title="Send" onClick={submit}><Send size={17} /></button>
        )}
      </div>
    </section>
  );
}

function ChatRow({ item, onApprove }: { item: ChatItem; onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void }) {
  if (item.kind === 'tool' || item.kind === 'approval') return <ToolCard item={item} onApprove={onApprove} />;
  return <div className={`chat-row ${item.kind}`}>{item.text}</div>;
}
