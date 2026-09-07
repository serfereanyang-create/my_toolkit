# 01 可视化 / 可观测性

目标：检验 CLI 是否“过程可观察、状态可理解、结果可回放”，而不是是否有 GUI。

## 任务点

| ID | 任务点 | 最小探针 | 通过标准 | 本包结果 |
| --- | --- | --- | --- | --- |
| V1 | 版本可显示 | `node dist/src/index.js --version` | 输出语义化版本号 | **PASS** → `results/V1-version.txt` |
| V2 | 帮助/命令可见 | `node dist/src/index.js --help` | 列出 flags 与 slash commands | **PASS** → `results/V2-help.txt` |
| V3 | 无色模式可读 | `--no-color --prompt "读取 package.json 并总结"` | 无 ANSI 也能看懂 Task/Tool/Assistant | **PASS** → `results/V3-no-color.txt` |
| V4 | JSONL 事件完整 | `--json --prompt "帮我看看项目索引"` | 含 `turn_start` / `tool_*` / `final` | **PASS** → `results/V4-json-events.jsonl` |
| V5 | CI 非交互 | `--ci --prompt "帮我看看项目索引"` | 不进入 REPL，有结果输出 | **PASS** → `results/V5-ci-mode.txt` |
| V6 | 人眼过程分层 | human 输出 | 有 Task/Tool/Assistant 分层 | **PARTIAL**（有分层，无进度条/表格美化） |
| V7 | 任务板 `/plan` | REPL | 能展示 todo/doing/done | **UNTESTED**（需交互） |
| V8 | 附件/截图 | `/attach` `/paste-image` | 可暂存并进入下一轮 | **UNTESTED**（需交互） |
| V9 | TUI/图表 | — | 进度条/树/仪表盘 | **UNTESTED**（未实现） |
| V10 | Web/富文本 | — | 本地 UI / 报告页 | **UNTESTED**（未实现） |

## 复现

```bash
node dist/src/index.js --version
node dist/src/index.js --help
node dist/src/index.js --provider mock --approval auto --no-color --prompt "读取 package.json 并总结"
node dist/src/index.js --provider mock --approval auto --json --prompt "帮我看看项目索引"
node dist/src/index.js --provider mock --ci --prompt "帮我看看项目索引"
```

## 结论

可视化底座（版本/帮助/无色/JSONL/CI）已过；产品级可视化（TUI、进度、卡片、图表）未证明。
