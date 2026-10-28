import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Plus, X, TerminalSquare, ClipboardCopy, Loader2 } from 'lucide-react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { desktop } from '../lib/ipc';
import { nextRovingTabId, type RovingTabKey } from '../lib/rovingTabs';
import { readTerminalOutput } from '../lib/terminalOutput';

type TermTab = {
  id: string;
  title: string;
  term: Xterm;
  fit: FitAddon;
  disposeData: () => void;
};

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

export function Terminal({ cwd, onClose, onCaptureOutput }: {
  cwd?: string;
  onClose: () => void;
  onCaptureOutput?: (text: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<Map<string, TermTab>>(new Map());
  const [tabs, setTabs] = useState<{ id: string; title: string }[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminalTheme = () => {
    const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
    const token = (name: string, fallback: string) => {
      if (typeof document === 'undefined') return fallback;
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };
    return {
      background: token('--bg-input-solid', dark ? '#2b2b2b' : '#ffffff'),
      foreground: token('--fg', dark ? '#d4d4d4' : '#262626'),
      cursor: token('--blue', dark ? '#80beff' : '#0066dd'),
      selectionBackground: dark ? '#45454a' : '#dce8f8',
    };
  };

  // xterm draws to a canvas, so it needs a resolved number rather than a CSS
  // var. Read it off a throwaway element rather than parsing the token: the
  // stylesheet's default is `calc(var(--fs-base) - 1px)`, and the computed value
  // of a custom property keeps the unevaluated calc() rather than collapsing it.
  const codeFontSize = () => {
    if (typeof document === 'undefined') return 12;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--fs-code,12px)';
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return Number.isFinite(px) && px > 0 ? px : 12;
  };

  useEffect(() => {
    const off = desktop.terminal.onEvent((event) => {
      const tab = tabsRef.current.get(event.id);
      if (!tab) return;
      if (event.type === 'data') {
        tab.term.write(event.data);
      } else if (event.type === 'exit') {
        tab.term.write(`\r\n[进程已退出，代码 ${event.code}]\r\n`);
      }
    });
    return off;
  }, []);

  async function createTab() {
    setCreating(true);
    setError(null);
    let term: Xterm | null = null;
    try {
      const result = await desktop.terminal.create({ cwd });
      term = new Xterm({
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', 'Noto Sans Mono CJK SC', Consolas, monospace",
        fontSize: codeFontSize(), cursorBlink: true,
        theme: terminalTheme(),
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      /*
       * xterm swallows every key it can map, including Ctrl+T, so while the
       * terminal had focus the app's own "底部终端" shortcut never fired and
       * Tab/Shift+Tab are sent to the shell — the panel was a keyboard trap
       * with no exit. Let the toggle chord through to the window handler;
       * everything else stays with the PTY, which is what a terminal is for.
       */
      term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && (event.key === 't' || event.key === 'T')));
      const onData = term.onData((data) => { void desktop.terminal.write(result.id, data); });
      const tab: TermTab = { id: result.id, title: shortCwd(result.cwd), term, fit, disposeData: () => onData.dispose() };
      tabsRef.current.set(result.id, tab);
      setTabs((prev) => [...prev, { id: result.id, title: tab.title }]);
      setActiveId(result.id);
    } catch (err) {
      term?.dispose();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function closeTab(id: string) {
    const tab = tabsRef.current.get(id);
    if (tab) { tab.disposeData(); tab.term.dispose(); tabsRef.current.delete(id); void desktop.terminal.kill(id); }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next.length ? next[next.length - 1].id : '');
      return next;
    });
  }

  useEffect(() => {
    void createTab();
    return () => {
      for (const [, tab] of tabsRef.current) { tab.disposeData(); tab.term.dispose(); void desktop.terminal.kill(tab.id); }
      tabsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the panel (X button or Ctrl+T from inside the terminal) removes
  // the node that had focus, so focus used to land on <body> — the next Tab
  // restarted from the top of the app. Hand it back to the composer instead.
  useEffect(() => {
    return () => {
      window.requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) {
          document.querySelector<HTMLElement>('.composer textarea')?.focus();
        }
      });
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const theme = terminalTheme();
      const size = codeFontSize();
      for (const tab of tabsRef.current.values()) {
        tab.term.options.theme = theme;
        if (tab.term.options.fontSize !== size) {
          tab.term.options.fontSize = size;
          try { tab.fit.fit(); void desktop.terminal.resize(tab.id, tab.term.cols, tab.term.rows); } catch { /* ignore */ }
        }
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const tab = tabsRef.current.get(activeId);
    if (!host || !tab) return;
    // xterm keeps its own DOM subtree per instance. Re-parenting the SAME
    // instance on every switch is fine, but calling open() again on an
    // instance that is already parented elsewhere tears down the element the
    // previous render put in `host` — which is why switching tabs used to
    // leave an empty panel. Only open an instance that is not yet mounted;
    // otherwise move the existing element in.
    const alreadyHere = tab.term.element && tab.term.element.parentElement === host;
    if (!alreadyHere) {
      host.replaceChildren();
      if (tab.term.element) host.appendChild(tab.term.element);
      else tab.term.open(host);
    }
    tab.fit.fit();
    tab.term.focus();
    void desktop.terminal.resize(tab.id, tab.term.cols, tab.term.rows);
    const observer = new ResizeObserver(() => {
      try { tab.fit.fit(); void desktop.terminal.resize(tab.id, tab.term.cols, tab.term.rows); } catch { /* ignore */ }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [activeId]);

  return (
    <section className="terminal-panel">
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className={`terminal-tab ${tab.id === activeId ? 'active' : ''}`} role="tab" tabIndex={tab.id === activeId ? 0 : -1} aria-selected={tab.id === activeId} data-terminal-tab-id={tab.id}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveId(tab.id); return; }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const next = nextRovingTabId(tabs.map((item) => item.id), tab.id, event.key as RovingTabKey);
                if (!next) return;
                setActiveId(next);
                window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-terminal-tab-id="${CSS.escape(next)}"]`)?.focus());
              }
            }}>
            <button type="button" className="terminal-tab-label" onClick={() => setActiveId(tab.id)} title={tab.title} aria-label={`切换到终端 ${tab.title}`}>
              <TerminalSquare size={13} /><span>{tab.title}</span>
            </button>
            <button type="button" className="terminal-tab-close" onClick={() => closeTab(tab.id)} aria-label={`关闭终端 ${tab.title}`}><X size={12} /></button>
          </div>
        ))}
        <button type="button" className="terminal-new" onClick={() => void createTab()} disabled={creating} aria-label="新建终端">
          {creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
        </button>
        <span className="terminal-tabs-spacer" />
        {onCaptureOutput && (
          <button type="button" className="terminal-capture-btn" disabled={!activeId} onClick={() => {
            const tab = tabsRef.current.get(activeId);
            if (!tab) return;
            tab.term.write('', () => {
              if (tabsRef.current.get(tab.id) === tab) onCaptureOutput(readTerminalOutput(tab.term.buffer.active));
            });
          }}
            title="引用输出到对话 (@terminal)">
            <ClipboardCopy size={13} /> 引用输出
          </button>
        )}
        <button type="button" className="terminal-close" onClick={onClose} aria-label="关闭终端面板"><X size={15} /></button>
      </div>
      {error && (
        <div className="terminal-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" onClick={() => void createTab()} disabled={creating}>重试</button>
        </div>
      )}
      <div className="terminal-body">
        {tabs.length === 0 && (
          <div className="terminal-empty" role="status">
            <TerminalSquare size={22} />
            <strong>还没有终端</strong>
            <span>新建一个终端后，命令输出可以引用到对话里。</span>
            <button type="button" className="btn-secondary" onClick={() => void createTab()} disabled={creating}>
              {creating ? '正在启动…' : '新建终端'}
            </button>
          </div>
        )}
        <div className="terminal-host" ref={hostRef} />
      </div>
    </section>
  );
}
