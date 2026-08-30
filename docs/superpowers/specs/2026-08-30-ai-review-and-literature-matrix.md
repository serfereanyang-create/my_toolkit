# AI 综述生成与文献矩阵导出设计

日期：2026-08-30
状态：已实现
范围：科研论文辅助工作台（Electron 桌面端）；新增 OpenAI 兼容 LLM 集成、流式综述生成、文献矩阵导出

## 1. 背景

应用目前是纯本地论文阅读与证据管理工具，导出能力停留在单篇 Markdown 与全库 JSON。用户需要一个从多篇论文证据直接产出"综述初稿"的能力，以及把筛选结果整理成文献矩阵表格的导出。综述文本通过接入大模型（OpenAI 兼容协议）生成；文献矩阵为确定性纯函数，不依赖 AI。

## 2. 已确认决策

- 输入范围：**当前筛选结果**（搜索词 + 状态 + 标签），左栏筛选即选择器，不新增勾选 UI
- 输出形态：**综述 Markdown + 文献矩阵表格**，两个独立导出入口
- 综述生成：**接入 AI**（OpenAI 兼容协议），流式输出
- 交互：**预览清单 + 流式生成**，可重新生成、可编辑、另存 `.md`
- 架构：**主进程代理 + safeStorage**，渲染进程不接触明文 key

## 3. 目标

1. 用户配置一次 OpenAI 兼容服务（baseUrl / apiKey / model / temperature）后，可对任意筛选结果一键生成综述初稿。
2. 综述生成过程流式可见、可取消、可重试，结果可编辑并保存。
3. 文献矩阵导出零依赖 AI，任意筛选结果可用。
4. API Key 用 Electron `safeStorage` 加密落盘，渲染进程、日志、localStorage 均无明文。
5. 失败路径全部有明确反馈，不静默截断、不写半成品文件。

## 4. 非目标

- 不支持 Anthropic 原生协议或其他协议（仅 OpenAI 兼容 `/chat/completions`）
- 不做多轮对话、不保存会话历史
- 不做矩阵格式自定义（列固定，见 §7）
- 不做本地模板综述回退（未配置 AI 时综述禁用，矩阵可用）
- 不改账户、SQLite、论文业务逻辑

## 5. 架构

```text
渲染层 ReviewDrawer（预览清单 → 流式 Markdown → 编辑 / 另存）
   │  invoke: ai:get-config / ai:save-config / ai:test-connection
   │          ai:generate-review / ai:cancel-review
   │  on: ai:review-chunk / ai:review-done / ai:review-error
   ▼
主进程 electron/ai-service.cjs
   ├─ 配置读写：{userData}/ai-config.json
   │    baseUrl、model、temperature 明文；apiKey 为 safeStorage 密文
   ├─ 提示词组装：paper-digest.cjs 纯函数
   ├─ SSE 请求与解析：仅 POST /chat/completions；外网地址强制 https，
   │    仅 http://localhost 或 http://127.0.0.1（本地模型服务）例外
   └─ 分片经 webContents.send 推送渲染层

主进程 electron/paper-matrix.cjs（纯函数）
   └─ papers → 文献矩阵 Markdown 表格
```

### 5.1 模块边界

| 单元 | 职责 | 依赖 |
|---|---|---|
| `electron/ai-service.cjs` | 配置存取、连接测试、SSE 流式请求、取消 | safeStorage、node:https |
| `electron/paper-digest.cjs` | papers → 提示词素材（分组摘要块、截断） | 无（纯函数） |
| `electron/paper-matrix.cjs` | papers → 矩阵 Markdown（纯函数） | 无 |
| `electron/main.cjs` | 注册 `ai:*` IPC 与事件转发 | ai-service |
| `electron/preload.cjs` | 暴露 `desktopApi.ai` | ipcRenderer |
| `src/components/paper/ReviewDrawer.tsx` | 预览、流式渲染、编辑、另存、取消 | desktopApi.ai |
| `src/components/paper/AiSettings.tsx` | AI 服务配置区（嵌入显示设置抽屉） | desktopApi.ai |
| `src/App.tsx` | 组装：筛选结果传入、抽屉开合、保存对接 | 上述组件 |

渲染进程不发起外部网络请求；`desktopApi.ai` 不返回明文 apiKey（只返回 `hasKey: boolean`）。

## 6. AI 配置与密钥安全

### 6.1 配置存储

- 文件：`{userData}/ai-config.json`
- 字段：`baseUrl`（必填；外网强制 https，`localhost`/`127.0.0.1` 允许 http 以支持本地模型服务）、`model`（必填）、`temperature`（0–2，默认 0.4）、`apiKeyCipher`（safeStorage `encryptString` 后 base64；不可用时文件不落 key）
- 渲染层可见信息：`{ baseUrl, model, temperature, hasKey }`——**永不含明文 key**

### 6.2 密钥写入与校验

- 保存：渲染层传明文 key → 主进程立即加密写入 → 返回 `{ ok: true }`，不回显
- `isEncryptionAvailable()` 为 false 时：保存配置返回明确错误，功能禁用（不降级明文存储）
- 解密失败（换机/密钥环变化）：视为未配置，提示重填

### 6.3 测试连接

- 用当前配置发一个 `max_tokens: 1` 的最小请求
- 成功：显示模型响应正常；失败：显示 HTTP 状态与错误摘要（截断 200 字符），不修改配置

## 7. 功能行为

### 7.1 入口

- 顶部"更多"菜单：`生成综述`、`导出文献矩阵`
- 质量抽屉"导入 / 导出"区：同样两个按钮
- 筛选结果为空：两功能均提示"当前筛选没有论文"

### 7.2 文献矩阵（无 AI）

- 纯函数 `buildLiteratureMatrix(papers)`：
  - 表头：`| # | 论文 | 作者 | 年份 | 来源 | DOI | 状态 | 方法 | 数据/样本 | 关键发现 | 局限 |`
  - 行 = 论文（当前筛选结果顺序），单元格内容做管道符转义与换行折叠
  - 文末附生成时间与论文数量说明
- 输出经现有 `saveMarkdown` 对话框保存为 `.md`

### 7.3 综述生成（AI）

**预览阶段**（点"生成综述"后抽屉展示）：

1. 将发送的论文清单（标题 + 年份），超限标注
2. 截断提示：论文数上限 **40 篇**（超出取前 40 并标注"仅取前 40 篇"）；单篇每字段截断 400 字符、证据主张每条 200 字符、每篇证据最多 8 条——预览中明确显示"内容将截断"
3. 确认按钮"开始生成"

**流式生成阶段**：

- 主进程组装请求：`stream: true`，SSE 解析 `delta.content`
- 分片实时推给渲染层，抽屉内以只读 Markdown 视图滚动展示
- 可"取消"：主进程 abort 请求，已收内容保留并标注"已手动停止"
- 抽屉关闭 = 取消

**完成后**：

- 视图切可编辑（TextArea），可"重新生成"（重新走预览）或"另存为 Markdown"
- 另存走现有 `saveMarkdown`

### 7.4 提示词

系统提示（固定）：

> 你是科研综述助手。只依据用户提供的论文摘要素材归纳，禁止编造数据或结论；引用发现时标注来源论文标题；用中文输出。

用户内容结构：

1. 说明：论文数量、分组依据
2. 按标签分组的摘要块（无标签论文归入"未分组"）：每篇含标题/作者/年份/来源/研究问题/方法/数据/关键发现/局限性/可信度备注/证据主张（含定位）
3. 输出要求：按主题分组综述 → 每组综合发现与证据引用 → 跨研究分歧 → 整体局限 → 文末参考文献列表（标题+年份）

## 8. 状态与数据流

```text
ReviewDrawer: idle → preview → generating → done | stopped | error
```

- `preview`：展示清单与截断信息，等待确认
- `generating`：追加 chunk；取消→`stopped`
- `error`：显示错误摘要 + 重试（回 preview）
- App 层新增 `reviewOpen` 状态；与 quality/account 抽屉互斥（复用 `activeDrawer` 模式扩展为 `'quality' | 'account' | 'review' | null`）

## 9. 失败处理

| 情况 | 行为 |
|---|---|
| 未配置 baseUrl/model/key | 生成按钮禁用 + 引导文案跳转 AI 配置区 |
| `isEncryptionAvailable()` 为 false | 保存配置报错，AI 功能整体禁用 |
| key 解密失败 | 视为未配置，要求重填 |
| 测试连接失败 | 显示状态码/错误摘要（≤200 字符），配置不变 |
| 网络中断 / 超时（120s 无数据） | 保留已收内容，标注"已中断"，可重试 |
| HTTP 429 / 5xx | 显示限流或服务错误提示，可重试 |
| SSE 解析异常 | 整体报错，不进入保存流程 |
| 筛选结果为空 | 按钮可点但提示无论文，不发起请求 |
| 论文超 40 篇 | 预览标注"仅取前 40 篇"，发送截断集 |

## 10. 测试计划

### 10.1 自动化

- `paper-digest`：分组正确、各截断规则生效、超 40 篇标注、空库返回空素材
- `paper-matrix`：表头固定、管道符转义、换行折叠、空列表输出说明文字
- `ai-service` 配置层（临时 userData）：保存/读取往返、hasKey 语义、safeStorage 不可用时拒绝保存、解密失败视为未配置
- SSE 解析器：正常分片、`[DONE]`、异常 JSON 不中断整体（容错跳过）
- 渲染层接线标记测试：ReviewDrawer/AiSettings 接入、activeDrawer 扩展、矩阵入口存在
- Vitest 全量 + `npm run build` 通过

### 10.2 手动验收

1. 配置真实 OpenAI 兼容服务 → 测试连接成功
2. 筛选论文 → 预览清单与筛选一致；>40 篇时显示截断标注
3. 流式输出可见；中途取消内容保留并标注
4. 重新生成、编辑、另存 `.md` 全通
5. 文献矩阵导出内容与筛选结果一致，Excel 粘贴不串列
6. 抓包/文件检查：落盘 key 为密文；日志与 localStorage 无明文 key
7. 未配置时综述禁用、矩阵可用
8. 生成中关抽屉 = 取消，无悬挂请求
9. 现有功能（账户/论文/导入导出/主题）回归正常
10. DevTools 仍禁用

## 11. 完成定义

- 三段式综述流（预览 → 流式 → 编辑/另存）可用且可取消
- 文献矩阵导出可用且与 AI 解耦
- key 全程密文落盘、渲染层不可见
- §9 失败路径均有对应行为
- §10 全部通过
- 生产构建通过，现有测试无回归
