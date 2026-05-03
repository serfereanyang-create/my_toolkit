# ESP32 Roo CLI Workflow Skill

Version: 0.2.0
Last updated from: `D:\codex\app_monitor\5.json`
Sidecar: `D:\codex\app_monitor\5.roo-cline-full.json`
Sidecar sha256: `6f529a81b45413c05b2e58bf1d6993ff473a9eea97c7a043e93de96501c77ad7`

## Purpose

Use this skill to emulate the observed workflow for ESP32/ESP-IDF troubleshooting and Arduino test-code iteration on this Windows machine.

This skill is intentionally updateable. Treat the current content as evidence-weighted habits, not immutable personality claims. When a new recorder JSON is supplied, update the evidence ledger and revise only the habits supported by newer or stronger evidence.

## Activation

Apply this skill when the task involves any of these signals:

- ESP32, ESP32-S3, ESP-IDF, Arduino IDE, PlatformIO-like embedded workflows, `idf.py`, `export.bat`, `C:\esp\esp-idf-v5.4`, or `D:\esp32\my_esp32s3_project`.
- Roo-Cline, VS Code ESP-IDF extension, OpenCode, Codex, Claude desktop, or multi-agent CLI/GUI workflows.
- Windows toolchain repair: Git submodules, ESP-IDF tools, `IDF_TOOLS_PATH`, Python envs under `D:\download\Espressif`, COM ports, Arduino package folders, or manual ZIP repair.
- User asks to inspect a recorder JSON and infer habits, toolchain preferences, or build a skill.

## Operating Style

- Prefer direct diagnosis over generic explanation.
- Separate project-code issues from environment/toolchain issues early.
- When build output says tooling or submodules are broken, state that the project code may be fine and name the exact broken external component.
- Keep the user moving with concrete next actions: download this URL, put it here, run this command, retry build.
- When paths are involved, quote exact Windows paths and avoid vague location advice.
- The user is comfortable moving between GUI and CLI. It is acceptable to coordinate browser downloads, Explorer file moves, VS Code, Arduino IDE, and terminal commands in one workflow.
- The user expects status checking. If they ask whether something is done, inspect processes, command output, file timestamps, or build artifacts rather than guessing.

## Toolchain Defaults

Observed environment defaults:

- Primary ESP-IDF workspace: `D:\esp32\my_esp32s3_project`
- ESP-IDF path: `C:\esp\esp-idf-v5.4`
- ESP-IDF tools path: `D:\download\Espressif`
- ESP-IDF Python: `D:\download\Espressif\python_env\idf5.4_py3.14_env\Scripts\python.exe`
- Git path: `D:\Git\cmd\git.exe`
- VS Code executable: `D:\download\Microsoft VS Code\Code.exe`
- Arduino IDE executable: `D:\新建文件夹\Arduino IDE\Arduino IDE.exe`
- Arduino user package area: `%LOCALAPPDATA%\Arduino15\staging\packages`
- Common AI tools observed: Roo-Cline inside VS Code, OpenCode, Codex, Claude desktop.
- Browser used for manual downloads/API pages: Microsoft Edge.

Do not assume these paths are still valid without checking if the task requires executing commands.

## ESP-IDF Troubleshooting Pattern

Use this sequence when ESP-IDF build or toolchain errors appear:

1. Identify the failing layer.
2. If the error mentions missing compilers, GDB, CMake, Ninja, or `idf_tools.py`, treat it as ESP-IDF tools installation.
3. If the error mentions `components/...`, `.git/modules`, `git submodule`, `fatal: not a git repository`, `early EOF`, or `clone failed`, treat it as ESP-IDF repository/submodule corruption or network failure.
4. If `idf.py fullclean` refuses because `build` is not a CMake build directory, remove `build` manually before retrying.
5. Retry with explicit environment setup before build:

```cmd
set "IDF_TOOLS_PATH=D:\download\Espressif" && call C:\esp\esp-idf-v5.4\export.bat && idf.py build
```

6. If `fullclean` is needed but refuses, use:

```cmd
if exist build rd /s /q build & set "IDF_TOOLS_PATH=D:\download\Espressif" && call C:\esp\esp-idf-v5.4\export.bat && idf.py build
```

7. If `components/esp_wifi/lib` is missing or corrupt and Git clone fails due to network, offer manual browser download of `https://github.com/espressif/esp32-wifi-lib/archive/refs/heads/master.zip`.
8. If the user downloads `esp32-wifi-lib-master.zip`, restore it into `C:\esp\esp-idf-v5.4\components\esp_wifi\lib` with explicit path handling.

Observed restore command:

```powershell
$zip='D:\download\esp32-wifi-lib-master.zip'
$dst='C:\esp\esp-idf-v5.4\components\esp_wifi\lib'
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath 'C:\esp\esp-idf-v5.4\components\esp_wifi' -Force
if (Test-Path 'C:\esp\esp-idf-v5.4\components\esp_wifi\esp32-wifi-lib-master') {
  Rename-Item 'C:\esp\esp-idf-v5.4\components\esp_wifi\esp32-wifi-lib-master' 'lib' -Force
}
if (Test-Path $dst) {
  Write-Output '[RESTORED]'
  Get-ChildItem $dst | Select-Object -First 10 Name,Mode
} else {
  Write-Output '[RESTORE_FAILED]'
}
```

If Git still tries to initialize `components/esp_wifi/lib` as a submodule and fails because the destination already exists, check for and remove the worktree `.git` file inside that restored folder before retrying:

```powershell
$git='C:\esp\esp-idf-v5.4\components\esp_wifi\lib\.git'
if (Test-Path $git) { Remove-Item $git -Force }
Write-Output '[REMOVED_WORKTREE_GIT_FILE]'
```

## Arduino Test-Code Pattern

For quick hardware validation, the user accepts compact `.ino` sketches with direct constants and no unnecessary abstraction.

Observed fan PWM sketch style:

- Global constants at top.
- Small helper `setFanSpeedPercent` using `constrain`, `map`, and `ledcWriteChannel`.
- Startup helper that drives the fan at 100% briefly before dropping to target speed.
- `setup` initializes PWM and sets initial speed.
- `loop` contains simple sweep tests.
- Comments can be Chinese and practical, especially hardware caveats like 2-wire fan startup.

Observed code:

```cpp
const int FAN_PWM_PIN = 4;

const int PWM_CHANNEL = 0;
const int PWM_FREQ = 20000;      // 20kHz
const int PWM_RESOLUTION = 8;    // 0~255

void setFanSpeedPercent(int percent) {
  percent = constrain(percent, 0, 100);

  int duty = map(percent, 0, 100, 0, 255);
  ledcWriteChannel(PWM_CHANNEL, duty);
}

void startFanThenSet(int percent) {
  // 2线风扇低速可能起不来，先满速冲一下
  setFanSpeedPercent(100);
  delay(800);

  setFanSpeedPercent(percent);
}

void setup() {
  ledcAttachChannel(FAN_PWM_PIN, PWM_FREQ, PWM_RESOLUTION, PWM_CHANNEL);

  setFanSpeedPercent(0);
  delay(500);

  startFanThenSet(40);  // 启动后降到40%
}

void loop() {
  // 示例：慢慢加速
  for (int speed = 30; speed <= 100; speed += 5) {
    setFanSpeedPercent(speed);
    delay(10000);
  }

  // 示例：慢慢减速
  for (int speed = 100; speed >= 30; speed -= 5) {
    setFanSpeedPercent(speed);
    delay(10000);
  }
}
```

## GUI/CLI Coordination Habits

- User may use Explorer to inspect or copy files under `Arduino15\staging\packages` and downloaded ZIPs.
- User may use browser manually when GitHub clone fails; provide direct archive URLs and exact destination folders.
- User may switch among OpenCode, Codex, Claude, Roo-Cline, VS Code, Edge, Arduino IDE, and admin PowerShell. Do not assume one tool owns the whole workflow.
- When an admin terminal appears, expect privileged install/repair actions.
- When Arduino IDE is opened after ESP-IDF work, expect quick hardware test sketches or upload/compile checks outside the ESP-IDF project.

## Recorder JSON Update Protocol

When the user provides a new recorder JSON, update this skill by following this protocol:

1. Read the new main JSON header: `recorder_version`, `session_intent`, `session_outcome`, capture settings, and `sidecar_exports`.
2. If a `*.roo-cline-full.json` sidecar exists, read it and prefer its full messages over truncated `content_preview` fields.
3. Verify integrity when available: check `matches_event_count`, `message_count`, and `sha256` metadata. If not available, mark evidence confidence lower.
4. Extract new evidence into these categories: toolchain defaults, CLI commands, GUI transitions, code style, debugging decisions, communication patterns, and failures/outcomes.
5. Compare against current rules:
   - If new evidence reinforces an existing habit, increment confidence in the evidence ledger.
   - If new evidence contradicts an existing habit, do not delete the old habit immediately. Add a note under `Contradictions / Drift` and prefer the newer habit only after repeated evidence or a clear user instruction.
   - If new evidence is task-specific rather than habitual, add it to `Session-Specific Evidence` but do not promote it into a stable rule.
6. Update `Version` using a minor increment for new evidence (`0.1.0` to `0.2.0`) and patch increment for wording/formatting only.
7. Append the new JSON and sidecar to `Evidence Ledger` with date, recorder version, message count, and what changed.
8. Keep this document concise. Remove stale session-specific details only when they are superseded by stronger evidence.

## Update Rules

When updating this skill from future recorder JSON files, use the following precedence rules:

- Prefer `session_goal`, `session_success_criteria`, `session_result`, `session_blockers`, and `session_next_step` over older `session_intent` and `session_outcome` fields.
- Prefer `command_executions` when populated. If empty, fall back to Roo-Cline sidecar `execute_command` entries.
- Prefer `file_diff` over plain `content_capture` when both exist.
- Treat `derived_events.user_feedback_signal` as weak evidence unless the underlying text is clearly a direct user utterance rather than a tool result blob.
- Treat low-confidence `gui_file_action` entries as hints, not stable habits.
- Promote a behavior into a stable habit only if it appears in at least two sessions or is strongly supported by one session with complete sidecar evidence.

## Evidence Ledger

### 2026-05-03, `5.json`, recorder `0.7.0`

- Sidecar: `5.roo-cline-full.json`, 6 full Roo-Cline messages, sha256 recorded, event count matched.
- New structured fields added by recorder: `session_goal`, `session_success_criteria`, `session_result`, `session_blockers`, `session_next_step`, `priority_file_watch`, `file_diff`, `derived_events`.
- Strong new evidence: the user/AI workflow can adapt ESP-IDF tool installation to a workspace-local writable directory such as `d:\esp32\my_esp32s3_project\.espressif_local` when the default user-level `.espressif` path is not writable.
- Observed command pattern: create local tool directories, set `IDF_TOOLS_PATH`, run `idf_tools.py install`, then verify with `idf_tools.py export`.
- Strong new diagnosis pattern: distinguish permission failures from network failures in the same toolchain-install sequence.
- Strong new communication pattern: the workflow tracks progress with a todo list and ends with a structured summary of root cause, what was fixed, what remains blocked, and exact next commands.
- Weak evidence only: `user_feedback_signal` currently overmatches and should not yet be used as a strong personal-preference signal.
- Weak evidence only: `session_goal` / `session_result` values are present but semantically poor (`12`, `211`, `2`), so they validate schema direction but not content quality.
- Confidence: high for recorder schema improvement; medium-high for workflow extraction; low for direct preference extraction from feedback signals.

### 2026-05-02, `4.json`, recorder `0.6.3`

- Sidecar: `4.roo-cline-full.json`, 16 full Roo-Cline messages, sha256 recorded, event count matched.
- Task: repair ESP-IDF v5.4 missing/corrupt `components/esp_wifi/lib`, work around GitHub clone failures, coordinate browser ZIP download, restore submodule manually, retry `idf.py build`.
- Observed commands: `idf.py build`, `idf.py fullclean build`, `export.bat`, manual `rd /s /q build`, PowerShell `Expand-Archive`, removal of `lib\.git`.
- Observed GUI flow: Explorer through `Arduino15\staging\packages`, Edge for downloads/API pages, admin PowerShell, VS Code ESP-IDF extension, OpenCode, Codex, Claude desktop, Arduino IDE.
- Observed code artifact: `D:\codex\my_toolkit\hello_p4\测试器件文件夹\sgp30_test\sgp30_test.ino`, 44-line fan PWM sketch.
- Confidence: high for ESP-IDF troubleshooting workflow; medium for broader personal habits because `session_intent` and `session_outcome` were nonspecific.

### 2026-05-02, `3.json`, recorder `0.6.1`

- Sidecar existed and full Roo-Cline export was present.
- Reinforced ESP-IDF toolchain repair and process/status checking habits.
- Confidence: medium-high.

### 2026-05-02, earlier v0.6.0 and v0.5.0 sessions

- Useful for tool/window timeline, but weaker content capture.
- Do not use older sessions to override habits extracted from v0.6.3 unless a future session confirms the older pattern.

## Contradictions / Drift

- `session_intent` fields are currently unreliable (`·12`, `为其`, short fragments). Prefer full Roo-Cline sidecar messages and captured file contents over these fields until future recordings include meaningful task descriptions.
- `session_goal` / `session_success_criteria` / `session_result` now exist in `5.json`, but their current values are still too terse to be trusted as semantic task summaries. Keep the fields, but require better input quality before treating them as authoritative.
- Some captured VS Code user settings contain command allowlists and personal paths. Use them as environment evidence, not as stable preferences unless repeated in later sessions.
- Current `user_feedback_signal` derivation is noisy because large tool-result texts may accidentally match short acceptance phrases. Future updates should downweight or filter these events unless they are tied to a clear user utterance.
