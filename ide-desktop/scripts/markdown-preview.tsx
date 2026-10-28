import React, { useEffect, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, ChatItem } from '../src/types';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/workspace-shell.css';

/*
 * Typography / overflow scene for the markdown renderer.
 *
 * Eight extreme-content specimens, each in its own assistant row so a probe can
 * address it by index, plus a user bubble, a standalone tool card and a turn
 * step (the `.step-detail .tool-card` variant, which carries its own
 * `overflow: hidden`), and a synthetic 420px-wide markdown host for the narrow
 * case (task-board plan) that lives outside `.msg-assistant` — and therefore
 * outside the `overflow-wrap` that bubble happens to set.
 *
 * The rows go through the real ConversationStream, so the split between the
 * plain `.md` path and the `.code-block-with-actions` path is the same one the
 * app takes: a reply containing a fence renders its code outside `.md`.
 */

interface StubScope { [key: string]: unknown }
const stubMethod = async () => ({ ok: true });
const stubObject: StubScope = new Proxy({} as StubScope, {
  get: (_target, key) => (key === 'then' ? undefined : stubMethod),
});
(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = new Proxy({} as StubScope, {
  get: (_target, key) => (key === 'then' ? undefined : stubObject),
});

const [{ appReducer, initialState }, { ConversationStream }, { Markdown }] = await Promise.all([
  import('../src/lib/state'),
  import('../src/components/ConversationStream'),
  import('../src/components/Markdown'),
]);

// ── specimen bodies ────────────────────────────────────────────────────────
const LONG_URL = `https://api.example.com/v2/repositories/${'very-long-segment-'.repeat(8)}?redirect=${'x'.repeat(80)}&token=abcdef0123456789abcdef0123456789`;
const LONG_PATH = `C:\\Users\\34516\\ZCodeProject\\ide-desktop\\node_modules\\@electron\\${'deeply-nested-package-folder\\'.repeat(6)}index.js`;
const LONG_HASH = 'a3f1c9d7e5b24680' .repeat(10);
const LONG_INLINE = `npm_config_registry_${'segment'.repeat(20)}_token`;

function wideTable(): string {
  const cells = ['检查项', '结果', '耗时', '文件', '备注', '负责人', '状态', '链接'];
  const row = ['冷启动构建', '通过', '12.4s', 'src/build/cache.ts', '清掉 node_modules/.vite', 'alice', '已完成', 'https://ci.example.com/job/1234567890'];
  const head = `| ${cells.join(' | ')} |`;
  const sep = `| ${cells.map(() => '---').join(' | ')} |`;
  const body = Array.from({ length: 3 }, () => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

const SPECIMENS: Array<{ key: string; text: string }> = [
  {
    key: 'long-url',
    text: `这段说明里的链接很长，用来验证它会不会把容器撑破：${LONG_URL}\n\n还有一个行内链接 [同一个地址](${LONG_URL})，以及直接写出来的裸地址。`,
  },
  {
    key: 'long-path',
    text: `读取失败，路径是：\n\n${LONG_PATH}\n\n再重复一次：\`${LONG_PATH}\`。`,
  },
  {
    key: 'no-space-string',
    text: `校验和是 ${LONG_HASH}，中间没有任何空格。\n\n另一串不带空格的 minified 代码：const a=${'b'.repeat(180)};`,
  },
  { key: 'wide-table', text: `宽表格：\n\n${wideTable()}` },
  {
    key: 'wide-code',
    text: '超宽代码行：\n\n```ts\n' + `const generated = '${'abcdef0123456789'.repeat(24)}';` + '\n```\n\n上面这行没有换行，只能横向滚动。',
  },
  {
    key: 'nested-list',
    text: `深层嵌套列表：\n\n- 第一层\n  - 第二层\n    - 第三层\n      - 第四层的项目文字比较长，用来检查缩进之后的可用宽度\n- 第一层的第二项\n  1. 第二层有序\n  2. 第二层第二项`,
  },
  {
    key: 'emoji-cjk',
    text: `混排测试 👍🏽 中文与 English 混排，表情 👨‍👩‍👧‍👦 和旗帜 🇨🇳 都在同一段里，还有 \`构建 ✅ 通过\` 这样的行内混合。日本語のテキストも混ざります。한국어도 있습니다。\n\n- 列表里的 emoji 🚀 与前后的 CJK 字符紧挨着\n- **加粗的 🇨🇳 中文** 和 *斜体 emoji 🎉*`,
  },
  {
    key: 'long-inline-code',
    text: `环境变量的名字很长：\`${LONG_INLINE}\`，后面接着一段普通文字，用来观察行内代码断了之后还能不能读。`,
  },
  {
    // Not one of the eight overflow classes: the heading ladder itself, so the
    // probe can read all six source levels in one place.
    key: 'headings',
    text: '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n#### 四级标题\n\n##### 五级标题\n\n###### 六级标题\n\n每个标题后面的段落，用的是正文的 --fs-6。',
  },
  {
    // `>` quotes: single, blank-line-separated paragraphs, two nested levels,
    // and a list and a fence inside the quote. The nested case is the one that
    // eats horizontal room, so it lives here as well as in the narrow host.
    key: 'quote',
    text: [
      '引用块的样子：',
      '',
      '> 单层引用：缓存会在这一步清空，确认之后不可恢复。',
      '>',
      '> 第二段，用来确认引用内部也能分段。',
      '>',
      '> > 嵌套一层：继续深入，检查左侧竖线往里的内缩。',
      '> > > 嵌套两层：再深一层，看看可用宽度还剩多少。',
      '>',
      '> 引用里的列表：',
      '>',
      '> - 引用内的第一项',
      '>   - 引用内的第二层',
      '>     1. 引用内的第三层有序项',
      '>',
      '> 引用里的代码：',
      '>',
      '> ```sh',
      '> rm -rf node_modules/.vite',
      '> ```',
      '',
      '引用之后回到正文。',
    ].join('\n'),
  },
];

const USER_BUBBLE = `帮我看一下这个地址 ${LONG_URL} 以及路径 ${LONG_PATH} 是否存在问题，它的校验和是 ${LONG_HASH}。`;

/** Quote, nesting and the heading ladder inside the tightest real host: the
 *  plan surface at --fs-3, two `overflow: hidden` boxes, 396px of content. */
const NARROW_TEXT = ['nested-list', 'headings', 'quote']
  .map((key) => SPECIMENS.find((specimen) => specimen.key === key)?.text ?? '')
  .join('\n\n');

/** The narrow host: the four overflow classes plus a fence and a space-aligned
 *  block, so `.md-code-block` and `.md-pre-text` are measured too. */
const PLAN_TEXT = [
  SPECIMENS[0].text, SPECIMENS[1].text, SPECIMENS[2].text, SPECIMENS[3].text, SPECIMENS[4].text,
  `### 列对齐输出\n\n行数    文件    尺寸\n1200    src/build/cache.ts    48 KB\n88      src/main.tsx          3 KB`,
].join('\n\n');

function buildChat(): ChatItem[] {
  const ts = Date.now();
  const chat: ChatItem[] = [];
  chat.push({ id: 'user-long', kind: 'user', text: USER_BUBBLE, ts });
  SPECIMENS.forEach((specimen, index) => {
    chat.push({ id: `answer-${index}`, kind: 'assistant', text: specimen.text });
  });
  // Standalone tool card: its output area wraps rather than scrolls.
  chat.push({
    id: 'tool-long', kind: 'tool', status: 'done', tool: 'read_file',
    input: { path: LONG_PATH },
    output: `${LONG_PATH}\n${LONG_HASH}\n${'x'.repeat(220)}`,
    ok: true, startedAt: ts, durationMs: 120,
  });
  // The same card nested inside a turn step, where `.step-detail .tool-card`
  // adds `overflow: hidden`.
  chat.push({
    id: 'turn-long', kind: 'turn', startedAt: ts - 4000, endedAt: ts,
    steps: [{
      id: 'step-long', kind: 'tool', status: 'done', tool: 'run_command',
      input: { command: `cat ${LONG_PATH}` },
      output: `${LONG_HASH}\n${LONG_PATH}`,
      ok: true, startedAt: ts - 3900, durationMs: 90,
    }],
    files: [], added: 0, removed: 0,
  });
  return chat;
}

const settings = {
  activeProviderId: 'preview', approval: 'ask' as const, recentWorkspaces: [],
  providers: [{ id: 'preview', type: 'custom' as const, label: '工作模型', baseUrl: 'https://preview.invalid', model: 'gpt-5.4', models: [{ id: 'gpt-5.4', contextWindow: 128000 }] }],
  preferences: { reasoningEffort: 'high' as const },
};

function Preview() {
  const [state] = useReducer(appReducer, null, (): AppState => ({
    ...initialState, settings, workspaceRoot: 'C:/workspace/YOYcode',
    activeSessionId: 'markdown-preview', chat: buildChat(),
  }));

  useEffect(() => {
    document.documentElement.dataset.previewReady = 'true';
  }, []);

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <div className="chat-shell" style={{ width: 'auto', flex: '1 1 auto', minWidth: 0, height: '100vh', '--rail-w': '0px' } as React.CSSProperties}>
        <div className="main">
          <div className="main-topbar"><div className="main-title"><span>markdown typography probe</span></div></div>
          <ConversationStream
            state={state}
            dispatch={() => {}}
            onApprove={() => {}}
            onEditUser={() => {}}
            onUndo={() => {}}
            onOpenFile={() => {}}
            expandAll
          />
        </div>
      </div>
      {/* Narrow markdown host: the task-board plan lives outside .msg-assistant,
          so it never sees the bubble's own overflow-wrap, and it sits inside
          two `overflow: hidden` boxes of its own. Same classes, real renderer,
          fixed 420px card. */}
      <div className="probe-narrow" data-probe="plan" style={{ width: 420, flex: '0 0 420px', height: '100vh', padding: 12, overflow: 'auto', background: 'var(--bg-app)' }}>
        <div className="task-board-card">
          <div className="task-board-plan">
            <div className="task-board-plan-head"><span>计划</span></div>
            <div className="task-board-plan-clip expanded">
              <div className="task-board-plan-content">
                <Markdown text={PLAN_TEXT} />
              </div>
            </div>
          </div>
        </div>
        {/* Same 420px column, second card: quotes, three-level lists and the
            six heading sizes inside the plan surface (--fs-3, 396px of
            content, two `overflow: hidden` boxes) — the tightest host these
            three features actually ship into. */}
        <div data-probe="quote-narrow" style={{ marginTop: 16 }}>
          <div className="task-board-card">
            <div className="task-board-plan">
              <div className="task-board-plan-head"><span>引用 / 嵌套 / 标题</span></div>
              <div className="task-board-plan-clip expanded">
                <div className="task-board-plan-content">
                  <Markdown text={NARROW_TEXT} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
