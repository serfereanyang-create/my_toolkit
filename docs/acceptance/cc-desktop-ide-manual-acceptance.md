# CC Desktop IDE — 手动验收清单

对应 `docs/superpowers/plans/2026-07-26-cc-desktop-ide.md` Task 11 Step 4–6。
自动化测试已全绿（CLI 324 + 桌面 Vitest 3 / node:test 8）；本清单覆盖需要真人操作 GUI / 真实 API key 的部分。

## 前置：构建

```bash
# 1. 构建 CLI(桌面桥接依赖 dist/src/index.js)
cd cli
npm install          # 若尚未安装
npm run build

# 2. 启动桌面应用
cd ../ide-desktop
npm install          # 若尚未安装(Electron 用镜像:ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/)
npm run desktop:run  # 构建 + 启动 Electron
# 或开发模式(热更新):npm run dev
```

---

## A. Mock 验收(无需 API key)

| # | 步骤 | 预期 | 通过? |
|---|------|------|-------|
| 1 | 启动应用 | 打开深色窗口，标题 `ZCode Desktop IDE`，欢迎页(**不是**论文助手 UI) | ☐ |
| 2 | 点 “Open Folder”，选一个项目文件夹 | 进入 IDE 三栏布局，顶栏显示 workspace 路径 | ☐ |
| 3 | 左侧 Files 视图 | 文件树列出目录内容(排除 .git/node_modules/dist) | ☐ |
| 4 | 点一个文件 | Monaco 编辑器打开该文件，出现标签页 | ☐ |
| 5 | 编辑内容 | 标签页出现黄点(dirty 标记) | ☐ |
| 6 | 按 `Ctrl+S` | 黄点消失(已保存)；关闭再打开该文件内容为已保存版本 | ☐ |
| 7 | 左侧 Settings 视图 | 看到 Mock / OpenAI compatible / Anthropic 三个 provider，含 model / base URL 字段 | ☐ |
| 8 | 保持 provider = Mock，AI 面板输入 `smoke multi-tool task` 回车 | 状态变 running；助手文本流式出现；出现工具卡片(tool_start / tool_result) | ☐ |
| 9 | 观察底部面板 | “Recent tool output” 列出最近工具调用及状态 | ☐ |
| 10 | 输入 `/help` `/status` `/model` `/provider` | 各自返回本地助手消息(不走 agent) | ☐ |
| 11 | Settings 里把 Approval 改成 `ask`，发一个会写文件的 prompt | 出现审批卡片，含 Allow once / Allow session / Deny | ☐ |
| 12 | 点 Deny | 写入被拒，工具结果显示 failed | ☐ |
| 13 | 再发一次，点 Allow session；后续同名写工具 | 不再重复弹审批(会话级放行生效) | ☐ |
| 14 | 运行中点 Stop(方块图标) | UI 回到可输入状态(input-ready) | ☐ |

## B. 路径安全 / 崩溃恢复(可选，快速验证)

| # | 步骤 | 预期 | 通过? |
|---|------|------|-------|
| 15 | 让 agent 尝试读取工作区外路径(如 `../../etc/hosts`) | 被路径牢笼拒绝(`Path escapes workspace`) | ☐ |
| 16 | 手动 kill 掉 CLI 子进程后再发 prompt | 触发 restart 路径，agent 重新拉起 | ☐ |
| 17 | 观察终端日志 + Settings UI | 完整 API key 从不出现，只显示 `configured:####` 后 4 位 | ☐ |

---

## C. 真实 Provider 联调(仅当你提供真实 key 时)

优先测 OpenAI 兼容(自定义网关走这条路径)。

1. Settings → 选 OpenAI compatible，填 base URL、model、API Key，点 “Save Key”。
   - 预期:输入框 placeholder 变为 `configured:####`(不回显完整 key)。
2. 顶部 provider 切到该 profile，Save Settings。
3. AI 面板问:`Read the package name from package.json and answer with only the name.`
4. 预期:agent 用只读工具(read_file，approval=ask 时只读不拦截)，回答包名。
5. 确认:渲染进程 UI 与终端日志里**都没有**出现完整 API key。

---

## D. Spec 验收对照(`specs/2026-07-26-cc-desktop-ide-design.md`)

- [ ] 1. ide-desktop 独立运行(不依赖论文助手)
- [ ] 2. workspace 打开 / 树 / 编辑器 / 保存可用
- [ ] 3. provider 含 OpenAI 兼容 / Anthropic / 自定义形态 / mock
- [ ] 4. API key 不完整渲染
- [ ] 5. mock 无 key 可用
- [ ] 6. 至少一个真实 provider 配置后可用
- [ ] 7. 助手流式增量渲染
- [ ] 8. 工具卡片渲染
- [ ] 9. 分级审批可用
- [ ] 10. 写入文件刷新已打开标签页
- [ ] 11. 会话存在于 .aicode/sessions
- [ ] 12. /help /model /provider /status 可用
- [ ] 13. Stop/cancel 恢复输入
- [ ] 14. agent 崩溃/重启路径可用
- [ ] 15. 工作区路径牢笼拒绝外部路径
- [ ] 16. 自动化 bridge/main/UI/mock 测试通过 ✅(已验证)

---

## 已由自动化覆盖(无需手动)

- CLI:`cd cli && npm test` → 324 通过(含 desktop-bridge-args / desktop-bridge / approval / smoke)
- 桌面:`cd ide-desktop && npm test` → typecheck + Vitest 3 reducer 测试 + node:test 8 主进程/桥接测试(含 mock-smoke 真实 spawn CLI)
