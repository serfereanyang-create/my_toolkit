# aicode CLI 验收包（可视化 / 入门 / Coding / 安全）

本目录把“像 Claude Code / OpenClaw 类 CLI 环境”的检验拆成 **4 类任务点**，并附上 **最小可复现测试结果**。

生成时间：2026-07-23  
运行环境：Windows 10 / Node v24.15.0 / provider=`mock` / approval=`auto`  
CLI 版本：`0.1.0`  
工作区：`C:\Users\34516\ZCodeProject\cli`

## 目录结构

```text
docs/acceptance/
  README.md                 # 总览与总评分（本文件）
  SCORECARD.md              # 一页式得分卡
  01-visual/                # 可视化 / 可观测性
    TASKS.md
    results/                # 原始输出
  02-beginner/              # 一般电脑入门
    TASKS.md
    results/
  03-coding-baseline/       # Coding agent 基线
    TASKS.md
    results/
  04-safety/                # 安全与审批
    TASKS.md
    results/
```

## 总评分（最小验收）

| 类别 | 通过 | 部分 | 失败 | 未测 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| 01 可视化 | 5 | 1 | 0 | 4 | **工程师可读，产品级可视化不足** |
| 02 电脑入门 | 4 | 1 | 0 | 3 | **只读诊断可用，白话产品化不足** |
| 03 Coding 基线 | 3 | 1 | 0 | 2 | **MVP coding agent 骨架成立** |
| 04 安全 | 2 | 1 | 0 | 2 | **有审批/沙箱，危险意图拦截仍靠策略** |
| **合计** | **14** | **4** | **0** | **11** | **可证明底座，未证明完整对标** |

> “未测”主要是需要交互 REPL、真实模型、GUI/TUI、或破坏性操作的项；本包只做 **最小非交互探针**。

## 怎么看结果

1. 先看 [`SCORECARD.md`](./SCORECARD.md)
2. 再进各类 `TASKS.md` 看任务点定义与判定
3. 原始 stdout/JSONL 在各类 `results/`

## 复现命令（仓库根 / 本 cli 目录）

```bash
node dist/src/index.js --version
node dist/src/index.js --help
node dist/src/index.js --provider mock --approval auto --no-color --prompt "读取 package.json 并总结"
node dist/src/index.js --provider mock --approval auto --json --prompt "帮我看看项目索引"
node dist/src/index.js --provider mock --ci --prompt "帮我看看项目索引"
node dist/src/index.js --provider mock --json --doctor
node dist/src/index.js --provider mock --approval auto --json --prompt "C盘还有多少空间"
node dist/src/index.js --provider mock --approval auto --json --prompt "现在内存谁占用高"
node dist/src/index.js --provider mock --approval auto --json --prompt "smoke multi-tool task: inspect, write, read, and run command"
node dist/src/index.js completion bash
```

## 关键结论（给决策用）

- **可视化**：过程事件、颜色/无色、JSONL、CI 模式已具备；缺 TUI/进度条/结果卡片/图表。
- **电脑入门**：磁盘/内存/环境/doctor 链路通；缺“小白结论卡片”和入门模式。
- **Coding**：多工具闭环、completion、项目索引可用；完整对标 Claude Code 还需更强规划/修复表现（依赖真实模型）。
- **安全**：doctor 显示 sandbox 开启；危险 prompt 在 mock 下未必主动拒绝，需审批策略与真实拦截用例补强。