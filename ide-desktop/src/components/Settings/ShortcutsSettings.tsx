import { useState } from 'react';
import { Search } from 'lucide-react';

/* Keyboard shortcuts page. UI-only mock: the list is static and the keys are
   display-only for now (no rebinding yet). A search box filters by label. */
type Shortcut = { id: string; label: string; keys: string[] };
type ShortcutGroup = { heading: string; items: Shortcut[] };

const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    heading: '常规',
    items: [
      { id: 'command-palette', label: '命令面板', keys: [MOD, 'K'] },
      { id: 'settings', label: '打开设置', keys: [MOD, ','] },
      { id: 'search', label: '全局搜索', keys: [MOD, 'Shift', 'F'] },
      { id: 'toggle-theme', label: '切换主题', keys: [MOD, 'Shift', 'L'] },
    ],
  },
  {
    heading: '聊天',
    items: [
      { id: 'new-chat', label: '新建聊天', keys: [MOD, 'N'] },
      { id: 'send', label: '发送消息', keys: ['Enter'] },
      { id: 'newline', label: '换行', keys: ['Shift', 'Enter'] },
      { id: 'stop', label: '停止生成', keys: ['Esc'] },
    ],
  },
  {
    heading: '编辑器',
    items: [
      { id: 'save', label: '保存文件', keys: [MOD, 'S'] },
      { id: 'find', label: '查找', keys: [MOD, 'F'] },
      { id: 'comment', label: '注释行', keys: [MOD, '/'] },
      { id: 'format', label: '格式化文档', keys: [MOD, 'Shift', 'P'] },
    ],
  },
];

export function ShortcutsSettings() {
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? SHORTCUT_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase())),
      })).filter((group) => group.items.length > 0)
    : SHORTCUT_GROUPS;

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">键盘快捷键</h1>

      <div className="settings-search settings-search-inline">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索快捷键..."
        />
      </div>

      {filtered.map((group) => (
        <section key={group.heading} className="settings-group">
          <h3 className="settings-group-heading">{group.heading}</h3>
          <div className="settings-card">
            {group.items.map((item) => (
              <div key={item.id} className="setting-row">
                <div className="setting-row-text">
                  <span className="setting-row-title">{item.label}</span>
                </div>
                <div className="setting-row-control">
                  <span className="shortcut-keys">
                    {item.keys.map((key, index) => (
                      <kbd key={index} className="shortcut-key">{key}</kbd>
                    ))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {filtered.length === 0 && (
        <div className="settings-placeholder">没有匹配的快捷键。</div>
      )}
    </div>
  );
}
