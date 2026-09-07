# 03 Coding Agent 基线

目标：检验是否具备 Claude Code 类 coding CLI 的最小闭环。

## 任务点

| ID | 任务点 | 最小探针 | 通过标准 | 本包结果 |
| --- | --- | --- | --- | --- |
| C1 | 多工具闭环 | smoke multi-tool | inspect → write → read → run | **PASS** → `results/C1-smoke-multi-tool.txt` |
| C2 | shell completion | `completion bash` | 输出 bash 补全脚本 | **PASS** → `results/C2-completion-bash.txt` |
| C3 | 项目索引 | prompt `帮我看看项目索引` | 调用 `project_index` | **PASS** → 见 `../01-visual/results/V4-json-events.jsonl` |
| C4 | 真实模型修复质量 | live provider | 能修真实 bug | **UNTESTED**（本包固定 mock） |
| C5 | 任务板 verify loop | `/plan` + typecheck/test | 规划/验证闭环 | **PARTIAL**（能力宣称有，本包未端到端） |
| C6 | session resume/export | `--resume` `/export` | 可恢复/导出 | **UNTESTED**（需交互） |

## 复现

```bash
node dist/src/index.js --provider mock --approval auto --prompt "smoke multi-tool task: inspect, write, read, and run command"
node dist/src/index.js completion bash
node dist/src/index.js --provider mock --approval auto --json --prompt "帮我看看项目索引"
```

## 结论

MVP coding agent 骨架成立：工具循环、completion、索引可用。完整对标 Claude Code 还需真实模型长任务与更深导航体验。
