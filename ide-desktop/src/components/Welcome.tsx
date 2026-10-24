export function Welcome({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return (
    <section className="welcome-panel" aria-labelledby="welcome-title">
      <div className="welcome-mark" aria-hidden="true"><img src="./icon.svg" alt="" /></div>
      <p className="eyebrow">YOYcode Desktop</p>
      <h1 id="welcome-title">从项目开始</h1>
      <p className="muted">打开一个本地项目文件夹，开始 AI 辅助编程会话。</p>
      <button type="button" className="primary-button" onClick={onOpenWorkspace}>打开项目文件夹</button>
      <p className="welcome-hint">支持 Git 项目、代码搜索、编辑器和预览面板</p>
    </section>
  );
}
