import type { ChatItem } from '../types';

export function ToolCard({ item, onApprove }: { item: Extract<ChatItem, { kind: 'tool' | 'approval' }>; onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void }) {
  if (item.kind === 'approval') {
    return (
      <section className="tool-card approval-card">
        <div className="tool-title">Approval · {item.tool}</div>
        <pre>{item.message}</pre>
        <div className="approval-actions">
          <button onClick={() => onApprove(item.requestId, 'allow_once')}>Allow once</button>
          <button onClick={() => onApprove(item.requestId, 'allow_session')}>Allow session</button>
          <button onClick={() => onApprove(item.requestId, 'deny')}>Deny</button>
        </div>
      </section>
    );
  }

  return (
    <section className={`tool-card ${item.status}`}>
      <div className="tool-title">{item.tool} · {item.status}</div>
      {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
      {item.output && <pre>{item.output}</pre>}
    </section>
  );
}
