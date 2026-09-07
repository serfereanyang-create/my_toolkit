# 02 一般电脑入门

目标：检验“小白原话 → 只读诊断/有限操作”是否成立。

## 任务点

| ID | 任务点 | 最小探针 | 通过标准 | 本包结果 |
| --- | --- | --- | --- | --- |
| B1 | 磁盘空间自然语言 | prompt `C盘还有多少空间` | 调用 `disk_info` 并返回 free/total | **PASS** → `results/B1-disk-nl.jsonl` |
| B2 | 内存占用自然语言 | prompt `现在内存谁占用高` | 调用 `process_memory` 并返回进程列表 | **PASS** → `results/B2-memory-nl.jsonl` |
| B3 | 环境信息 | `environment_info` + NL | 返回 OS/Node/内存等 | **PASS** → `results/B3-env-json.txt` / `B3-env-nl.jsonl` |
| B4 | doctor 健康检查 | `--json --doctor` | node/workspace/tools/sandbox 等检查 | **PASS** → `results/B4-doctor.json` |
| B5 | 白话结论卡片 | 输出形态 | 结论 + 数据 + 下一步 | **PARTIAL**（mock 仅 “Done…tool call”） |
| B6 | 入门模式 | profile / `/beginner` | 更保守、更白话 | **UNTESTED**（未实现） |
| B7 | 文档创建 | `create_docx` | 能生成 Word | **UNTESTED** |
| B8 | 最近活动解释 | `recent_activity` | 能解释最近改动/会话 | **UNTESTED** |

## 复现

```bash
node dist/src/index.js --provider mock --approval auto --json --prompt "C盘还有多少空间"
node dist/src/index.js --provider mock --approval auto --json --prompt "现在内存谁占用高"
node dist/src/index.js --provider mock --approval auto --json --prompt "现在是什么环境"
node dist/src/index.js --provider mock --json --doctor
```

## 实测摘要（本机）

- C 盘：约 **188 GB free / 413 GB total**
- 高内存进程：Memory Compression / Steam / Explorer / ZCode 等
- doctor：node、workspace、tools、sandbox 均为 ok

## 结论

只读诊断链路可用；缺“给小白看的结论卡片”和入门模式产品化。
