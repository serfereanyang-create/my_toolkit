import React, { useEffect, useReducer, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { AppState, ChatItem } from '../src/types';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/workspace-shell.css';
document.documentElement.style.setProperty('--font-ui', 'var(--font-ui-zh)');

// ConversationStream renders tool cards that only call desktop.* on click; the
// measurement never clicks, so a permissive stub lets the real component load
// instead of a copy of it.
interface StubScope { [key: string]: unknown }
const stubMethod = async () => ({ ok: true });
const stubObject: StubScope = new Proxy({} as StubScope, {
  get: (_target, key) => (key === 'then' ? undefined : stubMethod),
});
(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = new Proxy({} as StubScope, {
  get: (_target, key) => (key === 'then' ? undefined : stubObject),
});

const [{ appReducer, initialState }, { ConversationStream }] = await Promise.all([
  import('../src/lib/state'),
  import('../src/components/ConversationStream'),
]);

/** A reply shaped like the real ones: headings, prose, list, table, fenced code. */
function replyText(seed: number, repeat = 3): string {
  const block = (index: number) => `### 第 ${index} 段：${seed + index} 的排查结论

这一轮先把 **构建失败** 的现场固定下来，再看 \`vite build\` 输出的差异。失败点在依赖预打包之后，
所以要先排除缓存，再排除真正的类型错误。

- 缓存目录被上一次中断的构建写坏
- 增量产物里的 chunk 名和新的入口对不上
- 旧版本 Node 读取了错误的条件导出

| 检查项 | 结果 | 备注 |
| --- | --- | --- |
| 冷启动构建 | 通过 | 清掉 \`node_modules/.vite\` |
| 增量构建 | 失败 | 复现稳定 |

\`\`\`ts
const cacheDir = resolve(root, 'node_modules', '.vite');
await rm(cacheDir, { recursive: true, force: true });
\`\`\`
`;
  return Array.from({ length: repeat }, (_unused, index) => block(index + 1)).join('\n');
}

/** The cadence measured on the real CLI bridge: one delta every ~31ms. */
const CHUNK = '这是流式输出的一个片段，大约十二个字。';

function historyChat(turns: number): ChatItem[] {
  const chat: ChatItem[] = [];
  const base = Date.now() - 600000;
  for (let index = 0; index < turns; index += 1) {
    chat.push({ id: `u${index}`, kind: 'user', text: `第 ${index + 1} 轮：构建为什么失败？`, ts: base + index * 60000 });
    chat.push({ id: `a${index}`, kind: 'assistant', text: replyText(index, 3) });
    chat.push({
      id: `turn${index}`, kind: 'turn',
      startedAt: base + index * 60000 + 1000, endedAt: base + index * 60000 + 4000,
      steps: [
        { id: `step${index}a`, kind: 'tool', status: 'done', tool: 'read_file', input: { path: 'src/build/cache.ts' }, output: 'export const cacheDir = 1;', ok: true, startedAt: base + index * 60000 + 1100, durationMs: 90 },
        { id: `step${index}b`, kind: 'tool', status: 'done', tool: 'run_command', input: { command: 'npm run build' }, output: 'vite build failed', ok: false, added: 0, removed: 0, startedAt: base + index * 60000 + 1200, durationMs: 2100 },
      ],
      files: [{ path: 'src/build/cache.ts', added: 12, removed: 4, checkpointIds: [`cp${index}`] }],
      added: 12, removed: 4,
    });
  }
  chat.push({ id: 'u-live', kind: 'user', text: '把结论展开讲一遍，尽量长一些。', ts: Date.now() });
  // 一个正在跑的回合：真实会话在流式期间 agentStatus 是 running 且有一个未结束的
  // turn，工作指示条（含“生成中 N 字 · X 字/秒”）只在这个条件下渲染。
  chat.push({
    id: 'turn-live', kind: 'turn', startedAt: Date.now() - 3000,
    steps: [{ id: 'step-live', kind: 'tool', status: 'running', tool: 'run_command', input: { command: 'npm run build' }, startedAt: Date.now() - 2900 }],
    files: [], added: 0, removed: 0,
  });
  return chat;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function Preview() {
  const [state, dispatch] = useReducer(appReducer, 24, (turns: number): AppState => {
    const chat = historyChat(turns);
    return { ...initialState, chat, activeSessionId: 'preview-session', workspaceRoot: 'C:/workspace/YOYcode' };
  });
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    const preview = {
      /** Rebuild the transcript from scratch so scenarios never share state. */
      reset: (turns = 24) => {
        dispatchRef.current({ type: 'chat/load', sessionId: 'preview-session', chat: historyChat(turns) });
        dispatchRef.current({ type: 'agent/status', status: 'running' });
      },
      /**
       * Push `deltas` assistant_delta events through the real reducer at the
       * cadence measured on the real CLI bridge (31ms), then report how the
       * renderer behaved: frame intervals, long tasks, dispatch→paint latency.
       */
      stream: async (options: { deltas?: number; gapMs?: number; chunk?: string } = {}) => {
        const deltas = options.deltas ?? 60;
        const gapMs = options.gapMs ?? 31;
        const chunk = options.chunk ?? CHUNK;
        const frames: number[] = [];
        let last = performance.now();
        let recording = true;
        const tick = (time: number) => {
          frames.push(time - last);
          last = time;
          if (recording) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const longTasks: number[] = [];
        let observer: PerformanceObserver | null = null;
        try {
          observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
          observer.observe({ entryTypes: ['longtask'] });
        } catch { observer = null; }
        const renderCosts: number[] = [];
        const layoutCosts: number[] = [];
        const startedAt = performance.now();
        for (let index = 0; index < deltas; index += 1) {
          const before = performance.now();
          // flushSync makes the synchronous render+commit cost observable even
          // in an offscreen window that is not painting at 60Hz. It is the same
          // work the app does per delta; only the scheduling differs.
          flushSync(() => { dispatchRef.current({ type: 'agent/event', event: { type: 'assistant_delta', text: chunk } }); });
          const rendered = performance.now();
          // Force layout the way a real paint would, then time that separately.
          void document.body.offsetHeight;
          layoutCosts.push(performance.now() - rendered);
          renderCosts.push(rendered - before);
          await sleep(gapMs);
        }
        const totalMs = performance.now() - startedAt;
        recording = false;
        observer?.disconnect();
        // Drop the first interval: it spans the time before streaming began.
        const measured = frames.slice(1);
        const sorted = [...measured].sort((left, right) => left - right);
        const pick = (values: number[], ratio: number) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * ratio))] : 0;
        const round = (value: number) => Math.round(value * 10) / 10;
        const live = document.querySelector('.msg-assistant.streaming');
        return {
          deltas,
          totalMs: Math.round(totalMs),
          frames: measured.length,
          frameMedian: round(pick(sorted, 0.5)),
          frameP95: round(pick(sorted, 0.95)),
          framesOver50: measured.filter((value) => value > 50).length,
          framesOver100: measured.filter((value) => value > 100).length,
          fps: round((measured.length / Math.max(1, totalMs)) * 1000),
          longTasks: longTasks.map((value) => Math.round(value)),
          longTaskTotal: Math.round(longTasks.reduce((sum, value) => sum + value, 0)),
          renderMedian: round(pick([...renderCosts].sort((left, right) => left - right), 0.5)),
          renderP95: round(pick([...renderCosts].sort((left, right) => left - right), 0.95)),
          renderMax: round(Math.max(...renderCosts)),
          renderTotal: Math.round(renderCosts.reduce((sum, value) => sum + value, 0)),
          layoutMedian: round(pick([...layoutCosts].sort((left, right) => left - right), 0.5)),
          layoutP95: round(pick([...layoutCosts].sort((left, right) => left - right), 0.95)),
          domNodes: document.querySelectorAll('*').length,
          renderSeries: renderCosts.map((value) => Math.round(value * 10) / 10),
          streamingTextLength: live?.textContent?.length ?? 0,
          rows: document.querySelectorAll('.stream-inner > *').length,
        };
      },
      finish: () => dispatchRef.current({ type: 'agent/event', event: { type: 'assistant_message', text: '完成。' } }),
      streamingTextLength: () => (document.querySelector('.msg-assistant.streaming') as HTMLElement | null)?.textContent?.length ?? 0,
    };
    (window as unknown as { conversationPreview: unknown }).conversationPreview = preview;
    document.documentElement.dataset.conversationPreviewReady = 'true';
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ConversationStream
        state={state}
        dispatch={dispatch}
        onApprove={() => {}}
        onEditUser={() => {}}
        onUndo={() => {}}
        onOpenFile={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
