import type { TaskVerificationAttempt } from '../types';
import { verificationCheckLabels, verificationLabels } from '../lib/taskVerification';

const checkLabels = { running: '运行中', passed: '通过', failed: '失败', skipped: '未执行', cancelled: '已中断' };

function reasonText(reason?: string) {
  if (!reason) return '';
  if (reason.endsWith('script not found')) return '项目未配置该脚本';
  if (reason === 'cancelled by user') return '用户已停止本轮验证';
  if (reason === 'invalid or unreadable verification configuration') return '项目配置无效或无法读取';
  return reason;
}

export function TaskVerification({ attempts }: { attempts: TaskVerificationAttempt[] }) {
  if (!attempts.length) return null;
  return <section className="task-verification" aria-label="验证记录">
    <h4>验证记录 <span>{attempts.length} 轮</span></h4>
    {attempts.map((attempt, index) => <details className={`task-verification-attempt verification-${attempt.status}`} key={`${attempt.id}-${index}`} open={index === attempts.length - 1 && ['failed', 'cancelled', 'incomplete'].includes(attempt.status)}>
      <summary><span>第 {index + 1} 轮 · {attempt.phase === 'repair' ? '修复后验证' : '任务验证'}</span><strong>{verificationLabels[attempt.status]}</strong></summary>
      {attempt.status === 'skipped' && <p>本轮没有实际执行验证命令，请结合任务验收标准确认结果。</p>}
      {attempt.status === 'incomplete' && <p>此前失败的检查没有重新通过，任务仍需处理。</p>}
      {!attempt.results.length && attempt.status === 'cancelled' && <p>命令启动前已中断。</p>}
      {attempt.results.map((check, checkIndex) => <details className={`task-verification-check check-${check.status}`} key={`${check.name}-${checkIndex}`} open={check.status === 'failed'}>
        <summary><span>{verificationCheckLabels[check.name]} · {checkLabels[check.status]}</span><code>{check.command}</code></summary>
        <div className="task-verification-meta"><span>耗时 {(check.durationMs / 1000).toFixed(2)} 秒</span>{typeof check.exitCode === 'number' && <span>退出码 {check.exitCode}</span>}</div>
        {check.reason && <p>{reasonText(check.reason)}</p>}
        {check.output && <pre tabIndex={0} aria-label={`${check.name} 验证输出`}>{check.output}</pre>}
      </details>)}
    </details>)}
  </section>;
}
