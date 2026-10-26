import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Camera,
  CheckCircle2,
  CircleAlert,
  Crosshair,
  Keyboard,
  LoaderCircle,
  Monitor,
  MousePointerClick,
  RefreshCw,
  Sparkles,
  Type,
  X,
} from 'lucide-react';
import { desktop, type GuiToolResult } from '../lib/ipc';

/*
 * 电脑操控 — a window map for the machine the agent works on.
 *
 * Every other view in this app shows the project. This one shows the desktop:
 * which applications are running, what controls each window exposes, and a way
 * to press one. It runs the *same* computer_* tools the agent calls, through a
 * headless CLI child (electron/gui-control.cjs), so the thing you test here is
 * exactly the thing the agent will do in a turn — no model, no prompt, no
 * waiting for a provider round trip to click a button.
 *
 * The second job is the handoff: 交给智能体 turns the selected window plus what
 * you are looking at into a conversation prompt, which is how "看这个软件然后
 * 帮我操作" starts without the user having to describe the window from memory.
 */

type WindowRow = {
  pid: number;
  appPid: number;
  class: string;
  cloaked: boolean;
  /** Minimized: the rect below is where it WOULD be restored, not where it is. */
  iconic?: boolean;
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type Screen = { left: number; top: number; width: number; height: number };

type ElementRow = {
  index: number;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  action: string;
  /**
   * The window was minimized, so the CLI printed `(minimized)` in place of a
   * rectangle: the control exists and can be pressed by index, but it is not
   * somewhere on screen. Without this the row would look clickable and the
   * coordinates would be zeroes, which is a place — the top-left corner.
   */
  minimized?: boolean;
};

/**
 * Parse `index|type|name|(x,y WxH)|action` lines from computer_elements.
 *
 * The CLI replaces `|` and newlines inside a control's name with spaces before
 * printing, so a name never shifts the columns; splitting on `|` is safe, and a
 * malformed row is dropped rather than shown with the wrong index (an index is
 * a click target, so a wrong one is worse than a missing one).
 *
 * A minimized window has no rectangles at all — every control sits at the same
 * parked off-screen point — so those rows carry `(minimized)` instead of
 * numbers and are kept, marked, rather than dropped: the index is still the way
 * to press them.
 */
export function parseElementLines(output: string): ElementRow[] {
  const rows: ElementRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const at = /^(\d+)\|([^|]*)\|([^|]*)\|\((-?\d+),(-?\d+) (\d+)x(\d+)\)\|([^|]*)$/.exec(trimmed);
    if (at) {
      rows.push({
        index: Number(at[1]),
        type: at[2],
        name: at[3],
        x: Number(at[4]),
        y: Number(at[5]),
        width: Number(at[6]),
        height: Number(at[7]),
        action: at[8],
      });
      continue;
    }
    const mini = /^(\d+)\|([^|]*)\|([^|]*)\|\(minimized\)\|([^|]*)$/.exec(trimmed);
    if (!mini) continue;
    rows.push({
      index: Number(mini[1]),
      type: mini[2],
      name: mini[3],
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      action: mini[4],
      minimized: true,
    });
  }
  return rows;
}

/** The window's own process id when the row is a packaged app's frame. */
function windowKey(window: WindowRow): string {
  return String(window.appPid > 0 ? window.appPid : window.pid);
}

function windowLabel(window: WindowRow): string {
  return window.title.trim() || window.class || `pid ${window.pid}`;
}

/** A stable 2-letter monogram so rows are scannable without icons per app. */
function monogram(label: string): string {
  const ascii = label.match(/[A-Za-z0-9]/g)?.slice(0, 2).join('') ?? '';
  if (ascii) return ascii.toUpperCase();
  return Array.from(label.trim())[0] ?? '?';
}

const ACTION_VERB: Record<string, string> = {
  invoke: '点击',
  toggle: '切换',
  expand: '展开',
  text: '文本',
};

/**
 * Actions that move the user's focus or type into their window.
 *
 * Reading a window (list / elements / screenshot) never touches focus — that is
 * enforced in the CLI, not just here. These four do, so each one asks first:
 * the answer is about the user's own screen, and a click in this panel is not
 * obviously the same as agreeing to be interrupted.
 */
const FOCUS_TOOLS = new Set(['computer_activate', 'computer_press', 'computer_type', 'computer_key', 'computer_click', 'computer_drag']);

/** One line per tool that says what the prompt is about to do. */
function confirmText(tool: string, target: string, detail?: string): string {
  switch (tool) {
    case 'computer_activate': return `把「${target}」切到前台并夺取键盘焦点？`;
    case 'computer_press': return `在「${target}」上点击「${detail ?? '该控件'}」（窗口会先取得焦点）？`;
    case 'computer_type': return `向「${target}」输入文字（窗口会先取得焦点）？`;
    case 'computer_key': return `向「${target}」发送按键 ${detail ?? ''}（窗口会先取得焦点）？`;
    case 'computer_click': return `在「${target}」${detail ? `的 ${detail} 处` : '上'}点击（鼠标指针会移动过去）？`;
    case 'computer_drag': return `在「${target}」上从 ${detail ?? '起点'} 拖动（鼠标指针会移动过去）？`;
    default: return `继续操作「${target}」？`;  }
}

/** A capture shown in the panel, with the id later clicks are bound to. */
type Shot = {
  src: string;
  screenshotId?: string;
  label: string;
  width: number;
  height: number;
  /** Set once the window behind it has been acted on: the pixels are old. */
  stale?: boolean;
  /**
   * The window was minimized when this was taken. Its pixels are real, but it
   * has no on-screen position, so the picture is for looking at — clicking it
   * would be refused by the tool, and offering the gesture here would just be a
   * click that goes nowhere.
   */
  readOnly?: boolean;
};

export function GuiControlPanel({ onAskAgent, desktopMode }: {
  /** Hand a prompt to the conversation so the agent can take over. */
  onAskAgent: (text: string) => void;
  /** 执行方式 is 桌面 (not 仅后台执行); the panel says so when it is not. */
  desktopMode: boolean;
}) {
  const [status, setStatus] = useState<{ ok: boolean; platform: string; built: boolean; reason?: string } | null>(null);
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [elements, setElements] = useState<ElementRow[]>([]);
  const [elementsFor, setElementsFor] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [shot, setShot] = useState<Shot | null>(null);
  /** A Shift-drag in progress over the capture, in capture pixels. */
  const [dragBand, setDragBand] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const [typed, setTyped] = useState('');
  /** A focus-taking action awaiting the user's yes. */
  const [pending, setPending] = useState<{ tool: string; input: Record<string, unknown>; label: string; detail?: string } | null>(null);
  const requestSeq = useRef(0);


  const run = useCallback(async (tool: string, input?: Record<string, unknown>): Promise<GuiToolResult | null> => {
    setBusy(tool);
    setError('');
    try {
      const result = await desktop.guiControl.invoke(tool, input ?? {});
      if (!result.ok) {
        setError(result.error || result.output || '操作失败');
        return null;
      }
      return result;
    } catch (failure) {
      const raw = failure instanceof Error ? failure.message : String(failure);
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const invokeNow = useCallback((tool: string, input: Record<string, unknown>) => run(tool, input), [run]);

  /**
   * One entry point for every action. Focus-taking tools stop here first and
   * wait for the user's yes; reading tools run immediately.
   */
  const dispatchAction = useCallback(async (tool: string, input: Record<string, unknown>, detail?: string) => {
    if (FOCUS_TOOLS.has(tool)) {
      // Name the window the way the user sees it, not by the pid the tool
      // needs: "在「100」上点击" tells them nothing about which app they are
      // about to be pulled out of.
      const key = String(input.window ?? '').trim();
      const row = key ? windows.find((w) => windowKey(w) === key) : undefined;
      setPending({ tool, input, label: row ? windowLabel(row) : (key || '桌面'), ...(detail ? { detail } : {}) });
      return null;
    }
    return invokeNow(tool, input);
  }, [invokeNow, windows]);

  const refreshWindows = useCallback(async () => {
    const result = await run('computer_list_windows');
    if (!result) return;
    const data = result.data as { windows?: WindowRow[]; screen?: Screen | null } | undefined;
    const next = Array.isArray(data?.windows) ? data.windows : [];
    setWindows(next);
    setScreen(data?.screen ?? null);
    setSelected((current) => {
      if (current && next.some((w) => windowKey(w) === current)) return current;
      // Prefer a real, on-screen app over the shell's Progman/desktop helper.
      const better = next.find((w) => !w.cloaked && w.class !== 'Progman') ?? next[0];
      return better ? windowKey(better) : null;
    });
  }, [run]);

  const loadElements = useCallback(async (key: string) => {
    const seq = ++requestSeq.current;
    const result = await run('computer_elements', { window: key });
    // A slower earlier request must not overwrite the tree for the window the
    // user just clicked.
    if (seq !== requestSeq.current) return;
    if (!result) { setElements([]); setElementsFor(null); return; }
    setElements(parseElementLines(result.output));
    setElementsFor(key);
  }, [run]);

  useEffect(() => {
    let live = true;
    desktop.guiControl.status().then((next) => {
      if (!live) return;
      setStatus(next);
      if (next.ok) void refreshWindows();
    }).catch(() => { if (live) setStatus({ ok: false, platform: '', built: false, reason: '无法连接电脑操控服务。' }); });
    return () => { live = false; };
  }, [refreshWindows]);

  const selectedWindow = useMemo(
    () => windows.find((w) => windowKey(w) === selected) ?? null,
    [windows, selected],
  );

  // Loading the tree is part of selecting a window: the whole point of the list
  // is to get to the controls, and a second click to reveal them is noise.
  useEffect(() => {
    if (!selected) { setElements([]); setElementsFor(null); return; }
    void loadElements(selected);
  }, [selected, loadElements]);

  // A capture belongs to one window. Leaving it up while another window is
  // selected would offer clicks at coordinates that describe a different app,
  // and the tool would (correctly) refuse every one of them.
  useEffect(() => { setShot(null); setDragBand(null); }, [selected]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return elements;
    return elements.filter((el) => el.name.toLowerCase().includes(term) || el.type.toLowerCase().includes(term));
  }, [elements, filter]);

  async function press(element: ElementRow) {
    if (!selected) return;
    setNotice('');
    await dispatchAction('computer_press', {
      window: selected,
      index: element.index,
      // The guard is what turns "index 7" into a safe target: if the UI moved,
      // the CLI refuses instead of clicking whatever now sits at index 7.
      ...(element.name ? { expected: element.name } : {}),
    }, element.name || element.type);
  }

  async function activate() {
    if (!selected) return;
    const result = await dispatchAction('computer_activate', { window: selected });
    if (result) { setNotice(result.output); void refreshWindows(); }
  }

  async function screenshot() {
    // The selected window, not the desktop. A desktop grab returns whatever the
    // person is currently looking at — their browser, a chat, a game — which is
    // both the wrong subject and a privacy surprise. computer_window_shot
    // renders the target window in the background instead; the whole screen is
    // only captured when no window is selected.
    const result = selected
      ? await run('computer_window_shot', { window: selected })
      : await run('computer_screenshot');
    if (!result) return;
    const data = result.data as {
      computerImage?: { mediaType: string; data: string };
      screenshotId?: unknown;
      minimized?: unknown;
      image?: { width?: unknown; height?: unknown };
    } | undefined;
    const image = data?.computerImage;
    if (image) {
      const width = Number(data?.image?.width);
      const height = Number(data?.image?.height);
      // A minimized window is rendered offscreen for the capture, so the picture
      // is real but there is nowhere on screen to click. The tool refuses such a
      // click; showing the picture as clickable would offer a gesture that only
      // produces an error.
      const readOnly = data?.minimized === true;
      setShot({
        src: `data:${image.mediaType};base64,${image.data}`,
        ...(typeof data?.screenshotId === 'string' ? { screenshotId: data.screenshotId } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        label: selectedWindow ? windowLabel(selectedWindow) : '桌面',
        width: Number.isFinite(width) && width > 0 ? width : 0,
        height: Number.isFinite(height) && height > 0 ? height : 0,
      });
    }
    setNotice(result.output.split('\n')[0]);
  }

  /**
   * A click on the capture image, turned into the capture-relative form.
   *
   * The ratio matters: the image is downscaled before it is displayed (the CLI
   * caps it at 1568px), so a click at 700px in a 1568px-wide picture of a 2582px
   * window is window pixel 1152 — not 700. Sending the raw click would land it
   * more than a thousand pixels to the left, which is precisely the failure the
   * screenshotId model exists to remove.
   */
  function pointInShot(event: React.MouseEvent<HTMLImageElement>) {
    if (!shot || shot.width <= 0 || shot.height <= 0) return null;
    const img = event.currentTarget;
    const box = img.getBoundingClientRect();
    // clientLeft/clientWidth are the padding box — the 1px border is not part of
    // the picture, and counting it shifts every click down-right by a pixel at
    // small scales.
    const innerWidth = img.clientWidth || box.width;
    const innerHeight = img.clientHeight || box.height;
    if (innerWidth <= 0 || innerHeight <= 0) return null;
    return {
      x: Math.round((event.clientX - box.left - img.clientLeft) * (shot.width / innerWidth)),
      y: Math.round((event.clientY - box.top - img.clientTop) * (shot.height / innerHeight)),
    };
  }

  async function clickInShot(event: React.MouseEvent<HTMLImageElement>) {
    if (!shot?.screenshotId) return;
    // Shift means "this is a drag", not a click — the same image serves both,
    // because a canvas exposes neither a button nor a slider to press.
    if (event.shiftKey) return;
    const point = pointInShot(event);
    if (!point) return;
    const result = await dispatchAction(
      'computer_click',
      { window: selected ?? undefined, screenshotId: shot.screenshotId, x: point.x, y: point.y },
      `${point.x}, ${point.y}`,
    );
    if (result) {
      setShot((current) => (current ? { ...current, stale: true } : current));
      setNotice(result.output);
      if (selected) void loadElements(selected);
    }
  }

  /** Shift-press starts a drag; the band follows the pointer so the user can see
   *  where it will end before letting go. */
  function startDrag(event: React.MouseEvent<HTMLImageElement>) {
    if (!event.shiftKey || !shot?.screenshotId) return;
    event.preventDefault();
    const point = pointInShot(event);
    if (!point) return;
    setDragBand({ from: point, to: point });
  }

  function moveDrag(event: React.MouseEvent<HTMLImageElement>) {
    if (!dragBand) return;
    const point = pointInShot(event);
    if (point) setDragBand({ from: dragBand.from, to: point });
  }

  async function endDrag(event: React.MouseEvent<HTMLImageElement>) {
    if (!dragBand || !shot?.screenshotId) return;
    const target = pointInShot(event) ?? dragBand.to;
    const from = dragBand.from;
    setDragBand(null);
    // A press without travel is a click, not a drag; the tool would refuse it
    // anyway, and saying so here is clearer than an error bar.
    if (from.x === target.x && from.y === target.y) return;
    const result = await dispatchAction(
      'computer_drag',
      { window: selected ?? undefined, screenshotId: shot.screenshotId, fromX: from.x, fromY: from.y, toX: target.x, toY: target.y },
      `${from.x}, ${from.y} → ${target.x}, ${target.y}`,
    );
    if (result) {
      setShot((current) => (current ? { ...current, stale: true } : current));
      setNotice(result.output);
      if (selected) void loadElements(selected);
    }
  }

  async function sendText() {
    if (!selected || !typed.trim()) return;
    const result = await dispatchAction('computer_type', { window: selected, text: typed });
    if (!result) return;
    setNotice(result.output);
    setTyped('');
    void loadElements(selected);
  }

  async function sendKeys(keys: string) {
    if (!selected) return;
    const result = await dispatchAction('computer_key', { window: selected, keys }, keys);
    if (!result) return;
    setNotice(result.output);
    void loadElements(selected);
  }

  async function moveToCenter() {
    if (!selectedWindow) return;
    // A click on a window's centre is how you dismiss an overlay or focus a
    // canvas that exposes no accessible control at all — but it moves the
    // pointer, so it asks first. The window travels with the input so the
    // confirmation can name the app instead of saying "the desktop".
    const x = Math.round((selectedWindow.left + selectedWindow.right) / 2);
    const y = Math.round((selectedWindow.top + selectedWindow.bottom) / 2);
    const result = await dispatchAction('computer_click', { window: selected ?? undefined, x, y }, `${x}, ${y}`);
    if (result) setNotice(result.output);
  }

  /** Run the action the confirmation bar is holding. */
  async function confirmPending() {
    if (!pending) return;
    const action = pending;
    setPending(null);
    const result = await invokeNow(action.tool, action.input);
    // The picture showed the window as it was. After anything that changes it,
    // a second click on the same pixels would be aimed at content that is no
    // longer there — say so instead of letting the image pretend otherwise.
    if (result && shot) setShot((current) => (current ? { ...current, stale: true } : current));
    if (!result) return;
    setNotice(result.output);
    if (action.tool === 'computer_type') setTyped('');
    if (action.tool === 'computer_activate') void refreshWindows();
    if (selected && action.tool !== 'computer_screenshot') void loadElements(selected);
  }

  function askAgent() {
    const label = selectedWindow ? windowLabel(selectedWindow) : '桌面';
    const controls = visible.slice(0, 12).map((el) => `${el.name || el.type}（${ACTION_VERB[el.action] ?? el.action}）`).join('、');
    onAskAgent(
      `查看并操作「${label}」这个窗口（pid ${selected ?? '未知'}）。`
      + (controls ? `我已看到这些控件：${controls}。` : '')
      + '先用 computer_elements 读取它的界面，说明你能做什么，然后按我的目标操作。',
    );
  }


  if (!status) {
    return <div className="gui-panel gui-panel-empty"><LoaderCircle size={16} className="gui-spin" />正在连接电脑操控…</div>;
  }

  if (!status.ok) {
    return (
      <div className="gui-panel gui-panel-empty">
        <CircleAlert size={18} />
        <p>{status.reason ?? '电脑操控当前不可用。'}</p>
        <button type="button" className="gui-btn" onClick={() => void desktop.guiControl.status().then(setStatus)}>
          <RefreshCw size={14} />重试
        </button>
      </div>
    );
  }

  return (
    <div className="gui-panel">
      <header className="gui-head">
        <div className="gui-head-title">
          <Monitor size={16} />
          <div>
            <h1>电脑操控</h1>
            <p>{windows.length} 个窗口{screen ? ` · 屏幕 ${screen.width}×${screen.height}` : ''}</p>
          </div>
        </div>
        <div className="gui-head-actions">
          <button type="button" className="gui-btn" onClick={() => void refreshWindows()} disabled={Boolean(busy)}>
            <RefreshCw size={14} className={busy === 'computer_list_windows' ? 'gui-spin' : undefined} />刷新
          </button>
          <button
            type="button"
            className="gui-btn"
            onClick={() => void screenshot()}
            disabled={Boolean(busy)}
            title={selected ? '后台截取选中的窗口（不改变前台焦点）' : '未选中窗口时截取整个桌面'}
          >
            <Camera size={14} />{selected ? '截取窗口' : '截图'}
          </button>
          <button type="button" className="gui-btn gui-btn-accent" onClick={askAgent} disabled={!selected}>
            <Sparkles size={14} />交给智能体
          </button>
        </div>
      </header>

      {!desktopMode && (
        <div className="gui-banner">
          <ArrowRightLeft size={14} />
          <span>当前为「仅后台执行」。这个面板直接操作真实窗口，需要前台焦点；智能体在后台模式里只会使用隐藏浏览器。</span>
        </div>
      )}

      <div className="gui-body">
        <section className="gui-windows" aria-label="窗口列表">
          <div className="gui-section-title">窗口</div>
          {windows.map((window) => {
            const key = windowKey(window);
            return (
              <button
                type="button"
                key={key}
                className={`gui-window${key === selected ? ' active' : ''}${window.cloaked ? ' cloaked' : ''}`}
                onClick={() => setSelected(key)}
                title={`${window.class} · pid ${window.pid}${window.appPid ? ` · 应用 ${window.appPid}` : ''}${window.cloaked ? ' · 未显示' : ''}${window.iconic ? ' · 已最小化（位置是还原后的位置）' : ''}`}
              >
                <span className="gui-monogram">{monogram(windowLabel(window))}</span>
                <span className="gui-window-copy">
                  <span className="gui-window-title">{windowLabel(window)}</span>
                  <span className="gui-window-meta">
                    {window.class}
                    {window.cloaked ? ' · 未显示' : ''}
                    {/* A minimized window's size is the size it would come back
                        at, not something on screen — saying "已最小化" keeps the
                        numbers from reading as "this is where it is". */}
                    {window.iconic ? ' · 已最小化' : ` · ${Math.max(0, window.right - window.left)}×${Math.max(0, window.bottom - window.top)}`}
                  </span>
                </span>
              </button>
            );
          })}
          {windows.length === 0 && (
            <p className="gui-hint">没有可见窗口。先启动一个应用，再点刷新。</p>
          )}
        </section>

        <section className="gui-detail" aria-label="窗口控件">
          {selectedWindow ? (
            <>
              <div className="gui-detail-head">
                <div className="gui-detail-title">
                  <span>{windowLabel(selectedWindow)}</span>
                  <span className="gui-detail-meta">{elementsFor === selected ? `${elements.length} 个控件` : '读取中…'}</span>
                </div>
                <div className="gui-detail-actions">
                  <button type="button" className="gui-btn" onClick={() => void activate()} disabled={Boolean(busy)}>
                    <Crosshair size={13} />激活
                  </button>
                  <button type="button" className="gui-btn" onClick={() => void moveToCenter()} disabled={Boolean(busy)}>
                    <MousePointerClick size={13} />点中心
                  </button>
                  <button type="button" className="gui-btn" onClick={() => void loadElements(selected!)} disabled={Boolean(busy)}>
                    <RefreshCw size={13} className={busy === 'computer_elements' ? 'gui-spin' : undefined} />控件
                  </button>
                </div>
              </div>

              <input
                className="gui-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选控件名称或类型"
                aria-label="筛选控件"
              />

              <ul className="gui-elements">
                {visible.map((element) => (
                  <li key={element.index}>
                    <button
                      type="button"
                      className="gui-element"
                      onClick={() => void press(element)}
                      disabled={Boolean(busy)}
                      title={element.minimized
                        ? `${element.type} · 窗口已最小化，没有屏幕位置，只能按序号操作`
                        : `${element.type} · ${element.x},${element.y} ${element.width}×${element.height}`}
                    >
                      <span className="gui-element-index">{element.index}</span>
                      <span className="gui-element-name">{element.name || <em>{element.type}</em>}</span>
                      <span className={`gui-element-action ${element.action}`}>{ACTION_VERB[element.action] ?? element.action}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {visible.length === 0 && elementsFor === selected && (
                <p className="gui-hint">
                  {elements.length === 0
                    ? '这个窗口没有暴露可访问控件。用「点中心」或截图坐标点击它。'
                    : '没有匹配的控件。'}
                </p>
              )}

              <div className="gui-type-row">
                <Type size={14} />
                <input
                  className="gui-type-input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === 'Enter') { event.preventDefault(); void sendText(); }
                  }}
                  placeholder={`输入到「${windowLabel(selectedWindow)}」`}
                  aria-label="输入文本"
                  disabled={Boolean(busy)}
                />
                <button type="button" className="gui-btn" onClick={() => void sendText()} disabled={Boolean(busy) || !typed.trim()}>
                  输入
                </button>
              </div>
              <div className="gui-key-row">
                <Keyboard size={14} />
                {['{ENTER}', '{TAB}', '{ESC}', '^s', '^c', '^v'].map((keys) => (
                  <button key={keys} type="button" className="gui-key" onClick={() => void sendKeys(keys)} disabled={Boolean(busy)}>
                    {keys}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="gui-hint">从左侧选择一个窗口。</p>
          )}
        </section>
      </div>

      {(error || notice) && (
        <div className={`gui-status${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}
          <span>{error || notice}</span>
          <button type="button" className="gui-status-close" aria-label="关闭" onClick={() => { setError(''); setNotice(''); }}>
            <X size={13} />
          </button>
        </div>
      )}

      {/* Focus is the user's, not the panel's: every action that moves it stops
          here first. Enter confirms, Escape cancels, and the wording names the
          window so a mis-selected row is obvious before it happens. */}
      {pending && (
        <div className="gui-confirm" role="alertdialog" aria-label="确认前台操作">
          <CircleAlert size={14} />
          <span>{confirmText(pending.tool, pending.label, pending.detail)}</span>
          <button type="button" className="gui-btn gui-btn-accent" onClick={() => void confirmPending()} autoFocus>
            确认
          </button>
          <button type="button" className="gui-btn" onClick={() => setPending(null)}>取消</button>
        </div>
      )}

      {shot && (
        <div className="gui-shot">
          <div className="gui-section-title">
            截图
            <span className="gui-shot-meta">
              {shot.stale ? '已过期 · ' : ''}
              {shot.label}
              {shot.screenshotId
                ? shot.readOnly
                  ? ` · ${shot.screenshotId} · 已最小化，仅供查看`
                  : ` · ${shot.screenshotId} · 点图即点击，Shift+拖动`
                : ''}
            </span>
            {shot.stale && (
              <button type="button" className="gui-btn gui-btn-accent" onClick={() => void screenshot()} disabled={Boolean(busy)}>
                <Camera size={13} />重新截取
              </button>
            )}
            <button type="button" className="gui-status-close" aria-label="关闭截图" onClick={() => setShot(null)}><X size={13} /></button>
          </div>
          {shot.readOnly ? (
            // Minimized: the picture was rendered offscreen, so it has no
            // on-screen position. Clicking it would only produce the tool's
            // refusal, so the gesture is not offered at all.
            <img src={shot.src} alt={`${shot.label} 的窗口截图（已最小化，仅供查看）`} className="gui-shot-image readonly" />
          ) : shot.screenshotId ? (
            <div className="gui-shot-frame">
              <img
                src={shot.src}
                alt={`${shot.label} 的窗口截图${shot.stale ? '（已过期）' : ''}`}
                className={`gui-shot-image clickable${shot.stale ? ' stale' : ''}`}
                onClick={(event) => void clickInShot(event)}
                onMouseDown={startDrag}
                onMouseMove={moveDrag}
                onMouseUp={(event) => void endDrag(event)}
                onMouseLeave={() => setDragBand(null)}
                draggable={false}
              />
              {dragBand && shot.width > 0 && shot.height > 0 && (() => {
                // Percentage placement keeps the band aligned whatever the
                // panel's responsive scaling does to the picture.
                const left = Math.min(dragBand.from.x, dragBand.to.x) / shot.width * 100;
                const top = Math.min(dragBand.from.y, dragBand.to.y) / shot.height * 100;
                const width = Math.abs(dragBand.to.x - dragBand.from.x) / shot.width * 100;
                const height = Math.abs(dragBand.to.y - dragBand.from.y) / shot.height * 100;
                return (
                  <span
                    className="gui-shot-band"
                    style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                  />
                );
              })()}
            </div>
          ) : (
            <img src={shot.src} alt="当前桌面截图" className="gui-shot-image" />
          )}
        </div>
      )}

      {busy && <div className="gui-busy" aria-hidden="true" />}
    </div>
  );
}
