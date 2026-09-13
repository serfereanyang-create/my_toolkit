/**
 * HelpOverlay.tsx — 新功能 / 帮助内容悬浮层
 *
 * 渲染 helpContent.ts 的版本化内容；"新功能"页高亮与当前 app 版本一致的
 * 条目，"帮助"页列出真实可用的功能说明。Esc / 点击遮罩关闭。
 */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { desktop } from '../lib/ipc';
import { HELP_TOPICS, WHATS_NEW } from '../lib/helpContent';

export type HelpOverlayTab = 'whats-new' | 'help';

function normalizeVersion(raw: string): string {
  const match = raw.match(/\d+(?:\.\d+){0,3}/);
  return match ? match[0] : raw.trim();
}

export function HelpOverlay({ initialTab, onClose }: { initialTab: HelpOverlayTab; onClose: () => void }) {
  const [tab, setTab] = useState<HelpOverlayTab>(initialTab);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => setTab(initialTab), [initialTab]);

  useEffect(() => {
    let cancelled = false;
    desktop.app.getVersion()
      .then((result) => { if (!cancelled) setAppVersion(normalizeVersion(result.version)); })
      .catch(() => { /* version stays empty; nothing is highlighted */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentEntry = useMemo(
    () => WHATS_NEW.find((entry) => entry.version === appVersion) ?? WHATS_NEW[0],
    [appVersion],
  );

  return (
    <div className="help-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="help-overlay-card" onClick={(event) => event.stopPropagation()}>
        <div className="help-overlay-head">
          <div className="help-overlay-tabs">
            <button className={tab === 'whats-new' ? 'active' : ''} onClick={() => setTab('whats-new')}>新功能</button>
            <button className={tab === 'help' ? 'active' : ''} onClick={() => setTab('help')}>帮助</button>
          </div>
          <span className="help-overlay-version">{appVersion ? `v${appVersion}` : ''}</span>
          <button className="help-overlay-close" onClick={onClose} title="关闭"><X size={16} /></button>
        </div>

        <div className="help-overlay-body">
          {tab === 'whats-new' && (
            <div className="help-whats-new">
              {WHATS_NEW.map((entry) => (
                <section key={entry.version} className={entry === currentEntry ? 'help-entry current' : 'help-entry'}>
                  <h3>
                    v{entry.version}
                    {entry === currentEntry && <span className="help-entry-badge">当前版本</span>}
                    <span className="help-entry-date">{entry.date}</span>
                  </h3>
                  <ul>
                    {entry.highlights.map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {tab === 'help' && (
            <div className="help-topics">
              {HELP_TOPICS.map((topic) => (
                <section key={topic.id} className="help-topic">
                  <h3>{topic.title}</h3>
                  {topic.body.map((line, index) => <p key={index}>{line}</p>)}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
