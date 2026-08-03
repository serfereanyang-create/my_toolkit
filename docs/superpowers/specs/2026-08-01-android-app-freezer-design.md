# Android 应用冻结 App 设计

**日期：** 2026-08-01  
**状态：** 已实现（源码位于 `android-freezer/`）

## 背景

用户需要一个 Android 应用，将选定应用加入白名单后可冻结/解冻，并支持设置每日自动冻结时间与解冻条件。优先「最简单」的授权路径：开发者选项 + 无线调试，无需 Root。

## 目标

- 真正冻结：图标消失、不可启动、无后台（`pm disable-user`）
- 白名单管理 + 列表开关
- 每应用独立：冻结时间、定时解冻或仅手动解冻
- 全局一键全部冻结 / 全部解冻

## 非目标

- Root 方案
- 设备所有者（Device Owner）方案
- Play 商店上架合规（`QUERY_ALL_PACKAGES` 仅自用/侧载）
- 复杂分组、桌面小组件、通知栏 Tile（可后续扩展）

## 技术方案

### 冻结方式：Shizuku

| 方案 | 授权成本 | 冻结强度 | 结论 |
|------|----------|----------|------|
| 仅 force-stop | 无 | 弱，易自启 | 否 |
| Shizuku | 开发者选项 + 无线调试一次 | 强（pm disable-user） | **采用** |
| Device Owner | ADB 设设备所有者 | 强 | 设置更重 |
| Root | Root | 最强 | 门槛高 |

### 技术栈

- Kotlin + Jetpack Compose
- minSdk 30（Android 11，无线调试）
- Room 持久化白名单与日程
- WorkManager 一次性延迟任务，触发后重排下一天
- Shizuku UserService + AIDL 执行 `pm` 命令

### 核心命令

```
pm disable-user --user 0 <package>   # 冻结
pm enable --user 0 <package>         # 解冻
```

## 架构

```
UI (Compose)
  Home / Picker / Schedule / SetupGuide
        ↓
ViewModels
        ↓
AppRepository  ←→  Room (FrozenAppEntity)
        ↓
ShizukuHelper → IFreezeService (UserService) → pm 命令
        ↓
ScheduleScheduler → FreezeWorker / UnfreezeWorker
BootReceiver → 开机重排任务
```

## 数据模型

`FrozenAppEntity`：

- `packageName`（主键）、`label`
- `isFrozen`
- `freezeHour` / `freezeMinute`（-1 = 不自动冻结）
- `unfreezeHour` / `unfreezeMinute`
- `manualOnly`（true = 仅手动解冻）

## 界面

1. **Home**：白名单列表、冻结开关、定时摘要、全部冻结/解冻、Shizuku 状态横幅
2. **Picker**：已安装应用多选加入白名单（默认隐藏系统应用，可搜索）
3. **Schedule**：每日冻结时间 + 解冻条件（手动 / 定时）
4. **SetupGuide**：Shizuku 安装与授权步骤

## 边界情况

- Shizuku 未安装 / 未运行 / 未授权：横幅引导，禁止有效冻结
- 系统应用：Picker 默认隐藏；仍可选但用户自担风险
- 设备重启：`BOOT_COMPLETED` 后重排 WorkManager 任务；需 Shizuku 再次可用
- 从白名单移除已冻结应用：先解冻再删除

## 成功标准

- [x] 可在 Android Studio 打开 `android-freezer/` 同步 Gradle
- [x] 授权 Shizuku 后可对白名单应用执行冻结/解冻
- [x] 可配置每日冻结与解冻条件并持久化
- [x] 开机后可恢复调度（代码已实现；真机依赖 Shizuku 状态）

## 源码位置

`android-freezer/`（见该目录 `README.md`）
