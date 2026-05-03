import ctypes
import difflib
import fnmatch
import hashlib
import json
import os
import queue
import socket
import subprocess
import threading
import time
from collections import Counter
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, urlunparse
from urllib.request import urlopen
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk


user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD

kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.EmptyClipboard.restype = wintypes.BOOL

CF_TEXT = 1
CF_UNICODETEXT = 13

APP_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = APP_DIR / "scripts"
LOGS_DIR = APP_DIR / "logs"
BROWSER_LOGS_DIR = LOGS_DIR / "browser_sessions"
BROWSER_POLL_INTERVAL_SEC = 1.5
ROO_CLINE_TASKS_DIR = (
    Path.home()
    / "AppData"
    / "Roaming"
    / "Code"
    / "User"
    / "globalStorage"
    / "rooveterinaryinc.roo-cline"
    / "tasks"
)
ROO_POLL_INTERVAL_SEC = 2.0
CONTENT_CAPTURE_MAX_BYTES = 200_000
CONTENT_CAPTURE_PREVIEW_CHARS = 12_000
DIFF_CAPTURE_MAX_CHARS = 40_000

SPECIAL_TEXT_FILENAMES = {
    "cmakelists.txt",
    "sdkconfig",
    "platformio.ini",
}

PRIORITY_FILE_PATTERNS = [
    "main/main.c",
    "main/*.c",
    "main/*.h",
    "components/**",
    "CMakeLists.txt",
    "sdkconfig*",
    "settings.json",
    "*.ino",
    "platformio.ini",
]

NOISY_DIFF_PATH_PATTERNS = [
    "globalstorage/rooveterinaryinc.roo-cline/tasks/**",
    "workspaceStorage/**",
    "globalstorage/state.vscdb",
    "**/*.tmp",
    "**/command-output/cmd-*.txt",
]

GUI_ACTION_INCLUDE_ROOT_KEYWORDS = [
    "d:/esp32",
    "c:/esp",
    "/downloads",
    "arduino15",
]

USER_FEEDBACK_PHRASES = {
    "user_acceptance_signal": ["可以", "行", "继续", "对", "就这样", "没问题"],
    "user_rejection_signal": ["不要这样", "不对", "错了", "不是这个", "先别动代码"],
    "user_preference_signal": ["太麻烦了", "直接帮我做", "我只想看结果", "先别动代码", "别解释太多"],
}

EDITOR_PROCESS_NAMES = {
    "code.exe",
    "code - insiders.exe",
    "cursor.exe",
    "windsurf.exe",
    "arduino ide.exe",
    "arduino.exe",
}

EDITOR_TITLE_KEYWORDS = {
    "visual studio code",
    "vscode",
    "cursor",
    "windsurf",
    "arduino ide",
    "arduino",
}

TEXT_CAPTURE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".ini",
    ".ino",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
}

PRIVATE_APP_PROCESS_NAMES = {
    "qq.exe",
    "tim.exe",
    "wechat.exe",
    "weixin.exe",
    "wxwork.exe",
    "dingtalk.exe",
    "feishu.exe",
    "lark.exe",
    "telegram.exe",
    "whatsapp.exe",
    "signal.exe",
    "slack.exe",
    "discord.exe",
    "teams.exe",
    "ms-teams.exe",
    "1password.exe",
    "bitwarden.exe",
}

PRIVATE_APP_TITLE_KEYWORDS = {
    "微信",
    "wechat",
    "企业微信",
    "qq",
    "tim",
    "钉钉",
    "dingtalk",
    "飞书",
    "feishu",
    "lark",
    "telegram",
    "whatsapp",
    "signal",
    "slack",
    "discord",
    "teams",
    "1password",
    "bitwarden",
}

PRIVATE_PATH_EXACT_PARTS = {
    "qq",
    "tim",
    "wechat",
    "weixin",
    "wxwork",
    "tencent files",
    "wechat files",
    "telegram desktop",
    "whatsapp",
    "signal",
    "dingtalk",
    "feishu",
    "lark",
    "1password",
    "bitwarden",
}

PRIVATE_PATH_KEYWORDS = {
    "tencent\\qq",
    "tencent\\wechat",
    "tencent\\weixin",
    "tencent files",
    "wechat files",
    "wxwork",
    "telegram desktop",
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def normalize_path(value: str | Path) -> str:
    return os.path.normcase(os.path.abspath(str(value)))


def is_private_path(path: str | Path) -> bool:
    normalized = normalize_path(path)
    lowered = normalized.lower()
    parts = {part.lower() for part in Path(normalized).parts}
    if parts & PRIVATE_PATH_EXACT_PARTS:
        return True
    return any(keyword in lowered for keyword in PRIVATE_PATH_KEYWORDS)


def is_private_app_snapshot(snapshot: dict | None) -> bool:
    if not snapshot:
        return False

    process_name = str(snapshot.get("process_name", "")).lower()
    exe_path = str(snapshot.get("exe_path", ""))
    title = str(snapshot.get("window_title", "")).lower()

    if process_name in PRIVATE_APP_PROCESS_NAMES:
        return True
    if exe_path and is_private_path(exe_path):
        return True
    return any(keyword in title for keyword in PRIVATE_APP_TITLE_KEYWORDS)


def redact_private_snapshot(snapshot: dict | None) -> dict | None:
    if not snapshot or not is_private_app_snapshot(snapshot):
        return snapshot
    return {
        "window_title": "（隐私应用已隐藏）",
        "process_id": None,
        "process_name": "隐私应用",
        "exe_path": "（路径已隐藏）",
        "private_recording_blocked": True,
    }


def parse_extension_filter(raw_value: str) -> set[str] | None:
    cleaned = raw_value.replace(";", ",").replace(" ", "")
    if not cleaned:
        return None

    result: set[str] = set()
    for item in cleaned.split(","):
        if not item:
            continue
        if item in {"*", "*.*", "全部"}:
            return None
        if not item.startswith("."):
            item = f".{item}"
        result.add(item.lower())
    return result or None


def get_window_text(hwnd: int) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value.strip()


def get_process_path(pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        ok = kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size))
        return buffer.value if ok else ""
    finally:
        kernel32.CloseHandle(handle)


def get_foreground_snapshot() -> dict | None:
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None

    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    title = get_window_text(hwnd)
    exe_path = get_process_path(pid.value)
    process_name = Path(exe_path).name if exe_path else ""

    return {
        "window_title": title,
        "process_id": int(pid.value),
        "process_name": process_name,
        "exe_path": exe_path,
    }


def read_clipboard_text() -> str | None:
    try:
        if user32.OpenClipboard(None):
            try:
                handle = user32.GetClipboardData(CF_UNICODETEXT)
                if handle:
                    text = ctypes.wstring_at(handle)
                    return text if text else None
            finally:
                user32.CloseClipboard()
    except Exception:
        pass
    return None


def is_editor_snapshot(snapshot: dict | None) -> bool:
    if not snapshot:
        return False

    process_name = str(snapshot.get("process_name", "")).lower()
    title = str(snapshot.get("window_title", "")).lower()
    if process_name in EDITOR_PROCESS_NAMES:
        return True
    return any(keyword in title for keyword in EDITOR_TITLE_KEYWORDS)


def can_capture_text_content(path: str | Path) -> bool:
    try:
        file_path = Path(path)
    except TypeError:
        return False
    return file_path.suffix.lower() in TEXT_CAPTURE_EXTENSIONS or file_path.name.lower() in SPECIAL_TEXT_FILENAMES


def read_text_snapshot(path: str | Path) -> dict | None:
    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        size = file_path.stat().st_size
    except OSError:
        return None

    if size > CONTENT_CAPTURE_MAX_BYTES or not can_capture_text_content(file_path):
        return None

    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    preview = text[:CONTENT_CAPTURE_PREVIEW_CHARS]
    return {
        "path": str(file_path),
        "extension": file_path.suffix.lower(),
        "size": int(size),
        "sha256": hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest(),
        "line_count": text.count("\n") + (1 if text else 0),
        "preview": preview,
        "text": text,
        "truncated": len(text) > CONTENT_CAPTURE_PREVIEW_CHARS,
    }


def summarize_text_snapshot(snapshot: dict | None) -> dict | None:
    if not snapshot:
        return None
    return {
        "path": snapshot.get("path", ""),
        "extension": snapshot.get("extension", ""),
        "size": snapshot.get("size", 0),
        "sha256": snapshot.get("sha256", ""),
        "line_count": snapshot.get("line_count", 0),
        "preview": snapshot.get("preview", ""),
        "truncated": snapshot.get("truncated", False),
    }


def build_unified_diff(before_text: str, after_text: str, path: str) -> tuple[str, bool]:
    diff = "".join(
        difflib.unified_diff(
            before_text.splitlines(keepends=True),
            after_text.splitlines(keepends=True),
            fromfile=f"before/{path}",
            tofile=f"after/{path}",
        )
    )
    truncated = len(diff) > DIFF_CAPTURE_MAX_CHARS
    if truncated:
        diff = diff[:DIFF_CAPTURE_MAX_CHARS]
    return diff, truncated


def normalize_match_path(path: str) -> str:
    return path.replace("\\", "/")


def priority_file_match(path: str) -> tuple[bool, str]:
    normalized = normalize_match_path(path)
    name = Path(path).name
    for pattern in PRIORITY_FILE_PATTERNS:
        if fnmatch.fnmatchcase(normalized, pattern) or fnmatch.fnmatchcase(name, pattern):
            return True, pattern
    return False, ""


def path_matches_patterns(path: str, patterns: list[str]) -> bool:
    normalized = normalize_match_path(path)
    name = Path(path).name
    for pattern in patterns:
        if fnmatch.fnmatchcase(normalized, pattern) or fnmatch.fnmatchcase(name, pattern):
            return True
    return False


def should_capture_file_diff(path: str) -> bool:
    is_priority, _ = priority_file_match(path)
    if not is_priority:
        return False
    return not path_matches_patterns(path, NOISY_DIFF_PATH_PATTERNS)


def is_gui_action_candidate(path: str) -> bool:
    normalized = normalize_match_path(path).lower()
    if path_matches_patterns(path, NOISY_DIFF_PATH_PATTERNS):
        return False
    return any(keyword in normalized for keyword in GUI_ACTION_INCLUDE_ROOT_KEYWORDS)


def read_text_preview(path: str | Path) -> dict | None:
    snapshot = read_text_snapshot(path)
    if not snapshot:
        return None
    summary = summarize_text_snapshot(snapshot) or {}
    summary["line_count_estimate"] = summary.pop("line_count", 0)
    return summary


def summarize_roo_content_blocks(blocks: list[dict]) -> tuple[str, list[str]]:
    text_parts: list[str] = []
    tool_names: list[str] = []
    for block in blocks:
        block_type = block.get("type")
        if block_type in {"text", "reasoning"}:
            text_value = str(block.get("text", "")).strip()
            if text_value:
                text_parts.append(text_value)
        elif block_type == "tool_use":
            tool_name = str(block.get("name", "")).strip()
            if tool_name:
                tool_names.append(tool_name)
                text_parts.append(f"[tool_use] {tool_name}")
        elif block_type == "tool_result":
            text_value = str(block.get("content", "")).strip()
            if text_value:
                text_parts.append(f"[tool_result] {text_value}")
    summary = "\n".join(part for part in text_parts if part).strip()
    return summary[:CONTENT_CAPTURE_PREVIEW_CHARS], tool_names


def extract_roo_history_events(path: str | Path, start_index: int) -> tuple[list[dict], int]:
    history_path = Path(path)
    try:
        with open(history_path, "r", encoding="utf-8", errors="replace") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return [], start_index

    if not isinstance(payload, list):
        return [], start_index

    if start_index > len(payload):
        start_index = 0

    task_id = history_path.parent.name
    events: list[dict] = []
    for index, item in enumerate(payload[start_index:], start=start_index):
        role = str(item.get("role", "unknown"))
        blocks = item.get("content") or []
        if not isinstance(blocks, list):
            blocks = []
        summary, tool_names = summarize_roo_content_blocks(blocks)
        event = {
            "timestamp": now_iso(),
            "type": "roo_cline_message",
            "task_id": task_id,
            "source_path": str(history_path),
            "history_index": index,
            "role": role,
            "content_preview": summary,
            "tool_names": tool_names,
            "source_ts": item.get("ts"),
        }
        events.append(event)
    return events, len(payload)


def build_roo_full_export(events: list[dict]) -> list[dict]:
    grouped_indexes: dict[str, set[int]] = {}
    for event in events:
        if event.get("type") != "roo_cline_message":
            continue
        source_path = str(event.get("source_path", "")).strip()
        history_index = event.get("history_index")
        if not source_path or not isinstance(history_index, int):
            continue
        grouped_indexes.setdefault(source_path, set()).add(history_index)

    exported: list[dict] = []
    for source_path, indexes in grouped_indexes.items():
        history_path = Path(source_path)
        try:
            with open(history_path, "r", encoding="utf-8", errors="replace") as fh:
                payload = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue

        if not isinstance(payload, list):
            continue

        for history_index in sorted(indexes):
            if history_index < 0 or history_index >= len(payload):
                continue
            item = payload[history_index]
            exported.append(
                {
                    "task_id": history_path.parent.name,
                    "source_path": str(history_path),
                    "history_index": history_index,
                    "source_ts": item.get("ts"),
                    "role": item.get("role", "unknown"),
                    "content": item.get("content", []),
                }
            )

    return exported


def extract_user_message_text(blocks: list[dict]) -> str:
    parts: list[str] = []
    for block in blocks:
        if block.get("type") != "text":
            continue
        text = str(block.get("text", ""))
        start_tag = "<user_message>"
        end_tag = "</user_message>"
        if start_tag in text and end_tag in text:
            start = text.index(start_tag) + len(start_tag)
            end = text.index(end_tag, start)
            message = text[start:end].strip()
            if message:
                parts.append(message)
    return "\n".join(parts).strip()


def stringify_roo_block_content(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return str(value or "")


def extract_user_feedback_signals(events: list[dict]) -> list[dict]:
    signals: list[dict] = []
    for event in events:
        if event.get("type") != "roo_cline_message" or event.get("role") != "user":
            continue
        source_path = str(event.get("source_path", "")).strip()
        history_index = event.get("history_index")
        if not source_path or not isinstance(history_index, int):
            continue
        try:
            payload = json.loads(Path(source_path).read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        if history_index < 0 or history_index >= len(payload):
            continue
        blocks = payload[history_index].get("content") or []
        text = extract_user_message_text(blocks)
        if not text:
            continue
        for signal, phrases in USER_FEEDBACK_PHRASES.items():
            for phrase in phrases:
                if phrase in text:
                    signals.append(
                        {
                            "timestamp": event.get("timestamp", now_iso()),
                            "type": "user_feedback_signal",
                            "signal": signal,
                            "text": text[:CONTENT_CAPTURE_PREVIEW_CHARS],
                            "matched_phrase": phrase,
                            "confidence": "medium",
                            "source": event.get("type"),
                        }
                    )
                    break
    return signals


def load_managed_terminal_commands(session_name: str) -> list[dict]:
    commands: list[dict] = []
    if not LOGS_DIR.exists():
        return commands
    safe_prefix = session_name.replace(" ", "_")
    candidates = sorted(LOGS_DIR.glob(f"{safe_prefix}-*/commands.ndjson"))
    if not candidates:
        candidates = sorted(LOGS_DIR.glob("*/commands.ndjson"))

    for command_log in candidates:
        try:
            lines = command_log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            commands.append(
                {
                    "timestamp": item.get("timestamp", now_iso()),
                    "type": "command_executed",
                    "command_actor": "user",
                    "invoked_by": "user",
                    "shell": item.get("shell", "powershell"),
                    "command": item.get("command", ""),
                    "redacted_command": item.get("redacted_command", ""),
                    "cwd": item.get("cwd_before", ""),
                    "cwd_before": item.get("cwd_before", ""),
                    "cwd_after": item.get("cwd_after", ""),
                    "exit_code": item.get("native_exit_code"),
                    "succeeded": item.get("succeeded"),
                    "duration_ms": item.get("duration_ms"),
                    "primary_command": item.get("primary_command", ""),
                    "command_category": item.get("command_category", ""),
                    "intent": item.get("intent", ""),
                    "referenced_paths": item.get("referenced_paths", []),
                    "stdout_preview": item.get("output_preview", ""),
                    "stderr_preview": "",
                    "output_preview": item.get("output_preview", ""),
                    "source_log": str(command_log),
                }
            )
    return commands


def load_roo_command_executions(events: list[dict]) -> list[dict]:
    grouped_indexes: dict[str, set[int]] = {}
    for event in events:
        if event.get("type") != "roo_cline_message":
            continue
        source_path = str(event.get("source_path", "")).strip()
        history_index = event.get("history_index")
        if source_path and isinstance(history_index, int):
            grouped_indexes.setdefault(source_path, set()).add(history_index)

    commands: list[dict] = []
    for source_path, indexes in grouped_indexes.items():
        try:
            payload = json.loads(Path(source_path).read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        for history_index in sorted(indexes):
            if history_index < 0 or history_index >= len(payload):
                continue
            item = payload[history_index]
            if item.get("role") != "assistant":
                continue
            blocks = item.get("content") or []
            for block in blocks:
                if block.get("type") != "tool_use":
                    continue
                input_data = block.get("input") or {}
                command = str(input_data.get("command", "")).strip()
                cwd = str(input_data.get("cwd", "")).strip()
                if not command:
                    continue
                result_preview = ""
                exit_code = None
                succeeded = None
                if history_index + 1 < len(payload):
                    next_item = payload[history_index + 1]
                    if next_item.get("role") == "user":
                        for next_block in next_item.get("content") or []:
                            if next_block.get("type") != "tool_result":
                                continue
                            if str(next_block.get("tool_use_id", "")) != str(block.get("id", "")):
                                continue
                            result_preview = str(next_block.get("content", ""))[:CONTENT_CAPTURE_PREVIEW_CHARS]
                            if "Exit code: 0" in result_preview:
                                exit_code = 0
                                succeeded = True
                            else:
                                marker = "Exit code: "
                                if marker in result_preview:
                                    try:
                                        exit_code = int(result_preview.split(marker, 1)[1].splitlines()[0].strip())
                                        succeeded = exit_code == 0
                                    except ValueError:
                                        pass
                            break
                commands.append(
                    {
                        "timestamp": now_iso(),
                        "type": "command_executed",
                        "command_actor": "ai",
                        "invoked_by": "ai",
                        "shell": "roo_tool",
                        "command": command,
                        "redacted_command": command,
                        "cwd": cwd,
                        "cwd_before": cwd,
                        "cwd_after": cwd,
                        "exit_code": exit_code,
                        "succeeded": succeeded,
                        "duration_ms": None,
                        "primary_command": command.split()[0] if command.split() else "",
                        "command_category": "ai_tool",
                        "intent": "execute assistant-suggested command",
                        "referenced_paths": [cwd] if cwd else [],
                        "stdout_preview": result_preview,
                        "stderr_preview": "",
                        "output_preview": result_preview,
                        "source_log": source_path,
                    }
                )
    return commands


def infer_verification_steps(commands: list[dict]) -> list[dict]:
    verification_commands = {"idf.py", "ninja", "cmake", "pytest", "npm", "pnpm", "yarn"}
    steps: list[dict] = []
    for command in commands:
        primary = str(command.get("primary_command", "")).lower()
        raw = str(command.get("command", "")).lower()
        if primary not in verification_commands and " build" not in raw and " test" not in raw:
            continue
        result = "passed" if command.get("succeeded") else "failed"
        steps.append(
            {
                "timestamp": command.get("timestamp", now_iso()),
                "type": "verification_step",
                "verification_step": command.get("command", ""),
                "result": result,
                "evidence": f"exit_code={command.get('exit_code')}",
                "source_log": command.get("source_log", ""),
            }
        )
    return steps


def infer_gui_file_actions(events: list[dict]) -> list[dict]:
    file_events = [
        event
        for event in events
        if event.get("type") == "file_change"
        and event.get("change") != "error"
        and is_gui_action_candidate(str(event.get("full_path") or event.get("path") or ""))
    ]
    
    zip_patterns = {".zip", ".rar", ".7z", ".tar", ".gz"}
    actions: list[dict] = []
    recent_zips: dict[str, float] = {}
    current_time = datetime.now().timestamp()

    for event in file_events:
        path = event.get("path", "")
        ext = Path(path).suffix.lower()
        if ext in zip_patterns:
            recent_zips[path] = current_time

    for event in file_events:
        path = event.get("path", "")
        full_path = event.get("full_path", "")
        change = event.get("change", "")
        ext = Path(path).suffix.lower()
        
        action = ""
        confidence = "low"
        evidence = ""
        
        if change == "created":
            is_in_downloads = "download" in path.lower()
            has_zip_nearby = False
            for zip_path in recent_zips:
                if zip_path.lower().replace("\\", "/").rsplit("/", 1)[0] in path.lower().replace("\\", "/") or \
                   path.lower().replace("\\", "/").startswith(zip_path.lower().replace("\\", "/").rsplit("/", 1)[0]):
                    has_zip_nearby = True
                    break
            
            if is_in_downloads or has_zip_nearby:
                action = "extract_archive"
                confidence = "medium" if has_zip_nearby else "low"
                evidence = f"创建了 {ext} 归档中的文件"
            elif any(keyword in path.lower() for keyword in ["copy", "copy of", "副本"]):
                action = "copy_file"
                confidence = "medium"
                evidence = "文件名包含 copy 关键字"
            elif ext in {".c", ".cpp", ".h", ".py", ".ino", ".json", ".md"} and not any(n in path.lower() for n in ["tmp", "cache", "backup"]):
                action = "edit_code_file"
                confidence = "medium"
                evidence = f"编辑了代码文件 {ext}"
            else:
                action = "create_file"
                confidence = "low"
                evidence = f"创建了新文件 {ext}"

        elif change == "deleted":
            if "temp" in path.lower() or "tmp" in path.lower() or "cache" in path.lower():
                action = "clear_cache"
                confidence = "medium"
                evidence = "删除了临时/缓存文件"
            elif any(keyword in path.lower() for keyword in ["backup", "old", "unused"]):
                action = "cleanup_old_files"
                confidence = "medium"
                evidence = "清理旧文件"
            else:
                action = "delete_file"
                confidence = "low"
                evidence = "删除了文件"

        elif change == "renamed":
            if "copy" in path.lower() or "副本" in path:
                action = "duplicate_file"
                confidence = "medium"
                evidence = "复制了文件"
            else:
                action = "rename_file"
                confidence = "low"
                evidence = "重命名了文件"

        elif change == "modified":
            if ext in {".c", ".cpp", ".h", ".hpp", ".py", ".ino", ".js", ".ts", ".ino"}:
                action = "edit_source_code"
                confidence = "high"
                evidence = f"修改了源代码文件 {ext}"
            elif ext in {".json", ".yml", ".yaml", ".toml", ".ini"}:
                action = "edit_config"
                confidence = "medium"
                evidence = f"修改了配置文件 {ext}"
            elif ext in {".md", ".txt", ".html", ".css"}:
                action = "edit_text_file"
                confidence = "medium"
                evidence = f"编辑了文本文件 {ext}"
            else:
                action = "modify_file"
                confidence = "low"
                evidence = f"修改了文件 {ext}"

        if action:
            actions.append(
                {
                    "timestamp": event.get("timestamp", now_iso()),
                    "type": "gui_file_action",
                    "gui_file_action": action,
                    "target": path,
                    "full_target": full_path,
                    "confidence": confidence,
                    "evidence": evidence,
                }
            )
    
    seen: set[str] = set()
    unique_actions: list[dict] = []
    for a in actions:
        key = f"{a.get('gui_file_action')}_{a.get('target', '')}"
        if key not in seen:
            seen.add(key)
            unique_actions.append(a)
    
    return unique_actions


TOOL_CHAINS = {
    "esp_idf": {
        "keywords": ["idf.py", "esptool.py", "espflash", "idf_tools.py", "esp-idf"],
        "commands": {"idf.py", "esptool", "espflash", "cmake", "ninja", "idf-tools"},
        "file_extensions": {".c", ".h", ".cpp", ".hpp", ".ino", "CMakeLists.txt", "sdkconfig"},
    },
    "git": {
        "keywords": ["git", "git.exe"],
        "commands": {"git", "git.exe"},
        "file_extensions": {".git"},
    },
    "nodejs": {
        "keywords": ["npm", "pnpm", "yarn", "node", "node.exe"],
        "commands": {"npm", "pnpm", "yarn", "node", "npx"},
        "file_extensions": {".js", ".mjs", ".cjs", ".json"},
    },
    "python": {
        "keywords": ["python", "python.exe", "pip", "poetry", "pytest"],
        "commands": {"python", "python.exe", "pip", "pytest", "poetry"},
        "file_extensions": {".py", ".pyw"},
    },
    "platformio": {
        "keywords": ["platformio", "pio"],
        "commands": {"platformio", "pio"},
        "file_extensions": {"platformio.ini"},
    },
    "arduino": {
        "keywords": ["arduino", "arduino-cli"],
        "commands": {"arduino-cli", "arduino"},
        "file_extensions": {".ino", ".pde"},
    },
    "docker": {
        "keywords": ["docker", "docker.exe"],
        "commands": {"docker", "docker.exe", "docker-compose"},
        "file_extensions": {"Dockerfile", "docker-compose.yml"},
    },
    "cmake": {
        "keywords": ["cmake", "cmake.exe"],
        "commands": {"cmake", "cmake.exe", "make", "ninja"},
        "file_extensions": {"CMakeLists.txt", "Makefile"},
    },
}


def detect_tool_chains(commands: list[dict], file_events: list[dict]) -> list[dict]:
    detected_chains: dict[str, dict] = {}
    
    for cmd in commands:
        cmd_str = str(cmd.get("command", "")).lower()
        primary = str(cmd.get("primary_command", "")).lower()
        
        for chain_name, chain_data in TOOL_CHAINS.items():
            if any(k in cmd_str for k in chain_data["keywords"]):
                if chain_name not in detected_chains:
                    detected_chains[chain_name] = {
                        "tool_chain": chain_name,
                        "first_seen": cmd.get("timestamp", ""),
                        "command_count": 0,
                        "commands": [],
                        "succeeded_count": 0,
                        "failed_count": 0,
                    }
                detected_chains[chain_name]["command_count"] += 1
                detected_chains[chain_name]["commands"].append({
                    "command": cmd.get("command", ""),
                    "succeeded": cmd.get("succeeded", False),
                    "timestamp": cmd.get("timestamp", ""),
                })
                if cmd.get("succeeded"):
                    detected_chains[chain_name]["succeeded_count"] += 1
                else:
                    detected_chains[chain_name]["failed_count"] += 1
                break
    
    for event in file_events:
        path = str(event.get("path", "")).lower()
        ext = Path(path).suffix.lower()
        
        for chain_name, chain_data in TOOL_CHAINS.items():
            if ext in chain_data["file_extensions"]:
                if chain_name not in detected_chains:
                    detected_chains[chain_name] = {
                        "tool_chain": chain_name,
                        "first_seen": event.get("timestamp", ""),
                        "command_count": 0,
                        "commands": [],
                        "succeeded_count": 0,
                        "failed_count": 0,
                        "file_extensions": [],
                    }
                if "file_extensions" not in detected_chains[chain_name]:
                    detected_chains[chain_name]["file_extensions"] = []
                if ext not in detected_chains[chain_name]["file_extensions"]:
                    detected_chains[chain_name]["file_extensions"].append(ext)
                break
    
    return list(detected_chains.values())


AI_OPERATION_PATTERNS = {
    "install_tools": {
        "keywords": ["install", "下载", "安装", "setup", "setuptools", "idf_tools.py"],
        "commands": {"pip install", "npm install", "pip", "idf_tools.py install", "python -m pip"},
    },
    "build_project": {
        "keywords": ["build", "编译", "make", "cmake", "ninja", "idf.py build", "pio run"],
        "commands": {"idf.py build", "cmake", "ninja", "make", "platformio run", "pio run"},
    },
    "flash_device": {
        "keywords": ["flash", "烧录", "upload", "esptool", "idf.py flash", "pio run --target upload"],
        "commands": {"esptool", "idf.py flash", "idf.py app-flash", "pio run --target upload"},
    },
    "debug_error": {
        "keywords": ["debug", "错误", "error", "exception", "failed", "permission denied", "no such file"],
        "commands": {"idf.py check", "idf.py fullclean", "cmake", "ninja"},
    },
    "configure_project": {
        "keywords": ["config", "配置", "sdkconfig", "menuconfig", "settings"],
        "commands": {"idf.py menuconfig", "idf.py reconfigure", "pio run --target menuconfig"},
    },
    "edit_code": {
        "keywords": ["edit", "修改", "change", "update", "write", "create"],
        "commands": {"code", "cursor", "write", "echo", "type", "copy-item"},
    },
    "version_check": {
        "keywords": ["version", "check", "version", "--version", "-v"],
        "commands": {"--version", "-v", "version", "check"},
    },
    "clean_project": {
        "keywords": ["clean", "清理", "remove", "delete", "删除"],
        "commands": {"idf.py fullclean", "idf.py clean", "rm -rf", "Remove-Item", "clean"},
    },
    "port_monitor": {
        "keywords": ["monitor", "串口", "port", "serial", "uart"],
        "commands": {"idf.py monitor", "pio device monitor", "screen", "putty"},
    },
    "test_run": {
        "keywords": ["test", "测试", "pytest", "unittest"],
        "commands": {"pytest", "python -m pytest", "pio test", "npm test"},
    },
}


def classify_ai_operations(commands: list[dict]) -> list[dict]:
    operations: list[dict] = []
    seen_operations: set[str] = set()
    
    for cmd in commands:
        if cmd.get("command_actor") != "ai":
            continue
        
        cmd_str = str(cmd.get("command", "")).lower()
        timestamp = cmd.get("timestamp", "")
        
        for op_name, op_data in AI_OPERATION_PATTERNS.items():
            if any(k in cmd_str for k in op_data["keywords"]):
                if op_name not in seen_operations:
                    seen_operations.add(op_name)
                    operations.append({
                        "timestamp": timestamp,
                        "type": "ai_operation",
                        "ai_operation": op_name,
                        "confidence": "high" if any(c in cmd_str for c in op_data["commands"]) else "medium",
                        "trigger_command": cmd.get("command", ""),
                        "succeeded": cmd.get("succeeded", False),
                        "cwd": cmd.get("cwd", ""),
                    })
                break
    
    return operations


def extract_user_command_habits(commands: list[dict]) -> dict:
    user_commands = [cmd for cmd in commands if cmd.get("command_actor") in ("user", "human")]
    
    if not user_commands:
        return {
            "total_user_commands": 0,
            "average_command_length": 0,
            "common_flags": [],
            "command_patterns": [],
            "shell_usage": {},
        }
    
    all_flags: list[str] = []
    all_words: list[str] = []
    shell_counts: dict[str, int] = {}
    length_sum = 0
    
    for cmd in user_commands:
        raw_cmd = str(cmd.get("command", ""))
        shell = str(cmd.get("shell", "unknown"))
        shell_counts[shell] = shell_counts.get(shell, 0) + 1
        
        parts = raw_cmd.split()
        length_sum += len(raw_cmd)
        
        i = 0
        while i < len(parts):
            part = parts[i]
            if part.startswith("-"):
                all_flags.append(part)
            if not part.startswith("-"):
                all_words.append(part.lower())
            i += 1
    
    flag_counter = Counter(all_flags)
    common_flags = [{"flag": f, "count": c} for f, c in flag_counter.most_common(10)]
    
    word_counter = Counter(all_words)
    common_words = [{"word": w, "count": c} for w, c in word_counter.most_common(20) if len(w) > 2]
    
    return {
        "total_user_commands": len(user_commands),
        "average_command_length": round(length_sum / len(user_commands), 1) if user_commands else 0,
        "common_flags": common_flags,
        "command_patterns": common_words,
        "shell_usage": shell_counts,
    }


def assess_session_text_quality(text: str) -> dict:
    normalized = " ".join(text.strip().lower().split())
    generic_phrases = {
        "cli",
        "gui",
        "cli gui",
        "cli进度",
        "进度",
        "操作",
        "操作各种cli和gui",
        "各种cli和gui",
    }
    issues: list[str] = []

    if len(text.strip()) < 10:
        issues.append("too_short")
    if normalized in generic_phrases:
        issues.append("too_generic")
    if "+" not in text and "修复" not in text and "编译" not in text and "排查" not in text and "开发" not in text:
        issues.append("missing_task_signal")

    return {
        "ok": not issues,
        "issues": issues,
        "normalized": normalized,
    }


def build_default_watch_profiles() -> list[dict]:
    username = os.environ.get("USERNAME", "")
    vscode_root = Path(f"C:/Users/{username}/AppData/Roaming/Code")
    profiles = [
        {
            "key": "codex_workspace",
            "label": "Codex 工作目录",
            "path": Path("D:/codex"),
            "exclude_prefixes": [LOGS_DIR],
            "exclude_names": {"__pycache__", ".git"},
        },
        {
            "key": "opencode_workspace",
            "label": "OpenCode 工作目录",
            "path": Path("D:/OpenCode"),
            "exclude_prefixes": [],
            "exclude_names": {"__pycache__", ".git"},
        },
        {
            "key": "vscode_user",
            "label": "VS Code 用户配置",
            "path": vscode_root / "User",
            "exclude_prefixes": [],
            "exclude_names": {"workspaceStorage"},
        },
        {
            "key": "vscode_workspaces",
            "label": "VS Code 工作区状态",
            "path": vscode_root / "Workspaces",
            "exclude_prefixes": [],
            "exclude_names": {"Cache", "CachedData", "blob_storage"},
        },
        {
            "key": "downloads_folder",
            "label": "下载目录",
            "path": Path.home() / "Downloads",
            "exclude_prefixes": [],
            "exclude_names": set(),
        },
        {
            "key": "esp32_projects",
            "label": "ESP32 项目目录",
            "path": Path("D:/esp32"),
            "exclude_prefixes": [],
            "exclude_names": {"__pycache__", ".git", "build"},
        },
        {
            "key": "esp_idf_root",
            "label": "ESP-IDF 安装目录",
            "path": Path("C:/esp"),
            "exclude_prefixes": [],
            "exclude_names": {"__pycache__", ".git", "build"},
        },
    ]

    available: list[dict] = []
    for profile in profiles:
        if profile["path"].exists():
            available.append(
                {
                    **profile,
                    "path": str(profile["path"]),
                    "exclude_prefixes": [str(Path(item)) for item in profile["exclude_prefixes"]],
                }
            )
    return available


def should_ignore_path(path: str, profile: dict) -> bool:
    normalized = normalize_path(path)
    if is_private_path(normalized):
        return True

    exclude_names = profile.get("exclude_names", set())
    if any(part in exclude_names for part in Path(normalized).parts):
        return True

    for prefix in profile.get("exclude_prefixes", []):
        if normalized.startswith(normalize_path(prefix)):
            return True
    return False


def should_track_file(path: str, extension_filter: set[str] | None) -> bool:
    if extension_filter is None:
        return True
    return Path(path).suffix.lower() in extension_filter


def snapshot_directory(profile: dict) -> dict[str, dict]:
    root = Path(profile["path"])
    root_norm = normalize_path(root)
    snapshot: dict[str, dict] = {}
    stack = [root_norm]
    extension_filter = profile.get("extensions")

    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    full_path = normalize_path(entry.path)
                    if should_ignore_path(full_path, profile):
                        continue

                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        continue

                    if is_dir:
                        stack.append(full_path)
                        continue

                    if not should_track_file(full_path, extension_filter):
                        continue

                    try:
                        stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue

                    rel_path = os.path.relpath(full_path, root_norm)
                    snapshot[rel_path] = {
                        "full_path": full_path,
                        "size": int(stat.st_size),
                        "mtime_ns": int(stat.st_mtime_ns),
                        "inode": int(getattr(stat, "st_ino", 0)),
                    }
                    text_snapshot = read_text_snapshot(full_path)
                    if text_snapshot:
                        snapshot[rel_path]["text_snapshot"] = text_snapshot
        except OSError:
            continue

    return snapshot


def diff_snapshots(profile: dict, previous: dict[str, dict], current: dict[str, dict]) -> list[dict]:
    events: list[dict] = []
    old_paths = set(previous)
    new_paths = set(current)
    deleted_paths = old_paths - new_paths
    created_paths = new_paths - old_paths

    deleted_by_inode: dict[int, list[str]] = {}
    created_by_inode: dict[int, list[str]] = {}

    for path in deleted_paths:
        inode = previous[path].get("inode", 0)
        if inode:
            deleted_by_inode.setdefault(inode, []).append(path)

    for path in created_paths:
        inode = current[path].get("inode", 0)
        if inode:
            created_by_inode.setdefault(inode, []).append(path)

    matched_deleted: set[str] = set()
    matched_created: set[str] = set()

    for inode in set(deleted_by_inode) & set(created_by_inode):
        old_candidates = sorted(deleted_by_inode[inode])
        new_candidates = sorted(created_by_inode[inode])
        for old_path, new_path in zip(old_candidates, new_candidates):
            old_info = previous[old_path]
            new_info = current[new_path]
            matched_deleted.add(old_path)
            matched_created.add(new_path)
            events.append(
                enrich_file_event(
                {
                    "timestamp": now_iso(),
                    "type": "file_change",
                    "watch_label": profile["label"],
                    "watch_root": profile["path"],
                    "change": "renamed",
                    "path": new_path,
                    "old_path": old_path,
                    "full_path": new_info["full_path"],
                    "old_full_path": old_info["full_path"],
                }, old_info, new_info)
            )

    for path in sorted(deleted_paths - matched_deleted):
        info = previous[path]
        events.append(
            enrich_file_event(
            {
                "timestamp": now_iso(),
                "type": "file_change",
                "watch_label": profile["label"],
                "watch_root": profile["path"],
                "change": "deleted",
                "path": path,
                "full_path": info["full_path"],
            }, info, None)
        )

    for path in sorted(created_paths - matched_created):
        info = current[path]
        events.append(
            enrich_file_event(
            {
                "timestamp": now_iso(),
                "type": "file_change",
                "watch_label": profile["label"],
                "watch_root": profile["path"],
                "change": "created",
                "path": path,
                "full_path": info["full_path"],
            }, None, info)
        )

    for path in sorted(old_paths & new_paths):
        old_info = previous[path]
        new_info = current[path]
        if old_info["mtime_ns"] != new_info["mtime_ns"] or old_info["size"] != new_info["size"]:
            events.append(
                enrich_file_event(
                {
                    "timestamp": now_iso(),
                    "type": "file_change",
                    "watch_label": profile["label"],
                    "watch_root": profile["path"],
                    "change": "modified",
                    "path": path,
                    "full_path": new_info["full_path"],
                    "size": new_info["size"],
                }, old_info, new_info)
            )

    return events


def enrich_file_event(event: dict, old_info: dict | None, new_info: dict | None) -> dict:
    is_priority, reason = priority_file_match(event.get("path", ""))
    enriched = dict(event)
    enriched["is_priority_file"] = is_priority
    if reason:
        enriched["priority_reason"] = reason

    old_snapshot = old_info.get("text_snapshot") if old_info else None
    new_snapshot = new_info.get("text_snapshot") if new_info else None
    if should_capture_file_diff(event.get("path", "")) and (old_snapshot or new_snapshot):
        enriched["file_diff"] = {
            "file_actor": "unknown",
            "before_summary": summarize_text_snapshot(old_snapshot),
            "after_summary": summarize_text_snapshot(new_snapshot),
        }
        if old_snapshot and new_snapshot:
            diff_text, diff_truncated = build_unified_diff(
                old_snapshot.get("text", ""),
                new_snapshot.get("text", ""),
                event.get("path", ""),
            )
            enriched["file_diff"]["unified_diff"] = diff_text
            enriched["file_diff"]["diff_truncated"] = diff_truncated
    return enriched


def sanitize_url_for_log(raw_url: str) -> str:
    if not raw_url:
        return ""
    try:
        parsed = urlparse(raw_url)
    except Exception:
        return raw_url[:240]

    if parsed.scheme in {"http", "https"}:
        safe = parsed._replace(params="", query="", fragment="")
        return urlunparse(safe)[:240]
    if parsed.scheme == "file":
        safe = parsed._replace(query="", fragment="")
        return urlunparse(safe)[:240]
    if parsed.scheme in {"chrome", "edge", "about"}:
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"[:240]
    if parsed.scheme in {"devtools", "chrome-extension"}:
        return f"{parsed.scheme}://{parsed.netloc}"[:240]
    return raw_url[:240]


def extract_domain(raw_url: str) -> str:
    try:
        parsed = urlparse(raw_url)
    except Exception:
        return ""
    return parsed.netloc.lower()


def classify_url_kind(safe_url: str) -> str:
    try:
        parsed = urlparse(safe_url)
    except Exception:
        return "unknown"
    if parsed.scheme in {"http", "https"}:
        return "web"
    if parsed.scheme == "file":
        return "local_file"
    if parsed.scheme in {"chrome", "edge", "about"}:
        return "browser_internal"
    if parsed.scheme == "chrome-extension":
        return "extension"
    return parsed.scheme or "unknown"


def url_path_depth(safe_url: str) -> int:
    try:
        parsed = urlparse(safe_url)
    except Exception:
        return 0
    return len([part for part in parsed.path.split("/") if part])


def build_browser_resource(safe_url: str) -> dict:
    try:
        parsed = urlparse(safe_url)
    except Exception:
        return {"resource_type": "unknown", "path_summary": "", "target_name": ""}

    path = parsed.path or ""
    parts = [part for part in path.split("/") if part]
    domain = parsed.netloc.lower()
    suffix = Path(path).suffix.lower()
    resource_type = "web_page"
    target_name = parts[-1] if parts else ""

    if domain == "github.com" and len(parts) >= 2:
        target_name = f"{parts[0]}/{parts[1]}"
        if "archive" in parts or suffix == ".zip":
            resource_type = "github_archive_zip"
        else:
            resource_type = "github_repository"
    elif domain.endswith("docs.espressif.com"):
        resource_type = "official_docs"
    elif domain == "nodejs.org" and parts[:1] == ["dist"]:
        resource_type = "toolchain_download"
    elif suffix == ".zip":
        resource_type = "archive_download"
    elif suffix in {".exe", ".msi"}:
        resource_type = "installer_download"

    return {
        "domain": domain,
        "path_summary": path[:240],
        "resource_type": resource_type,
        "target_name": target_name[:120],
        "file_extension": suffix,
    }


def classify_navigation(old_tab: dict, new_tab: dict) -> str:
    old_url = old_tab.get("url", "")
    new_url = new_tab.get("url", "")
    try:
        old_parsed = urlparse(old_url)
        new_parsed = urlparse(new_url)
    except Exception:
        return "unknown"

    if old_parsed.scheme != new_parsed.scheme:
        return "scheme_changed"
    if old_parsed.netloc.lower() != new_parsed.netloc.lower():
        return "cross_domain"
    if old_parsed.path != new_parsed.path:
        return "same_domain_path"
    return "same_page"


def detect_installed_browsers() -> list[dict]:
    candidates = [
        {
            "key": "chrome",
            "label": "Google Chrome",
            "exe_path": Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        },
        {
            "key": "edge",
            "label": "Microsoft Edge",
            "exe_path": Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        },
    ]
    return [item for item in candidates if item["exe_path"].exists()]


def find_free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fetch_debug_tabs(port: int) -> list[dict]:
    url = f"http://127.0.0.1:{port}/json/list"
    with urlopen(url, timeout=2.0) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize_browser_target(item: dict, browser_label: str) -> dict | None:
    if item.get("type") != "page":
        return None
    raw_url = item.get("url", "")
    if not raw_url or raw_url.startswith("devtools://"):
        return None
    safe_url = sanitize_url_for_log(raw_url)
    title = (item.get("title", "") or "").strip()[:240]
    return {
        "target_id": item.get("id", ""),
        "browser_label": browser_label,
        "title": title,
        "url": safe_url,
        "domain": extract_domain(safe_url),
        "url_kind": classify_url_kind(safe_url),
        "path_depth": url_path_depth(safe_url),
        "browser_resource": build_browser_resource(safe_url),
        "title_length": len(title),
    }


def build_action_summaries(events: list[dict], limit: int = 10) -> list[dict]:
    tracked_types = {
        "file_change",
        "browser_tab_opened",
        "browser_tab_closed",
        "browser_tab_navigated",
        "browser_tab_title_changed",
    }
    source_events = [
        event for event in events
        if event.get("type") in tracked_types and event.get("change") != "error"
    ]
    if not source_events:
        return []

    source_events = sorted(source_events, key=lambda item: item.get("timestamp", ""))
    groups: list[list[dict]] = []
    max_gap_seconds = 8

    for event in source_events:
        if not groups:
            groups.append([event])
            continue

        last_group = groups[-1]
        last_event = last_group[-1]
        same_scope = (
            last_event.get("watch_label") == event.get("watch_label")
            and last_event.get("browser_label") == event.get("browser_label")
        )
        try:
            delta = datetime.fromisoformat(event["timestamp"]) - datetime.fromisoformat(last_event["timestamp"])
            within_gap = delta.total_seconds() <= max_gap_seconds
        except Exception:
            within_gap = False

        if same_scope and within_gap:
            last_group.append(event)
        else:
            groups.append([event])

    summaries = [summarize_event_group(group) for group in groups[-limit:]]
    return summaries[::-1]


def summarize_event_group(group: list[dict]) -> dict:
    first = group[0]
    event_type = first.get("type")
    if event_type == "file_change":
        return summarize_file_group(group)
    return summarize_browser_group(group)


def summarize_file_group(group: list[dict]) -> dict:
    first = group[0]
    watch_label = first.get("watch_label", "文件监视")
    counts = Counter(event.get("change", "unknown") for event in group)
    sample_paths = [event.get("path", "") for event in group[:5] if event.get("path")]
    suffixes = Counter(
        (Path(event.get("path", "")).suffix.lower() or "[无扩展名]")
        for event in group
        if event.get("path")
    )
    top_suffixes = [suffix for suffix, _ in suffixes.most_common(3)]
    folders = Counter(
        Path(event.get("path", "")).parts[0]
        for event in group
        if event.get("path") and len(Path(event.get("path", "")).parts) > 1
    )
    top_folder = folders.most_common(1)[0][0] if folders else ""
    top_folders = [folder for folder, _ in folders.most_common(3)]
    detail_bits = []
    if counts["modified"]:
        detail_bits.append(f"修改 {counts['modified']}")
    if counts["created"]:
        detail_bits.append(f"新建 {counts['created']}")
    if counts["deleted"]:
        detail_bits.append(f"删除 {counts['deleted']}")
    if counts["renamed"]:
        detail_bits.append(f"重命名 {counts['renamed']}")
    detail_text = "、".join(detail_bits) if detail_bits else "无有效变化"

    if counts["created"] and counts["modified"]:
        operation_hint = "新建后继续编辑"
    elif counts["renamed"] and not counts["deleted"]:
        operation_hint = "整理命名或重构"
    elif counts["modified"] >= 2 and not counts["created"] and not counts["deleted"]:
        operation_hint = "连续编辑已有文件"
    elif counts["deleted"] and not counts["created"]:
        operation_hint = "清理文件"
    else:
        operation_hint = "批量文件操作"

    if len(group) == 1:
        event = group[0]
        change = event.get("change")
        path = event.get("path", "")
        if change == "created":
            title = f"{watch_label}: 新建文件"
            summary = f"可能新建了 `{path}`。"
        elif change == "modified":
            title = f"{watch_label}: 修改文件"
            summary = f"可能编辑了 `{path}`。"
        elif change == "deleted":
            title = f"{watch_label}: 删除文件"
            summary = f"可能删除了 `{path}`。"
        else:
            title = f"{watch_label}: 重命名文件"
            summary = f"可能将 `{event.get('old_path', '')}` 重命名为 `{path}`。"
    else:
        area_text = f"`{top_folder}` 目录下" if top_folder else "同一监视目标中"
        title = f"{watch_label}: {len(group)} 项文件变化"
        suffix_text = f"类型：{'、'.join(top_suffixes)}。" if top_suffixes else ""
        sample_text = f"样例：{'、'.join(sample_paths[:3])}。" if sample_paths else ""
        summary = (
            f"{area_text} {len(group)} 项变化（{detail_text}）。"
            f"判断：{operation_hint}。{suffix_text}{sample_text}"
        ).strip()

    return {
        "title": title,
        "summary": summary,
        "watch_label": watch_label,
        "event_count": len(group),
        "change_counts": dict(counts),
        "top_extensions": top_suffixes,
        "top_folders": top_folders,
        "operation_hint": operation_hint,
        "started_at": group[0].get("timestamp"),
        "ended_at": group[-1].get("timestamp"),
        "sample_paths": sample_paths,
    }


def summarize_browser_group(group: list[dict]) -> dict:
    browser_label = group[0].get("browser_label", "受管浏览器")
    counts = Counter(event.get("type", "unknown") for event in group)
    urls = [event.get("url", "") for event in group if event.get("url")]
    domains = Counter(event.get("domain", "") for event in group if event.get("domain"))
    top_domains = [domain for domain, _ in domains.most_common(3) if domain]
    url_kinds = Counter(event.get("url_kind", "unknown") for event in group if event.get("url_kind"))
    navigation_scopes = Counter(
        event.get("navigation_scope", "")
        for event in group
        if event.get("type") == "browser_tab_navigated" and event.get("navigation_scope")
    )

    if len(group) == 1:
        event = group[0]
        event_type = event.get("type")
        domain_text = f"（{event.get('domain')}）" if event.get("domain") else ""
        if event_type == "browser_tab_opened":
            title = f"{browser_label}: 打开标签页"
            summary = f"可能打开了 `{event.get('url', '')}`{domain_text}。"
        elif event_type == "browser_tab_navigated":
            title = f"{browser_label}: 页面跳转"
            scope = event.get("navigation_scope", "unknown")
            summary = f"可能跳转到了 `{event.get('url', '')}`{domain_text}，跳转类型：{scope}。"
        elif event_type == "browser_tab_closed":
            title = f"{browser_label}: 关闭标签页"
            summary = f"可能关闭了标题为 `{event.get('title', '') or '未命名页面'}` 的标签页。"
        else:
            title = f"{browser_label}: 页面标题变化"
            summary = f"页面标题变成了 `{event.get('title', '') or '未命名页面'}`。"
    else:
        detail_bits = []
        if counts["browser_tab_opened"]:
            detail_bits.append(f"打开 {counts['browser_tab_opened']} 个标签页")
        if counts["browser_tab_navigated"]:
            detail_bits.append(f"跳转 {counts['browser_tab_navigated']} 次")
        if counts["browser_tab_title_changed"]:
            detail_bits.append(f"标题变化 {counts['browser_tab_title_changed']} 次")
        if counts["browser_tab_closed"]:
            detail_bits.append(f"关闭 {counts['browser_tab_closed']} 个标签页")

        if counts["browser_tab_navigated"] >= 2:
            guess = "可能是在连续浏览多个页面。"
        elif counts["browser_tab_opened"] and counts["browser_tab_closed"]:
            guess = "可能是在快速查阅和切换页面。"
        else:
            guess = "可能完成了一组浏览器操作。"

        domain_text = f"主要站点：{'、'.join(top_domains)}。" if top_domains else ""
        scope_text = ""
        if navigation_scopes:
            scope_text = "跳转类型：" + "、".join(
                f"{name} {count}" for name, count in navigation_scopes.most_common()
            ) + "。"
        kind_text = ""
        if url_kinds:
            kind_text = "地址类型：" + "、".join(
                f"{name} {count}" for name, count in url_kinds.most_common()
            ) + "。"
        title = f"{browser_label}: {len(group)} 项浏览器活动"
        summary = (
            f"记录到 {len(group)} 项浏览器活动（{'，'.join(detail_bits)}）。"
            f"{guess} {domain_text}{scope_text}{kind_text}"
        ).strip()

    return {
        "title": title,
        "summary": summary,
        "browser_label": browser_label,
        "event_count": len(group),
        "event_counts": dict(counts),
        "top_domains": top_domains,
        "url_kinds": dict(url_kinds),
        "navigation_scopes": dict(navigation_scopes),
        "started_at": group[0].get("timestamp"),
        "ended_at": group[-1].get("timestamp"),
        "sample_urls": urls[:3],
    }


class SkillRecorderApp:
    POLL_MS = 800
    FILE_WATCH_INTERVAL_SEC = 2.0

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("安全技能录制器")
        self.root.geometry("1260x820")
        self.root.minsize(1080, 700)
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        BROWSER_LOGS_DIR.mkdir(parents=True, exist_ok=True)

        self.recording = False
        self.session_started_at = ""
        self.session_name = tk.StringVar(value="新建技能会话")
        self.session_intent = tk.StringVar(value="")
        self.session_outcome = tk.StringVar(value="")
        self.session_success_criteria = tk.StringVar(value="")
        self.session_result = tk.StringVar(value="")
        self.session_blockers = tk.StringVar(value="")
        self.session_next_step = tk.StringVar(value="")
        self.status_text = tk.StringVar(value="空闲")
        self.file_watch_status = tk.StringVar(value="文件监视未启动")
        self.browser_status = tk.StringVar(value="浏览器监视未启动")
        self.extension_filter_text = tk.StringVar(value="")
        self.last_snapshot = None
        self.events: list[dict] = []
        self.file_event_queue: queue.Queue[dict] = queue.Queue()
        self.browser_event_queue: queue.Queue[dict] = queue.Queue()
        self.file_watch_stop = threading.Event()
        self.file_watch_threads: list[threading.Thread] = []
        self.watch_profiles = build_default_watch_profiles()
        self.watch_profile_vars: dict[str, tk.BooleanVar] = {
            profile["key"]: tk.BooleanVar(value=True) for profile in self.watch_profiles
        }
        self.file_watch_running = False

        self.installed_browsers = detect_installed_browsers()
        self.browser_choice = tk.StringVar(
            value=self.installed_browsers[0]["label"] if self.installed_browsers else "未检测到浏览器"
        )
        self.browser_monitor_stop = threading.Event()
        self.browser_monitor_thread: threading.Thread | None = None
        self.browser_process: subprocess.Popen | None = None
        self.browser_process_name = ""
        self.browser_debug_port: int | None = None
        self.browser_session_dir: Path | None = None
        self.browser_last_tabs: dict[str, dict] = {}
        self.browser_running = False

        self.roo_watch_stop = threading.Event()
        self.roo_watch_thread: threading.Thread | None = None
        self.roo_history_positions: dict[str, int] = {}

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._append_log("已就绪。这里会记录前台窗口切换、文件变化、受管浏览器活动，以及 Roo-Cline 对话增量。")
        self._append_log("开始/结束录制时会要求填写一句意图或总结，方便后续给 skill 打标签。")
        self._append_log("编辑器内容捕获仅针对常见代码/文本文件，并且通过文件内容预览实现，不会读取聊天软件窗口。")
        self._tick()

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)

        header = tk.Frame(self.root, bg="#16324f", padx=18, pady=14)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)

        tk.Label(
            header,
            text="安全技能录制器",
            fg="white",
            bg="#16324f",
            font=("Segoe UI Semibold", 18),
        ).grid(row=0, column=0, sticky="w")

        tk.Label(
            header,
            text="面向 GUI、编辑器、受管浏览器和 Roo-Cline 对话的本地录制工具",
            fg="#dbe9f4",
            bg="#16324f",
            font=("Segoe UI", 10),
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))

        controls = ttk.Frame(self.root, padding=(16, 14))
        controls.grid(row=1, column=0, sticky="ew")
        controls.columnconfigure(1, weight=1)
        controls.columnconfigure(3, weight=1)

        ttk.Label(controls, text="会话名称").grid(row=0, column=0, sticky="w")
        ttk.Entry(controls, textvariable=self.session_name).grid(
            row=0, column=1, sticky="ew", padx=(8, 18)
        )

        ttk.Label(controls, text="手动步骤").grid(row=0, column=2, sticky="w")
        self.step_entry = ttk.Entry(controls)
        self.step_entry.grid(row=0, column=3, sticky="ew", padx=(8, 0))

        ttk.Label(controls, text="开始意图").grid(row=1, column=0, sticky="w", pady=(10, 0))
        ttk.Entry(controls, textvariable=self.session_intent).grid(
            row=1, column=1, sticky="ew", padx=(8, 18), pady=(10, 0)
        )

        ttk.Label(controls, text="结束总结").grid(row=1, column=2, sticky="w", pady=(10, 0))
        ttk.Entry(controls, textvariable=self.session_outcome).grid(
            row=1, column=3, sticky="ew", padx=(8, 0), pady=(10, 0)
        )

        ttk.Label(controls, text="成功标准").grid(row=2, column=0, sticky="w", pady=(10, 0))
        ttk.Entry(controls, textvariable=self.session_success_criteria).grid(
            row=2, column=1, sticky="ew", padx=(8, 18), pady=(10, 0)
        )

        ttk.Label(controls, text="下一步").grid(row=2, column=2, sticky="w", pady=(10, 0))
        ttk.Entry(controls, textvariable=self.session_next_step).grid(
            row=2, column=3, sticky="ew", padx=(8, 0), pady=(10, 0)
        )

        button_row = ttk.Frame(controls)
        button_row.grid(row=3, column=0, columnspan=4, sticky="ew", pady=(14, 0))

        self.start_button = ttk.Button(button_row, text="开始录制", command=self.start_recording)
        self.start_button.grid(row=0, column=0, padx=(0, 8))

        self.stop_button = ttk.Button(
            button_row, text="停止录制", command=self.stop_recording, state="disabled"
        )
        self.stop_button.grid(row=0, column=1, padx=(0, 8))

        ttk.Button(button_row, text="添加手动步骤", command=self.add_manual_step).grid(
            row=0, column=2, padx=(0, 8)
        )
        ttk.Button(button_row, text="导出 JSON", command=self.export_json).grid(
            row=0, column=3, padx=(0, 8)
        )
        ttk.Button(button_row, text="清空会话", command=self.clear_session).grid(row=0, column=4, padx=(0, 8))
        ttk.Button(button_row, text="启动受管 PowerShell", command=self.launch_managed_powershell).grid(
            row=0, column=5, padx=(0, 8)
        )
        ttk.Button(button_row, text="打开日志目录", command=self.open_logs_folder).grid(row=0, column=6)

        browser_frame = ttk.LabelFrame(controls, text="浏览器活动录制", padding=10)
        browser_frame.grid(row=4, column=0, columnspan=4, sticky="ew", pady=(14, 0))
        browser_frame.columnconfigure(1, weight=1)

        ttk.Label(browser_frame, text="浏览器").grid(row=0, column=0, sticky="w")
        if self.installed_browsers:
            browser_values = [item["label"] for item in self.installed_browsers]
            self.browser_combo = ttk.Combobox(
                browser_frame,
                textvariable=self.browser_choice,
                values=browser_values,
                state="readonly",
            )
        else:
            self.browser_combo = ttk.Combobox(
                browser_frame,
                textvariable=self.browser_choice,
                values=["未检测到浏览器"],
                state="disabled",
            )
        self.browser_combo.grid(row=0, column=1, sticky="ew", padx=(8, 8))

        ttk.Button(browser_frame, text="启动受管浏览器", command=self.start_browser_monitor).grid(
            row=0, column=2, padx=(0, 8)
        )
        ttk.Button(browser_frame, text="停止浏览器监视", command=self.stop_browser_monitor).grid(
            row=0, column=3
        )
        ttk.Label(browser_frame, textvariable=self.browser_status).grid(
            row=1, column=0, columnspan=4, sticky="w", pady=(8, 0)
        )
        ttk.Label(
            browser_frame,
            text="记录标题、域名、脱敏 URL，并为后续页面内容捕获保留结构化字段。",
            wraplength=1100,
        ).grid(row=2, column=0, columnspan=4, sticky="w", pady=(8, 0))

        watch_frame = ttk.LabelFrame(controls, text="文件与编辑器内容监视", padding=10)
        watch_frame.grid(row=5, column=0, columnspan=4, sticky="ew", pady=(14, 0))
        watch_frame.columnconfigure(0, weight=1)

        if self.watch_profiles:
            for idx, profile in enumerate(self.watch_profiles):
                label = f"{profile['label']}  ({profile['path']})"
                ttk.Checkbutton(
                    watch_frame,
                    text=label,
                    variable=self.watch_profile_vars[profile["key"]],
                ).grid(row=idx, column=0, sticky="w", pady=(0, 4))
        else:
            ttk.Label(watch_frame, text="当前没有发现可用的默认监视目录。").grid(row=0, column=0, sticky="w")

        filter_row = max(len(self.watch_profiles), 1)
        filter_frame = ttk.Frame(watch_frame)
        filter_frame.grid(row=filter_row, column=0, sticky="ew", pady=(8, 0))
        filter_frame.columnconfigure(1, weight=1)

        ttk.Label(filter_frame, text="文件类型过滤").grid(row=0, column=0, sticky="w")
        ttk.Entry(filter_frame, textvariable=self.extension_filter_text).grid(
            row=0, column=1, sticky="ew", padx=(8, 8)
        )
        ttk.Label(filter_frame, text="留空表示记录全部；示例：.py,.md,.json,.ino").grid(
            row=0, column=2, sticky="w"
        )

        watch_buttons = ttk.Frame(watch_frame)
        watch_buttons.grid(row=filter_row + 1, column=0, sticky="w", pady=(10, 0))
        ttk.Button(watch_buttons, text="开始文件监视", command=self.start_file_watch).grid(
            row=0, column=0, padx=(0, 8)
        )
        ttk.Button(watch_buttons, text="停止文件监视", command=self.stop_file_watch).grid(
            row=0, column=1, padx=(0, 8)
        )
        ttk.Label(watch_buttons, textvariable=self.file_watch_status).grid(row=0, column=2, sticky="w")

        status_frame = tk.Frame(self.root, bg="#f4f7f9", padx=16, pady=10)
        status_frame.grid(row=2, column=0, sticky="nsew")
        status_frame.columnconfigure(0, weight=3)
        status_frame.columnconfigure(1, weight=2)
        status_frame.rowconfigure(1, weight=1)

        self.recording_banner = tk.Label(
            status_frame,
            text="录制器空闲中",
            bg="#c9d6df",
            fg="#18222b",
            padx=12,
            pady=8,
            font=("Segoe UI Semibold", 11),
        )
        self.recording_banner.grid(row=0, column=0, sticky="w", pady=(0, 10))

        ttk.Label(status_frame, textvariable=self.status_text).grid(row=0, column=1, sticky="e", pady=(0, 10))

        left = ttk.LabelFrame(status_frame, text="活动时间线", padding=10)
        left.grid(row=1, column=0, sticky="nsew", padx=(0, 8))
        left.columnconfigure(0, weight=1)
        left.rowconfigure(0, weight=1)

        right = ttk.Frame(status_frame)
        right.grid(row=1, column=1, sticky="nsew", padx=(8, 0))
        right.columnconfigure(0, weight=1)
        right.rowconfigure(1, weight=1)
        right.rowconfigure(2, weight=1)

        self.log_text = tk.Text(left, wrap="word", font=("Consolas", 10), state="disabled")
        self.log_text.grid(row=0, column=0, sticky="nsew")

        current_frame = ttk.LabelFrame(right, text="当前前台应用", padding=10)
        current_frame.grid(row=0, column=0, sticky="nsew", pady=(0, 8))
        current_frame.columnconfigure(1, weight=1)

        self.current_title = tk.StringVar(value="-")
        self.current_process = tk.StringVar(value="-")
        self.current_path = tk.StringVar(value="-")
        self.event_count = tk.StringVar(value="0")

        ttk.Label(current_frame, text="窗口标题").grid(row=0, column=0, sticky="nw", pady=(0, 8))
        ttk.Label(current_frame, textvariable=self.current_title, wraplength=430).grid(
            row=0, column=1, sticky="w", pady=(0, 8)
        )

        ttk.Label(current_frame, text="进程").grid(row=1, column=0, sticky="nw", pady=(0, 8))
        ttk.Label(current_frame, textvariable=self.current_process, wraplength=430).grid(
            row=1, column=1, sticky="w", pady=(0, 8)
        )

        ttk.Label(current_frame, text="可执行文件").grid(row=2, column=0, sticky="nw", pady=(0, 8))
        ttk.Label(current_frame, textvariable=self.current_path, wraplength=430).grid(
            row=2, column=1, sticky="w", pady=(0, 8)
        )

        ttk.Label(current_frame, text="已捕获事件").grid(row=3, column=0, sticky="nw")
        ttk.Label(current_frame, textvariable=self.event_count).grid(row=3, column=1, sticky="w")

        summary_frame = ttk.LabelFrame(right, text="动作摘要", padding=10)
        summary_frame.grid(row=1, column=0, sticky="nsew", pady=(0, 8))
        summary_frame.columnconfigure(0, weight=1)
        summary_frame.rowconfigure(0, weight=1)
        self.summary_text = tk.Text(summary_frame, wrap="word", font=("Segoe UI", 10), state="disabled")
        self.summary_text.grid(row=0, column=0, sticky="nsew")

        note = ttk.LabelFrame(right, text="安全边界", padding=12)
        note.grid(row=2, column=0, sticky="nsew")
        ttk.Label(
            note,
            wraplength=450,
            text="聊天类隐私应用会被跳过；编辑器内容只会在检测到代码/文本文件变动时记录有限预览。",
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            note,
            wraplength=450,
            text="Roo-Cline 只读取 api_conversation_history.json 的新增条目，不会反向修改原始任务记录。",
        ).grid(row=1, column=0, sticky="w", pady=(8, 0))

        self._refresh_summary_text()

    def _append_log(self, line: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"{line}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _refresh_summary_text(self) -> None:
        summaries = build_action_summaries(self.events, limit=10)
        self.summary_text.configure(state="normal")
        self.summary_text.delete("1.0", "end")
        if not summaries:
            self.summary_text.insert("end", "暂无动作摘要。开始浏览器监视或文件监视后，这里会自动归纳最近的活动。\n")
        else:
            for item in summaries:
                self.summary_text.insert("end", f"{item['title']}\n")
                self.summary_text.insert("end", f"{item['summary']}\n")
                if item.get("sample_paths"):
                    self.summary_text.insert("end", f"示例文件：{', '.join(item['sample_paths'])}\n")
                if item.get("sample_urls"):
                    self.summary_text.insert("end", f"示例地址：{', '.join(item['sample_urls'])}\n")
                self.summary_text.insert("end", "\n")
        self.summary_text.configure(state="disabled")

    def _refresh_current(self, snapshot: dict | None) -> None:
        if not snapshot:
            self.current_title.set("-")
            self.current_process.set("-")
            self.current_path.set("-")
            return

        if snapshot.get("private_recording_blocked"):
            self.current_title.set("（隐私应用已隐藏）")
            self.current_process.set("隐私应用（不记录）")
            self.current_path.set("（路径已隐藏）")
            return

        self.current_title.set(snapshot.get("window_title") or "（无标题窗口）")
        process_name = snapshot.get("process_name") or "（未知进程）"
        process_id = snapshot.get("process_id")
        self.current_process.set(f"{process_name} (PID {process_id})")
        self.current_path.set(snapshot.get("exe_path") or "（路径不可用）")

    def _push_event(self, event: dict) -> None:
        self.events.append(event)
        self.event_count.set(str(len(self.events)))
        if event.get("type") in {
            "file_change",
            "browser_tab_opened",
            "browser_tab_closed",
            "browser_tab_navigated",
            "browser_tab_title_changed",
        }:
            self._refresh_summary_text()

    def _record_app_action(self, action: str, details: dict | None = None) -> None:
        event = {
            "timestamp": now_iso(),
            "type": "app_ui_action",
            "action": action,
            "details": details or {},
            "session_name": self.session_name.get().strip(),
            "recording": self.recording,
            "file_watch_running": self.file_watch_running,
            "browser_running": self.browser_running,
            "context": redact_private_snapshot(get_foreground_snapshot()) or {},
        }
        self._push_event(event)
        self._append_log(f"[{event['timestamp']}] 应用操作 -> {action}")

    def _tick(self) -> None:
        snapshot = get_foreground_snapshot()
        private_snapshot = is_private_app_snapshot(snapshot)
        self._refresh_current(redact_private_snapshot(snapshot))
        self._drain_event_queue(self.file_event_queue)
        self._drain_event_queue(self.browser_event_queue)

        if private_snapshot:
            self.last_snapshot = None
        elif self.recording and snapshot:
            if self._is_new_snapshot(snapshot):
                event = {
                    "timestamp": now_iso(),
                    "type": "window_change",
                    **snapshot,
                }
                self._push_event(event)
                self.last_snapshot = snapshot
                self._append_log(
                    f"[{event['timestamp']}] 窗口切换 -> {snapshot['process_name'] or '未知进程'} | "
                    f"{snapshot['window_title'] or '（无标题窗口）'}"
                )

        if self.recording:
            current_clip = read_clipboard_text()
            if current_clip and current_clip != self.last_clipboard_text:
                if len(current_clip) <= 5000:
                    event = {
                        "timestamp": now_iso(),
                        "type": "clipboard_change",
                        "clipboard_content": current_clip[:1000],
                        "content_length": len(current_clip),
                    }
                    self._push_event(event)
                    self._append_log(f"[{event['timestamp']}] 剪贴板变化 -> {len(current_clip)} 字符")
                self.last_clipboard_text = current_clip

        self.root.after(self.POLL_MS, self._tick)

    def _drain_event_queue(self, event_queue: queue.Queue[dict]) -> None:
        drained: list[dict] = []
        while True:
            try:
                drained.append(event_queue.get_nowait())
            except queue.Empty:
                break

        if not drained:
            return

        for event in drained:
            self._push_event(event)

        if len(drained) >= 3:
            self._append_log(self._format_event_batch(drained))
            return

        for event in drained:
            self._append_log(self._format_event(event))

    def _format_event_batch(self, events: list[dict]) -> str:
        if all(event.get("type") == "file_change" for event in events):
            return self._format_file_event_batch(events)
        if all(event.get("type", "").startswith("browser_") for event in events):
            return self._format_browser_event_batch(events)
        return f"[{events[-1].get('timestamp', '')}] 批量事件 -> {len(events)} 项"

    def _format_file_event_batch(self, events: list[dict]) -> str:
        watch_label = events[0].get("watch_label", "文件监视")
        counts = Counter(event.get("change", "unknown") for event in events)
        detail_bits = []
        change_labels = {
            "created": "新建",
            "modified": "修改",
            "deleted": "删除",
            "renamed": "重命名",
            "error": "错误",
        }
        for key in ("modified", "created", "deleted", "renamed", "error"):
            if counts[key]:
                detail_bits.append(f"{change_labels[key]} {counts[key]}")
        sample_paths = [event.get("path", "") for event in events if event.get("path")]
        sample_text = f" | 样例：{'、'.join(sample_paths[:2])}" if sample_paths else ""
        return (
            f"[{events[-1].get('timestamp', '')}] 文件变化摘要 -> {watch_label} | "
            f"{'、'.join(detail_bits)}{sample_text}"
        )

    def _format_browser_event_batch(self, events: list[dict]) -> str:
        summary = summarize_browser_group(events)
        return f"[{events[-1].get('timestamp', '')}] 浏览器活动摘要 -> {summary['summary']}"

    def _format_event(self, event: dict) -> str:
        if event.get("type") == "file_change":
            return self._format_file_event(event)
        if event.get("type", "").startswith("browser_"):
            return self._format_browser_event(event)
        if event.get("type") == "roo_cline_message":
            role = event.get("role", "unknown")
            preview = (event.get("content_preview") or "").replace("\n", " ")[:120]
            return f"[{event.get('timestamp', '')}] Roo-Cline -> {role} | {preview}"
        if event.get("type") == "manual_step":
            return f"[{event.get('timestamp', '')}] 手动步骤 -> {event.get('label', '')}"
        if event.get("type") == "app_ui_action":
            return f"[{event.get('timestamp', '')}] 应用操作 -> {event.get('action', '')}"
        return f"[{event.get('timestamp', '')}] {event.get('type', 'event')}"

    def _format_file_event(self, event: dict) -> str:
        change_map = {
            "created": "新建",
            "modified": "修改",
            "deleted": "删除",
            "renamed": "重命名",
            "error": "错误",
        }
        change_label = change_map.get(event.get("change"), event.get("change", "unknown"))
        watch_label = event.get("watch_label", "文件监视")
        path = event.get("path", "")
        capture_note = " | 已捕获内容预览" if event.get("content_capture") else ""
        if event.get("change") == "error":
            return f"[{event['timestamp']}] 文件监视错误 -> {watch_label} | {event.get('message', '')}"
        if event.get("change") == "renamed":
            return f"[{event['timestamp']}] 文件{change_label} -> {watch_label} | {event.get('old_path', '')} -> {path}{capture_note}"
        return f"[{event['timestamp']}] 文件{change_label} -> {watch_label} | {path}{capture_note}"

    def _format_browser_event(self, event: dict) -> str:
        event_type = event.get("type")
        browser_label = event.get("browser_label", "受管浏览器")
        if event_type == "browser_tab_opened":
            return f"[{event['timestamp']}] 浏览器打开标签页 -> {browser_label} | {event.get('url', '')} | 标签数 {event.get('tab_count', '-')}"
        if event_type == "browser_tab_closed":
            return f"[{event['timestamp']}] 浏览器关闭标签页 -> {browser_label} | {event.get('title', '') or event.get('url', '')} | 标签数 {event.get('tab_count', '-')}"
        if event_type == "browser_tab_navigated":
            scope = event.get("navigation_scope", "unknown")
            return f"[{event['timestamp']}] 浏览器页面跳转 -> {browser_label} | {scope} | {event.get('url', '')}"
        if event_type == "browser_tab_title_changed":
            return f"[{event['timestamp']}] 浏览器标题变化 -> {browser_label} | {event.get('title', '')}"
        return f"[{event['timestamp']}] 浏览器事件 -> {browser_label}"

    def _is_new_snapshot(self, snapshot: dict) -> bool:
        if not self.last_snapshot:
            return True
        keys = ("window_title", "process_id", "exe_path")
        return any(snapshot.get(key) != self.last_snapshot.get(key) for key in keys)

    def _ensure_text_value(self, current: str, prompt_title: str, prompt_text: str) -> str | None:
        value = current.strip()
        if value:
            return value
        response = simpledialog.askstring(prompt_title, prompt_text, parent=self.root)
        if response is None:
            return None
        value = response.strip()
        if not value:
            messagebox.showwarning(prompt_title, "请至少输入一句话。")
            return None
        return value

    def _maybe_attach_content_capture(self, event: dict) -> dict:
        if event.get("change") not in {"created", "modified", "renamed"}:
            return event
        snapshot = get_foreground_snapshot()
        if not is_editor_snapshot(snapshot):
            return event
        full_path = event.get("full_path")
        if not full_path:
            return event
        capture = read_text_preview(full_path)
        if not capture:
            return event
        enriched = dict(event)
        enriched["content_capture"] = {
            **capture,
            "captured_from": snapshot.get("process_name", ""),
            "window_title": snapshot.get("window_title", ""),
        }
        return enriched

    def _prime_roo_history_positions(self) -> None:
        self.roo_history_positions.clear()
        if not ROO_CLINE_TASKS_DIR.exists():
            return
        try:
            history_files = ROO_CLINE_TASKS_DIR.glob("*/api_conversation_history.json")
            for history_path in history_files:
                _, next_index = extract_roo_history_events(history_path, 10**9)
                self.roo_history_positions[str(history_path)] = next_index
        except OSError:
            return

    def _start_roo_watch(self) -> None:
        if self.roo_watch_thread and self.roo_watch_thread.is_alive():
            return
        self._prime_roo_history_positions()
        self.roo_watch_stop.clear()
        self.roo_watch_thread = threading.Thread(
            target=self._roo_watch_loop,
            daemon=True,
            name="roo-cline-watch",
        )
        self.roo_watch_thread.start()

    def _stop_roo_watch(self) -> None:
        self.roo_watch_stop.set()
        self.roo_watch_thread = None

    def _roo_watch_loop(self) -> None:
        while not self.roo_watch_stop.wait(ROO_POLL_INTERVAL_SEC):
            if not ROO_CLINE_TASKS_DIR.exists():
                continue
            try:
                history_files = sorted(
                    ROO_CLINE_TASKS_DIR.glob("*/api_conversation_history.json"),
                    key=lambda item: item.stat().st_mtime,
                    reverse=True,
                )[:12]
            except OSError:
                continue

            for history_path in history_files:
                key = str(history_path)
                start_index = self.roo_history_positions.get(key, 0)
                events, next_index = extract_roo_history_events(history_path, start_index)
                if events:
                    for event in events:
                        self.file_event_queue.put(event)
                self.roo_history_positions[key] = next_index

    def start_recording(self) -> None:
        if self.recording:
            return

        session_name = self.session_name.get().strip()
        if not session_name:
            messagebox.showwarning("需要会话名称", "开始录制前请先输入会话名称。")
            return

        intent = self._ensure_text_value(
            self.session_intent.get(),
            "开始意图",
            "请用一句话写清楚本次任务；例如：ESP32-S3 风扇 PWM 编译方案 + IDF 工具链修复",
        )
        if intent is None:
            return
        self.session_intent.set(intent)

        success_criteria = self.session_success_criteria.get().strip()
        if not success_criteria:
            success_criteria = simpledialog.askstring(
                "成功标准",
                "这次做到什么算成功？可以留空。",
                parent=self.root,
            ) or ""
        self.session_success_criteria.set(success_criteria.strip())

        self.recording = True
        self.session_started_at = now_iso()
        self.last_snapshot = None
        self.status_text.set(f"已开始录制：{self.session_started_at}")
        self.recording_banner.configure(text="录制中", bg="#c44536", fg="white")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self._start_roo_watch()
        self._record_app_action(
            "start_recording",
            {
                "started_at": self.session_started_at,
                "intent": intent,
                "session_goal": intent,
                "session_success_criteria": self.session_success_criteria.get().strip(),
            },
        )
        self._push_event(
            {
                "timestamp": self.session_started_at,
                "type": "session_intent",
                "phase": "start",
                "text": intent,
                "session_goal": intent,
                "session_success_criteria": self.session_success_criteria.get().strip(),
            }
        )
        self._append_log(f"[{self.session_started_at}] 开始会话 -> {session_name} | {intent}")

    def stop_recording(self) -> None:
        if not self.recording:
            return

        outcome = self._ensure_text_value(
            self.session_outcome.get(),
            "结束总结",
            "请用一句话写清楚这次完成了什么；例如：修复 ESP-IDF 缺失工具并确认 PWM 方案可编译",
        )
        if outcome is None:
            return
        self.session_outcome.set(outcome)

        result = self.session_result.get().strip()
        if not result:
            result = simpledialog.askstring(
                "任务结果",
                "请输入结果：success / partial_success / failed，或直接写中文成功/部分成功/失败。",
                parent=self.root,
            ) or ""
        self.session_result.set(result.strip())

        blockers = self.session_blockers.get().strip()
        if not blockers:
            blockers = simpledialog.askstring("卡点", "卡在哪一步？没有可以留空。", parent=self.root) or ""
        self.session_blockers.set(blockers.strip())

        next_step = self.session_next_step.get().strip()
        if not next_step:
            next_step = simpledialog.askstring("下一步", "下一步准备做什么？可以留空。", parent=self.root) or ""
        self.session_next_step.set(next_step.strip())

        stopped_at = now_iso()
        self.recording = False
        self._stop_roo_watch()
        self.status_text.set(f"已停止录制：{stopped_at}")
        self.recording_banner.configure(text="录制器空闲中", bg="#c9d6df", fg="#18222b")
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        self._record_app_action(
            "stop_recording",
            {
                "stopped_at": stopped_at,
                "outcome": outcome,
                "session_result": self.session_result.get().strip(),
                "session_blockers": self.session_blockers.get().strip(),
                "session_next_step": self.session_next_step.get().strip(),
            },
        )
        self._push_event(
            {
                "timestamp": stopped_at,
                "type": "session_intent",
                "phase": "stop",
                "text": outcome,
                "session_result": self.session_result.get().strip(),
                "session_blockers": self.session_blockers.get().strip(),
                "session_next_step": self.session_next_step.get().strip(),
            }
        )
        self._append_log(f"[{stopped_at}] 结束会话 -> {outcome}")

    def add_manual_step(self) -> None:
        step = self.step_entry.get().strip()
        if not step:
            messagebox.showwarning("需要步骤说明", "请输入这一步的简短描述。")
            return

        snapshot = redact_private_snapshot(get_foreground_snapshot()) or {}
        event = {
            "timestamp": now_iso(),
            "type": "manual_step",
            "label": step,
            "context": snapshot,
        }
        self._push_event(event)
        self._append_log(f"[{event['timestamp']}] 手动步骤 -> {step}")
        self._record_app_action("add_manual_step", {"label": step})
        self.step_entry.delete(0, "end")

    def clear_session(self) -> None:
        if self.recording:
            messagebox.showwarning("正在录制中", "请先停止当前录制，再清空会话。")
            return
        if self.file_watch_running:
            messagebox.showwarning("文件监视进行中", "请先停止文件监视，再清空会话。")
            return
        if self.browser_running:
            messagebox.showwarning("浏览器监视进行中", "请先停止浏览器监视，再清空会话。")
            return

        self.events.clear()
        self.event_count.set("0")
        self.session_started_at = ""
        self.session_intent.set("")
        self.session_outcome.set("")
        self.session_success_criteria.set("")
        self.session_result.set("")
        self.session_blockers.set("")
        self.session_next_step.set("")
        self.last_snapshot = None
        self.roo_history_positions.clear()
        self.status_text.set("空闲")
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")
        self._append_log("会话已清空。")
        self._append_log("可以重新开始录制，或单独启动文件监视 / 浏览器监视。")
        self._record_app_action("clear_session")
        self._refresh_summary_text()

    def export_json(self) -> None:
        self._record_app_action("export_json_requested")
        if not self.events:
            messagebox.showinfo("还没有事件", "请至少录制一个事件后再导出。")
            return

        session_name = self.session_name.get().strip() or "技能会话"
        default_name = f"{session_name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        target = filedialog.asksaveasfilename(
            title="导出会话为 JSON",
            defaultextension=".json",
            initialfile=default_name,
            filetypes=[("JSON 文件", "*.json"), ("所有文件", "*.*")],
        )
        if not target:
            self._record_app_action("export_json_cancelled")
            return

        self._record_app_action("export_json_confirmed", {"target": target})

        command_executions = load_managed_terminal_commands(session_name) + load_roo_command_executions(self.events)
        verification_steps = infer_verification_steps(command_executions)
        gui_file_actions = infer_gui_file_actions(self.events)
        user_feedback_signals = extract_user_feedback_signals(self.events)
        file_events = [e for e in self.events if e.get("type") == "file_change" and e.get("change") != "error"]
        tool_chains = detect_tool_chains(command_executions, file_events)
        ai_operations = classify_ai_operations(command_executions)
        user_command_habits = extract_user_command_habits(command_executions)
        derived_events = gui_file_actions + user_feedback_signals + verification_steps

        payload = {
            "session_name": session_name,
            "session_goal": self.session_intent.get().strip(),
            "session_success_criteria": self.session_success_criteria.get().strip(),
            "session_result": self.session_result.get().strip(),
            "session_blockers": [
                item.strip() for item in self.session_blockers.get().replace("；", ";").split(";") if item.strip()
            ],
            "session_next_step": self.session_next_step.get().strip(),
            "session_intent": self.session_intent.get().strip(),
            "session_outcome": self.session_outcome.get().strip(),
            "created_at": now_iso(),
            "session_started_at": self.session_started_at,
            "host_user": os.environ.get("USERNAME", ""),
            "recorder_version": "0.7.0",
            "safety_mode": {
                "global_keylogging": False,
                "password_capture": False,
                "cookie_capture": False,
                "token_capture": False,
                "form_input_capture": False,
                "page_content_capture": True,
                "network_upload": False,
                "private_app_window_capture": False,
            },
            "page_content_capture": {
                "enabled": True,
                "mode": "text_preview_on_file_change",
                "editor_processes": sorted(EDITOR_PROCESS_NAMES),
                "extensions": sorted(TEXT_CAPTURE_EXTENSIONS),
                "max_bytes": CONTENT_CAPTURE_MAX_BYTES,
                "preview_chars": CONTENT_CAPTURE_PREVIEW_CHARS,
            },
            "roo_cline_capture": {
                "enabled": True,
                "tasks_root": str(ROO_CLINE_TASKS_DIR),
                "event_type": "roo_cline_message",
                "captures_incremental_entries": True,
                "full_export_mode": "sidecar_json",
            },
            "privacy_filter": {
                "private_app_process_names": sorted(PRIVATE_APP_PROCESS_NAMES),
                "private_title_keywords": sorted(PRIVATE_APP_TITLE_KEYWORDS),
                "private_path_filter_enabled": True,
                "records_private_app_window_events": False,
            },
            "browser_monitor": {
                "managed_only": True,
                "installed_browsers": [item["label"] for item in self.installed_browsers],
                "recorded_fields": [
                    "title",
                    "domain",
                    "sanitized_url",
                    "browser_resource",
                    "url_kind",
                    "path_depth",
                    "tab_lifecycle",
                    "navigation_scope",
                    "tab_count",
                ],
            },
            "file_watch": {
                "extension_filter": sorted(parse_extension_filter(self.extension_filter_text.get()) or []),
                "private_path_filter_enabled": True,
                "watch_roots": [
                    profile["path"]
                    for profile in self.watch_profiles
                    if self.watch_profile_vars[profile["key"]].get()
                ],
            },
            "priority_file_watch": {
                "patterns": PRIORITY_FILE_PATTERNS,
                "diff_capture_max_chars": DIFF_CAPTURE_MAX_CHARS,
            },
            "command_executions": command_executions,
            "tool_chains": tool_chains,
            "ai_operations": ai_operations,
            "user_command_habits": user_command_habits,
            "derived_events": derived_events,
            "action_summaries": build_action_summaries(self.events + derived_events, limit=20),
            "events": self.events + derived_events,
        }

        with open(target, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

        roo_full_export = build_roo_full_export(self.events)
        if roo_full_export:
            sidecar_payload = {
                "schema_version": "1.0",
                "generated_at": now_iso(),
                "message_count": len(roo_full_export),
                "source_file_count": len({item["source_path"] for item in roo_full_export}),
                "messages": roo_full_export,
            }
            sidecar_text = json.dumps(sidecar_payload, ensure_ascii=False, indent=2)
            sidecar_target = str(Path(target).with_suffix(".roo-cline-full.json"))
            with open(sidecar_target, "w", encoding="utf-8") as fh:
                fh.write(sidecar_text)
            payload["sidecar_exports"] = {
                "roo_cline_full_messages": {
                    "path": sidecar_target,
                    "schema_version": sidecar_payload["schema_version"],
                    "message_count": sidecar_payload["message_count"],
                    "source_file_count": sidecar_payload["source_file_count"],
                    "sha256": hashlib.sha256(sidecar_text.encode("utf-8")).hexdigest(),
                    "matches_event_count": sidecar_payload["message_count"] == len(
                        [event for event in self.events if event.get("type") == "roo_cline_message"]
                    ),
                }
            }
            with open(target, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)

        self.status_text.set(f"已导出 JSON：{target}")
        self._append_log(f"[{now_iso()}] 导出 JSON -> {target}")
        messagebox.showinfo("导出完成", f"会话已导出到：\n{target}")

    def launch_managed_powershell(self) -> None:
        script_path = SCRIPTS_DIR / "managed_powershell.ps1"
        if not script_path.exists():
            messagebox.showerror("缺少脚本", f"没有找到脚本：\n{script_path}")
            return

        session_name = self.session_name.get().strip() or "技能会话"
        try:
            subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoExit",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script_path),
                    "-SessionName",
                    session_name,
                ],
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
        except OSError as exc:
            messagebox.showerror("启动失败", f"无法启动受管 PowerShell：\n{exc}")
            return

        self.status_text.set("已启动受管 PowerShell")
        self._record_app_action("launch_managed_powershell", {"session_name": session_name})
        self._append_log(f"[{now_iso()}] 启动受管 PowerShell -> {session_name}")
        messagebox.showinfo(
            "受管终端已启动",
            "新的 PowerShell 窗口已经打开。\n\n注意：该窗口中的命令和输出会被详细记录，请不要在其中输入密码或敏感令牌。",
        )

    def open_logs_folder(self) -> None:
        self._record_app_action("open_logs_folder", {"path": str(LOGS_DIR)})
        try:
            os.startfile(str(LOGS_DIR))
        except OSError as exc:
            messagebox.showerror("打开失败", f"无法打开日志目录：\n{exc}")

    def start_file_watch(self) -> None:
        if self.file_watch_running:
            return

        selected_profiles = [
            {
                **profile,
                "extensions": parse_extension_filter(self.extension_filter_text.get()),
            }
            for profile in self.watch_profiles
            if self.watch_profile_vars[profile["key"]].get()
        ]
        if not selected_profiles:
            messagebox.showwarning("没有监视目标", "请至少勾选一个要监视的目录。")
            return

        self.file_watch_stop.clear()
        self.file_watch_threads = []
        for profile in selected_profiles:
            thread = threading.Thread(
                target=self._watch_profile_loop,
                args=(profile,),
                daemon=True,
                name=f"watch-{profile['key']}",
            )
            thread.start()
            self.file_watch_threads.append(thread)

        self.file_watch_running = True
        watched_labels = "、".join(profile["label"] for profile in selected_profiles)
        ext_filter = parse_extension_filter(self.extension_filter_text.get())
        filter_text = "全部文件类型" if ext_filter is None else "、".join(sorted(ext_filter))
        self.file_watch_status.set(f"监视中：{watched_labels} | {filter_text}")
        self._record_app_action(
            "start_file_watch",
            {
                "watched_labels": watched_labels,
                "extension_filter": filter_text,
                "watch_roots": [profile["path"] for profile in selected_profiles],
            },
        )
        self._append_log(f"[{now_iso()}] 开始文件监视 -> {watched_labels} | {filter_text}")

    def stop_file_watch(self) -> None:
        if not self.file_watch_running:
            return

        self.file_watch_stop.set()
        self.file_watch_threads = []
        self.file_watch_running = False
        self.file_watch_status.set("文件监视已停止")
        self._record_app_action("stop_file_watch")
        self._append_log(f"[{now_iso()}] 停止文件监视")

    def _watch_profile_loop(self, profile: dict) -> None:
        try:
            previous = snapshot_directory(profile)
        except Exception as exc:
            self.file_event_queue.put(
                {
                    "timestamp": now_iso(),
                    "type": "file_change",
                    "watch_label": profile["label"],
                    "watch_root": profile["path"],
                    "change": "error",
                    "message": str(exc),
                }
            )
            return

        while not self.file_watch_stop.wait(self.FILE_WATCH_INTERVAL_SEC):
            try:
                current = snapshot_directory(profile)
                for event in diff_snapshots(profile, previous, current):
                    self.file_event_queue.put(self._maybe_attach_content_capture(event))
                previous = current
            except Exception as exc:
                self.file_event_queue.put(
                    {
                        "timestamp": now_iso(),
                        "type": "file_change",
                        "watch_label": profile["label"],
                        "watch_root": profile["path"],
                        "change": "error",
                        "message": str(exc),
                    }
                )
                return

    def start_browser_monitor(self) -> None:
        if self.browser_running:
            return
        if not self.installed_browsers:
            messagebox.showwarning("未检测到浏览器", "当前没有检测到可用的 Chrome 或 Edge。")
            return

        browser = next((item for item in self.installed_browsers if item["label"] == self.browser_choice.get()), None)
        if not browser:
            messagebox.showwarning("浏览器不可用", "请选择一个可用的浏览器。")
            return

        session_name = self.session_name.get().strip() or "技能会话"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_name = session_name.replace(" ", "_")
        session_dir = BROWSER_LOGS_DIR / f"{browser['key']}-{safe_name}-{stamp}"
        profile_dir = session_dir / "profile"
        profile_dir.mkdir(parents=True, exist_ok=True)

        port = find_free_tcp_port()
        args = [
            str(browser["exe_path"]),
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "about:blank",
        ]

        try:
            self.browser_process = subprocess.Popen(args)
        except OSError as exc:
            messagebox.showerror("启动失败", f"无法启动受管浏览器：\n{exc}")
            return

        self.browser_process_name = browser["label"]
        self.browser_debug_port = port
        self.browser_session_dir = session_dir
        self.browser_last_tabs = {}
        self.browser_monitor_stop.clear()
        self.browser_monitor_thread = threading.Thread(
            target=self._browser_monitor_loop,
            args=(browser["label"], port),
            daemon=True,
            name="browser-monitor",
        )
        self.browser_monitor_thread.start()
        self.browser_running = True
        self.browser_status.set(f"监视中：{browser['label']} | 调试端口 {port}")
        self._record_app_action(
            "start_browser_monitor",
            {
                "browser_label": browser["label"],
                "debug_port": port,
                "session_dir": str(session_dir),
            },
        )
        self._append_log(f"[{now_iso()}] 启动受管浏览器 -> {browser['label']} | 端口 {port}")
        messagebox.showinfo(
            "受管浏览器已启动",
            "新的浏览器实例已经启动。\n\n该实例会记录标签页打开、关闭、跳转、标题和脱敏 URL，不记录密码、Cookie、令牌、表单输入或页面正文。",
        )

    def stop_browser_monitor(self) -> None:
        if not self.browser_running:
            return

        self.browser_monitor_stop.set()
        if self.browser_process and self.browser_process.poll() is None:
            try:
                self.browser_process.terminate()
                self.browser_process.wait(timeout=5)
            except Exception:
                try:
                    self.browser_process.kill()
                except Exception:
                    pass

        self.browser_process = None
        self.browser_monitor_thread = None
        self.browser_running = False
        self.browser_debug_port = None
        self.browser_last_tabs = {}
        self.browser_status.set("浏览器监视已停止")
        self._record_app_action("stop_browser_monitor")
        self._append_log(f"[{now_iso()}] 停止浏览器监视")

    def _browser_monitor_loop(self, browser_label: str, port: int) -> None:
        deadline = time.time() + 20
        tabs: list[dict] = []

        while time.time() < deadline and not self.browser_monitor_stop.is_set():
            try:
                tabs = fetch_debug_tabs(port)
                break
            except Exception:
                time.sleep(0.5)
        else:
            self.browser_event_queue.put(
                {
                    "timestamp": now_iso(),
                    "type": "browser_tab_title_changed",
                    "browser_label": browser_label,
                    "title": "无法连接到受管浏览器调试接口",
                    "url": "",
                    "domain": "",
                    "url_kind": "error",
                }
            )
            return

        self.browser_last_tabs = {
            tab["target_id"]: tab
            for tab in (
                normalize_browser_target(item, browser_label) for item in tabs
            )
            if tab
        }

        for tab in self.browser_last_tabs.values():
            self.browser_event_queue.put(
                {
                    "timestamp": now_iso(),
                    "type": "browser_tab_opened",
                    "tab_count": len(self.browser_last_tabs),
                    **tab,
                }
            )

        while not self.browser_monitor_stop.wait(BROWSER_POLL_INTERVAL_SEC):
            if self.browser_process and self.browser_process.poll() is not None:
                break

            try:
                current_items = fetch_debug_tabs(port)
            except Exception:
                continue

            current_tabs = {
                tab["target_id"]: tab
                for tab in (
                    normalize_browser_target(item, browser_label) for item in current_items
                )
                if tab
            }
            previous_tabs = self.browser_last_tabs

            for target_id, tab in current_tabs.items():
                if target_id not in previous_tabs:
                    self.browser_event_queue.put(
                        {
                            "timestamp": now_iso(),
                            "type": "browser_tab_opened",
                            "tab_count": len(current_tabs),
                            **tab,
                        }
                    )
                    continue

                old_tab = previous_tabs[target_id]
                if old_tab.get("url") != tab.get("url"):
                    self.browser_event_queue.put(
                        {
                            "timestamp": now_iso(),
                            "type": "browser_tab_navigated",
                            "old_url": old_tab.get("url", ""),
                            "old_domain": old_tab.get("domain", ""),
                            "navigation_scope": classify_navigation(old_tab, tab),
                            "tab_count": len(current_tabs),
                            **tab,
                        }
                    )
                elif old_tab.get("title") != tab.get("title"):
                    self.browser_event_queue.put(
                        {
                            "timestamp": now_iso(),
                            "type": "browser_tab_title_changed",
                            "tab_count": len(current_tabs),
                            **tab,
                        }
                    )

            for target_id, tab in previous_tabs.items():
                if target_id not in current_tabs:
                    self.browser_event_queue.put(
                        {
                            "timestamp": now_iso(),
                            "type": "browser_tab_closed",
                            "tab_count": len(current_tabs),
                            **tab,
                        }
                    )

            self.browser_last_tabs = current_tabs

    def on_close(self) -> None:
        self.file_watch_stop.set()
        self.browser_monitor_stop.set()
        self.roo_watch_stop.set()
        if self.browser_running:
            self.stop_browser_monitor()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    try:
        root.iconname("安全技能录制器")
    except tk.TclError:
        pass
    app = SkillRecorderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
