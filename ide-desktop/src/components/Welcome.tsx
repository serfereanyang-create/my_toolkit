export function Welcome({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return (
    <section className="welcome-panel">
      <p className="eyebrow">YOYcode Desktop</p>
      <h1>AI 编程工作区</h1>
      <p className="muted">打开一个本地项目文件夹，开始 AI 辅助编程会话。</p>
      <button className="primary-button" onClick={onOpenWorkspace}>打开文件夹</button>
    </section>
  );
}
