# YOYcode 缺陷复审与验证记录

日期：2026-10-09（Asia/Shanghai）。环境：Windows、Node v24.19.0、npm 11.17.0。

本轮接续此前未提交的改动，重点复审专家路由、只读工具边界、模型降级、供应商身份匹配和子任务取消。CLI 与桌面端是独立 Git 仓库；本记录不代表整个产品不存在其他缺陷。

## 本轮修复

| 编号 | 问题与影响 | 修复与证据 |
| --- | --- | --- |
| 1 | 安全规则只匹配 `vulnerability`，遗漏复数 `vulnerabilities`。省略 expert 的安全审查任务得到 `general`，工具权限扩大。 | 补齐复数规则；覆盖英文单复数、大写和中文目标，同时检查任务板与直接分派两条入口，以及禁止写文件、执行命令和派生子任务的工具边界。 |
| 2 | 降级判断将除 400/422 外的所有 HTTP 状态都视为可降级；取消错误携带 503 等状态时也会降级。 | 取消类型先于 HTTP 状态判定；只允许 401/402/403/404/408/429 和 500–599，保留传输错误判定。验证 409、413、取消均不会调用备用模型或发出降级通知，原异常保留。 |
| 3 | 调度器依赖子任务主动轮询取消。父级已取消，或上一任务完成时发生取消而没有轮询，仍会启动后续任务。 | worker 在领取任务前检查父级取消，唤醒等待 worker 并停止分派。两项新测试修复前分别实际启动 3 个任务，修复后分别启动 0 个和 1 个；未启动任务保留 cancelled 结果。 |
| 4 | 提供商 ID 和其他提供商的显示名称碰撞时，前后端都可能选中错误接口；重名供应商与同名模型也会静默选第一项。 | CLI 和桌面匹配均优先使用 ID，再匹配显示名称；重名且无法唯一定位时拒绝猜测。测试逐个验证 CLI 所有 picker 选项解析回对应接口，并覆盖重名通配选择、唯一模型和桌面模型名归一化。 |
| 5 | 前后端领域关键词先于只读意图判断。`Inspect React frontend code`、`Read the backend API endpoint`、`查看前端页面结构` 等任务被分到可写实现专家。 | 实现专家的领域匹配必须不包含只读意图；补齐 review、检查、读取、审查、审阅。两条路由入口均验证只读工具集；已有实际实现任务继续选择 frontend/backend。 |

本轮修改的实现文件：

- `cli/src/experts/router.ts`
- `cli/src/subagent/runner.ts`
- `cli/src/subagent/orchestrator.ts`
- `cli/src/dispatch/tierRouter.ts`
- `ide-desktop/src/lib/dispatchMatch.ts`

对应回归测试位于 `cli/tests/expert-router.test.ts`、`cli/tests/tierFallback.test.ts`、`cli/tests/tierRouter.test.ts`、`cli/src/subagent/orchestrator.test.ts` 和 `ide-desktop/src/lib/dispatchMatch.test.ts`。这些文件中的此前改动继续保留。

## 每组修复后的验证

| 修复组 | 针对该组的验证 | CLI 结构审计 |
| --- | --- | --- |
| 1：安全专家推断 | 24 项 Node 测试通过 | 970/970 |
| 2：降级与取消错误 | 10 项降级测试通过；另与 transport retry、只读审查联合验证 26 项通过 | 970/970 |
| 3：子任务取消 | 24 项调度 Vitest 测试通过，包含新增的 2 项取消回归 | 970/970 |
| 4：供应商身份 | 35 项 CLI Node 测试、22 项桌面匹配/链操作测试通过；桌面 typecheck 通过 | 970/970 |
| 5：前后端只读路由 | 46 项专家路由、只读审查、模型降级和供应商解析测试通过 | 970/970 |

每组均进行了代码复审。检查重点包括：工具过滤是否真正禁止写入与代理派生、取消是否优先于状态码、备用模型是否被错误调用、ID 选择能否解析到原供应商、依赖任务是否在取消后继续启动。

## 整体回归

| 检查 | 结果 |
| --- | --- |
| CLI Node，最终代码 | 983 项执行并通过，0 失败；按名称过滤下述 3 项旧测试 |
| CLI Node，前四组修复后 | 982 项执行并通过，0 失败；按名称过滤下述 3 项旧测试 |
| CLI Vitest，最终代码 | 11 个文件，169/169 通过 |
| 桌面 Vitest | 36 个文件，442/442 通过 |
| 桌面 Node | 402/402 通过 |
| CLI TypeScript 构建 | 通过 |
| 桌面 typecheck 与生产构建 | 通过；Vite 仍有大 chunk 警告 |
| 本轮涉及 CLI 文件的 ESLint | 通过，0 错误 |
| 两个 Git 仓库的 `git diff --check` | 通过 |

桌面通过 `npm test` 验证。CLI Vitest 使用 `npm run test:unit -- --reporter=dot`；CLI 结构审计使用已构建的 `node dist/src/audit/checks.js`。

## 留存的未执行测试

以下旧测试会直接修改或删除当前测试进程的 `OPENAI_API_KEY`。根据当前用户对密钥环境变量的保护规则，本轮按名称过滤，并未将它们算作通过。Node 的名称过滤不将这些条目计入实际执行总数。

| 文件 | 测试名称 | 留存原因 |
| --- | --- | --- |
| `cli/tests/embedder.test.ts` | `openai provider without an API key fails loudly instead of faking embeddings` | 删除并恢复 `process.env.OPENAI_API_KEY` |
| `cli/tests/embedder.test.ts` | `createDefaultEmbedder honors AICODE_EMBED_* overrides` | 设置并恢复 `process.env.OPENAI_API_KEY` |
| `cli/tests/sandbox.test.ts` | `runSandboxedCommand executes in workspace with scrubbed env` | 覆盖并恢复 `process.env.OPENAI_API_KEY` |

后续可将这些测试重构为依赖注入和独立环境对象的测试，再恢复执行；本轮未修改这些与修复无关的旧测试。

本轮 CLI Node 回归命令（在 CLI 仓库目录执行）：

```powershell
node --test --test-name-pattern='^(?!openai provider without an API key fails loudly instead of faking embeddings$|createDefaultEmbedder honors AICODE_EMBED_.* overrides$|runSandboxedCommand executes in workspace with scrubbed env$).*' dist/tests/*.test.js
```

## 验证边界

新回归测试使用模拟 provider、不可用的示例接口域名和隔离临时目录。本轮未发起真实供应商付费请求，也未验证桌面 GUI 的实际点击流程。关键词路由仍属于启发式分类，不能保证理解所有自然语言表达。

本轮没有提交 commit、创建分支、清理既有未跟踪文件或修改 Codex 的受保护配置。保留此前的桌面、CLI 和用户文档改动。
