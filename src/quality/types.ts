/**
 * quality/types.ts — 代码质量门禁类型定义
 *
 * 门禁（QualityGate）= 对代码库的一个可量化检查项，带阈值与阻断语义。
 * 工作流引擎的 gate 节点、CLI 工具、桌面质量面板共用这套类型。
 */

export type GateType =
  | 'complexity'   // 圈复杂度：critical 函数数量
  | 'smells'       // 代码异味：critical+major 异味数量
  | 'security'     // 安全扫描：critical+high 问题数量
  | 'test_ratio'   // 测试文件比例（%）
  | 'quality'      // 综合质量分（0-100，来自 auditCodeQuality）
  | 'declared';    // 外部声明的指标值（如真实覆盖率，由调用方传入）

export type GateSeverity = 'low' | 'medium' | 'high' | 'critical';

export type QualityGate = {
  name: string;
  type: GateType;
  /**
   * 阈值含义随类型不同：
   * - complexity/smells/security: 允许的最大问题数（≤ 阈值通过）
   * - test_ratio/quality: 最低要求值（≥ 阈值通过）
   */
  threshold: number;
  /** 阻断门禁失败时中止流程；非阻断仅记录告警 */
  blocking: boolean;
  /** glob 匹配参与检查的文件，默认匹配全部 ts/tsx 源文件（见 DEFAULT_GATE_PATTERN） */
  pattern?: string;
  /** declared 类型必填：调用方直接提供的指标值 */
  declaredValue?: number;
};

export type GateResult = {
  name: string;
  type: GateType;
  passed: boolean;
  /** 实际测得的指标值 */
  value: number;
  threshold: number;
  /** 阈值方向：'max' 表示 ≤ 通过，'min' 表示 ≥ 通过 */
  direction: 'max' | 'min';
  blocking: boolean;
  /** 门禁对人可读的一句话结论 */
  message: string;
  /** 失败时的具体证据（前 N 条） */
  evidence?: string[];
  durationMs: number;
};

export type QualityGateReport = {
  passed: boolean;
  /** 有任一阻断门禁失败时为 true */
  blocked: boolean;
  timestamp: string;
  durationMs: number;
  results: GateResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    blockingFailures: number;
  };
};

/** 预置门禁套件 */
export type GatePresetName = 'strict' | 'standard' | 'relaxed';

export const GATE_PRESETS: Record<GatePresetName, QualityGate[]> = {
  strict: [
    { name: '圈复杂度', type: 'complexity', threshold: 0, blocking: true },
    { name: '代码异味', type: 'smells', threshold: 0, blocking: true },
    { name: '安全问题', type: 'security', threshold: 0, blocking: true },
    { name: '测试比例', type: 'test_ratio', threshold: 40, blocking: true },
    { name: '综合质量分', type: 'quality', threshold: 80, blocking: false },
  ],
  standard: [
    { name: '圈复杂度', type: 'complexity', threshold: 3, blocking: true },
    { name: '代码异味', type: 'smells', threshold: 5, blocking: false },
    { name: '安全问题', type: 'security', threshold: 1, blocking: true },
    { name: '测试比例', type: 'test_ratio', threshold: 20, blocking: false },
    { name: '综合质量分', type: 'quality', threshold: 60, blocking: false },
  ],
  relaxed: [
    { name: '圈复杂度', type: 'complexity', threshold: 10, blocking: false },
    { name: '代码异味', type: 'smells', threshold: 20, blocking: false },
    { name: '安全问题', type: 'security', threshold: 5, blocking: true },
    { name: '测试比例', type: 'test_ratio', threshold: 10, blocking: false },
    { name: '综合质量分', type: 'quality', threshold: 40, blocking: false },
  ],
};

export const DEFAULT_GATE_PATTERN = '**/*.{ts,tsx}';
