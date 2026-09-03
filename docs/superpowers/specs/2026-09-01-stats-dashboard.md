# 统计仪表盘设计

日期：2026-09-01
状态：已实现
范围：科研论文辅助工作台（Electron 桌面端）；新增全局统计抽屉与 ECharts 可视化

## 1. 背景

当前统计能力仅有质量检查抽屉里的三个数字（论文数、证据数、待修引用数），无法回答"读到哪一步了""证据可靠性如何""集中在哪些年份和主题"这类问题。需要一个全局统计视图，把已有数据可视化。

## 2. 已确认决策

- 统计范围：**全部论文（全局口径）**，不受左栏搜索/状态/标签筛选影响
- 展现位置：**新增统计抽屉**，与质量/账户/综述抽屉互斥
- 图表实现：**引入 ECharts**，按需注册组件 + 动态 import
- 统计逻辑与图表分离：纯函数可 TDD，脱离 ECharts 即可测试

## 3. 目标

1. 一个入口即可查看整库阅读状态、证据可靠性、年份分布、标签热度和总体概览。
2. 统计口径与既有质量面板一致，不出现两套互相矛盾的数字。
3. 三套主题下图表均可读，深色主题不出现白底块。
4. 引入 ECharts 不显著拖慢首屏（动态导入，按需注册）。
5. 空库、缺字段、图表加载失败都有明确降级，不白屏。

## 4. 非目标

- 不做时间序列的"阅读进度趋势"（缺少逐次阅读时间戳数据）
- 不做统计结果导出为图片或 PDF
- 不做自定义图表配置、维度自选
- 不改账户、SQLite、论文与 AI 业务逻辑
- 不因统计需要给 Paper 增加新字段或迁移 schema

## 5. 架构

```text
渲染层 StatsDrawer（右侧抽屉 480，与 quality/account/review 互斥）
   │  输入：papers 全量（App 传入，非 filteredPapers）
   ▼
src/lib/paperStats.ts（纯函数，无 ECharts 依赖）
   buildPaperStats(papers) → PaperStats
   ▼
StatsDrawer 将 PaperStats 转为 ECharts option
   ▼
src/components/paper/StatsChart.tsx
   懒加载 echarts/core + 按需注册 + 主题色 + resize + dispose
```

### 5.1 模块边界

| 单元 | 职责 | 依赖 |
|---|---|---|
| `src/lib/paperStats.ts` | papers → 统计结果（纯函数） | 仅 Paper 类型 |
| `src/lib/paperStats.test.ts` | 统计单测 | vitest |
| `src/components/paper/StatsChart.tsx` | ECharts 实例生命周期、主题、尺寸、dispose | echarts（动态） |
| `src/components/paper/StatsDrawer.tsx` | 抽屉外壳、数字卡、option 编排、空态 | paperStats、StatsChart |
| `src/lib/uiState.ts` | ActiveDrawer 增加 `'stats'` | 无 |
| `src/App.tsx` | 入口菜单、抽屉渲染、传入全量 papers 与主题 | 上述组件 |

## 6. 统计数据模型

```ts
export type PaperStats = {
  total: number;                                   // 论文总数
  evidenceTotal: number;                           // 证据条目总数
  issueTotal: number;                              // 引用待修问题总数
  checklistCompletion: number;                     // 0–1，材料自查平均完成度
  byStatus: { status: PaperStatus; count: number }[];        // 固定五种状态，count 可为 0
  byReliability: { level: Reliability; count: number }[];    // 固定 高/中/低
  byYear: { year: string; count: number }[];                 // 升序；缺失归入 '未标注'
  topTags: { tag: string; count: number }[];                 // 频次降序，最多 10 项
};
```

### 6.1 口径定义（必须与现有 UI 一致）

- `total`：`papers.length`
- `evidenceTotal`：所有论文 `evidence` 条数之和
- `issueTotal`：复用现有 `inspectCitation(paper, papers)` 的问题条数总和；为避免循环依赖，`inspectCitation` 从 `App.tsx` 抽到 `src/lib/citationIssues.ts`，App 与统计模块共同引用（同一实现，杜绝两套口径）
- `checklistCompletion`：每篇论文按 `DEFAULT_CHECKLIST_ITEMS` 计算勾选比例，再对所有论文取平均；空库为 0
- `byStatus`：固定顺序 未读/粗读/精读/已摘录/待复核，无数据也保留 0
- `byReliability`：固定顺序 高/中/低，统计所有论文的证据条目
- `byYear`：`year` 去空白后为 4 位数字才算有效，否则归入 `'未标注'`；有效年份升序在前，`'未标注'` 排最后
- `topTags`：标签去空白后非空才计入；同一论文重复标签只计一次；频次降序，同频按标签名 `localeCompare('zh')` 升序；最多 10 项

## 7. 界面行为

### 7.1 入口

- 顶部"更多"菜单新增 `统计概览`
- 质量检查抽屉"导入 / 导出"上方新增 `统计概览` 按钮
- 打开时关闭其他抽屉（复用 `nextActiveDrawer`）

### 7.2 抽屉内容（自上而下）

1. **概览数字卡**：论文数、证据数、待修引用、自查完成度（百分比整数）
2. **阅读状态分布**：环形图（doughnut）
3. **证据可靠性**：柱状图（高/中/低）
4. **发表年份分布**：柱状图（按年份升序，含"未标注"）
5. **标签 Top 10**：横向柱状图（频次降序，最高在上）

### 7.3 空态与降级

- `total === 0`：整个抽屉显示 Empty「还没有论文，先新建或导入」，不渲染任何图表
- 单一维度无数据（如无标签、无证据）：该图表位显示占位文案（如「暂无标签数据」），其余图表照常渲染
- ECharts 动态导入失败：显示「图表加载失败」提示，**数字卡仍然显示**，不白屏

### 7.4 主题适配

- 图表主色取 `getThemeTokens(appTheme).accent`，文字色取 `textSecondary`，坐标轴与分割线取 `border`
- 图表背景透明，不使用 ECharts 内置 light/dark 主题，避免与应用主题冲突
- 主题切换时重新 `setOption`，无需重建实例

### 7.5 生命周期

- ECharts 实例在抽屉打开且容器可见后初始化
- 监听容器尺寸变化 `resize()`
- 抽屉关闭或组件卸载 `dispose()`，释放实例与监听

## 8. 依赖与打包

- 新增依赖：`echarts`
- 引入方式：`echarts/core` + 按需 `use([...])` 注册 PieChart、BarChart、GridComponent、TooltipComponent、LegendComponent、CanvasRenderer
- `StatsChart` 内部用动态 `import()` 加载 echarts，首屏不含图表代码
- 现有 >500 kB 的 chunk 警告已存在；本次要求：**主入口 chunk 不因 echarts 显著增大**（echarts 应进入独立异步 chunk）

## 9. 失败处理

| 情况 | 行为 |
|---|---|
| 论文库为空 | Empty 占位，不渲染图表 |
| 某维度无数据 | 该图表位占位文案，其余正常 |
| 年份缺失或非法 | 归入「未标注」，论文不丢失 |
| 标签全为空 | 标签图显示「暂无标签数据」 |
| ECharts 加载失败 | 「图表加载失败」提示 + 数字卡保留 |
| 抽屉关闭 | dispose 实例，无内存泄漏 |
| 主题切换 | 重新 setOption，图表不消失、不闪烁重建 |

## 10. 测试计划

### 10.1 自动化（vitest）

`paperStats`：
- 空库：total 0、各分布数组结构完整（byStatus/byReliability 仍含固定项且全 0）、checklistCompletion 0
- byStatus 固定五项顺序且计数正确
- byReliability 跨论文汇总证据可靠性
- byYear：有效年份升序、非法/空年份归入「未标注」且排最后
- topTags：频次降序、同频 zh 升序、同一论文重复标签只计一次、最多 10 项
- checklistCompletion：部分勾选取平均，结果在 0–1
- evidenceTotal / issueTotal 与逐条计算一致

`citationIssues`（抽取后）：
- 保持原有判定：缺作者/年份/来源、DOI 与 URL 均缺、DOI 重复
- App 使用抽取后的实现，行为不变

接线：
- `scripts/test-renderer-auth-wiring.cjs` 增加 `StatsDrawer`、`label: '统计概览'`、`'stats'` 标记
- `ActiveDrawer` 含 `'stats'`

构建：`npm test` 全绿、`npm run build` 通过

### 10.2 手动验收

1. 空库打开统计 → Empty 占位，无报错
2. 有数据 → 四张图与数字卡正确
3. 数字卡与质量抽屉的论文/证据/待修数字**完全一致**
4. 冰川蓝/暖纸白/午夜黑逐个切换 → 图表可读、深色无白底块
5. 左栏搜索或筛选变化 → 统计数字**不变**（全局口径）
6. 与质量/账户/综述抽屉互斥；关闭后再开正常
7. 桌面端启动无控制台报错，DevTools 仍禁用

## 11. 完成定义

- 统计抽屉可用，含数字卡与四张图表
- 统计口径与既有面板一致，且来自同一份 `citationIssues` 实现
- 全局口径不受筛选影响
- 三套主题图表可读
- 空态与加载失败均有降级
- echarts 进入独立异步 chunk，主入口未显著增大
- `npm test` 全绿、`npm run build` 通过、桌面冒烟无报错
