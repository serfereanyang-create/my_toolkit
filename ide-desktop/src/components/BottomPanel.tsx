import type { AppState } from '../types';

export function BottomPanel({ state }: { state: AppState }) {
  const toolItems = state.chat.filter((item) => item.kind === 'tool').slice(-8);
  return (
    <section className="bottom-output">
      <div className="bottom-title">Recent tool output</div>
      {toolItems.length === 0 ? <div className="muted">No tool output yet.</div> : toolItems.map((item) => (
        <div key={item.id} className="bottom-line">{item.tool} · {item.status}</div>
      ))}
    </section>
  );
}
