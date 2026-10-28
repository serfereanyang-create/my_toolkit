/**
 * task-board-preview — 任务计划卡（`--page=tasks`）。
 *
 * 这块是 TaskBoardCard：计划正文（可折叠 Markdown）、总体进度、按依赖层级分的
 * 阶段、每条任务的验收标准 / 结果 / 验证徽标、底部动作（确认 / 暂停 / 跳过 / 重开）。
 * 它从来只在 app 级的 `app-task-board-checks.cjs` 里被"能渲染出来吗"检查过，
 * 颜色和边框没进过 a11y 门禁。
 *
 * 冻结口径（离线）：纯 props 组件，`onAction` 只把动作记到 window 上。不连 CLI、
 * 不写 sidecar。
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TaskBoard } from '../src/types';
import '../src/styles.css';
import '../src/workspace-shell.css';

type Stage = 'active' | 'detail' | 'waiting' | 'invalid';

const STARTED = Date.now() - 125000;

const PLAN = [
  '## 恢复流程复审',
  '',
  '1. 读 `restoreSession` 与 `refresh` 两条路径，确认过期令牌在写入前被拦下。',
  '2. 把并发刷新收敛到同一个 Promise，避免 N 个请求各发一次刷新。',
  '3. 为刷新失败补一条集成测试，覆盖磁盘恢复回退。',
  '4. 复核 `sessionEvents` 的订阅在卸载时释放。',
  '',
  '> 边界：不改动 CLI 侧的会话协议，只碰渲染层与 token 校验。',
].join('\n');

const ACTIVE: TaskBoard = {
  id: 'board-preview',
  title: '认证流程复审',
  goal: '检查会话恢复和令牌刷新边界',
  status: 'active',
  runtimeMode: 'executing',
  activeTaskId: 't2',
  startedAt: STARTED,
  planMarkdown: PLAN,
  tasks: [
    { id: 't1', title: '检查会话恢复路径', status: 'done', dependsOn: [], acceptance: '恢复流程不抛错，过期令牌返回空', resultSummary: '已完成：拦截点补在写入之前。' },
    {
      id: 't2', title: '验证并发令牌刷新', status: 'in_progress', dependsOn: ['t1'],
      acceptance: '并发 8 个请求只发起 1 次刷新', detail: '用 Promise 共享首次刷新结果。',
      verification: [
        { id: 'v1', phase: 'initial', status: 'failed', startedAt: '2026-10-27T10:00:00Z', finishedAt: '2026-10-27T10:02:00Z', summary: '并发用例失败', results: [{ name: 'test', command: 'npx vitest run tests/session.test.cjs', status: 'failed', exitCode: 1, durationMs: 8200, output: 'expected 1 call, received 8' }] },
        { id: 'v2', phase: 'repair', status: 'running', startedAt: '2026-10-27T10:03:00Z', summary: '重跑中', results: [] },
      ],
    },
    { id: 't3', title: '补充回归测试', status: 'pending', dependsOn: ['t2'], acceptance: '刷新失败回退到磁盘恢复有覆盖' },
    { id: 't4', title: '复核事件订阅释放', status: 'blocked', dependsOn: ['t2'], error: '等待 t2 完成后再跑内存泄漏检查' },
  ],
};

const WAITING: TaskBoard = {
  id: 'board-waiting', title: '依赖升级计划', goal: '把 Vite 与 Electron 升到当前 LTS', status: 'draft', runtimeMode: 'awaiting_confirm', startedAt: STARTED,
  tasks: [
    { id: 'w1', title: '锁定目标版本', status: 'pending', dependsOn: [], acceptance: '版本矩阵写进 README' },
    { id: 'w2', title: '跑一次全量构建', status: 'pending', dependsOn: ['w1'], acceptance: '构建与测试全绿' },
  ],
};

// 循环依赖：inspectTaskGraph 会把它判成"依赖异常"，卡片换成告警块而不是继续执行。
const INVALID: TaskBoard = {
  id: 'board-invalid', title: '循环依赖示例', goal: '验证依赖异常时的提示', status: 'active', runtimeMode: 'executing', startedAt: STARTED,
  tasks: [
    { id: 'x1', title: '任务甲', status: 'pending', dependsOn: ['x2'] },
    { id: 'x2', title: '任务乙', status: 'pending', dependsOn: ['x1'] },
  ],
};

const BOARDS: Record<Stage, TaskBoard> = { active: ACTIVE, detail: ACTIVE, waiting: WAITING, invalid: INVALID };

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  agent: { taskBoardAction: async () => ({ ok: true }) },
  clipboard: { writeText: async () => ({ ok: true }) },
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount() {
  const { TaskBoardCard } = await import('../src/components/TaskBoardCard');

  function Preview() {
    const [stage, setStage] = useState<Stage>('active');
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
      (window as unknown as { taskBoardPreview: unknown }).taskBoardPreview = {
        stage: async (name: Stage) => {
          setStage(name);
          await frame();
          setNonce((value) => value + 1);
          await frame();
          if (name !== 'detail') return;
          // 展开当前任务那一条，把验收标准、结果与验证记录一起放出来。
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const item = document.querySelector<HTMLElement>('.task-board-item.current .task-board-item-head');
            if (item) { item.click(); await frame(); await sleep(80); return; }
            await sleep(50);
          }
        },
        actions: () => [],
      };
      document.documentElement.dataset.previewReady = 'true';
    }, [stage, nonce]);
    return (
      <div style={{ padding: 16, maxWidth: 720 }}>
        <TaskBoardCard key={`${stage}:${nonce}`} board={BOARDS[stage]} onAction={() => {}} />
      </div>
    );
  }

  createRoot(document.getElementById('root')!).render(<Preview />);
}

void mount();
