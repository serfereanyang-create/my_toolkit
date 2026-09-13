# AGENTS.md — aicode CLI

工程规范（供人类与编码智能体共同遵守）。修改本仓库前先读这份文件。

## 命令面

- `npm run build` — tsc 全量编译到 `dist/`（ESM, NodeNext, strict）
- `npm run typecheck` — 无输出编译检查
- `npm test` — build + `node --test dist/tests/*.test.js`（零测试框架依赖；当前基线全绿，见 CI）
- `npm run coverage` — 同上带 `--experimental-test-coverage`
- `npm run lint` / `lint:fix` — eslint flat config；**新代码不允许新增 error**，历史 warning 存量见 `eslint.config.mjs` 注释，逐步收紧
- `npm run format` / `format:check` — prettier（尚未全量执行；执行它请单独开一个 commit，不要混进功能改动）
- `npm run audit:100` — 100+ 项结构化自检，任何发版前必跑
- `npm run smoke` — mock provider 多工具冒烟（不联网、不需要 key）

## 提交与验证纪律

- 每次功能改动必须：`npm test` 全绿 + `audit:100` 通过，才允许提交。
- 一个 commit 只做一类事；**不要**把 lint/format 扫面与功能修复混在同一 commit。
- 提交信息用 conventional commits（`feat(scope): …` / `fix: …`）。

## 结构与禁区

- `src/agent/agent.ts` 是回合主循环：改动 run-loop 的控制流（审批、取消、工具注入顺序）必须带回归测试；computer-use 工具是 post-scope 动态注册（镜像 spawn_subagent），加新“始终可用”工具走同样模式。
- `src/safety/`（policy.ts、sandbox.ts）：命令注入/审批语义改动必须附带 decideApproval 或 sandbox 的表驱动测试。Mimosa 钩子会拦截 Bash 直接写源码/安全配置——一律用 Edit/Write 工具。
- `src/session/store.ts`：JSONL 持久格式是兼容边界。新字段一律 optional；**绝不**把 base64/大 payload 写进 ToolCallRecord（多模态 parts 只挂 message）。
- providers：四种线格式（openai chat / anthropic / openai-responses / gemini）行为要一致；改消息转换跑 `tests/protocol.test.ts` + 对应 provider 测试。
- 凭据：只从环境变量/密钥服务读取；源码、示例、测试不得含可用凭据字面量。

## 测试策略

- 新工具 → `tests/<name>.test.ts`：validate 严格性 + risk 级别 + 纯逻辑单测；涉及真实进程/GUI 的工具（`src/tools/computer.ts`）用真机冒烟验证并把不可靠断言留在单测外。
- 不 mock 时钟与时区断言；路径断言一律 `path.join` 归一化（Windows 反斜杠陷阱）。
- 测试文件放 `tests/`，命名 `*.test.ts`，用 `node:test` + `node:assert/strict`。

## Windows 注意

- `run_command` 前台通道已做 `&amp;` 实体修复 + `chcp 65001`（sandbox.ts）；后台 job 通道（commandJobs.ts）仍走裸 shell，勿在提示词里依赖 `&&` 于 GBK 控制台的输出编码。
- PowerShell 子进程一律 `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 且前置 UTF-8 输出编码设置（见 `src/tools/computer.ts` runPs）。
