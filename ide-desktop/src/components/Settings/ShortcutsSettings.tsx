import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import { desktop } from '../../lib/ipc';
import {
  SHORTCUT_ACTIONS, serializeChord, chordFromEvent, validateChord,
  parseChord, resolveBindings, findConflicts,
} from '../../lib/keybindings';

/* Keyboard shortcuts page (iteration 19): every row is now REBINDABLE.
   Click a chip, press a chord, it validates live and saves. The rows mirror
   the same SHORTCUT_ACTIONS table App's dispatcher consumes, so the page can
   never drift from real behaviour again. Editor-internal keys (Monaco) are
   listed read-only at the bottom. */

type Group = { heading: string; items: typeof SHORTCUT_ACTIONS };

const GROUPS: Group[] = (() => {
  const order = ['常规', '聊天', '面板'] as const;
  return order
    .map((heading) => ({ heading, items: SHORTCUT_ACTIONS.filter((a) => a.group === heading) }))
    .filter((g) => g.items.length > 0);
})();

const READONLY_EDITOR_ROWS: Array<{ label: string; keys: string[] }> = [
  { label: '保存文件（自动入历史快照）', keys: ['Ctrl', 'S'] },
  { label: 'AI 内联编辑', keys: ['Ctrl', 'K'] },
  { label: '手动触发补全', keys: ['Ctrl', 'Space'] },
  { label: '接受 AI 建议', keys: ['Tab'] },
  { label: '取消 AI 建议', keys: ['Esc'] },
  { label: '当前行加/去书签', keys: ['点击行号左侧装订线'] },
];

const READONLY_CHAT_ROWS: Array<{ label: string; keys: string[] }> = [
  { label: '发送消息', keys: ['Enter'] },
  { label: '换行', keys: ['Shift', 'Enter'] },
  { label: '停止生成', keys: ['Esc'] },
  { label: '浏览输入历史', keys: ['↑', '↓'] },
  { label: '审批：允许一次', keys: ['Y'] },
  { label: '审批：本会话允许', keys: ['A'] },
  { label: '审批：拒绝', keys: ['N'] },
];

const READONLY_PALETTE_ROWS: Array<{ label: string; keys: string[] }> = [
  { label: '下一条 / 上一条命令', keys: ['↓', '↑'] },
  { label: '跳到下一分组', keys: ['Tab'] },
  { label: '执行选中命令', keys: ['Enter'] },
  { label: '关闭面板', keys: ['Esc'] },
];

/** Split "Ctrl+Shift+P" into individual kbd chips for display. */
function chordKeys(serialized: string): string[] {
  const parsed = parseChord(serialized);
  if (!parsed) return [serialized];
  const mods: string[] = [];
  if (parsed.ctrl) mods.push('Ctrl');
  if (parsed.alt) mods.push('Alt');
  if (parsed.shift) mods.push('Shift');
  if (parsed.meta) mods.push('Meta');
  const key = serialized.slice(serialized.lastIndexOf('+') + 1) || serialized;
  return [...mods, key.length === 1 ? key.toUpperCase() : key];
}

export function ShortcutsSettings() {
  const [query, setQuery] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<{ id: string; message: string } | null>(null);
  const captureIdRef = useRef<string | null>(null);
  captureIdRef.current = capturing;

  const reload = useCallback(() => {
    desktop.keybindings.get().then(setOverrides).catch(() => undefined);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
  const conflictedIds = useMemo(() => {
    const set = new Set<string>();
    for (const ids of conflicts.values()) for (const id of ids) set.add(id);
    return set;
  }, [conflicts]);

  // Live capture: a document-level listener while a row is armed.
  useEffect(() => {
    if (!capturing) return;
    function onDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { setCapturing(null); setCaptureError(null); return; }
      const chord = chordFromEvent(event);
      if (!chord) return; // modifier-only press: keep waiting
      const err = validateChord(chord);
      if (err) { setCaptureError(err); return; }
      const serialized = serializeChord(chord);
      const id = captureIdRef.current!;
      void desktop.keybindings.set(id, serialized).then((r) => {
        if (r?.ok) {
          setCapturing(null);
          setCaptureError(null);
          reload();
          window.dispatchEvent(new Event('zcode:keybindings-changed'));
        } else {
          setCaptureError(r?.error ?? '保存失败');
        }
      });
    }
    document.addEventListener('keydown', onDown, true);
    return () => document.removeEventListener('keydown', onDown, true);
  }, [capturing, reload]);

  async function resetOne(id: string) {
    setResetError(null);
    try {
      const result = await desktop.keybindings.set(id, null);
      if (!result?.ok) { setResetError({ id, message: result?.error ?? '恢复默认失败' }); return; }
      reload();
      window.dispatchEvent(new Event('zcode:keybindings-changed'));
    } catch (error) {
      // The rebind path reported captureError; the reset path returned a bare
      // rejected promise, so a failed reset looked like a click that did nothing.
      setResetError({ id, message: error instanceof Error ? error.message : String(error ?? '未知错误') });
    }
  }

  const filteredGroups = query.trim()
    ? GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((a) => a.label.toLowerCase().includes(query.trim().toLowerCase())),
      })).filter((g) => g.items.length > 0)
    : GROUPS;

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">键盘快捷键</h1>

      <div className="settings-search settings-search-inline">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索快捷键..."
          aria-label="搜索快捷键"
        />
      </div>

      {/* The warning glyph must not be an emoji: the UI font stack falls back to
          a symbol font that renders U+26A0 as a bare triangle, which no longer
          matches the "带 ⚠" wording below. A plain bullet is font-independent. */}
      <div className="sc-hint">点击键位标签，按下新的组合键即可改绑；按 Esc 取消。标有「键位冲突」的条目与其他命令冲突。</div>

      {resetError && (
        <div className="settings-error-row" role="alert">
          <span>恢复默认失败：{resetError.message}</span>
          <button type="button" onClick={() => void resetOne(resetError.id)}>重试</button>
        </div>
      )}

      {filteredGroups.map((group) => (
        <section key={group.heading} className="settings-group">
          <h3 className="settings-group-heading">{group.heading}</h3>
          <div className="settings-card">
            {group.items.map((item) => {
              const serialized = serializeChord(bindings[item.id]);
              const isCapturing = capturing === item.id;
              const custom = Boolean(overrides[item.id]);
              const conflict = conflictedIds.has(item.id);
              return (
                <div key={item.id} className="setting-row">
                  <div className="setting-row-text">
                    <span className="setting-row-title">{item.label}</span>
                    {custom && <span className="sc-custom-badge">已自定义</span>}
                    {conflict && <span className="sc-conflict-badge">键位冲突</span>}
                  </div>
                  <div className="setting-row-control sc-keys-control">
                    <button
                      type="button"
                      className={`sc-chip${isCapturing ? ' capturing' : ''}${conflict ? ' conflict' : ''}`}
                      onClick={() => { setCapturing(isCapturing ? null : item.id); setCaptureError(isCapturing ? null : `按下 ${item.label} 的新键位…`); }}
                      title={isCapturing ? '按 Esc 取消' : '点击改绑'}
                    >
                      {isCapturing
                        ? <span className="sc-capture-text">{captureError ?? '按下新键位…（Esc 取消）'}</span>
                        : chordKeys(serialized).map((k, i) => <kbd key={i} className="shortcut-key">{k}</kbd>)}
                    </button>
                    {custom && !isCapturing && (
                      <button type="button" className="sc-reset" title="恢复默认" onClick={() => { void resetOne(item.id); }}>
                        <RotateCcw size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {filteredGroups.length === 0 && (
        <div className="settings-placeholder">没有匹配的快捷键。</div>
      )}

      <section className="settings-group">
        <h3 className="settings-group-heading">编辑器内（由 Monaco 固定，暂不可改绑）</h3>
        <div className="settings-card">
          {READONLY_EDITOR_ROWS.map((row) => (
            <div key={row.label} className="setting-row">
              <div className="setting-row-text">
                <span className="setting-row-title">{row.label}</span>
              </div>
              <div className="setting-row-control">
                <span className="shortcut-keys">
                  {row.keys.map((key, index) => (
                    <kbd key={index} className="shortcut-key">{key}</kbd>
                  ))}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-heading">聊天输入与审批（固定键位）</h3>
        <div className="settings-card">
          {READONLY_CHAT_ROWS.map((row) => (
            <div key={row.label} className="setting-row">
              <div className="setting-row-text">
                <span className="setting-row-title">{row.label}</span>
              </div>
              <div className="setting-row-control">
                <span className="shortcut-keys">
                  {row.keys.map((key, index) => (
                    <kbd key={index} className="shortcut-key">{key}</kbd>
                  ))}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-heading">命令面板与浮层（固定键位）</h3>
        <div className="settings-card">
          {READONLY_PALETTE_ROWS.map((row) => (
            <div key={row.label} className="setting-row">
              <div className="setting-row-text">
                <span className="setting-row-title">{row.label}</span>
              </div>
              <div className="setting-row-control">
                <span className="shortcut-keys">
                  {row.keys.map((key, index) => (
                    <kbd key={index} className="shortcut-key">{key}</kbd>
                  ))}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
