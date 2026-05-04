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
CF_UNICODETEXT = 13

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE

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

APP_DIR = Path(__file__).resolve().parent
LOGS_DIR = APP_DIR / "logs"
SCRIPTS_DIR = APP_DIR / "scripts"
BROWSER_LOGS_DIR = LOGS_DIR / "browser_sessions"
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

POLL_MS = 1200
FILE_WATCH_INTERVAL_SEC = 1.2
BROWSER_POLL_INTERVAL_SEC = 1.5
ROO_POLL_INTERVAL_SEC = 2.0
CONTENT_CAPTURE_MAX_BYTES = 200_000
CONTENT_CAPTURE_PREVIEW_CHARS = 12_000
DIFF_CAPTURE_MAX_CHARS = 40_000

SPECIAL_TEXT_FILENAMES = {"cmakelists.txt", "sdkconfig", "platformio.ini", "dockerfile", "makefile"}
TEXT_CAPTURE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".h", ".hpp", ".ino", ".py", ".js", ".ts", ".tsx", ".jsx", ".json",
    ".md", ".txt", ".toml", ".ini", ".yml", ".yaml", ".xml", ".html", ".css", ".sql", ".sh",
    ".rs", ".go", ".java", ".cs", ".vue", ".mjs",
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

PRIVATE_APP_PROCESS_NAMES = {
    "qq.exe", "tim.exe", "wechat.exe", "weixin.exe", "wxwork.exe", "dingtalk.exe", "feishu.exe", "lark.exe",
    "telegram.exe", "whatsapp.exe", "signal.exe", "slack.exe", "discord.exe", "teams.exe", "ms-teams.exe",
    "1password.exe", "bitwarden.exe",
}
PRIVATE_APP_TITLE_KEYWORDS = {
    "wechat", "微信", "企业微信", "qq", "tim", "钉钉", "dingtalk", "飞书", "feishu", "lark", "telegram",
    "whatsapp", "signal", "slack", "discord", "teams", "1password", "bitwarden",
}
PRIVATE_PATH_KEYWORDS = {
    "tencent\\qq", "tencent\\wechat", "tencent\\weixin", "tencent files", "wechat files", "wxwork",
    "telegram desktop", "1password", "bitwarden", "dingtalk", "feishu", "lark",
}

EDITOR_PROCESS_NAMES = {
    "code.exe", "code - insiders.exe", "vscode.exe", "cursor.exe", "windsurf.exe", "codex.exe",
    "opencode.exe", "cc.exe", "codeium.exe", "arduino ide.exe", "arduino.exe",
}
CLI_HOST_PROCESS_NAMES = {"powershell.exe", "pwsh.exe", "cmd.exe", "windowsterminal.exe", "wt.exe", "bash.exe", "sh.exe"}
TOOL_CAPTURE_KEYWORDS = {
    "visual studio code", "vscode", "vs code", "vbscode", "cursor", "windsurf", "codex", "opencode", "cc",
    "codeium", "roo", "cline", "terminal", "powershell", "cmd", "bash", "pwsh", "arduino",
}

USER_FEEDBACK_PHRASES = {
    "user_acceptance_signal": ["可以", "行", "继续", "对", "就这样", "没问题"],
    "user_rejection_signal": ["不要这样", "不对", "错了", "不是这个", "先别动代码"],
    "user_preference_signal": ["太麻烦了", "直接帮我做", "我只想看结果", "先别动代码", "别解释太多"],
}

TOOL_CHAINS = {
    "esp_idf": ["idf.py", "idf_tools.py", "esp-idf", "esptool.py", "espflash"],
    "git": ["git ", "git.exe"],
    "nodejs": ["npm", "pnpm", "yarn", "node", "npx"],
    "python": ["python", "pip", "pytest", "poetry"],
    "platformio": ["platformio", "pio "],
    "arduino": ["arduino", "arduino-cli"],
    "docker": ["docker", "docker-compose"],
    "cmake": ["cmake", "ninja", "make"],
}

AI_OPERATION_PATTERNS = {
    "install_tools": [" install", "pip install", "npm install", "idf_tools.py", "setup"],
    "build_project": [" build", "cmake", "ninja", "make", "pio run"],
    "flash_device": [" flash", "upload", "esptool"],
    "debug_error": ["error", "failed", "traceback", "exception", "permission denied", "拒绝访问"],
    "configure_project": ["menuconfig", "reconfigure", "sdkconfig", "settings"],
    "version_check": ["--version", " version", " check", "where ", "get-command"],
    "clean_project": [" clean", "remove-item", "rm ", "del ", "rmdir", "fullclean"],
    "test_run": [" test", "pytest", "npm test", "pio test"],
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_path(value: str | Path) -> str:
    return os.path.normcase(os.path.abspath(str(value)))


def parse_extension_filter(raw_value: str) -> set[str] | None:
    text = raw_value.replace("；", ",").replace(";", ",").replace(" ", "")
    if not text:
        return None
    result: set[str] = set()
    for item in text.split(","):
        if not item:
            continue
        if item in {"*", "*.*", "全部"}:
            return None
        if not item.startswith("."):
            item = f".{item}"
        result.add(item.lower())
    return result or None


def normalize_match_path(path: str) -> str:
    return path.replace("\\", "/")


def path_matches_patterns(path: str, patterns: list[str]) -> bool:
    normalized = normalize_match_path(path)
    name = Path(path).name
    for pattern in patterns:
        if fnmatch.fnmatchcase(normalized, pattern) or fnmatch.fnmatchcase(name, pattern):
            return True
    return False


def priority_file_match(path: str) -> tuple[bool, str]:
    normalized = normalize_match_path(path)
    name = Path(path).name
    for pattern in PRIORITY_FILE_PATTERNS:
        if fnmatch.fnmatchcase(normalized, pattern) or fnmatch.fnmatchcase(name, pattern):
            return True, pattern
    return False, ""


def should_capture_file_diff(path: str) -> bool:
    normalized = normalize_match_path(path)
    if path_matches_patterns(normalized, NOISY_DIFF_PATH_PATTERNS):
        return False
    return priority_file_match(path)[0] or can_capture_text_content(path)


def is_private_path(path: str | Path) -> bool:
    lowered = normalize_path(path).lower()
    return any(keyword in lowered for keyword in PRIVATE_PATH_KEYWORDS)


def get_window_text(hwnd: int) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value.strip()


def get_process_path(pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(32768)
        buf = ctypes.create_unicode_buffer(size.value)
        ok = kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size))
        return buf.value if ok else ""
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


def is_private_app_snapshot(snapshot: dict | None) -> bool:
    if not snapshot:
        return False
    process_name = str(snapshot.get("process_name", "")).lower()
    title = str(snapshot.get("window_title", "")).lower()
    exe_path = str(snapshot.get("exe_path", ""))
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


def read_clipboard_text() -> str | None:
    try:
        if not user32.OpenClipboard(None):
            return None
        try:
            handle = user32.GetClipboardData(CF_UNICODETEXT)
            if not handle:
                return None
            text = ctypes.wstring_at(handle)
            return text or None
        finally:
            user32.CloseClipboard()
    except Exception:
        return None


def can_capture_text_content(path: str | Path) -> bool:
    try:
        file_path = Path(path)
    except TypeError:
        return False
    return file_path.suffix.lower() in TEXT_CAPTURE_EXTENSIONS or file_path.name.lower() in SPECIAL_TEXT_FILENAMES


def is_tool_capture_snapshot(snapshot: dict | None) -> bool:
    if not snapshot:
        return False
    process_name = str(snapshot.get("process_name", "")).lower()
    title = str(snapshot.get("window_title", "")).lower()
    if process_name in EDITOR_PROCESS_NAMES:
        return True
    if process_name in CLI_HOST_PROCESS_NAMES and any(keyword in title for keyword in TOOL_CAPTURE_KEYWORDS):
        return True
    return any(keyword in title for keyword in TOOL_CAPTURE_KEYWORDS)


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


def read_text_preview(path: str | Path) -> dict | None:
    snapshot = read_text_snapshot(path)
    if not snapshot:
        return None
    return summarize_text_snapshot(snapshot)


def build_unified_diff(before_text: str, after_text: str, path: str) -> tuple[str, bool]:
    diff_text = "".join(
        difflib.unified_diff(
            before_text.splitlines(keepends=True),
            after_text.splitlines(keepends=True),
            fromfile=f"before/{path}",
            tofile=f"after/{path}",
        )
    )
    truncated = len(diff_text) > DIFF_CAPTURE_MAX_CHARS
    if truncated:
        diff_text = diff_text[:DIFF_CAPTURE_MAX_CHARS]
    return diff_text, truncated


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
    if parsed.scheme in {"chrome", "edge", "about", "devtools", "chrome-extension"}:
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"[:240]
    return raw_url[:240]


def extract_domain(raw_url: str) -> str:
    try:
        return urlparse(raw_url).netloc.lower()
    except Exception:
        return ""


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
        return {"resource_type": "unknown", "path_summary": "", "target_name": "", "file_extension": ""}
    path = parsed.path or ""
    parts = [part for part in path.split("/") if part]
    domain = parsed.netloc.lower()
    suffix = Path(path).suffix.lower()
    resource_type = "web_page"
    target_name = parts[-1] if parts else ""
    if domain == "github.com" and len(parts) >= 2:
        target_name = f"{parts[0]}/{parts[1]}"
        resource_type = "github_repository"
        if "archive" in parts or suffix == ".zip":
            resource_type = "github_archive_zip"
    elif domain.endswith("docs.espressif.com"):
        resource_type = "official_docs"
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
        return "same_domain_new_path"
    return "same_page_update"


def find_free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fetch_debug_tabs(port: int) -> list[dict]:
    with urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def normalize_browser_target(item: dict, browser_label: str) -> dict | None:
    if item.get("type") != "page":
        return None
    raw_url = str(item.get("url", ""))
    safe_url = sanitize_url_for_log(raw_url)
    return {
        "browser_label": browser_label,
        "target_id": str(item.get("id", "")),
        "title": str(item.get("title", ""))[:240],
        "url": safe_url,
        "domain": extract_domain(safe_url),
        "browser_resource": build_browser_resource(safe_url),
        "url_kind": classify_url_kind(safe_url),
        "path_depth": url_path_depth(safe_url),
    }


def detect_installed_browsers() -> list[dict]:
    candidates = [
        ("Microsoft Edge", Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe", "edge"),
        ("Google Chrome", Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe", "chrome"),
    ]
    result = []
    for label, exe_path, key in candidates:
        if exe_path.exists():
            result.append({"label": label, "exe_path": exe_path, "key": key})
    return result


def parse_window_title_metadata(title: str) -> dict:
    raw_parts = [part.strip() for part in title.split("-") if part.strip()]
    title_lower = title.lower()
    editor_label = ""
    for candidate in ["Visual Studio Code", "VS Code", "VSCode", "Cursor", "Windsurf", "Codex", "OpenCode", "Codeium", "Arduino IDE", "Arduino", "cc"]:
        if candidate.lower() in title_lower:
            editor_label = candidate
            break
    cleaned_parts = [part for part in raw_parts if part.lower() != editor_label.lower()] if editor_label else raw_parts[:]
    workspace_name = cleaned_parts[-1] if cleaned_parts else ""
    primary_subject = cleaned_parts[0] if cleaned_parts else ""
    terminal_tab_name = ""
    for part in cleaned_parts:
        lower = part.lower()
        if any(token in lower for token in ["terminal", "powershell", "cmd", "bash", "zsh", "pwsh", "output"]):
            terminal_tab_name = part
            break
    project_name = primary_subject
    for sep in ["/", "\\"]:
        if sep in primary_subject:
            project_name = primary_subject.split(sep)[-1].strip()
            break
    return {
        "editor_label": editor_label,
        "workspace_name": workspace_name,
        "project_name": project_name,
        "terminal_tab_name": terminal_tab_name,
        "title_parts": raw_parts,
    }


def describe_active_tool(snapshot: dict | None) -> dict:
    if not snapshot:
        return {"tool_name": "unknown", "process_name": "", "window_title": "", "window_title_metadata": {}}
    process_name = str(snapshot.get("process_name", ""))
    title = str(snapshot.get("window_title", ""))
    title_lower = title.lower()
    title_metadata = parse_window_title_metadata(title)
    if "opencode" in title_lower:
        tool_name = "OpenCode"
    elif "codex" in title_lower:
        tool_name = "Codex"
    elif "cc" in title_lower:
        tool_name = "cc"
    elif "roo" in title_lower or "cline" in title_lower:
        tool_name = "Roo-Cline"
    else:
        tool_name = title_metadata.get("editor_label") or process_name or "unknown"
    return {
        "tool_name": tool_name,
        "process_name": process_name,
        "window_title": title,
        "window_title_metadata": title_metadata,
    }


def summarize_roo_content_blocks(blocks: list[dict]) -> tuple[str, list[str]]:
    previews: list[str] = []
    tool_names: list[str] = []
    for block in blocks:
        block_type = block.get("type")
        if block_type == "text":
            previews.append(str(block.get("text", "")))
        elif block_type == "tool_use":
            tool_names.append(str(block.get("name", "")))
            previews.append(str((block.get("input") or {}).get("command", "")))
        elif block_type == "tool_result":
            previews.append(str(block.get("content", "")))
    preview = "\n".join(item for item in previews if item).strip()
    return preview[:CONTENT_CAPTURE_PREVIEW_CHARS], tool_names


def extract_roo_history_events(path: str | Path, start_index: int) -> tuple[list[dict], int]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return [], start_index
    events: list[dict] = []
    next_index = start_index
    for index, item in enumerate(payload[start_index:], start=start_index):
        role = str(item.get("role", ""))
        blocks = item.get("content") or []
        preview, tool_names = summarize_roo_content_blocks(blocks)
        events.append(
            {
                "timestamp": now_iso(),
                "type": "roo_cline_message",
                "role": role,
                "source_path": str(path),
                "history_index": index,
                "content_preview": preview,
                "tool_names": tool_names,
                "blocks": blocks,
            }
        )
        next_index = index + 1
    return events, next_index


def build_roo_full_export(events: list[dict]) -> list[dict]:
    output: list[dict] = []
    for event in events:
        if event.get("type") != "roo_cline_message":
            continue
        output.append(
            {
                "timestamp": event.get("timestamp", ""),
                "role": event.get("role", ""),
                "history_index": event.get("history_index"),
                "source_path": event.get("source_path", ""),
                "content_preview": event.get("content_preview", ""),
                "blocks": event.get("blocks", []),
            }
        )
    return output


def extract_user_message_text(blocks: list[dict]) -> str:
    texts: list[str] = []
    for block in blocks:
        if block.get("type") == "text":
            texts.append(str(block.get("text", "")))
    return "\n".join(texts).strip()


def extract_user_feedback_signals(events: list[dict]) -> list[dict]:
    signals: list[dict] = []
    for event in events:
        if event.get("type") != "roo_cline_message" or event.get("role") != "user":
            continue
        text = extract_user_message_text(event.get("blocks", []))
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
            for block in item.get("content") or []:
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
    result: list[dict] = []
    verification_commands = {"idf.py", "ninja", "cmake", "pytest", "npm", "pnpm", "yarn"}
    for command in commands:
        primary = str(command.get("primary_command", "")).lower()
        raw = str(command.get("command", "")).lower()
        if primary not in verification_commands and " build" not in raw and " test" not in raw:
            continue
        result.append(
            {
                "timestamp": command.get("timestamp", now_iso()),
                "type": "verification_step",
                "verification_step": command.get("command", ""),
                "result": "passed" if command.get("succeeded") else "failed",
                "evidence": f"exit_code={command.get('exit_code')}",
                "source_log": command.get("source_log", ""),
            }
        )
    return result


def infer_gui_file_actions(events: list[dict]) -> list[dict]:
    actions: list[dict] = []
    seen: set[str] = set()
    for event in events:
        if event.get("type") != "file_change" or event.get("change") == "error":
            continue
        path = str(event.get("path", ""))
        full_path = str(event.get("full_path", ""))
        change = str(event.get("change", ""))
        ext = Path(path).suffix.lower()
        action = ""
        confidence = "low"
        evidence = ""
        if change == "created":
            if ext in {".zip", ".rar", ".7z", ".tar", ".gz"}:
                action = "archive_detected"
                evidence = f"创建了归档文件 {ext}"
            elif any(word in path.lower() for word in ["copy", "副本"]):
                action = "copy_file"
                confidence = "medium"
                evidence = "文件名含 copy/副本"
            elif ext in {".c", ".cpp", ".h", ".hpp", ".ino", ".py", ".js", ".ts", ".json"}:
                action = "edit_code_file"
                confidence = "medium"
                evidence = f"创建了代码/配置文件 {ext}"
            else:
                action = "create_file"
                evidence = f"创建了文件 {ext}"
        elif change == "modified":
            if ext in {".c", ".cpp", ".h", ".hpp", ".ino", ".py", ".js", ".ts"}:
                action = "edit_source_code"
                confidence = "high"
                evidence = f"修改了源代码文件 {ext}"
            elif ext in {".json", ".yml", ".yaml", ".toml", ".ini"}:
                action = "edit_config"
                confidence = "medium"
                evidence = f"修改了配置文件 {ext}"
            else:
                action = "modify_file"
                evidence = f"修改了文件 {ext}"
        elif change == "deleted":
            if any(word in path.lower() for word in ["tmp", "temp", "cache"]):
                action = "clear_cache"
                confidence = "medium"
                evidence = "删除临时/缓存文件"
            else:
                action = "delete_file"
                evidence = "删除了文件"
        elif change == "renamed":
            action = "rename_file"
            evidence = "重命名了文件"
        if not action:
            continue
        key = f"{action}|{path}"
        if key in seen:
            continue
        seen.add(key)
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
    return actions


def infer_command_tool_chain(command: dict) -> str:
    raw = str(command.get("command", "")).lower()
    for tool_chain, keywords in TOOL_CHAINS.items():
        if any(keyword in raw for keyword in keywords):
            return tool_chain
    return "unknown"


def infer_terminal_action(command: dict) -> str:
    raw = str(command.get("command", "")).lower()
    if any(token in raw for token in [" install", "pip install", "npm install", "idf_tools.py"]):
        return "install_dependencies"
    if any(token in raw for token in [" build", "cmake", "ninja", "make", "pio run"]):
        return "build_project"
    if any(token in raw for token in [" flash", "upload", "esptool"]):
        return "flash_device"
    if any(token in raw for token in [" test", "pytest", "npm test", "pio test"]):
        return "run_tests"
    if any(token in raw for token in [" check", "--version", " version", " where ", "get-command"]):
        return "inspect_environment"
    if any(token in raw for token in [" menuconfig", " reconfigure", "sdkconfig"]):
        return "configure_project"
    if any(token in raw for token in ["git status", "git diff", "git log"]):
        return "inspect_git_state"
    if any(token in raw for token in ["git add", "git commit", "git merge", "git rebase"]):
        return "change_git_state"
    if any(token in raw for token in ["mkdir", "new-item", "copy", "copy-item", "move", "move-item"]):
        return "change_filesystem"
    if any(token in raw for token in ["del ", "erase ", "remove-item", "rm ", "rmdir"]):
        return "delete_files"
    return "run_command"


def summarize_command_output(command: dict) -> dict:
    output = str(command.get("output_preview") or command.get("stdout_preview") or "")
    lower = output.lower()
    signals: list[str] = []
    if "permissionerror" in lower or "access is denied" in lower or "拒绝访问" in output:
        signals.append("permission_denied")
    if "required tools were not found" in lower or "no version found in path" in lower:
        signals.append("missing_toolchain_tools")
    if "no such file" in lower or "找不到" in output:
        signals.append("path_not_found")
    if "traceback" in lower or "exception" in lower:
        signals.append("python_exception")
    if "error:" in lower or "failed" in lower:
        signals.append("command_reported_error")
    if command.get("succeeded") is True and not signals:
        signals.append("completed_successfully")
    return {
        "exit_code": command.get("exit_code"),
        "succeeded": command.get("succeeded"),
        "duration_ms": command.get("duration_ms"),
        "output_chars": len(output),
        "output_signals": signals,
        "output_preview": output[:CONTENT_CAPTURE_PREVIEW_CHARS],
    }


def build_terminal_activity(commands: list[dict]) -> list[dict]:
    result: list[dict] = []
    for index, command in enumerate(commands):
        raw = str(command.get("command", ""))
        lower = raw.lower()
        result.append(
            {
                "sequence": index + 1,
                "timestamp": command.get("timestamp", ""),
                "type": "terminal_activity",
                "actor": command.get("command_actor", "unknown"),
                "invoked_by": command.get("invoked_by", "unknown"),
                "shell": command.get("shell", ""),
                "cwd_before": command.get("cwd_before", command.get("cwd", "")),
                "cwd_after": command.get("cwd_after", ""),
                "command": raw,
                "redacted_command": command.get("redacted_command", raw),
                "primary_command": command.get("primary_command", ""),
                "tool_chain": infer_command_tool_chain(command),
                "terminal_action": infer_terminal_action(command),
                "referenced_paths": command.get("referenced_paths", []),
                "uses_environment_assignment": "set " in lower or "$env:" in lower,
                "uses_command_chaining": "&&" in raw or "||" in raw or ";" in raw,
                "is_potentially_destructive": any(token in lower for token in ["remove-item", "del ", "erase ", "rm ", "rmdir", "git clean"]),
                "output": summarize_command_output(command),
                "source_log": command.get("source_log", ""),
            }
        )
    return result


def path_related_to_command(file_event: dict, command: dict) -> bool:
    full_path = normalize_path(file_event.get("full_path") or file_event.get("path") or "")
    cwd = normalize_path(command.get("cwd") or command.get("cwd_before") or "") if command.get("cwd") or command.get("cwd_before") else ""
    if cwd and full_path.startswith(cwd.rstrip("/") + "/"):
        return True
    for ref in command.get("referenced_paths", []) or []:
        ref_norm = normalize_path(ref)
        if ref_norm and (full_path.startswith(ref_norm.rstrip("/") + "/") or ref_norm in full_path):
            return True
    return False


def build_tool_file_impacts(commands: list[dict], file_events: list[dict]) -> list[dict]:
    command_times = [parse_time(str(command.get("timestamp", ""))) for command in commands]
    file_items = [(parse_time(str(event.get("timestamp", ""))), event) for event in file_events]
    impacts: list[dict] = []
    for index, command in enumerate(commands):
        start = command_times[index]
        if not start:
            continue
        later_times = [item for item in command_times[index + 1 :] if item]
        end = min(later_times) if later_times else None
        related_events: list[dict] = []
        for event_time, event in file_items:
            if not event_time or event_time < start:
                continue
            if end and event_time >= end:
                continue
            if not end and (event_time - start).total_seconds() > 600:
                continue
            if path_related_to_command(event, command):
                related_events.append(event)
        if not related_events:
            continue
        change_counts = Counter(event.get("change", "unknown") for event in related_events)
        impacts.append(
            {
                "type": "tool_file_impact",
                "command_sequence": index + 1,
                "timestamp": command.get("timestamp", ""),
                "actor": command.get("command_actor", "unknown"),
                "tool_chain": infer_command_tool_chain(command),
                "terminal_action": infer_terminal_action(command),
                "command": command.get("command", ""),
                "cwd": command.get("cwd") or command.get("cwd_before", ""),
                "impact_window": "until_next_command_or_10m",
                "file_change_count": len(related_events),
                "change_counts": dict(change_counts),
                "priority_file_change_count": sum(1 for event in related_events if event.get("is_priority_file")),
                "impacted_files": [
                    {
                        "timestamp": event.get("timestamp", ""),
                        "change": event.get("change", ""),
                        "path": event.get("path", ""),
                        "full_path": event.get("full_path", ""),
                        "is_priority_file": event.get("is_priority_file", False),
                        "priority_reason": event.get("priority_reason", ""),
                        "has_diff": bool(event.get("file_diff")),
                    }
                    for event in related_events[:40]
                ],
                "impacted_files_truncated": len(related_events) > 40,
            }
        )
    return impacts


def classify_ai_operations(commands: list[dict]) -> list[dict]:
    operations: list[dict] = []
    seen: set[str] = set()
    for command in commands:
        if command.get("command_actor") != "ai":
            continue
        raw = str(command.get("command", "")).lower()
        for name, patterns in AI_OPERATION_PATTERNS.items():
            if any(pattern in raw for pattern in patterns):
                if name in seen:
                    break
                seen.add(name)
                operations.append(
                    {
                        "timestamp": command.get("timestamp", ""),
                        "type": "ai_operation",
                        "ai_operation": name,
                        "confidence": "medium",
                        "trigger_command": command.get("command", ""),
                        "succeeded": command.get("succeeded"),
                        "cwd": command.get("cwd", ""),
                    }
                )
                break
    return operations


def detect_tool_chains(commands: list[dict], file_events: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for command in commands:
        tool_chain = infer_command_tool_chain(command)
        if tool_chain == "unknown":
            continue
        item = grouped.setdefault(
            tool_chain,
            {"tool_chain": tool_chain, "first_seen": command.get("timestamp", ""), "command_count": 0, "commands": [], "succeeded_count": 0, "failed_count": 0, "file_extensions": []},
        )
        item["command_count"] += 1
        item["commands"].append({"command": command.get("command", ""), "timestamp": command.get("timestamp", ""), "succeeded": command.get("succeeded")})
        if command.get("succeeded"):
            item["succeeded_count"] += 1
        else:
            item["failed_count"] += 1
    for event in file_events:
        ext = Path(str(event.get("path", ""))).suffix.lower()
        if not ext:
            continue
        for tool_chain, keywords in TOOL_CHAINS.items():
            if tool_chain in {"esp_idf", "cmake"} and ext in {".c", ".h", ".cpp", ".hpp", ".ino"}:
                item = grouped.setdefault(tool_chain, {"tool_chain": tool_chain, "first_seen": event.get("timestamp", ""), "command_count": 0, "commands": [], "succeeded_count": 0, "failed_count": 0, "file_extensions": []})
                if ext not in item["file_extensions"]:
                    item["file_extensions"].append(ext)
    return list(grouped.values())


def extract_user_command_habits(commands: list[dict]) -> dict:
    user_commands = [command for command in commands if command.get("command_actor") in {"user", "human"}]
    if not user_commands:
        return {"total_user_commands": 0, "average_command_length": 0, "common_flags": [], "command_patterns": [], "shell_usage": {}}
    flags: list[str] = []
    words: list[str] = []
    shell_counts: dict[str, int] = {}
    total_length = 0
    for command in user_commands:
        raw = str(command.get("command", ""))
        shell = str(command.get("shell", "unknown"))
        shell_counts[shell] = shell_counts.get(shell, 0) + 1
        total_length += len(raw)
        for part in raw.split():
            if part.startswith("-"):
                flags.append(part)
            else:
                words.append(part.lower())
    return {
        "total_user_commands": len(user_commands),
        "average_command_length": round(total_length / len(user_commands), 1),
        "common_flags": [{"flag": flag, "count": count} for flag, count in Counter(flags).most_common(10)],
        "command_patterns": [{"word": word, "count": count} for word, count in Counter(words).most_common(20) if len(word) > 2],
        "shell_usage": shell_counts,
    }


def build_tool_file_changes(events: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for event in events:
        if event.get("type") != "file_change" or event.get("change") == "error":
            continue
        tool_info = event.get("file_actor") or {}
        tool_name = str(tool_info.get("tool_name") or "unknown")
        process_name = str(tool_info.get("process_name") or "")
        key = f"{tool_name}|{process_name}"
        item = grouped.setdefault(
            key,
            {
                "tool_name": tool_name,
                "process_name": process_name,
                "window_title": tool_info.get("window_title", ""),
                "window_title_metadata": tool_info.get("window_title_metadata", {}),
                "file_change_count": 0,
                "priority_file_change_count": 0,
                "change_counts": Counter(),
                "files": [],
            },
        )
        item["file_change_count"] += 1
        if event.get("is_priority_file"):
            item["priority_file_change_count"] += 1
        item["change_counts"][event.get("change", "unknown")] += 1
        item["files"].append(
            {
                "timestamp": event.get("timestamp", ""),
                "change": event.get("change", ""),
                "path": event.get("path", ""),
                "full_path": event.get("full_path", ""),
                "is_priority_file": event.get("is_priority_file", False),
            }
        )
    result: list[dict] = []
    for item in grouped.values():
        files = item["files"]
        result.append(
            {
                "tool_name": item["tool_name"],
                "process_name": item["process_name"],
                "window_title": item["window_title"],
                "window_title_metadata": item["window_title_metadata"],
                "file_change_count": item["file_change_count"],
                "priority_file_change_count": item["priority_file_change_count"],
                "change_counts": dict(item["change_counts"]),
                "files": files[:80],
                "files_truncated": len(files) > 80,
            }
        )
    result.sort(key=lambda entry: entry["file_change_count"], reverse=True)
    return result


def build_simple_file_journal(events: list[dict]) -> list[str]:
    change_labels = {"created": "新建", "modified": "修改", "deleted": "删除", "renamed": "重命名"}
    lines: list[str] = []
    for event in events:
        if event.get("type") != "file_change" or event.get("change") == "error":
            continue
        timestamp = str(event.get("timestamp", ""))
        time_text = timestamp[11:19] if len(timestamp) >= 19 else timestamp
        tool = event.get("file_actor") or {}
        tool_name = str(tool.get("tool_name") or tool.get("process_name") or "unknown")
        change = change_labels.get(str(event.get("change", "")), str(event.get("change", "")))
        path = str(event.get("path", ""))
        if event.get("change") == "renamed":
            lines.append(f"{time_text} {tool_name} {change} {event.get('old_path', '')} -> {path}")
        else:
            lines.append(f"{time_text} {tool_name} {change} {path}")
    return lines


GUI_TERMINAL_PROCESS_NAMES = {
    "code.exe": "vscode_terminal",
    "code - insiders.exe": "vscode_terminal",
    "vscode.exe": "vscode_terminal",
    "cursor.exe": "cursor_terminal",
    "windsurf.exe": "windsurf_terminal",
    "codex.exe": "codex_terminal",
    "opencode.exe": "opencode_terminal",
    "cc.exe": "cc_terminal",
    "codeium.exe": "codeium_terminal",
    "arduino ide.exe": "arduino_terminal",
    "arduino.exe": "arduino_terminal",
}


def infer_gui_terminal_sessions(events: list[dict], file_events: list[dict]) -> list[dict]:
    sessions: list[dict] = []
    window_events = [event for event in events if event.get("type") == "window_change"]
    clipboard_items = [(parse_time(str(event.get("timestamp", ""))), event) for event in events if event.get("type") == "clipboard_change"]
    file_items = [(parse_time(str(event.get("timestamp", ""))), event) for event in file_events]
    for index, event in enumerate(window_events):
        process_name = str(event.get("process_name", "")).lower()
        terminal_kind = GUI_TERMINAL_PROCESS_NAMES.get(process_name)
        if not terminal_kind:
            continue
        title = str(event.get("window_title", ""))
        title_lower = title.lower()
        start = parse_time(str(event.get("timestamp", "")))
        if not start:
            continue
        end = None
        for later in window_events[index + 1 :]:
            later_time = parse_time(str(later.get("timestamp", "")))
            if later_time and later.get("process_id") == event.get("process_id"):
                end = later_time
                break
        related_files = []
        for event_time, file_event in file_items:
            if not event_time or event_time < start:
                continue
            if end and event_time >= end:
                continue
            if not end and (event_time - start).total_seconds() > 600:
                continue
            related_files.append(file_event)
        if not related_files:
            continue
        title_signals = [keyword for keyword in TOOL_CAPTURE_KEYWORDS if keyword in title_lower]
        related_clipboard = []
        for event_time, clip_event in clipboard_items:
            if not event_time or event_time < start:
                continue
            if end and event_time >= end:
                continue
            if not end and (event_time - start).total_seconds() > 600:
                continue
            related_clipboard.append(clip_event)
        sessions.append(
            {
                "type": "gui_terminal_session",
                "timestamp": event.get("timestamp", ""),
                "terminal_kind": terminal_kind,
                "process_name": event.get("process_name", ""),
                "process_id": event.get("process_id"),
                "window_title": title,
                "title_signals": title_signals,
                "window_title_metadata": parse_window_title_metadata(title),
                "exe_path": event.get("exe_path", ""),
                "active_window_duration_scope": "until_next_same_process_focus_or_10m",
                "file_change_count": len(related_files),
                "change_counts": dict(Counter(item.get("change", "unknown") for item in related_files)),
                "priority_file_change_count": sum(1 for item in related_files if item.get("is_priority_file")),
                "clipboard_change_count": len(related_clipboard),
                "clipboard_samples": [
                    {
                        "timestamp": item.get("timestamp", ""),
                        "content_length": item.get("content_length", 0),
                        "clipboard_preview": str(item.get("clipboard_content", ""))[:200],
                    }
                    for item in related_clipboard[:10]
                ],
                "clipboard_samples_truncated": len(related_clipboard) > 10,
                "impacted_files": [
                    {
                        "timestamp": item.get("timestamp", ""),
                        "change": item.get("change", ""),
                        "path": item.get("path", ""),
                        "full_path": item.get("full_path", ""),
                        "is_priority_file": item.get("is_priority_file", False),
                    }
                    for item in related_files[:40]
                ],
                "impacted_files_truncated": len(related_files) > 40,
            }
        )
    return sessions


def build_default_watch_profiles() -> list[dict]:
    username = os.environ.get("USERNAME", "")
    vscode_root = Path(f"C:/Users/{username}/AppData/Roaming/Code")
    return [
        {"key": "codex_workspace", "label": "Codex 工作目录", "path": Path("D:/codex"), "exclude_prefixes": [LOGS_DIR], "exclude_names": {"__pycache__", ".git"}},
        {"key": "opencode_workspace", "label": "OpenCode 工作目录", "path": Path("D:/OpenCode"), "exclude_prefixes": [], "exclude_names": {"__pycache__", ".git"}},
        {"key": "vscode_user", "label": "VS Code 用户配置", "path": vscode_root / "User", "exclude_prefixes": [], "exclude_names": {"History"}},
        {"key": "vscode_workspace", "label": "VS Code 工作区状态", "path": vscode_root / "Workspaces", "exclude_prefixes": [], "exclude_names": set()},
        {"key": "downloads", "label": "下载目录", "path": Path.home() / "Downloads", "exclude_prefixes": [], "exclude_names": {"Temp"}},
        {"key": "esp32_projects", "label": "ESP32 项目目录", "path": Path("D:/esp32"), "exclude_prefixes": [], "exclude_names": {"build", ".git"}},
        {"key": "esp_idf_root", "label": "ESP-IDF 安装目录", "path": Path("C:/esp"), "exclude_prefixes": [], "exclude_names": {".git"}},
    ]


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
    if not root.exists():
        return {}
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


def enrich_file_event(event: dict, old_info: dict | None, new_info: dict | None) -> dict:
    enriched = dict(event)
    is_priority, reason = priority_file_match(event.get("path", ""))
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
            diff_text, diff_truncated = build_unified_diff(old_snapshot.get("text", ""), new_snapshot.get("text", ""), event.get("path", ""))
            enriched["file_diff"]["unified_diff"] = diff_text
            enriched["file_diff"]["diff_truncated"] = diff_truncated
    return enriched


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
            events.append(enrich_file_event({"timestamp": now_iso(), "type": "file_change", "watch_label": profile["label"], "watch_root": str(profile["path"]), "change": "renamed", "path": new_path, "old_path": old_path, "full_path": new_info["full_path"], "old_full_path": old_info["full_path"]}, old_info, new_info))
    for path in sorted(deleted_paths - matched_deleted):
        info = previous[path]
        events.append(enrich_file_event({"timestamp": now_iso(), "type": "file_change", "watch_label": profile["label"], "watch_root": str(profile["path"]), "change": "deleted", "path": path, "full_path": info["full_path"]}, info, None))
    for path in sorted(created_paths - matched_created):
        info = current[path]
        events.append(enrich_file_event({"timestamp": now_iso(), "type": "file_change", "watch_label": profile["label"], "watch_root": str(profile["path"]), "change": "created", "path": path, "full_path": info["full_path"]}, None, info))
    for path in sorted(old_paths & new_paths):
        old_info = previous[path]
        new_info = current[path]
        if old_info["mtime_ns"] != new_info["mtime_ns"] or old_info["size"] != new_info["size"]:
            events.append(enrich_file_event({"timestamp": now_iso(), "type": "file_change", "watch_label": profile["label"], "watch_root": str(profile["path"]), "change": "modified", "path": path, "full_path": new_info["full_path"], "size": new_info["size"]}, old_info, new_info))
    return events


def summarize_event_group(group: list[dict]) -> dict:
    counts = Counter(event.get("type", "unknown") for event in group)
    return {"summary": ", ".join(f"{key}:{value}" for key, value in counts.items()), "counts": dict(counts)}


def summarize_browser_group(group: list[dict]) -> dict:
    counts = Counter(event.get("type", "unknown") for event in group)
    return {"summary": ", ".join(f"{key}:{value}" for key, value in counts.items()), "counts": dict(counts)}


def build_action_summaries(events: list[dict], limit: int = 20) -> list[dict]:
    result: list[dict] = []
    for line in build_simple_file_journal(events)[:limit]:
        result.append({"summary": line})
    return result


class SkillRecorderApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("安全技能录制器")
        self.root.geometry("1260x820")
        self.root.minsize(1080, 700)

        self.recording = False
        self.last_snapshot = None
        self.last_clipboard_text = None
        self.events: list[dict] = []
        self.file_event_queue: queue.Queue[dict] = queue.Queue()
        self.browser_event_queue: queue.Queue[dict] = queue.Queue()

        self.file_watch_stop = threading.Event()
        self.file_watch_threads: list[threading.Thread] = []
        self.file_watch_running = False

        self.browser_monitor_stop = threading.Event()
        self.browser_monitor_thread: threading.Thread | None = None
        self.browser_process: subprocess.Popen | None = None
        self.browser_running = False
        self.browser_last_tabs: dict[str, dict] = {}
        self.browser_debug_port: int | None = None
        self.browser_session_dir: Path | None = None

        self.roo_watch_stop = threading.Event()
        self.roo_watch_thread: threading.Thread | None = None
        self.roo_history_positions: dict[str, int] = {}

        self.watch_profiles = build_default_watch_profiles()
        self.watch_profile_vars = {profile["key"]: tk.BooleanVar(value=True) for profile in self.watch_profiles}

        self.session_name = tk.StringVar(value="新建技能会话")
        self.session_intent = tk.StringVar(value="")
        self.session_outcome = tk.StringVar(value="")
        self.session_success_criteria = tk.StringVar(value="")
        self.session_result = tk.StringVar(value="")
        self.session_blockers = tk.StringVar(value="")
        self.session_next_step = tk.StringVar(value="")
        self.extension_filter_text = tk.StringVar(value="")
        self.status_text = tk.StringVar(value="空闲")
        self.file_watch_status = tk.StringVar(value="文件监视未启动")
        self.browser_status = tk.StringVar(value="浏览器监视未启动")
        self.current_title = tk.StringVar(value="-")
        self.current_process = tk.StringVar(value="-")
        self.current_path = tk.StringVar(value="-")
        self.event_count = tk.StringVar(value="0")
        self.session_started_at = ""

        self.installed_browsers = detect_installed_browsers()
        self.browser_choice = tk.StringVar(value=self.installed_browsers[0]["label"] if self.installed_browsers else "未检测到浏览器")

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
        tk.Label(header, text="Skill User Monitor", fg="white", bg="#16324f", font=("Segoe UI", 17, "bold")).grid(row=0, column=0, sticky="w")
        tk.Label(header, textvariable=self.status_text, fg="#d8e7f5", bg="#16324f", font=("Segoe UI", 10)).grid(row=0, column=1, sticky="e", padx=(20, 0))
        header.columnconfigure(0, weight=1)

        controls = ttk.Frame(self.root, padding=(16, 14))
        controls.grid(row=1, column=0, sticky="ew")
        for col in range(4):
            controls.columnconfigure(col, weight=1)

        ttk.Label(controls, text="会话名称").grid(row=0, column=0, sticky="w")
        ttk.Entry(controls, textvariable=self.session_name).grid(row=1, column=0, sticky="ew", padx=(0, 12))
        ttk.Label(controls, text="成功标准").grid(row=0, column=1, sticky="w")
        ttk.Entry(controls, textvariable=self.session_success_criteria).grid(row=1, column=1, sticky="ew", padx=(0, 12))
        ttk.Label(controls, text="结果").grid(row=0, column=2, sticky="w")
        ttk.Entry(controls, textvariable=self.session_result).grid(row=1, column=2, sticky="ew", padx=(0, 12))
        ttk.Label(controls, text="扩展过滤").grid(row=0, column=3, sticky="w")
        ttk.Entry(controls, textvariable=self.extension_filter_text).grid(row=1, column=3, sticky="ew")

        button_row = ttk.Frame(controls)
        button_row.grid(row=2, column=0, columnspan=4, sticky="ew", pady=(12, 0))
        for col in range(8):
            button_row.columnconfigure(col, weight=1)
        ttk.Button(button_row, text="开始录制", command=self.start_recording).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ttk.Button(button_row, text="结束录制", command=self.stop_recording).grid(row=0, column=1, sticky="ew", padx=6)
        ttk.Button(button_row, text="开始文件监视", command=self.start_file_watch).grid(row=0, column=2, sticky="ew", padx=6)
        ttk.Button(button_row, text="停止文件监视", command=self.stop_file_watch).grid(row=0, column=3, sticky="ew", padx=6)
        ttk.Button(button_row, text="启动受管浏览器", command=self.start_browser_monitor).grid(row=0, column=4, sticky="ew", padx=6)
        ttk.Button(button_row, text="停止浏览器监视", command=self.stop_browser_monitor).grid(row=0, column=5, sticky="ew", padx=6)
        ttk.Button(button_row, text="启动受管 PowerShell", command=self.launch_managed_powershell).grid(row=0, column=6, sticky="ew", padx=6)
        ttk.Button(button_row, text="导出 JSON", command=self.export_json).grid(row=0, column=7, sticky="ew", padx=(6, 0))

        status_frame = tk.Frame(self.root, bg="#f4f7f9", padx=16, pady=10)
        status_frame.grid(row=2, column=0, sticky="nsew")
        status_frame.columnconfigure(0, weight=1)
        status_frame.rowconfigure(4, weight=1)

        meta = ttk.Frame(status_frame)
        meta.grid(row=0, column=0, sticky="ew")
        meta.columnconfigure(1, weight=1)
        meta.columnconfigure(3, weight=1)
        ttk.Label(meta, text="当前标题").grid(row=0, column=0, sticky="w")
        ttk.Label(meta, textvariable=self.current_title).grid(row=0, column=1, sticky="ew", padx=(8, 18))
        ttk.Label(meta, text="当前进程").grid(row=0, column=2, sticky="w")
        ttk.Label(meta, textvariable=self.current_process).grid(row=0, column=3, sticky="ew")
        ttk.Label(meta, text="当前路径").grid(row=1, column=0, sticky="w")
        ttk.Label(meta, textvariable=self.current_path).grid(row=1, column=1, columnspan=3, sticky="ew", padx=(8, 0))
        ttk.Label(meta, text="文件监视").grid(row=2, column=0, sticky="w")
        ttk.Label(meta, textvariable=self.file_watch_status).grid(row=2, column=1, columnspan=3, sticky="ew", padx=(8, 0))
        ttk.Label(meta, text="浏览器监视").grid(row=3, column=0, sticky="w")
        ttk.Label(meta, textvariable=self.browser_status).grid(row=3, column=1, columnspan=3, sticky="ew", padx=(8, 0))
        ttk.Label(meta, text="事件数").grid(row=4, column=0, sticky="w")
        ttk.Label(meta, textvariable=self.event_count).grid(row=4, column=1, sticky="w", padx=(8, 0))

        watch_frame = ttk.LabelFrame(status_frame, text="监视目录")
        watch_frame.grid(row=1, column=0, sticky="ew", pady=(10, 8))
        for idx, profile in enumerate(self.watch_profiles):
            ttk.Checkbutton(watch_frame, text=profile["label"], variable=self.watch_profile_vars[profile["key"]]).grid(row=idx // 3, column=idx % 3, sticky="w", padx=8, pady=4)

        browser_frame = ttk.Frame(status_frame)
        browser_frame.grid(row=2, column=0, sticky="ew")
        browser_frame.columnconfigure(1, weight=1)
        ttk.Label(browser_frame, text="浏览器").grid(row=0, column=0, sticky="w")
        values = [item["label"] for item in self.installed_browsers] or ["未检测到浏览器"]
        ttk.Combobox(browser_frame, textvariable=self.browser_choice, values=values, state="readonly").grid(row=0, column=1, sticky="ew", padx=(8, 0))

        self.log_text = tk.Text(status_frame, wrap="word", height=20, font=("Consolas", 10))
        self.log_text.grid(row=4, column=0, sticky="nsew", pady=(10, 0))
        self.log_text.configure(state="disabled")

    def _append_log(self, text: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

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
        self.current_process.set(f"{snapshot.get('process_name') or '（未知进程）'} (PID {snapshot.get('process_id')})")
        self.current_path.set(snapshot.get("exe_path") or "（路径不可用）")

    def _push_event(self, event: dict) -> None:
        self.events.append(event)
        self.event_count.set(str(len(self.events)))

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

    def _format_browser_event(self, event: dict) -> str:
        event_type = event.get("type")
        browser_label = event.get("browser_label", "受管浏览器")
        if event_type == "browser_monitor_status":
            status = event.get("status", "unknown")
            if status == "launching":
                return f"[{event['timestamp']}] 浏览器监视启动中 -> {browser_label} | 调试端口 {event.get('debug_port', '-')}"
            if status == "connected":
                return f"[{event['timestamp']}] 浏览器调试接口已连接 -> {browser_label} | 初始标签数 {event.get('tab_count', '-')}"
            if status == "connect_failed":
                return f"[{event['timestamp']}] 浏览器调试接口连接失败 -> {browser_label} | {event.get('message', '')}"
            return f"[{event['timestamp']}] 浏览器监视状态 -> {browser_label} | {status}"
        if event_type == "browser_tab_opened":
            return f"[{event['timestamp']}] 浏览器打开标签页 -> {browser_label} | {event.get('url', '')} | 标签数 {event.get('tab_count', '-')}"
        if event_type == "browser_tab_closed":
            return f"[{event['timestamp']}] 浏览器关闭标签页 -> {browser_label} | {event.get('title', '') or event.get('url', '')} | 标签数 {event.get('tab_count', '-')}"
        if event_type == "browser_tab_navigated":
            return f"[{event['timestamp']}] 浏览器页面跳转 -> {browser_label} | {event.get('navigation_scope', 'unknown')} | {event.get('url', '')}"
        if event_type == "browser_tab_title_changed":
            return f"[{event['timestamp']}] 浏览器标题变化 -> {browser_label} | {event.get('title', '')}"
        return f"[{event['timestamp']}] 浏览器事件 -> {browser_label}"

    def _format_file_event(self, event: dict) -> str:
        change_map = {"created": "新建", "modified": "修改", "deleted": "删除", "renamed": "重命名", "error": "错误"}
        change_label = change_map.get(event.get("change"), event.get("change", "unknown"))
        watch_label = event.get("watch_label", "文件监视")
        path = event.get("path", "")
        actor = event.get("file_actor") or {}
        actor_text = actor.get("tool_name", actor.get("process_name", "unknown"))
        capture_note = " | 已捕获内容预览" if event.get("content_capture") else ""
        if event.get("change") == "error":
            return f"[{event['timestamp']}] 文件监视错误 -> {watch_label} | {event.get('message', '')}"
        if event.get("change") == "renamed":
            return f"[{event['timestamp']}] 文件{change_label} -> {watch_label} | {actor_text} | {event.get('old_path', '')} -> {path}{capture_note}"
        return f"[{event['timestamp']}] 文件{change_label} -> {watch_label} | {actor_text} | {path}{capture_note}"

    def _format_event(self, event: dict) -> str:
        event_type = event.get("type")
        if event_type == "file_change":
            return self._format_file_event(event)
        if str(event_type).startswith("browser_"):
            return self._format_browser_event(event)
        if event_type == "roo_cline_message":
            preview = str(event.get("content_preview", "")).replace("\n", " ")[:120]
            return f"[{event.get('timestamp', '')}] Roo-Cline -> {event.get('role', 'unknown')} | {preview}"
        if event_type == "clipboard_change":
            return f"[{event.get('timestamp', '')}] 剪贴板变化 -> {event.get('content_length', 0)} 字符"
        if event_type == "session_intent":
            phase = event.get("phase", "")
            return f"[{event.get('timestamp', '')}] {'开始会话' if phase == 'start' else '结束会话'} -> {event.get('text', '')}"
        if event_type == "manual_step":
            return f"[{event.get('timestamp', '')}] 手动步骤 -> {event.get('label', '')}"
        if event_type == "app_ui_action":
            return f"[{event.get('timestamp', '')}] 应用操作 -> {event.get('action', '')}"
        return f"[{event.get('timestamp', '')}] {event_type}"

    def _drain_event_queue(self, event_queue: queue.Queue[dict]) -> None:
        drained: list[dict] = []
        while True:
            try:
                drained.append(event_queue.get_nowait())
            except queue.Empty:
                break
        for event in drained:
            self._push_event(event)
            self._append_log(self._format_event(event))

    def _is_new_snapshot(self, snapshot: dict) -> bool:
        if not self.last_snapshot:
            return True
        return any(snapshot.get(key) != self.last_snapshot.get(key) for key in ("window_title", "process_id", "exe_path"))

    def _tick(self) -> None:
        snapshot = get_foreground_snapshot()
        private_snapshot = is_private_app_snapshot(snapshot)
        self._refresh_current(redact_private_snapshot(snapshot))
        self._drain_event_queue(self.file_event_queue)
        self._drain_event_queue(self.browser_event_queue)
        if private_snapshot:
            self.last_snapshot = None
        elif self.recording and snapshot and self._is_new_snapshot(snapshot):
            event = {"timestamp": now_iso(), "type": "window_change", **snapshot}
            self._push_event(event)
            self.last_snapshot = snapshot
            self._append_log(f"[{event['timestamp']}] 窗口切换 -> {snapshot['process_name'] or '未知进程'} | {snapshot['window_title'] or '（无标题窗口）'}")
        if self.recording:
            current_clip = read_clipboard_text()
            if current_clip and current_clip != self.last_clipboard_text:
                if len(current_clip) <= 5000:
                    event = {"timestamp": now_iso(), "type": "clipboard_change", "clipboard_content": current_clip[:1000], "content_length": len(current_clip)}
                    self._push_event(event)
                    self._append_log(f"[{event['timestamp']}] 剪贴板变化 -> {len(current_clip)} 字符")
                self.last_clipboard_text = current_clip
        self.root.after(POLL_MS, self._tick)

    def _ensure_text_value(self, current: str, prompt_title: str, prompt_text: str) -> str | None:
        value = current.strip()
        if value:
            return value
        response = simpledialog.askstring(prompt_title, prompt_text, parent=self.root)
        if response is None:
            return None
        response = response.strip()
        if not response:
            messagebox.showwarning(prompt_title, "请至少输入一句话。")
            return None
        return response

    def _maybe_attach_context(self, event: dict) -> dict:
        snapshot = get_foreground_snapshot()
        redacted = redact_private_snapshot(snapshot)
        enriched = dict(event)
        enriched["file_actor"] = describe_active_tool(redacted)
        if event.get("change") not in {"created", "modified", "renamed"}:
            return enriched
        if not is_tool_capture_snapshot(snapshot):
            return enriched
        full_path = event.get("full_path")
        if not full_path:
            return enriched
        capture = read_text_preview(full_path)
        if not capture:
            return enriched
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
            for history_path in ROO_CLINE_TASKS_DIR.glob("*/api_conversation_history.json"):
                _, next_index = extract_roo_history_events(history_path, 10**9)
                self.roo_history_positions[str(history_path)] = next_index
        except OSError:
            return

    def _start_roo_watch(self) -> None:
        if self.roo_watch_thread and self.roo_watch_thread.is_alive():
            return
        self._prime_roo_history_positions()
        self.roo_watch_stop.clear()
        self.roo_watch_thread = threading.Thread(target=self._roo_watch_loop, daemon=True, name="roo-cline-watch")
        self.roo_watch_thread.start()

    def _stop_roo_watch(self) -> None:
        self.roo_watch_stop.set()
        self.roo_watch_thread = None

    def _roo_watch_loop(self) -> None:
        while not self.roo_watch_stop.wait(ROO_POLL_INTERVAL_SEC):
            if not ROO_CLINE_TASKS_DIR.exists():
                continue
            try:
                history_files = sorted(ROO_CLINE_TASKS_DIR.glob("*/api_conversation_history.json"), key=lambda item: item.stat().st_mtime, reverse=True)[:12]
            except OSError:
                continue
            for history_path in history_files:
                key = str(history_path)
                start_index = self.roo_history_positions.get(key, 0)
                events, next_index = extract_roo_history_events(history_path, start_index)
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
        intent = self._ensure_text_value(self.session_intent.get(), "开始意图", "这次会话准备做什么？")
        if intent is None:
            return
        self.session_intent.set(intent)
        self.recording = True
        self.session_started_at = now_iso()
        self.status_text.set(f"录制中：{session_name}")
        self._start_roo_watch()
        self._record_app_action("start_recording")
        event = {"timestamp": self.session_started_at, "type": "session_intent", "phase": "start", "text": intent}
        self._push_event(event)
        self._append_log(f"[{self.session_started_at}] 开始会话 -> {session_name} | {intent}")

    def stop_recording(self) -> None:
        if not self.recording:
            return
        outcome = self._ensure_text_value(self.session_outcome.get(), "结束总结", "这次会话结果怎么样？")
        if outcome is None:
            return
        self.session_outcome.set(outcome)
        self.recording = False
        self._stop_roo_watch()
        stopped_at = now_iso()
        self.status_text.set("空闲")
        self._record_app_action("stop_recording")
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

    def launch_managed_powershell(self) -> None:
        script_path = SCRIPTS_DIR / "managed_powershell.ps1"
        if not script_path.exists():
            messagebox.showerror("缺少脚本", f"没有找到脚本：\n{script_path}")
            return
        session_name = self.session_name.get().strip() or "技能会话"
        try:
            subprocess.Popen(
                ["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(script_path), "-SessionName", session_name],
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
        except OSError as exc:
            messagebox.showerror("启动失败", f"无法启动受管 PowerShell：\n{exc}")
            return
        self.status_text.set("已启动受管 PowerShell")
        self._record_app_action("launch_managed_powershell", {"session_name": session_name})
        self._append_log(f"[{now_iso()}] 启动受管 PowerShell -> {session_name}")

    def start_file_watch(self) -> None:
        if self.file_watch_running:
            return
        selected_profiles = [
            {**profile, "extensions": parse_extension_filter(self.extension_filter_text.get())}
            for profile in self.watch_profiles
            if self.watch_profile_vars[profile["key"]].get()
        ]
        if not selected_profiles:
            messagebox.showwarning("没有监视目标", "请至少勾选一个要监视的目录。")
            return
        self.file_watch_stop.clear()
        self.file_watch_threads = []
        for profile in selected_profiles:
            thread = threading.Thread(target=self._watch_profile_loop, args=(profile,), daemon=True, name=f"watch-{profile['key']}")
            thread.start()
            self.file_watch_threads.append(thread)
        self.file_watch_running = True
        watched_labels = "、".join(profile["label"] for profile in selected_profiles)
        ext_filter = parse_extension_filter(self.extension_filter_text.get())
        filter_text = "全部文件类型" if ext_filter is None else "、".join(sorted(ext_filter))
        self.file_watch_status.set(f"监视中：{watched_labels} | {filter_text}")
        self._record_app_action("start_file_watch", {"watched_labels": watched_labels, "extension_filter": filter_text, "watch_roots": [str(profile['path']) for profile in selected_profiles]})
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
            self.file_event_queue.put({"timestamp": now_iso(), "type": "file_change", "watch_label": profile["label"], "watch_root": str(profile["path"]), "change": "error", "message": str(exc)})
            return
        while not self.file_watch_stop.wait(FILE_WATCH_INTERVAL_SEC):
            try:
                current = snapshot_directory(profile)
                for event in diff_snapshots(profile, previous, current):
                    self.file_event_queue.put(self._maybe_attach_context(event))
                previous = current
            except Exception as exc:
                self.file_event_queue.put({"timestamp": now_iso(), "type": "file_change", "watch_label": profile["label"], "watch_root": str(profile["path"]), "change": "error", "message": str(exc)})
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
        self.browser_running = True
        self.browser_debug_port = port
        self.browser_session_dir = session_dir
        self.browser_last_tabs = {}
        self.browser_monitor_stop.clear()
        self.browser_monitor_thread = threading.Thread(target=self._browser_monitor_loop, args=(browser["label"], port), daemon=True, name="browser-monitor")
        self.browser_monitor_thread.start()
        self.browser_status.set(f"监视中：{browser['label']} | 调试端口 {port}")
        self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_monitor_status", "browser_label": browser["label"], "status": "launching", "debug_port": port, "session_dir": str(session_dir)})
        self._record_app_action("start_browser_monitor", {"browser_label": browser["label"], "debug_port": port, "session_dir": str(session_dir)})
        self._append_log(f"[{now_iso()}] 启动受管浏览器 -> {browser['label']} | 端口 {port}")

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
            self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_monitor_status", "browser_label": browser_label, "status": "connect_failed", "message": "无法连接到受管浏览器调试接口", "debug_port": port})
            return
        self.browser_last_tabs = {tab["target_id"]: tab for tab in (normalize_browser_target(item, browser_label) for item in tabs) if tab}
        self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_monitor_status", "browser_label": browser_label, "status": "connected", "debug_port": port, "tab_count": len(self.browser_last_tabs)})
        for tab in self.browser_last_tabs.values():
            self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_tab_opened", "tab_count": len(self.browser_last_tabs), **tab})
        while not self.browser_monitor_stop.wait(BROWSER_POLL_INTERVAL_SEC):
            if self.browser_process and self.browser_process.poll() is not None:
                break
            try:
                current_items = fetch_debug_tabs(port)
            except Exception:
                continue
            current_tabs = {tab["target_id"]: tab for tab in (normalize_browser_target(item, browser_label) for item in current_items) if tab}
            previous_tabs = self.browser_last_tabs
            for target_id, tab in current_tabs.items():
                if target_id not in previous_tabs:
                    self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_tab_opened", "tab_count": len(current_tabs), **tab})
                    continue
                old_tab = previous_tabs[target_id]
                if old_tab.get("url") != tab.get("url"):
                    self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_tab_navigated", "old_url": old_tab.get("url", ""), "old_domain": old_tab.get("domain", ""), "navigation_scope": classify_navigation(old_tab, tab), "tab_count": len(current_tabs), **tab})
                elif old_tab.get("title") != tab.get("title"):
                    self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_tab_title_changed", "tab_count": len(current_tabs), **tab})
            for target_id, tab in previous_tabs.items():
                if target_id not in current_tabs:
                    self.browser_event_queue.put({"timestamp": now_iso(), "type": "browser_tab_closed", "tab_count": len(current_tabs), **tab})
            self.browser_last_tabs = current_tabs

    def clear_session(self) -> None:
        if self.recording or self.file_watch_running or self.browser_running:
            messagebox.showwarning("仍有监视在运行", "请先停止录制、文件监视和浏览器监视。")
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
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")
        self.status_text.set("空闲")
        self._append_log("会话已清空。")

    def export_json(self) -> None:
        self._record_app_action("export_json_requested")
        if not self.events:
            messagebox.showinfo("还没有事件", "请至少录制一个事件后再导出。")
            return
        session_name = self.session_name.get().strip() or "技能会话"
        default_name = f"{session_name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        target = filedialog.asksaveasfilename(title="导出会话为 JSON", defaultextension=".json", initialfile=default_name, filetypes=[("JSON 文件", "*.json"), ("所有文件", "*.*")])
        if not target:
            self._record_app_action("export_json_cancelled")
            return
        self._record_app_action("export_json_confirmed", {"target": target})
        command_executions = load_managed_terminal_commands(session_name) + load_roo_command_executions(self.events)
        file_events = [event for event in self.events if event.get("type") == "file_change" and event.get("change") != "error"]
        verification_steps = infer_verification_steps(command_executions)
        gui_file_actions = infer_gui_file_actions(self.events)
        user_feedback_signals = extract_user_feedback_signals(self.events)
        tool_chains = detect_tool_chains(command_executions, file_events)
        ai_operations = classify_ai_operations(command_executions)
        user_command_habits = extract_user_command_habits(command_executions)
        terminal_activity = build_terminal_activity(command_executions)
        tool_file_impacts = build_tool_file_impacts(command_executions, file_events)
        tool_file_changes = build_tool_file_changes(self.events)
        simple_file_journal = build_simple_file_journal(self.events)
        gui_terminal_sessions = infer_gui_terminal_sessions(self.events, file_events)
        derived_events = gui_file_actions + user_feedback_signals + verification_steps
        payload = {
            "session_name": session_name,
            "session_goal": self.session_intent.get().strip(),
            "session_success_criteria": self.session_success_criteria.get().strip(),
            "session_result": self.session_result.get().strip(),
            "session_blockers": [item.strip() for item in self.session_blockers.get().replace("；", ";").split(";") if item.strip()],
            "session_next_step": self.session_next_step.get().strip(),
            "session_intent": self.session_intent.get().strip(),
            "session_outcome": self.session_outcome.get().strip(),
            "created_at": now_iso(),
            "session_started_at": self.session_started_at,
            "host_user": os.environ.get("USERNAME", ""),
            "recorder_version": "1.0.0-rebuilt",
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
                "recorded_fields": ["title", "domain", "sanitized_url", "browser_resource", "url_kind", "path_depth", "tab_lifecycle", "navigation_scope", "tab_count"],
            },
            "file_watch": {
                "extension_filter": sorted(parse_extension_filter(self.extension_filter_text.get()) or []),
                "private_path_filter_enabled": True,
                "watch_roots": [str(profile["path"]) for profile in self.watch_profiles if self.watch_profile_vars[profile["key"]].get()],
            },
            "priority_file_watch": {"patterns": PRIORITY_FILE_PATTERNS, "diff_capture_max_chars": DIFF_CAPTURE_MAX_CHARS},
            "command_executions": command_executions,
            "tool_file_changes": tool_file_changes,
            "simple_file_journal": simple_file_journal,
            "terminal_activity": terminal_activity,
            "tool_file_impacts": tool_file_impacts,
            "gui_terminal_sessions": gui_terminal_sessions,
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
            sidecar_payload = {"schema_version": "1.0", "generated_at": now_iso(), "message_count": len(roo_full_export), "source_file_count": len({item['source_path'] for item in roo_full_export}), "messages": roo_full_export}
            sidecar_text = json.dumps(sidecar_payload, ensure_ascii=False, indent=2)
            sidecar_target = str(Path(target).with_suffix(".roo-cline-full.json"))
            with open(sidecar_target, "w", encoding="utf-8") as fh:
                fh.write(sidecar_text)
        self.status_text.set(f"已导出 JSON：{target}")
        self._append_log(f"[{now_iso()}] 导出 JSON -> {target}")
        messagebox.showinfo("导出完成", f"会话已导出到：\n{target}")

    def on_close(self) -> None:
        self.file_watch_stop.set()
        self.browser_monitor_stop.set()
        self.roo_watch_stop.set()
        if self.browser_running:
            self.stop_browser_monitor()
        self.root.destroy()


def main() -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    BROWSER_LOGS_DIR.mkdir(parents=True, exist_ok=True)
    root = tk.Tk()
    app = SkillRecorderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
