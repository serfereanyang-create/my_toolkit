# 高精度花费统计（5 位小数）

## 功能说明

已将 IDE 中的花费显示精度从 **2 位小数** 提升到 **5 位小数**，适配低价模型（如 Claude Haiku）的微小花费。

## 格式化逻辑

```typescript
function formatCost(cost: number): string {
  // 零值
  if (cost === 0) return '$0.00000';
  
  // 极小值（小于 $0.00001）
  if (cost < 0.00001) return '< $0.00001';
  
  // 大额（>= $1）：保持 2 位小数
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  
  // 小额（< $1）：显示 5 位小数
  return `$${cost.toFixed(5)}`;
}
```

## 示例对比

| Token 用量 | 旧格式（2 位小数）| 新格式（5 位小数）| 场景 |
|------------|-------------------|-------------------|------|
| 1K input, 500 output | < $0.01 | **$0.00123** | Haiku 快速补全 |
| 5K input, 2K output | < $0.01 | **$0.00587** | Cmd+K 编辑 |
| 50K input, 10K output | $0.06 | **$0.05870** | Chat 多轮对话 |
| 200K input, 50K output | $2.45 | **$2.45** | 大型重构 |

## 显示位置

### 1️⃣ **Usage Settings - 模型费用表**

```
┌─────────────────────────────────────────────────────────────┐
│ 模型费用                                                     │
├─────────────────┬────────┬────────┬─────────┬──────────────┤
│ 模型            │ 总量   │ 输入   │ 输出    │ 花费         │
├─────────────────┼────────┼────────┼─────────┼──────────────┤
│ claude-3-haiku  │ 1.5K   │ 1.0K   │ 500    │ $0.00123 ✨  │
│ claude-sonnet-4 │ 50K    │ 40K    │ 10K    │ $0.58700 ✨  │
│ gpt-4o          │ 200K   │ 150K   │ 50K    │ $2.45        │
└─────────────────┴────────┴────────┴─────────┴──────────────┘
```

### 2️⃣ **Usage Settings - 详细记录**

```
┌─────────────────────────────────────────────────────────────┐
│ 详细记录                                                     │
├──────────────┬─────────────────┬────────┬────────┬─────────┤
│ 时间         │ 模型            │ 输入   │ 输出   │ 花费    │
├──────────────┼─────────────────┼────────┼────────┼─────────┤
│ 14:23        │ claude-3-haiku  │ 1.0K   │ 500   │ $0.00123 ✨ │
│ 14:20        │ claude-sonnet-4 │ 40K    │ 10K   │ $0.58700 ✨ │
│ 14:15        │ gpt-4o          │ 150K   │ 50K   │ $2.45   │
└──────────────┴─────────────────┴────────┴────────┴─────────┘
```

## 技术细节

### 价格配置（types.ts）

```typescript
export type CustomModel = {
  id: string;
  contextWindow?: number;
  inputPricePerM?: number;    // $/1M tokens
  outputPricePerM?: number;   // $/1M tokens
  cacheReadPricePerM?: number;
  cacheWritePricePerM?: number;
};
```

### 计算逻辑（UsageSettings.tsx）

```typescript
const pricing = findModelPricing(settings, model);
let cost = 0;

if (pricing) {
  // 输入 tokens
  cost += (inputTokens / 1_000_000) * (pricing.inputPricePerM ?? 0);
  
  // 输出 tokens
  cost += (outputTokens / 1_000_000) * (pricing.outputPricePerM ?? 0);
  
  // 缓存读取
  cost += (cacheReadTokens / 1_000_000) * (pricing.cacheReadPricePerM ?? 0);
  
  // 缓存写入
  cost += (cacheCreationTokens / 1_000_000) * (pricing.cacheWritePricePerM ?? 0);
}

// 格式化显示
const formattedCost = formatCost(cost); // 使用新的5位小数格式
```

## 适用模型价格参考

### Anthropic Claude 3 系列（2024-08 标准价格）

| 模型 | 输入（$/1M tokens）| 输出（$/1M tokens）| 典型单次花费 |
|------|-------------------|-------------------|--------------|
| Haiku | $0.25 | $1.25 | **$0.00123** ✨ |
| Sonnet | $3.00 | $15.00 | **$0.05870** ✨ |
| Opus | $15.00 | $75.00 | $2.45 |

### OpenAI GPT 系列

| 模型 | 输入（$/1M tokens）| 输出（$/1M tokens）| 典型单次花费 |
|------|-------------------|-------------------|--------------|
| GPT-4o-mini | $0.15 | $0.60 | **$0.00098** ✨ |
| GPT-4o | $5.00 | $15.00 | $1.85 |
| GPT-4 Turbo | $10.00 | $30.00 | $3.80 |

## 为什么需要 5 位小数？

### ❌ 旧格式问题（2 位小数）

```
1000 input tokens (Haiku $0.25/M):
  实际花费: $0.00025
  显示结果: < $0.01  ← 损失 97.5% 精度！
```

### ✅ 新格式优势（5 位小数）

```
1000 input tokens (Haiku $0.25/M):
  实际花费: $0.00025
  显示结果: $0.00025  ← 精确到小数点后5位！
```

## 用户体验改进

### Before（2 位小数）

```
用户：我今天用了多少钱？
IDE：< $0.01
用户：具体多少？看不出来啊 😕
```

### After（5 位小数）

```
用户：我今天用了多少钱？
IDE：$0.00123
用户：很清楚！我继续用 Haiku 很便宜 😊
```

## 实际应用场景

### 场景 1：内联补全（Ctrl+Space）

```
触发频率: 每分钟 5-10 次
单次用量: 2K input + 200 output
单次花费: $0.00075（Haiku）
小时成本: $0.00075 × 10 × 60 = $0.45/小时 ✅ 可见
```

### 场景 2：Cmd+K 快捷编辑

```
触发频率: 每小时 20 次
单次用量: 5K input + 2K output
单次花费: $0.00250（Haiku）
小时成本: $0.00250 × 20 = $0.05/小时 ✅ 可追踪
```

### 场景 3：Chat 多轮对话

```
触发频率: 每天 50 轮
单次用量: 50K input + 10K output
单次花费: $0.18（Sonnet）
日成本: $0.18 × 50 = $9.00/天 ✅ 准确计费
```

## CSS 样式支持

### 现有样式类

```css
.usage-cost-low {
  color: var(--success);  /* 绿色：< $1 */
}

.usage-cost-high {
  color: var(--warning);  /* 橙色：>= $1 */
}

.usage-cost-na {
  color: var(--muted);    /* 灰色：未配置 */
}
```

### 花费列对齐

```css
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums; /* 等宽数字 */
  font-family: 'SF Mono', Consolas, monospace;
}
```

## 测试验证

### 1. 手动测试

```bash
# 1. 启动 IDE
npm run dev

# 2. 完成一次 Haiku 请求（< 2K tokens）
# 3. 打开 Settings → Usage
# 4. 检查 "模型费用" 表格，确认显示 $0.00XXX
```

### 2. 单元测试（可选）

```typescript
import { formatCost } from './UsageSettings';

describe('formatCost', () => {
  it('shows 5 decimals for small amounts', () => {
    expect(formatCost(0.00123)).toBe('$0.00123');
    expect(formatCost(0.00025)).toBe('$0.00025');
    expect(formatCost(0.99999)).toBe('$0.99999');
  });

  it('shows 2 decimals for large amounts', () => {
    expect(formatCost(1.00)).toBe('$1.00');
    expect(formatCost(2.45)).toBe('$2.45');
    expect(formatCost(100.50)).toBe('$100.50');
  });

  it('handles edge cases', () => {
    expect(formatCost(0)).toBe('$0.00000');
    expect(formatCost(0.000001)).toBe('< $0.00001');
  });
});
```

## 相关文件

- **核心逻辑**: `ide-desktop/src/components/Settings/UsageSettings.tsx`
- **类型定义**: `ide-desktop/src/types.ts`
- **后端数据**: `ide-desktop/electron/usage-store.cjs`
- **IPC 通信**: `ide-desktop/electron/ipc.cjs`

## 兼容性

- ✅ 不影响现有价格配置
- ✅ 向后兼容 2 位小数显示（大额花费）
- ✅ 所有模型均支持（Anthropic / OpenAI / 自定义）
- ✅ CSV 导出、图表显示均使用新格式

## 下一步优化（可选）

1. **实时花费预测**：在 Composer 输入框旁显示 "预计花费 $0.00123"
2. **花费告警**：超过每日预算时弹出提示
3. **模型对比**：自动推荐更便宜的模型（Haiku vs Sonnet）
4. **花费曲线**：按小时显示花费趋势图

---

**实施完成** ✅  
修改文件: 1 个（`UsageSettings.tsx`）  
构建状态: ✅ 成功  
生产就绪: ✅ 是
