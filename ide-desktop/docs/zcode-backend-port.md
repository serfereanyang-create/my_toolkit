# ZCode 后端功能移植台账

来源：`zcode-upstream`（github.com/zai-org/ZCode，v3.14.3，`packages/services/src`）。
每个移植 = 读上游实现 → CJS 移植进 `electron/` → node --test 测试 → 提交。
2026-09-25 完成 15 轮。

| # | 功能 | 上游来源 | 本地模块 | 提交 |
|---|------|----------|----------|------|
| 1 | 工作区 checkpoint（隐藏 ref 快照 + 三方恢复 + blob 哈希冲突检测） | git/gitCheckpointService + repo + store | `checkpoints.cjs` + IPC `checkpoints.*` | e67376e |
| 2 | 工作区模糊文件搜索（前缀<子串<子序列打分、二分 top-K、索引缓存） | file/workspaceFileSearch + shared/workspaceFileSearch | `file-search.cjs` + IPC `files.search` | cadf73e |
| 3 | 进程树快照/终止器（宽→强、树范围） | process/processTree* | `process-tree.cjs` | （R3 提交） |
| 4 | 进程资源采样（cputime 差分、整机归一化 CPU%、pid 复用防护） | process/processResourceSampler | `resource-sampler.cjs` + IPC `resources.sample` | （R4 提交） |
| 5 | 结构化 JSONL 日志 + 轮转清理（写链串行） | logger/serviceLogger | `logger.cjs` | （R5 提交） |
| 6 | 防抖文件监视器 + ignore 规则（chokidar） | fileWatcher/fileWatcherService | `file-watcher.cjs` | （R6 提交） |
| 7 | 自定义斜杠命令（markdown+frontmatter，用户/工作区双目录，工作区优先） | commands/commandFileParser + commandsService | `commands.cjs` + IPC `commands.*` | （R7 提交） |
| 8 | 原子写文件（同目录 tmp + rename 重试 + 过期 tmp 清理 + 按目标写链） | fs/atomicFileUtils | `atomic-file.cjs`（commands.save 已接入） | （R8 提交） |
| 9 | 会话导出 markdown（fence 升级、sha256、未知角色留痕） | conversation-share/sharedContextFormatter | `export-session.cjs` + IPC `sessions.export` | （R9 提交） |
| 10 | 提交信息文件范围过滤（会话触碰文件 → 变更文件子集） | git/commitMessageFileScope | `commit-scope.cjs` | （R10 提交） |
| 11 | 启发式 conventional 提交信息（类型分类 + 公共 scope，subject 过上游正则） | git/gitCommitMessageGenerator | `commit-message.cjs` | （R11 提交） |
| 12 | 设置导出/导入（**密钥永不落盘**，hasApiKey 标记，按 id 合并保本地键） | settings-sync | `settings-portable.cjs` + IPC `settings.*Bundle` | （R12 提交） |
| 13 | 终端会话树终止 + shell profile 探测 | terminal/terminalService + terminalProfile | `terminal-profile.cjs`、`terminal.cjs` kill 升级 | （R13 提交） |
| 14 | 系统诊断快照（版本/CPU/内存/盘余量/git） | system/systemService | `system-info.cjs` + IPC `system.info` | （R14 提交） |
| 15 | 空会话清理后端（分析只读；删除时重校验候选资格，防数字过期） | （对应清理计划） | `session-cleanup.cjs` + IPC `sessions.analyzeCleanup/cleanupDelete` | （R15 提交） |

## 有意的偏差（都写了注释）

- checkpoint 冲突检测用 `git hash-object`（带 clean 过滤器）而非上游的 `--no-filters`：Windows `core.autocrlf=true` 下 `git restore` 回写 CRLF，裸哈希会把没动过的文件误报冲突。
- 原子写去掉了上游的跨进程锁文件（本应用主进程是唯一写者），改为进程内按目标路径写链 + 保留 rename 重试。
- 终端是管道型（非 node-pty），UTF-8 编码修正保留本地实现；树终止用 #3 模块。

## 空会话清理：实测统计（2026-09-25，只读）

| 目录 | 总数 | 真空 | 仅 system | 有内容 | 可删候选 |
|------|------|------|-----------|--------|----------|
| `cli/.aicode/sessions` | 535 | 8 | 0 | 527 | **8** |
| `~/.aicode/sessions` | 24 | 0 | 0 | 24 | 0 |
| `ide-desktop/.aicode/sessions` | 2 | 0 | 0 | 2 | 0 |

与当时计划里的 1475 相比大幅减少（此前清理过）。8 个候选未删，等用户确认后调 `sessions.cleanupDelete`。

## 验证

- node --test 全量 374/374 绿（含每个移植模块的专属测试）。
- vitest 全量 374/374 绿 + typecheck 干净。
- IPC 通道对齐守卫（`tests/ipc-channel-parity.test.cjs`）覆盖全部新增通道。
