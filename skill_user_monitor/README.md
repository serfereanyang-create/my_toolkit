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

### 浏览器监控
- 通过 Chrome/Edge DevTools Protocol 捕获标签页
- 记录标题、域名、URL、导航类型

### AI 命令捕获
- 从 Roo-Cline 任务目录读取 AI 执行的命令
- 捕获命令输出、退出码、工作目录

### 剪贴板监控
- 录制时检测剪贴板变化（仅记录前 1000 字符）

### 智能推断
| 功能 | 说明 |
|------|------|
| 工具链关联 | 检测 ESP-IDF、Git、Node.js、Python、PlatformIO 等工具链 |
| AI 操作分类 | 推断 AI 执行的操作：install_tools、build_project、debug_error 等 |
| 用户命令习惯 | 统计用户常用 flags、命令模式、Shell 偏好 |
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