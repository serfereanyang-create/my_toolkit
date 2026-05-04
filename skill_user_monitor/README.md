# Skill Recorder - 工作流监视器

记录用户操作习惯，辅助 skill 构建。

## 功能

### 窗口监控
- 记录前台窗口切换（进程名、窗口标题）
- 自动跳过隐私应用（微信、钉钉、QQ 等）

### 文件监控
- 监视多个目录（项目目录、下载目录、ESP32 等）
- 支持扩展名过滤
- 优先级文件（main/*.c, *.ino, CMakeLists.txt 等）自动捕获 diff
- 直接记录文件变化发生时，前台是谁、用的什么工具、窗口标题是什么

### 浏览器监控
- 通过 Chrome/Edge DevTools Protocol 捕获标签页
- 记录标题、域名、URL、导航类型

### AI 命令捕获
- 从 Roo-Cline 任务目录读取 AI 执行的命令
- 捕获命令输出、退出码、工作目录
- 生成结构化终端活动：actor、shell、cwd、工具链、动作类型、输出信号
- 将工具/命令启动后发生的文件改动关联到对应命令
- 对 VS Code、Cursor、Windsurf、Arduino IDE 这类 GUI 内置终端补充推断会话

### 剪贴板监控
- 录制时检测剪贴板变化（仅记录前 1000 字符）

### 智能推断
| 功能 | 说明 |
|------|------|
| 工具链关联 | 检测 ESP-IDF、Git、Node.js、Python、PlatformIO 等工具链 |
| 工具文件变化 | 直接汇总哪个工具改了哪些文件 |
| AI 操作分类 | 推断 AI 执行的操作：install_tools、build_project、debug_error 等 |
| 用户命令习惯 | 统计用户常用 flags、命令模式、Shell 偏好 |
| 终端活动 | 将命令归类为 build_project、install_dependencies、inspect_environment 等 |
| 工具文件影响 | 关联每条命令后续造成的 created/modified/deleted 文件变化 |
| GUI 终端会话 | 从编辑器窗口切换、文件变化和剪贴板变化推断内置终端活动及影响文件 |
| GUI 文件操作 | 推断文件操作类型：extract_archive、edit_code_file、copy_file 等 |
| 用户反馈信号 | 从 Roo 消息中提取用户接受/拒绝/偏好信号 |

## 导出字段

```json
{
  "session_name": "会话名称",
  "session_goal": "用户意图",
  "session_success_criteria": "成功标准",
  "session_result": "会话结果",
  "session_blockers": ["阻碍因素"],
  "session_next_step": "下一步",
  "session_intent": "开始意图",
  "session_outcome": "结束总结",

  "tool_chains": [
    {"tool_chain": "esp_idf", "command_count": 5, "succeeded_count": 3}
  ],

  "ai_operations": [
    {"ai_operation": "install_tools", "confidence": "high", "succeeded": false}
  ],

  "user_command_habits": {
    "total_user_commands": 10,
    "common_flags": [{"flag": "-v", "count": 3}]
  },

  "command_executions": [
    {"command": "idf.py build", "succeeded": true, "output_preview": "..."}
  ],

  "tool_file_changes": [
    {
      "tool_name": "OpenCode",
      "process_name": "opencode.exe",
      "window_title": "main.c - my_project - OpenCode",
      "file_change_count": 3,
      "change_counts": {"modified": 2, "created": 1},
      "files": [
        {"path": "main/main.c", "change": "modified", "is_priority_file": true}
      ]
    }
  ],

  "simple_file_journal": [
    "21:56:30 OpenCode 修改 main/main.c",
    "21:56:31 Codex 新建 components/foo.h"
  ],

  "terminal_activity": [
    {
      "sequence": 1,
      "actor": "ai",
      "shell": "roo_tool",
      "tool_chain": "esp_idf",
      "terminal_action": "build_project",
      "uses_command_chaining": false,
      "output": {
        "exit_code": 0,
        "output_signals": ["completed_successfully"]
      }
    }
  ],

  "tool_file_impacts": [
    {
      "command_sequence": 1,
      "tool_chain": "esp_idf",
      "terminal_action": "build_project",
      "file_change_count": 3,
      "change_counts": {"modified": 2, "created": 1},
      "impacted_files": [
        {"path": "build/project_description.json", "change": "modified", "has_diff": false}
      ]
    }
  ],

  "gui_terminal_sessions": [
    {
      "terminal_kind": "vscode_terminal",
      "window_title": "Terminal - my_project - Visual Studio Code",
      "window_title_metadata": {
        "editor_label": "Visual Studio Code",
        "workspace_name": "my_project",
        "project_name": "Terminal",
        "terminal_tab_name": "Terminal"
      },
      "file_change_count": 2,
      "change_counts": {"modified": 2},
      "clipboard_change_count": 1,
      "clipboard_samples": [
        {"clipboard_preview": "idf.py build", "content_length": 12}
      ],
      "impacted_files": [
        {"path": "main/main.c", "change": "modified", "is_priority_file": true}
      ]
    }
  ],

  "gui_file_actions": [
    {"gui_file_action": "edit_source_code", "target": "main/main.c"}
  ],

  "derived_events": [...],
  "events": [...]
}
```

## 隐私

- ❌ 不记录全局按键
- ❌ 不捕获密码、Cookie、Token
- ✅ 跳过隐私应用窗口
- ✅ 跳过隐私路径
- ✅ 剪贴板内容本地记录，不上传
- 安全模式默认启用

## 运行

```bash
pip install -r requirements.txt
python app.py
```

## 依赖

- Python 3.10+
- tkinter（内置）
- ctypes（Windows API）
