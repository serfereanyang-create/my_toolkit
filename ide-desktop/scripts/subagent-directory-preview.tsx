/**
 * subagent-directory-preview — 子智能体目录（`--page=subagent`）。
 *
 * 这一块列 `spawn_subagent` 派发的每个子会话：运行中 / 已结束两段、状态徽标、
 * 展开后的完整结果。它原来是「只靠 states-preview 顺带渲染过」的——`--page=panels`
 * 只接五个质量面板，所以它一次门禁都没进过。
 *
 * 冻结口径（离线）：`desktop.subagents.list/remove` 由本地录制替身回答。不 spawn
 * 子智能体、不读 sidecar、不连 CLI。
 *
 * 轮询注意：只要还有「运行中」的行，组件每 3s 会自己刷一次。替身每次回同一份数据，
 * 所以重渲染不改变盒子，但 `formatAgo` 的秒数会走——探针量的是几何与颜色，不受影响。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/workspace-shell.css';

type Stage = 'mixed' | 'expanded' | 'empty' | 'error';

const NOW = Date.now();

const RUNNING = [
  { id: 'sub-1', goal: '复审认证边界', expert: 'reviewer', status: 'running' as const, startedAt: NOW - 40000, steps: 6 },
  { id: 'sub-2', goal: '梳理模块依赖', expert: 'explorer', status: 'running' as const, startedAt: NOW - 12000, steps: 2 },
];

const FINISHED = [
  {
    id: 'sub-3', goal: '整理会话恢复流程的测试点', expert: 'reviewer', status: 'done' as const,
    startedAt: NOW - 900000, finishedAt: NOW - 600000, durationMs: 300000, steps: 12,
    answer: '已覆盖 4 个测试点：过期令牌、并发刷新、刷新失败回退、磁盘恢复。',
    subSessionId: 'sess-preview-sub-3',
  },
  { id: 'sub-4', goal: '审计 CSS token 命名', expert: 'explorer', status: 'failed' as const, startedAt: NOW - 1800000, finishedAt: NOW - 1750000, durationMs: 50000, steps: 3, answer: '读取 styles.css 时权限被拒。' },
  { id: 'sub-5', goal: '补充回归用例', expert: 'coder', status: 'interrupted' as const, startedAt: NOW - 2400000, finishedAt: NOW - 2300000, durationMs: 100000, steps: 5 },
];

// 三个开关就够：空态、错误态、正常态。切态时重挂组件，读的是同一份替身。
let empty = false;
let failure = false;

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  subagents: {
    list: async () => {
      if (failure) throw new Error('无法读取子智能体记录：EACCES: permission denied, open "C:/workspace/YOYcode/.aicode/subagents.json"');
      if (empty) return { running: [], finished: [] };
      return { running: RUNNING, finished: FINISHED };
    },
    remove: async () => ({ ok: true }),
  },
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount() {
  const { SubagentDirectory } = await import('../src/components/SubagentDirectory');

  function Preview() {
    const [nonce, setNonce] = useState(0);
    const pending = useRef<(() => void) | null>(null);
    useEffect(() => {
      (window as unknown as { subagentDirectoryPreview: unknown }).subagentDirectoryPreview = {
        stage: async (name: Stage) => {
          empty = name === 'empty';
          failure = name === 'error';
          await new Promise<void>((resolve) => { pending.current = resolve; setNonce((value) => value + 1); });
          if (name !== 'expanded') return;
          // 展开一条已结束的子会话：用户点的就是它的标题栏。取第一条（已完成、
          // 有正文和子会话 id），展开后才有 <pre> 正文与"子会话："那一段。
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const head = document.querySelector<HTMLElement>('.subagent-list .subagent-item-head');
            if (head) { head.click(); await frame(); await sleep(80); return; }
            await sleep(50);
          }
        },
      };
      document.documentElement.dataset.previewReady = 'true';
      if (pending.current) { const done = pending.current; pending.current = null; void frame().then(done); }
    }, [nonce]);
    // 真实挂载点是「工作区工具」面板的子智能体页签
    // （WorkspaceToolsPanel → .workspace-tools-subagents），外壳照原样。
    return (
      <div className="workspace-tools-subagents" style={{ padding: 16, maxWidth: 720 }}>
        <SubagentDirectory key={nonce} sessionId="preview-session" />
      </div>
    );
  }

  createRoot(document.getElementById('root')!).render(<Preview />);
}

void mount();
