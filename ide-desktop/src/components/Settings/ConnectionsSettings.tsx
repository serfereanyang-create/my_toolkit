import { Laptop, Server } from 'lucide-react';
import { SectionHeader } from './controls';

/* Connections page. Static UI only — no local state yet; interaction logic
   comes later. Mirrors the reference: a section header plus a large empty
   panel inviting an SSH connection. */
export function ConnectionsSettings() {
  return (
    <div className="settings-page">
      <h1 className="settings-page-title">连接</h1>

      <SectionHeader title="来自此电脑的 SSH 连接" />

      <div className="settings-cta-panel">
        <div className="settings-cta-illustration">
          <Laptop size={26} />
          <span className="settings-cta-dots">···</span>
          <Server size={26} />
        </div>
        <p className="settings-cta-text">通过 SSH 连接到远程设备</p>
        <button
          type="button"
          className="settings-cta-btn"
          title="暂未接入：SSH 连接还没有数据源"
          disabled
        >
          添加
        </button>
      </div>
    </div>
  );
}
