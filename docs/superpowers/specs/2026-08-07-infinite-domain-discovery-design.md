# 无限值域显示 + 有效域发现引擎 + 复数坐标 + 预览窗 设计文档

**日期**: 2026-08-07
**状态**: 设计已批准，待实现
**关联应用**: `math-visualizer/`（本地 Electron 桌面数学函数可视化工具）

## 1. 背景与问题

当前 2D 函数只显示固定区间（默认 `[-10, 10]`），用户提出两个核心诉求：

1. **"无限显示，所有值域"** —— 不要写死区间，图像应覆盖函数真正有取值、有意义的整个范围。
2. **有些函数在原点附近无定义**（例如 `sqrt(x-10000)`、`1/(x-500)`、`log(x-1e6)`），固定看原点附近等于什么都看不到。因此该能力必须**统一扩展**到 3D、极坐标、以及尚未实现的**复数坐标**。

关键约束（用户明确）：**范围必须由函数/表达式本身推导得出**，不是去网上查图抄。即纯粹的数值 + 符号分析。

## 2. 目标

- 打开/输入任意函数后，**自动聚焦到该函数有效的区域**（首屏就能看到有意义的图像），而不是死盯原点。
- 用户仍可自由缩放/平移；缩放后按新视口**自适应重采样**，保持精度。
- 提供一个**默认隐藏**、可调大小、可折叠的**预览窗**，展示"全局有效域地图"，点击即可跳转聚焦。
- 新增**复数坐标工作区**（复域着色 / 复映射轨迹 / 四分量视图 / 黎曼曲面），风格与现有面板统一。

### 非目标

- 不做云端、协作、动画导出（属于后续扩展）。
- 不追求对病态函数（处处稠密奇点等）的完美处理，只需给出合理的启发式聚焦 + 兜底默认区间。

## 3. 整体架构

四个新增/改造模块：

1. **有效域发现引擎 (Domain Discovery Engine)** —— `src/lib/domainDiscovery.ts`（新建）
2. **视口模型 (Viewport Model)** —— 改造 `FunctionDef` / `PlotSettings`，引入 `rangeMode`
3. **预览窗 (Preview Window)** —— 新增 UI 浮层组件 + 全局有效域地图渲染
4. **复数工作区 (Complex Workspace)** —— `src/lib/complexEngine.ts`（新建）+ 新 Tab

## 4. 有效域发现引擎 (Domain Discovery Engine)

核心思想：**表达式驱动的数值探测**，找到函数"有有限实值"的区间，并挑出信息量最大的一段作为首屏视口。

### 4.1 输入 / 输出

```typescript
interface DomainDiscoveryResult {
  // 全局发现的有效区间（可能多段，用于预览窗地图）
  validIntervals: Array<[number, number]>;
  // 建议的首屏视口（x 方向）
  focusRange: [number, number];
  // 建议的 y 方向视口（按 focusRange 内的取值算得）
  focusYRange: [number, number];
  // 是否找到有效区；false 时回退默认 [-10,10]
  found: boolean;
  // 检测到的特征：奇点、渐近、周期性等，用于提示与采样加密
  features: {
    singularities: number[];      // 疑似奇点/竖直渐近
    periodic?: number;            // 探测到的周期（如 sin）
    monotonicUnbounded?: boolean; // 单调无界（如 exp、线性）
  };
}

function discoverDomain(
  expr: string,
  variable: string,        // detect1DVar 得到的自变量名
  opts?: { maxSpan?: number; sampleBudget?: number }
): DomainDiscoveryResult;
```

### 4.2 算法：指数区间探测 (exponential interval probing)

不假设函数在原点附近有值。步骤：

1. **多尺度粗扫**：以对数尺度在 `x ∈ ±{0, 1, 10, 100, 1e3, 1e4, 1e5, 1e6}` 及其间插值点上评估表达式（正负对称），记录哪些点得到有限实数（`isFinite` 且非 `NaN`/复数）。
   - 用现有 `evaluateBatch` 批量算，避免逐点开销。
2. **区间合并**：把连续有值的采样点合并成候选有效区间 `validIntervals`。
3. **边界二分细化**：对每个区间端点，在"有值/无值"跳变处做二分（~20 次），精确定位定义域边界（如 `sqrt(x-10000)` 精确定位到 `x=10000`）。
4. **奇点检测**：相邻采样点值出现符号翻转且幅度爆炸 → 记为 `singularities`（如 `1/(x-500)` 在 500 处）。
5. **周期检测**：对整段有界函数做自相关/过零间隔估计，若近似周期 `P`，则 `focusRange` 取 `[-1.5P, 1.5P]`，展示几个完整周期即可。
6. **首屏聚焦挑选 `focusRange`**：
   - 有有限有效区 → 取"信息密度最高"的一段：优先包含奇点邻域、极值、过零点的区间；否则取最长有界区间，并留 10% 边距。
   - 单调无界（exp/线性）→ 以能看清形态的窗口为准（如让 y 跨越 ~3 个数量级对应的 x 宽度）。
   - 找不到任何有限值 → `found=false`，回退 `[-10,10]`。
7. **`focusYRange`**：在 `focusRange` 内采样，取值的 [p2, p98] 分位数（抗离群），再留 8% 边距，避免奇点把 y 轴拉爆。

### 4.3 与 3D / 极坐标的统一

- **3D `z=f(x,y)`**：对 x、y 各跑一次一维探测（固定另一变量取候选中心），得到各自 `focusRange`，组合成矩形视口；`z` 方向用分位数裁剪。
- **极坐标 `r=f(θ)`**：θ 天然是 `[0, 2π]`（或探测周期取整数倍），对 `r(θ)` 做有界性/分位数分析决定径向缩放。
- **复数**：见第 7 节，复平面上按模长分位数确定显示窗口。

### 4.4 性能

- 总采样预算 `sampleBudget` 默认 ~2000 点，全部走批量评估。
- 结果随表达式缓存（key = expr+variable）；表达式不变、只平移缩放视口时不重算发现，只做重采样。

## 5. 视口模型 (Viewport Model)

现有 `FunctionDef.range` 保留为"用户显式设定"。新增运行期视口状态：

```typescript
type RangeMode = 'auto' | 'manual' | 'locked';

interface ViewportState {
  rangeMode: RangeMode;
  // 发现引擎结果（auto 模式的数据源）
  discovered?: DomainDiscoveryResult;
  // 当前实际用于渲染的视口
  viewport: { x: [number, number]; y?: [number, number]; z?: [number, number] };
}
```

三种模式语义：

- **auto**（默认）：视口 = 发现引擎的 `focusRange/focusYRange`。表达式变化 → 重新发现 → 重新聚焦。
- **manual**：用户拖动/滚轮缩放后进入。视口 = 用户当前所见；表达式不变时不再自动跳。按当前视口自适应重采样。
- **locked**：用户在编辑器里显式填了固定区间并点锁定。完全尊重用户区间，发现引擎只用于预览窗展示，不改主图。

**自适应重采样**：Plotly `relayout` 事件（缩放/平移）→ 拿到新 `xaxis.range` → 在该范围内按 `samples` 重新 `generate2DData` → 更新 trace。放大细节不失真，缩小不过采样。用防抖（~150ms）避免拖动过程狂算。

## 6. 预览窗 (Preview Window)

默认**隐藏**。作为主图区右下角的浮层。

### 6.1 状态机

三态：`hidden`（默认）→ `expanded` → `collapsed`。

- **hidden**：不渲染浮层。工具栏出现「显示预览」按钮。
- **expanded**：右下角浮层，含标题栏（▾ 折叠 / ✕ 隐藏）+ 全局有效域地图画布 + 右下拖拽手柄。
- **collapsed**：只留标题条（~180×28），点 ▾ 展开。

状态持久化在 `PlotSettings.preview`，重开工程保留。

```typescript
interface PreviewState {
  mode: 'hidden' | 'expanded' | 'collapsed';
  width: number;   // 180 ~ 主图区 45%
  height: number;  // 120 ~ 主图区 45%
}
```

### 6.2 尺寸约束

- 最小 `180 × 120`；最大 `≈ 主图区 45%`（随窗口变化动态 clamp）。
- 右下角拖拽手柄改大小；collapsed 时宽度沿用、高度固定标题条高。

### 6.3 全局有效域地图

预览窗画布内容（数据来自发现引擎 `validIntervals`）：

- **绿色区块** = 该 x 区间函数有有限取值。
- **红色竖线/断点** = `singularities`。
- **蓝色框** = 主图当前 `viewport` 在全局中的位置。
- 顶部一条对数刻度轴，覆盖发现到的全局跨度（可能 `-1e6 ~ 1e6`），让用户一眼看清"函数在哪儿有东西"。

### 6.4 联动

- **点击绿色区块** → 主图 `rangeMode='auto'` 并 `focusRange` 设为该区块 → 主图跳转聚焦。
- **拖动蓝色框** → 主图 `rangeMode='manual'`，视口随蓝框平移。
- 主图缩放/平移 → 蓝框实时随动（单向：主图动 → 蓝框动；蓝框拖 → 主图动，不形成回环，用"谁在拖"标志位隔离）。

## 7. 复数工作区 (Complex Workspace)

新增 Tab `complex`。自变量为复数 `z = x + i·y`，表达式经 mathjs 复数运算求值（mathjs 原生支持 `complex`、`i`）。`src/lib/complexEngine.ts` 提供批量复数评估与颜色映射。

四种可视化（用户已选，统一风格）：

1. **复域着色 (Domain Coloring)**（默认）：在复平面网格上算 `w=f(z)`，用 HSL 编码——色相=`arg(w)`，明度=`|w|`（对数压缩）。Plotly `heatmap`/`image` 呈现。发现引擎在此按 `|f(z)|` 的分位数决定复平面显示窗口。
2. **复映射轨迹 (Mapping Trajectory)**：把输入侧的网格线/圆（如同心圆 + 辐射线）经 `f` 映射，画出像曲线，直观看"形变"。
3. **四分量视图 (Quadrant View)**：`2×2` 子图分别画 `Re(f)`、`Im(f)`、`|f|`、`arg(f)` 的伪彩热图，共享同一复平面窗口。
4. **黎曼曲面 (Riemann Surface)**：3D，`x,y` 为复平面，`z = Re(f)` 或 `|f|`，颜色叠加 `arg`，用现有 3D 场景渲染多值分支的抬升。

复数模式下发现引擎降级为"复平面模长分位数窗口"：粗扫复平面找 `|f(z)|` 有限的区域，避开极点，给出方形聚焦窗。

## 8. 数据结构改动汇总

`src/types/index.ts`：

```typescript
// FunctionDef 新增
interface FunctionDef {
  // ...existing...
  rangeMode?: RangeMode;         // 默认 'auto'
  viewport?: ViewportState['viewport'];
}

// PlotSettings 新增
interface PlotSettings {
  // ...existing... (autoRange 字段并入 rangeMode 语义，保留兼容)
  preview: PreviewState;         // 预览窗持久状态
}

// 新增复数函数类型
type FunctionType = /* ...existing... */ | 'complex';
interface ComplexConfig {
  view: 'domain-color' | 'mapping' | 'quadrant' | 'riemann';
  surfaceComponent?: 're' | 'abs';   // riemann 用
}
```

## 9. 实现顺序（后续 plan 展开）

1. `domainDiscovery.ts`：指数探测 + 边界二分 + 奇点/周期检测 + 首屏聚焦（含单元测试：sqrt(x-10000)、1/(x-500)、sin(x)、exp(x)、log(x-1e6)）。
2. 接入 2D：`rangeMode='auto'` 首屏聚焦 + relayout 自适应重采样。
3. 扩展 3D / 极坐标聚焦。
4. 预览窗组件（三态浮层 + 全局有效域地图 + 联动）。
5. `complexEngine.ts` + 复数 Tab 四视图。
6. 打包验证（真实 .exe，非 .bat），回归现有功能（切割面、查询点、多函数、填充）。

## 10. 风险与兜底

- **病态函数**（处处奇点、极慢发散）：发现引擎有采样预算上限，超时/无有限值即回退 `[-10,10]` 并在预览窗提示"未能自动定位有效域"。
- **重采样性能**：防抖 + 采样点上限；大跨度对数扫描控制在预算内。
- **复数求值异常**：mathjs 复数结果需判 `NaN/Infinity`，映射前过滤。
- **不破坏现有功能**：viewport 改造对 `locked` 显式区间完全透明，回归测试覆盖切割/查询/填充。

