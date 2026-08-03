export function Welcome({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return (
    <section className="welcome-panel">
      <p className="eyebrow">ZCode Desktop</p>
      <h1>AI coding workspace</h1>
      <p className="muted">Open a local project folder to start a Claude-Code-like desktop session.</p>
      <button className="primary-button" onClick={onOpenWorkspace}>Open Folder</button>
    </section>
  );
}
