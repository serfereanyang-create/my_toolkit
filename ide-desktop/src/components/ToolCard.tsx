import { Wrench, ShieldAlert, CheckCircle2, XCircle, Loader } from 'lucide-react';
import type { ChatItem } from '../types';

export function ToolCard({ item, onApprove }: { item: Extract<ChatItem, { kind: 'tool' | 'approval' }>; onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void }) {
  if (item.kind === 'approval') {
    return (
      <section className="tool-card approval-card">
        <div className="tool-title"><ShieldAlert size={15} /> 需要审批 · {item.tool}</div>
        <pre>{item.message}</pre>
        <div className="approval-actions">
          <button onClick={() => onApprove(item.requestId, 'allow_once')}>允许一次</button>
          <button onClick={() => onApprove(item.requestId, 'allow_session')}>本次会话允许</button>
          <button onClick={() => onApprove(item.requestId, 'deny')}>拒绝</button>
        </div>
      </section>
    );
  }

  const icon = item.status === 'running'
    ? <Loader size={15} />
    : item.status === 'failed'
      ? <XCircle size={15} />
      : <CheckCircle2 size={15} />;

  return (
    <section className={`tool-card ${item.status}`}>
      <div className="tool-title">{icon} {item.tool}</div>
      {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
      {item.output && <pre>{item.output}</pre>}
    </section>
  );
}
