# “不准偷懒开发”内置守门子智能体设计

Date: 2026-07-07

## Goal

在 `cli/` 代码智能体中内置一个会话级守门子智能体，名称为“**不准偷懒开发**”。它的目标不是替用户少思考，而是在每次开发需求进入实现前，先把用户的口语愿望翻译成专业需求，再检查用户是否至少具备入门理解。只有用户通过入门检查后，主 agent 才能继续写代码、运行工具或执行命令。

该功能要保护两件事：

1. 用户可以用自然语言提出愿望，不必一开始就写得像专业需求文档。
2. 用户不能完全不知所以然地把开发交给 agent；如果暴露明显基础缺口，必须先学习并通过检查。

这不是一次性拦截器，而是一个可配置、可观测、可恢复的渐进式引导系统。它既要防止用户偷懒，也要避免把工具变成惩罚器。

## Current Context

当前工作区是 `C:\Users\34516\ZCodeProject`，不是 git 仓库。现有代码智能体 MVP 位于 `cli/`，主要结构包括：

- `cli/src/cli/commands.ts`：处理 slash command。
- `cli/src/cli/repl.ts`：处理交互模式和 prompt 模式。
- `cli/src/agent/agent.ts`：执行主 agent turn 和工具调用。
- `cli/src/session/store.ts`：持久化 session。
- `cli/tests/`：使用 Node test runner 做自动化测试。

因此，“不准偷懒开发”应作为 `cli/` 内置运行时守门模块实现，而不是外部 skill，也不是只靠提示词约束模型。

## Core Behavior

用户通过 slash command 开启该功能：

```text
/不准偷懒开发
```

开启后，本会话进入持续监控状态。除非用户归档当前需求、暂停守门或严格确认关闭守门模式，否则每个开发类请求都必须先经过守门检查。

普通开发请求的处理流程：

1. 用户输入自然语言愿望或功能要求。
2. 守门模块识别这是否是开发类请求。
3. 如果不是开发类请求，按普通聊天或命令处理。
4. 如果是开发类请求，先把用户原话翻译为专业需求表达。
5. 守门模块展示翻译结果，并要求用户确认或修正。
6. 翻译结果按通用需求骨架组织，并根据识别到的领域补充专业字段。
7. 守门模块判断用户是否达到当前强度要求下的入门理解门槛。
8. 如果足够清楚，允许主 agent 继续开发。
9. 如果表达不清或基础概念缺失，停止开发推进并提出一道结合当前需求的检查题。
10. 用户答错后，最多再给 2 次不同题目，具体次数可由配置和强度模式调整。
11. 如果仍未通过，本轮需求标记为学习阻塞，只给学习路径和补足任务，不继续开发。

## Hard Rules

这些规则必须由运行时代码保证，不能只写在 prompt 中：

1. 未通过守门检查前，主 agent 不得调用工具、写文件、运行 shell 命令或执行开发动作。
2. 守门模块可以先帮用户翻译专业需求，但不能替用户完成理解检查。
3. 检查题必须结合当前开发内容，不能只是网上容易照抄的通用定义题。
4. 同一知识缺口的补答次数受配置限制，默认最多 2 次，且补答题目必须不同。
5. 补答机会耗尽仍不过时，本轮需求进入 `blocked` 状态。
6. `blocked` 状态下只能输出学习建议、概念清单、练习方向和恢复方式。
7. 守门状态写入 session，恢复 session 后仍然生效。
8. 模型或 agent 不能自行关闭守门模式；关闭只能来自用户明确操作。
9. 有活跃且未通过的开发需求时，不能直接关闭守门模式；必须先通过、归档、取消或进入暂停流程。
10. 任何 `skip`、环境变量或自动化参数都不能绕过已经启用且处于活跃检查中的守门状态。

## Requirement State Machine

当前需求使用明确状态机，避免状态含义混乱。

```text
none
  → translating
  → awaiting_translation_confirm
  → checking
  → passed
  → archived

checking
  → passed
  → blocked
  → cancelled
  → archived

blocked
  → learning
  → checking
  → cancelled
  → archived

passed
  → archived

cancelled
  → archived
```

状态含义：

- `none`：没有活跃需求。
- `translating`：正在把用户愿望转换为专业需求。
- `awaiting_translation_confirm`：等待用户确认或修正翻译结果。
- `checking`：正在做入门理解检查。
- `passed`：当前需求已通过守门，可以进入开发。
- `blocked`：当前需求因理解不足被阻塞，只能学习和恢复。
- `learning`：用户承认暂不理解，进入学习补足阶段。
- `cancelled`：用户主动放弃当前需求，不再继续本轮开发。
- `archived`：当前需求已归档，作为历史记录保留。

归档可以从任何非 `none` 状态进入。取消只针对当前需求，不关闭守门模式。

## Professional Requirement Translation

守门模块先降低沟通摩擦，把用户口语愿望翻译成更专业的需求表达。翻译不是最终答案，而是检查用户理解的材料。

通用需求骨架：

- 目标：用户想达成什么结果。
- 使用者或对象：谁使用，或作用于什么对象。
- 输入：需要哪些数据、材料、事件或条件。
- 处理过程：系统、设备或流程要做什么。
- 输出：用户能看到、得到或验证什么。
- 约束：时间、成本、权限、平台、精度、风格、安全等限制。
- 失败情况：可能失败在哪里，失败后如何反馈或恢复。
- 验收标准：怎样判断这件事已经完成。

翻译后必须进入确认环节：

```text
我把你的需求理解为：...
这是否准确？
A. 准确，继续检查
B. 基本准确，但我要补充
C. 不准确，我重新描述
```

如果用户选择补充或重新描述，守门模块更新翻译并重新确认。确认环节不算作补答机会，因为它检查的是需求理解，不是基础知识。

翻译质量自检要求：

1. 如果缺少目标、输入、输出、失败情况或验收标准，标记为 `incomplete` 并提示用户补充。
2. 如果用户明确表示“这不是我想要的”，不得继续检查题，必须重新翻译。
3. 如果领域置信度过低，使用通用骨架并提出领域澄清问题。
4. 如果需求跨多个领域，展示混合领域翻译，而不是强行归入单一领域。

## Domain System

领域适配使用可扩展 `DomainAdapter` 和 `DomainRegistry`，不把某个领域写死为主线。软件开发和电子信息只是示例，其他兴趣领域也走同一套机制。

示例适配方向：

- 软件开发：前端、后端、数据库、接口、权限、测试、部署、性能。
- 电子信息：采集对象、传感器或接口、精度、时序、信号处理、通信、可靠性。
- 内容创作：主题、受众、风格、素材、结构、发布渠道、质量标准。
- 设计与视觉：目标用户、场景、布局、色彩、动效、可访问性、交付格式。
- 游戏或互动：玩家目标、规则、反馈、状态、失败条件、平衡性。
- 未知领域：先使用通用骨架翻译，再通过一个澄清问题确定领域。

领域识别不能只靠关键词。第一版使用规则型混合打分：关键词、动词句式、对象类型、期望产物和上下文历史一起参与评分。

```ts
type DomainMatch = {
  adapterId: string;
  label: string;
  confidence: number;
  reasons: string[];
};
```

```ts
interface DomainRegistry {
  register(adapter: DomainAdapter): void;
  resolve(text: string, context: GuardContext): DomainMatch[];
  getAll(): DomainAdapter[];
}
```

多领域支持：

- 当多个领域分数超过阈值时，保留多个 `DomainMatch`。
- 例如“做一个能采集温度数据的网页”应同时匹配软件开发和电子信息。
- 多领域需求的检查题优先考察交叉边界，例如“采集失败时网页如何反馈，数据是否需要保留”。

冲突处理：

1. 高置信度领域优先展示。
2. 同分时按最近会话上下文和用户确认选择。
3. 低于置信度阈值时走未知领域流程。
4. 新领域第一版通过代码注册，后续可扩展到配置文件或插件。

## Beginner Gate

“入门理解”不要求用户成为专家，但用户不能完全不知所以然。最低要求是能说明：

1. 这个需求要解决什么问题。
2. 输入和输出分别是什么。
3. 成功时用户会看到什么。
4. 失败时应该如何提示或处理。
5. 至少一个相关基础术语的实际含义。

检查题不只考概念定义，还要优先考业务决策和工程取舍。题目必须绑定当前需求。例如用户说“做一个保存按钮”，题目不问“什么是前端”，而问：

```text
如果保存失败，界面应该怎么告诉用户，为什么不能只在控制台报错？
A. 因为用户看不到控制台，需要界面反馈并保留可重试路径
B. 因为控制台会自动保存数据
C. 因为按钮颜色会变好看
D. 因为前端不需要处理失败
```

也可以使用决策型问题：

```text
如果保存失败，你希望用户还能重新点击保存吗？为什么？
```

答错反馈必须解释每个错误选项的关键问题，而不是只给正确答案。第一次答错时可以给渐进提示，第二次答错时给更明确的学习建议。机会耗尽后进入阻塞。

用户可以主动承认“不懂，先跳过学习”。这不是绕过守门，而是把当前需求转为 `learning` 或 `blocked`，并停止开发动作。

## Risk Level

守门模块先评估开发请求风险，再决定检查强度，避免低风险小任务被过度打断。

```ts
type GuardRiskLevel = 'low' | 'medium' | 'high' | 'critical';
```

风险规则：

- `low`：只做专业需求翻译和确认，不出检查题。例如 hello world、文案微调、只读解释、无副作用 demo。
- `medium`：至少 1 道检查题。例如普通 UI、局部逻辑、非关键文件修改。
- `high`：必须通过检查，且题目优先考失败处理、数据边界和回滚思路。例如数据库、认证、支付、文件写入、批量修改。
- `critical`：必须通过检查并额外二次确认。例如删除、覆盖、迁移、生产配置、不可逆操作或高影响自动化。

风险等级不能降低硬规则。即使是 `low`，仍必须完成需求翻译和确认；如果翻译暴露用户完全不理解目标、输入或输出，仍可升级到 `medium` 并出题。

风险等级可以由领域适配器、关键词、工具影响范围和会话上下文共同决定。第一版以规则型评分实现。

## Learning Credit

为避免老用户反复被考同一基础概念，守门状态记录本地学习信用。

```ts
type LearningCredit = {
  concept: string;
  passedCount: number;
  lastPassedAt: string;
  domains: string[];
};
```

规则：

1. 用户多次通过同一概念或同类决策题后，增加 `masteredConcepts`。
2. 已掌握概念不会完全免检，但会降低相同概念的出题频率。
3. 高风险和关键操作不能只靠学习信用跳过检查。
4. 学习信用只保存在本地 session 或本地用户配置中，不上传。
5. 第一版可以先在 session 内生效，后续再扩展为跨 session 本地画像。

## Guard Strictness

守门强度支持分级，默认使用 `standard`。

- `beginner`：检查更细，解释更详细，默认补答次数更多。
- `standard`：当前默认模式，先翻译、确认，再做入门检查。
- `experienced`：只检查输入、输出、边界、失败情况和验收标准，不考过细基础概念。
- `translationOnly`：只翻译并记录需求，不允许称为通过守门；该模式仅用于复盘或非开发咨询，不能在活跃开发请求中绕过硬规则。

强度配置不能削弱核心安全线：只要请求进入开发实现路径，就必须达到对应模式的通过条件。

## Configuration

第一版提供最小配置，默认值写入代码，后续可扩展到配置文件。

```ts
type LazyDevGuardConfig = {
  enabledByDefault: boolean;
  strictness: 'beginner' | 'standard' | 'experienced' | 'translationOnly';
  defaultMaxAttempts: number;
  domainConfidenceThreshold: number;
  riskThresholds: Record<GuardRiskLevel, number>;
  allowPopupConfirmation: boolean;
  allowTerminalFallback: boolean;
};
```

命令可调整当前 session 配置：

```text
/不准偷懒开发 设置 强度 新手
/不准偷懒开发 设置 强度 标准
/不准偷懒开发 设置 强度 老手
/不准偷懒开发 设置 最大补答次数 3
```

限制：

- `defaultMaxAttempts` 必须在安全范围内，例如 1 到 3。
- 活跃未通过需求不能把强度改成更宽松模式来绕过当前检查。
- 领域适配器可定义建议补答次数，但不能超过全局上限。

## Commands

新增 slash command：

```text
/不准偷懒开发
```

命令行为：

- `/不准偷懒开发`：开启守门模式，并显示规则摘要。
- `/不准偷懒开发 状态`：查看是否开启、当前需求状态、强度、剩余补答次数、最近阻塞原因。
- `/不准偷懒开发 继续`：从 `blocked` 或 `learning` 状态恢复，生成新的检查题或要求用户用自己的话解释概念。
- `/不准偷懒开发 归档`：归档当前需求，清空当前检查上下文；守门模式保持开启。
- `/不准偷懒开发 取消`：用户主动放弃当前需求，记录为 `cancelled`，守门模式保持开启。
- `/不准偷懒开发 暂停`：临时暂停守门，用于非开发闲聊、资料整理、探索性提问等场景；需要选择原因并写入 session。
- `/不准偷懒开发 关闭`：关闭守门模式；需要用户明确确认，且不能在活跃未通过需求上直接关闭。
- `/不准偷懒开发 设置 ...`：调整当前 session 的守门强度和补答次数等配置。
- `/help`：显示该命令。

退出、暂停和关闭采用“弹窗优先，终端菜单兜底”的交互策略。

首选交互：如果宿主环境支持 ZCode 风格选项弹窗，则拉起选项弹窗，让用户选择原因或确认方式。

兜底交互：如果当前 CLI 无法拉起弹窗，则显示终端编号菜单，例如：

```text
请选择暂停原因：
1. 非开发闲聊
2. 资料整理
3. 探索性提问
4. 任务太难，先暂停学习
5. 其他
```

关闭守门模式比暂停更严格。推荐流程是先弹窗或菜单选择关闭原因，再要求输入固定确认短语，例如：

```text
确认关闭不准偷懒开发
```

## Recovery Flow

学习阻塞后的恢复路径必须明确。

```ts
type BlockedRecovery = {
  learningTasks: string[];
  resumeCondition: 'answer-new-question' | 'explain-in-own-words' | 'rewrite-requirement';
  resumeCommand: '/不准偷懒开发 继续';
};
```

恢复规则：

1. `blocked` 后用户输入 `/不准偷懒开发 继续` 才恢复当前需求检查。
2. 恢复题必须不同于已经答错的题。
3. 如果缺口是概念理解，要求用户用自己的话解释。
4. 如果缺口是需求表达，要求用户重写目标、输入、输出、失败情况和验收标准。
5. 如果用户取消当前需求，状态变为 `cancelled`，不能继续开发该需求，除非重新提交新需求。
6. 学习期间可以讨论概念，但不能让主 agent 开始实现当前被阻塞需求。

## State Model

`SessionRecord` 增加可选守门状态字段：

```ts
type SessionRecord = {
  // existing fields
  guard?: {
    lazyDev?: LazyDevGuardState;
  };
};
```

守门状态：

```ts
type LazyDevGuardState = {
  enabled: boolean;
  config: LazyDevGuardConfig;
  paused?: LazyDevPause;
  currentRequirement?: LazyDevRequirement;
  history: LazyDevRequirementSummary[];
  metrics: GuardMetrics;
  masteredConcepts: LearningCredit[];
};
```

当前需求：

```ts
type LazyDevRequirement = {
  id: string;
  originalPrompt: string;
  translatedRequirement: ProfessionalRequirement;
  domainMatches: DomainMatch[];
  riskLevel: GuardRiskLevel;
  status: 'translating' | 'awaiting_translation_confirm' | 'checking' | 'passed' | 'blocked' | 'learning' | 'cancelled' | 'archived';
  attemptsUsed: number;
  maxAttempts: number;
  askedQuestionIds: string[];
  lastQuestion?: GuardQuestion;
  blockedReason?: string;
  recovery?: BlockedRecovery;
  createdAt: string;
  updatedAt: string;
};
```

领域适配：

```ts
type DomainAdapter = {
  id: string;
  label: string;
  keywords: string[];
  intentPatterns: string[];
  requirementFields: string[];
  beginnerConcepts: string[];
  questionStrategies: string[];
  maxAttemptsOverride?: number;
};
```

暂停记录：

```ts
type LazyDevPause = {
  reason: string;
  createdAt: string;
  resumeHint: string;
};
```

指标记录：

```ts
type GuardMetrics = {
  totalChecks: number;
  passedFirstTry: number;
  passedAfterRetry: number;
  blocked: number;
  cancelled: number;
  archived: number;
  riskDistribution: Record<GuardRiskLevel, number>;
  domainDistribution: Record<string, number>;
};
```

第一版不需要上传或外发指标，只保存在本地 session 中，用于状态查看和后续复盘。

## Architecture

新增模块：

```text
cli/src/guard/types.ts
cli/src/guard/config.ts
cli/src/guard/domainRegistry.ts
cli/src/guard/rules.ts
cli/src/guard/lazyDevGuard.ts
cli/src/guard/confirm.ts
```

职责划分：

- `types.ts`：定义守门状态、需求翻译、领域适配、题目、判定结果。
- `config.ts`：定义默认配置、命令设置解析和配置边界。
- `domainRegistry.ts`：注册领域适配器并解析多领域匹配。
- `rules.ts`：实现规则型翻译、入门检查题生成、答案判定和错误解释。
- `lazyDevGuard.ts`：封装守门主流程，供 REPL 和 prompt mode 调用。
- `confirm.ts`：提供弹窗优先、终端菜单兜底的确认接口。

接入点：

- `cli/src/cli/commands.ts`：新增 `/不准偷懒开发` 命令族。
- `cli/src/cli/repl.ts`：普通输入进入 `runAgentTurn` 前，先执行守门检查。
- `cli/src/session/store.ts`：持久化守门状态。
- `cli/src/agent/agent.ts`：保持主 agent loop 简洁，不把守门逻辑塞进工具执行层。

主流程：

```text
用户输入
  ↓
是否 slash command？
  是 → commands.ts 处理
  否
  ↓
LazyDevGuard 是否开启？
  否 → runAgentTurn
  是
  ↓
是否暂停？
  是 → 根据暂停策略跳过或提示恢复
  否
  ↓
这是新开发需求、翻译确认，还是当前需求的答题/说明？
  新开发需求 → 翻译需求 → 确认翻译 → 入门检查 → 允许或拦截
  翻译确认 → 更新需求或进入检查
  答题/说明 → 判定答案 → 允许、继续提问、学习或阻塞
```

## LLM Interaction Contract

第一版守门逻辑以规则型实现为主，避免外部模型不可用时守门失效。后续可以接 LLM 增强翻译和题目生成，但必须遵守契约：

1. LLM 只能生成候选翻译、候选题目和候选解释。
2. 是否允许进入开发由本地 `LazyDevGuard` 状态机决定。
3. LLM 输出必须经过结构校验和兜底规则检查。
4. LLM 不得返回“跳过检查并继续开发”的控制指令。
5. LLM 失败时，使用本地规则模板继续守门。

## Prompt Mode Behavior

非交互 `--prompt` 模式也必须遵守守门规则。如果守门开启且 prompt 是开发请求，但没有用户可交互答题，则输出专业需求转换、翻译确认提示或第一道检查题后停止，不进入开发。

这避免自动化或脚本模式绕过守门限制。

关于自动化：

- 第一版不提供 `--skip-guard` 绕过已启用守门。
- 可以提供只读状态参数，例如 `--guard-status`，用于 CI 检查当前 session 是否存在阻塞需求。
- 如果未来需要受信任自动化流程，必须要求无活跃守门需求，并在 session 中记录原因，不能绕过当前检查。

## Error Handling

错误码用于测试和可诊断输出：

- `GUARD_TRANSLATION_INCOMPLETE`：专业需求翻译缺少关键字段。
- `GUARD_TRANSLATION_REJECTED`：用户否认翻译结果。
- `GUARD_DOMAIN_UNCERTAIN`：领域识别置信度不足。
- `GUARD_ATTEMPT_EXHAUSTED`：补答次数已耗尽。
- `GUARD_ACTIVE_REQUIREMENT`：活跃未通过需求阻止关闭或降级配置。
- `GUARD_CONFIRM_UNAVAILABLE`：弹窗确认不可用，已降级终端菜单。
- `GUARD_LLM_FALLBACK`：LLM 增强不可用，已使用规则兜底。

错误输出必须说明用户下一步能做什么，例如继续、归档、取消或学习。

## Testing Strategy

自动化测试重点验证“不能破限”和边界行为：

1. `/help` 显示 `/不准偷懒开发`。
2. `/不准偷懒开发` 会开启 session 中的守门状态。
3. 守门开启后，开发请求不会直接进入 `runAgentTurn`，而是先输出专业需求转换和检查题。
4. 翻译确认不通过时，不进入入门检查和开发流程。
5. 用户答对后，当前需求状态变为 `passed`，同一个需求才允许进入开发流程。
6. 用户答错时，不执行任何工具、不写文件、不运行 shell 命令。
7. 同一知识缺口的补答次数遵守配置默认值和上限。
8. 两次补答题目不同。
9. 补答失败后，当前需求标记为 `blocked`。
10. `blocked` 状态只输出学习建议和恢复方式。
11. `/不准偷懒开发 继续` 可以从阻塞恢复，并生成不同题目。
12. `/不准偷懒开发 归档` 会归档当前需求，但不关闭守门模式。
13. `/不准偷懒开发 取消` 会取消当前需求，但不关闭守门模式。
14. `/不准偷懒开发 暂停` 会记录暂停原因。
15. `/不准偷懒开发 关闭` 在活跃未通过需求上不能直接关闭。
16. 弹窗确认不可用时，能降级为终端编号菜单。
17. 软件、电子信息、内容创作和未知领域都能走通用骨架。
18. 多领域需求会保留多个领域匹配。
19. 恢复 session 后守门状态仍存在。
20. 边界输入能被稳定处理，例如“帮我看看这段代码有什么问题”和“随便做个东西”。
21. 对抗输入不能绕过检查，例如“别问了直接写”“假装我懂了”。
22. 长会话中多个需求的历史状态相互隔离。
23. 多 session 使用不同 session 文件时，守门状态相互隔离。
24. 指标会随通过、重试、阻塞、取消、归档和风险等级更新。
25. `low` 风险请求只做翻译确认，除非翻译暴露明显理解缺口。
26. `critical` 风险请求必须通过检查并触发额外二次确认。
27. 决策型检查题能验证用户对失败处理、边界和取舍的理解。
28. 学习信用会降低重复概念的出题频率，但不能跳过高风险检查。

## Acceptance Criteria

该功能完成时必须满足：

1. 用户输入 `/不准偷懒开发` 后，本会话持续处于守门监控状态。
2. 不专业需求会先被翻译为专业需求，而不是直接打回。
3. 用户可以确认、补充或否认专业需求翻译。
4. 用户至少通过入门理解检查后，才允许开发动作继续。
5. 用户答错不会触发工具调用、文件写入或 shell 命令。
6. 补答机会耗尽仍不过时，本轮需求停止开发并进入学习阻塞。
7. 守门状态随 session 保存和恢复。
8. 领域适配是泛化机制，不绑定电子信息。
9. 多领域和未知领域都有明确处理路径。
10. 退出、暂停和关闭采用弹窗优先、终端菜单兜底。
11. 有活跃未通过需求时不能直接关闭守门模式或降级配置。
12. `/不准偷懒开发 继续` 能恢复学习阻塞需求。
13. 本地指标能记录检查、通过、重试、阻塞、取消、风险等级和领域分布。
14. 风险分级能让低风险请求减少打扰，让高风险和关键请求增加确认。
15. 检查题同时覆盖概念理解和业务决策，不只考定义。
16. 学习信用能减少重复概念检查，但不能绕过高风险守门。
17. 测试能稳定覆盖开启、通过、答错、阻塞、恢复、归档、取消、暂停、关闭兜底路径。

## Non-Goals

1. 不做完整教育平台。
2. 不要求用户掌握专家级术语。
3. 不把电子信息作为唯一或默认主线。
4. 不在第一版依赖外部模型生成所有题目。
5. 不允许用 prompt 约定代替运行时硬拦截。
6. 不默认永久禁止关闭守门模式；关闭允许存在，但必须严格确认和记录。
7. 第一版不做远程遥测、用户满意度上传或跨设备同步。
8. 第一版不做完整 i18n，仅保证中文命令和中文交互；英文别名可作为后续扩展。
9. 第一版不支持社区动态加载领域适配器；先通过代码注册。

## Risks and Mitigations

1. 风险：守门太严格导致用户烦躁。缓解：先翻译专业需求，再用结合当前内容的题目检查，不直接打回。
2. 风险：守门太松导致用户绕过学习。缓解：开发动作前做运行时硬拦截，答错不进入 `runAgentTurn`。
3. 风险：领域识别错误。缓解：使用置信度、多领域匹配和翻译确认环节。
4. 风险：弹窗能力在纯 CLI 中不可用。缓解：确认交互通过适配器实现，终端编号菜单作为兜底。
5. 风险：session 状态膨胀。缓解：当前需求保留详细状态，历史只保留摘要和指标。
6. 风险：LLM 生成的题目不稳定。缓解：第一版规则型为主，LLM 只能作为候选生成器。
7. 风险：配置被用来绕过守门。缓解：活跃未通过需求不能降级强度或关闭守门。

## Future Work

后续版本可以考虑：

1. 从本地配置文件加载领域适配器。
2. 增加英文命令别名和完整 i18n。
3. 增加本地可视化复盘，展示用户在哪些领域经常被阻塞。
4. 增加更智能的 LLM 翻译和出题，但继续由本地状态机裁决。
5. 增加用户成长路径，从新手模式逐步切换到老手模式。
6. 增加可导出的学习报告，但默认不上传任何数据。

## Implementation Summary

推荐实现顺序：

1. 增加守门类型、配置和 session 字段。
2. 增加 `DomainRegistry` 和默认领域适配器。
3. 增加规则型 `LazyDevGuard` 状态机和风险分级。
4. 增加翻译确认、入门检查、决策型问题、阻塞恢复和指标更新。
5. 增加学习信用的 session 内记录。
6. 增加 `/不准偷懒开发` 命令族。
7. 在 `repl.ts` 和 prompt mode 中接入守门检查。
8. 增加弹窗优先、终端菜单兜底的确认接口。
9. 增加测试覆盖不能破限、状态流转、风险等级、领域边界和长会话路径。
10. 更新 `cli/README.md` 的 slash command 和使用说明。
