import { SectionHeader, EmptyState } from './controls';

/* Environment page. Static UI only — no persisted state yet; interaction
   logic (adding projects) comes later. Mirrors the reference: an intro
   header with a 了解更多 link, then a "选择项目" section with an 添加项目
   action and an empty list. */
export function EnvironmentSettings() {
  return (
    <div className="settings-page">
      <h1 className="settings-page-title">环境</h1>
      <p className="settings-page-lead">
        本地环境会告诉 ChatGPT 如何为项目设置工作树。
        <a href="#" className="settings-link">了解更多</a>。
      </p>

      <section className="settings-group">
        <SectionHeader
          title="选择项目"
          action={<button type="button" className="settings-action-btn">添加项目</button>}
        />
        <EmptyState title="尚无项目" description="添加的项目将显示在此处" />
      </section>
    </div>
  );
}
