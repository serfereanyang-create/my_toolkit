import { Wifi, Copy, Pencil } from 'lucide-react';
import type { AppState, ChatItem } from '../types';
import { ToolCard } from './ToolCard';

export function ConversationStream({ state, onApprove, onEditUser }: {
  state: AppState;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
}) {
  if (state.chat.length === 0) {
    return (
      <div className="stream">
        <div className="stream-empty">
          <h2>有什么可以帮忙的？</h2>
          <p className="muted">随心输入开始一段对话，或从左侧打开项目。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="stream">
      <div className="stream-inner">
        {state.agentStatus === 'starting' && (
          <div className="status-line"><Wifi size={15} /> 正在连接…</div>
        )}
        {state.chat.map((item) => <Row key={item.id} item={item} onApprove={onApprove} onEditUser={onEditUser} />)}
      </div>
    </div>
  );
}

function formatTime(ts?: number): string {
  const date = ts ? new Date(ts) : new Date();
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${days[date.getDay()]}${hh}:${mm}`;
}

function Row({ item, onApprove, onEditUser }: {
  item: ChatItem;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
}) {
  if (item.kind === 'tool' || item.kind === 'approval') return <ToolCard item={item} onApprove={onApprove} />;
  if (item.kind === 'user') {
    return (
      <div className="msg-user-group">
        <div className="msg-user">{item.text}</div>
        <div className="msg-user-meta">
          <span className="msg-time">{formatTime(item.ts)}</span>
          <button className="msg-action" title="复制" onClick={() => navigator.clipboard?.writeText(item.text)}><Copy size={14} /></button>
          <button className="msg-action" title="编辑" onClick={() => onEditUser(item.text)}><Pencil size={14} /></button>
        </div>
      </div>
    );
  }
  return <div className="msg-assistant">{item.text}</div>;
}
