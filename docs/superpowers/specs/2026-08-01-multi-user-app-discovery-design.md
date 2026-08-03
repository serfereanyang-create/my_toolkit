# 多用户应用发现与桌面布局保护设计

**日期：** 2026-08-01  
**状态：** 待实现

## 背景

当前应用只通过普通应用进程的 `PackageManager` 查询用户 0，并把 `packageName` 作为唯一标识。OnePlus 的应用分身安装在 Android 用户 999（`MultiApp`）中，因此微信主实例和微信分身无法同时被发现或独立管理。

当前冻结实现使用 `pm disable-user --user 0`。该命令会让桌面把应用视为不可用，部分桌面会重建图标，导致解冻后文件夹归属和图标位置无法可靠恢复。

## 目标

- 发现主用户、分身用户和其他已启用 Android 用户空间中的应用。
- 将相同包名在不同用户空间中的实例作为独立对象管理。
- 通过用户 ID 对正确的实例执行冻结、解冻和状态查询。
- 使用 `pm suspend/unsuspend` 优先保留桌面文件夹和图标位置。
- 保留现有白名单与定时设置，并兼容旧版本数据库记录。
- 继续通过 Shizuku UserService 执行特权操作。

## 非目标

- 直接读取或修改 OnePlus/系统桌面数据库。
- 保证已经被 `disable-user` 清理的历史桌面布局自动恢复。
- Root、Device Owner 或无障碍服务替代方案。
- 修改不同用户空间之间的应用数据、账号或权限。
- 依赖 OnePlus 私有 API；用户名称只作为展示信息，用户 ID 是实际操作依据。

## 核心模型

### 受管应用标识

受管应用的稳定标识为：

```text
(packageName, userId)
```

例如：

```text
(com.tencent.mm, 0)    微信 · 主用户
(com.tencent.mm, 999)  微信 · MultiApp
```

`packageName` 用于定位 APK，`userId` 用于定位安装该 APK 的 Android 用户空间。两者不可单独作为白名单主键。

### 展示模型

`InstalledAppInfo` 增加：

- `userId: Int`
- `userName: String`
- `isSystemApp: Boolean`
- `packageName`, `label`, `icon`

列表项显示应用名称、包名和用户空间名称；相同应用的不同用户实例必须能够被用户明确区分。

## 应用发现

### 查询位置

普通应用进程不能可靠读取所有 Android 用户的包列表，因此发现逻辑移到 Shizuku UserService：

1. 通过 `cmd user list` 获取用户 ID 和用户名称。
2. 过滤不可操作的用户状态；至少保留运行中的主用户和已安装应用的已启用用户空间。
3. 对每个用户执行 `pm list packages --user <userId>`，得到该用户实际安装的包。
4. 对每个包通过 `pm path --user <userId>` 或等价的包信息查询确认其在该用户可用。
5. 返回包名、用户 ID、用户名称、标签和必要的应用元数据。

为了保持图标和标签一致，Repository 可以在本地通过 `PackageManager` 加载已知包的图标和标签；若当前进程无法解析其他用户的资源，则使用 UserService 返回的标签，并允许图标为空。

### UserService 接口

AIDL 接口增加面向多用户的查询与操作方法：

```text
List<UserInfo> getUsers()
List<UserAppInfo> getInstalledApps(int userId)
String freeze(String packageName, int userId)
String unfreeze(String packageName, int userId)
String getState(String packageName, int userId)
```

返回值使用可序列化的 AIDL 数据类。所有包名和用户 ID 都由服务端校验，不接受任意 shell 文本。

## 冻结策略

### 新默认策略

冻结：

```bash
pm suspend --user <userId> <packageName>
```

解冻：

```bash
pm unsuspend --user <userId> <packageName>
pm enable --user <userId> <packageName>
```

`unsuspend` 解除新策略的暂停状态，`enable` 兼容旧版本用 `disable-user` 产生的禁用状态。服务端逐条执行并在任意关键命令失败时返回错误，不更新本地数据库状态。

### 状态查询

`getState(packageName, userId)` 同时检查：

- 包是否对该用户安装；
- 包的 enabled/disabled 状态；
- 包是否处于 suspended 状态。

只要 suspended 或 disabled，即返回 `disabled`；否则返回 `enabled`。查询失败返回带有明确原因的 `ERROR:`。

### 安全校验

UserService 使用 `ProcessBuilder` 的参数数组执行固定命令，不通过 `sh -c` 拼接包名。服务端必须：

- 校验包名符合 Android 包名格式；
- 校验 `userId` 为已知用户；
- 校验包名对该用户确实存在；
- 仅暴露查询、冻结和解冻操作；
- 保留系统关键包保护和清晰错误返回。

## 数据库迁移

`FrozenAppEntity` 从单列主键升级为复合主键：

```text
primary key (packageName, userId)
```

Room 数据库版本从 1 升为 2，使用显式 Migration：

1. 创建 `frozen_apps_new`，包含 `packageName`、`userId`、标签、冻结状态和日程字段。
2. 从旧表复制记录，旧记录的 `userId` 设置为 `0`。
3. 删除旧表并将新表重命名为 `frozen_apps`。
4. 建立 `(packageName, userId)` 主键及查询需要的索引。
5. 数据库构建器注册 `MIGRATION_1_2`，禁止 destructive migration。

已有主用户白名单和日程配置不丢失。新加入的分身或其他用户实例拥有独立配置。

## Repository 与 ViewModel

Repository 的操作方法统一接收 `packageName` 和 `userId`，包括：

- `getInstalledUserApps()` 返回所有用户实例；
- `addToWhitelist()` 保存用户 ID；
- `getApp()`、`setFrozen()`、冻结和解冻操作按复合键定位；
- 全部冻结/解冻遍历每一条独立实例。

Home、Picker 和 Schedule ViewModel 不再仅传递包名。导航路由携带 `packageName` 与 `userId`，对包名进行 URL 编码或通过稳定的导航参数传递。

## 定时调度

定时任务输入数据增加 `userId`：

```text
packageName=<package>
userId=<id>
```

WorkManager 的唯一任务名、tag 和取消逻辑同时包含包名与用户 ID，避免主用户微信和分身互相取消或覆盖任务。Worker 从两个参数读取目标，并调用对应用户的 Repository 方法。

## 界面行为

### Picker

- 默认显示所有用户空间中的非系统应用。
- 同一包名在不同用户空间显示为不同条目。
- 搜索同时匹配标签、包名和用户空间名称。
- 白名单判定按 `(packageName, userId)`，不是只按包名。

### Home

- 同一应用的不同用户实例分别显示。
- 每行显示用户空间名称或用户 ID，避免两个“微信”条目混淆。
- 开关只改变当前条目的对应用户实例。
- “全部冻结/解冻”遍历所有白名单实例。

### Schedule

- 日程设置绑定到当前 `(packageName, userId)`。
- 页面标题或副标题显示用户空间名称。

## 错误处理与兼容性

- Shizuku 未运行或未授权：继续阻止特权操作并显示引导。
- 某个用户空间不可访问：跳过该用户并保留其他用户结果；若全部查询失败，显示可诊断错误。
- `pm suspend` 在某个 ROM 或受保护包上失败：返回失败原因，不把数据库标记为已冻结。
- 发现同一包的多个用户实例时，不去重，只按复合标识保留。
- 解冻旧记录时同时尝试 `unsuspend` 与 `enable`，保证从旧 `disable-user` 状态恢复。
- 若 Android 版本或 OEM 不支持暂停命令，明确提示当前 ROM 不支持布局保护，而不是静默回退到会破坏桌面布局的 `disable-user`。

## 测试与验收

### 单元/数据库测试

- Room v1 到 v2 迁移后旧记录的 `userId` 为 0，日程字段保持不变。
- `(com.tencent.mm, 0)` 与 `(com.tencent.mm, 999)` 可以同时存在。
- DAO 的查询、更新、删除和冻结状态更新不会串用户。
- 调度名称和输入参数对不同用户实例互不冲突。

### Shizuku 服务测试

- 正确用户的冻结、解冻和状态查询命令包含对应 `--user`。
- 非法包名、未知用户和未安装包被拒绝。
- 命令失败时返回错误且不改变数据库状态。

### 真机验收

在 OnePlus PJE110 Android 16 上验证：

1. 选择器同时显示 `com.tencent.mm` 的用户 0 和用户 999 实例。
2. 分别冻结主微信和微信分身，确认互不影响。
3. 分别解冻，确认应用可启动。
4. 观察使用 `suspend/unsuspend` 前后桌面文件夹和图标位置是否保留。
5. 验证用户 10 中的应用可发现、加入白名单并独立操作。
6. 验证两套实例的定时冻结和解冻任务互不覆盖。

## 风险与限制

Android 没有公开、跨 OEM 的桌面布局恢复 API。暂停模式用于避免继续触发“像卸载一样”的桌面重建，但桌面行为仍由 Launcher 实现决定；已经因旧策略丢失的文件夹和坐标不能由本应用可靠恢复。
