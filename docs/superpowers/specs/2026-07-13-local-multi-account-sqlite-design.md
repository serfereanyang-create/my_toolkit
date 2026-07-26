# 本机多账户 SQLite 账户体系设计

日期：2026-07-13  
状态：已实现（P0/P1）  
范围：科研论文辅助工作台（Electron 桌面端）

## 背景

当前账户资料与论文库均落在渲染进程 `localStorage`：

- 无真实用户身份
- 无密码与会话
- 无多用户隔离
- Electron 仅有导入/导出 IPC，无数据库层

目标是建立**本机多账户**的真实账户数据库管理，不引入联网后端。

## 目标与非目标

### 目标（第一期）

1. 本机注册 / 登录 / 退出 / 修改资料
2. 用户名或邮箱 + 密码登录
3. 密码哈希入库，不明文存储
4. 会话可在应用重启后恢复（未过期）
5. 论文库按 `user_id` 隔离
6. 账户间迁移：复用现有导出/导入资料库（导入归属当前登录用户）
7. 旧 `localStorage` 论文仅在用户确认后导入当前账户

### 非目标（第一期不做）

- 云同步、远程 API、OAuth
- 邮箱验证码 / 找回密码邮件
- 管理员后台与角色权限体系
- 一键“转让给另一账户”的后台迁移
- 自动静默合并或删除旧 localStorage 数据

## 架构

```text
React UI (账户面板：登录/注册/资料/退出)
  └─ window.desktopApi (preload bridge)
       └─ Electron main process
            ├─ auth service
            │    register / login / logout / getSession / updateProfile / changePassword
            ├─ library service
            │    list/save papers scoped by user_id
            └─ SQLite (better-sqlite3)
                 file: {userData}/paper-assistant.sqlite
```

### 模块边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| `electron/db.cjs` | 打开库、迁移 schema、提供 prepared statements | better-sqlite3, app paths |
| `electron/auth.cjs` | 注册登录、密码哈希、会话 | db, crypto |
| `electron/library-store.cjs` | 按用户读写论文 | db, session user |
| `electron/preload.cjs` | 暴露安全 IPC API | ipcRenderer |
| `src` 账户 UI | 登录注册资料面板状态机 | desktopApi |

渲染进程不直接访问数据库文件，不接触 password hash / salt。

## 数据模型

### `users`

| 列 | 类型 | 约束 |
|----|------|------|
| id | TEXT | PK (uuid) |
| username | TEXT | UNIQUE NOT NULL |
| email | TEXT | UNIQUE NULL（空则存 NULL，不存空串） |
| password_hash | TEXT | NOT NULL |
| password_salt | TEXT | NOT NULL |
| display_name | TEXT | NOT NULL DEFAULT '' |
| institution | TEXT | NOT NULL DEFAULT '' |
| research_field | TEXT | NOT NULL DEFAULT '' |
| notes | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | ISO-8601 |
| updated_at | TEXT | ISO-8601 |

索引：`username` unique，`email` unique（允许多个 NULL）。

### `sessions`

| 列 | 类型 | 约束 |
|----|------|------|
| id | TEXT | PK |
| user_id | TEXT | FK users.id |
| token_hash | TEXT | UNIQUE NOT NULL |
| created_at | TEXT | |
| expires_at | TEXT | |

### `papers`

在现有论文 JSON 字段基础上关系化或整包 JSON 存储二选一。

**第一期推荐：行内存 JSON 文档 + 关系元数据**，迁移快、与现有 `Paper` 结构兼容：

| 列 | 类型 | 约束 |
|----|------|------|
| id | TEXT | PK（论文 id） |
| user_id | TEXT | FK users.id NOT NULL |
| payload | TEXT | NOT NULL（JSON string of Paper） |
| updated_at | TEXT | |
| title | TEXT | 冗余，便于搜索 |
| year | TEXT | 冗余可选 |
| status | TEXT | 冗余可选 |

唯一约束：`(user_id, id)` 或全局 id 在用户内唯一。第一期论文 id 仍用现有 `makeId`，并保证用户内唯一。

### 本地会话文件（可选增强）

除 `sessions` 表外，主进程可在 `userData/session.json` 保存当前 token 明文副本（仅本机），方便启动恢复。表中只存 token_hash。

若只使用内存 + sessions 表，则 token 明文仅保存在受保护的 userData 小文件中，二选一即可；**采用 userData `session.json` + DB token_hash**。

## 安全设计

1. 密码哈希：Node `crypto.scrypt`（或等价），随机 salt
2. 登录失败文案统一：「用户名/邮箱或密码错误」
3. 不向渲染进程返回 `password_hash` / `password_salt` / 原始 token 哈希材料
4. IPC 仅暴露必要字段的用户 DTO
5. 所有写操作要求有效会话（注册/登录除外）
6. 退出：删除 session 行 + 删除 session.json

## 业务流程

### 注册

输入：username, email?, password, confirmPassword  
校验：

- username 3–32，字母数字下划线或中文用户名策略需固定为：trim 后长度 3–32，不允许空白
- password ≥ 8
- confirm 一致
- email 若填写则格式合法且唯一
- username 唯一

成功：插入 user → 创建 session → 返回 user DTO + 空论文库（默认不自动塞示例，避免污染真实账户；示例可通过“恢复示例”仅作用于当前用户）

### 登录

输入：account（username 或 email）, password  
成功：session + 加载该用户 papers  
失败：通用错误，保留 account 输入，密码可清空或保留（建议清空密码）

### 会话恢复

应用启动：

1. 读 `session.json`
2. 校验 token 对应 session 未过期
3. 有效则 `getSession` 返回 user，并 load papers
4. 无效则视为未登录

默认会话时长：30 天（可配置常量）

### 修改资料

已登录可改：display_name, institution, research_field, notes, email  
改 email 需唯一校验  

### 修改密码

输入：oldPassword, newPassword, confirm  
旧密码错误则拒绝；成功后可选择使其他 session 失效（第一期仅单会话足够：轮换当前 session）

### 退出

删除会话；UI 进入未登录；不展示任何用户论文

## 失败处理

| 情况 | 行为 |
|------|------|
| 表单校验失败 | 字段/表单提示，可改后重试 |
| 用户名或邮箱冲突 | 明确冲突，不覆盖 |
| 密码错误 | 通用错误，可重试 |
| 数据库写失败/损坏 | 明确错误，保留输入，可重试；不静默 |
| 会话过期 | 清本地 session，要求重新登录 |
| 导入库格式错误 | 保持现有导入错误提示，数据不写入 |

## 旧数据迁移

1. 检测 `localStorage['science-paper-assistant:v1']` 是否有论文
2. 用户首次成功注册或登录后，若该用户 papers 为空且旧库非空，弹一次对话框：
   - 导入到当前账户
   - 暂不导入
3. 导入为复制写入当前 `user_id`，**不自动删除** localStorage
4. 旧 `science-paper-assistant:account` 资料仅用于预填显示字段，不产生密码账户

## 账户间迁移（混合模式第一期）

- 用户 A 登录 → 导出资料库 JSON
- 用户 B 登录 → 导入资料库 JSON
- 导入记录全部归属 B
- 去重规则沿用现有导入逻辑（若导入路径复用 reference/library 逻辑则保持一致）

## UI 变化

账户图标面板状态：

1. **未登录**：Tab 或分段「登录 | 注册」
2. **已登录**：头像首字母、资料表单、保存、修改密码入口、退出登录
3. 与显示设置（齿轮）分离；同时只开一个气泡

主工作区：

- 未登录也可先限制为：必须登录后才能使用论文库（推荐，避免无主数据）  
  **第一期采用：未登录可看空壳，但读写论文需登录**（点击新建/导入时引导登录）

## IPC API（草案）

```ts
desktopApi.auth = {
  register(input): Promise<{ user } | { error }>
  login(input): Promise<{ user } | { error }>
  logout(): Promise<void>
  getSession(): Promise<{ user } | null>
  updateProfile(patch): Promise<{ user } | { error }>
  changePassword(input): Promise<{ ok: true } | { error }>
}

desktopApi.library = {
  load(): Promise<Paper[]>          // current user
  save(papers: Paper[]): Promise<void>
}
```

现有 import/export 对话框 IPC 保留；save 时写入当前用户库。

## 打包与依赖

- 依赖：`better-sqlite3`
- Electron 打包需重建 native 模块（electron-builder / @electron/rebuild）
- 若 native 构建在本机失败，实现阶段需记录 fallback 评估，但设计默认坚持 SQLite

## 测试计划

1. 单元：密码哈希校验、用户名邮箱查重、session 过期
2. 集成：注册→重启仍登录→退出→无法读原用户论文
3. 双用户：A 建文、B 登录不可见 A
4. 迁移：确认弹窗导入后仅当前用户可见
5. 失败：错误密码、重复用户名、重复邮箱

## 验收标准

1. 可注册、登录、退出
2. 重启后未过期会话可恢复
3. A/B 论文库互不可见
4. 密码不明文出现在 DB 与日志
5. 失败可重试且有明确提示
6. 旧论文仅在确认后导入
7. 导出/导入可完成账户间迁移

## 实现分期

### P0
- schema + auth IPC + 账户 UI 登录注册退出
- papers 按用户存 SQLite
- 会话恢复

### P1
- 资料修改、改密
- localStorage 迁移弹窗
- 去掉渲染进程作为论文权威存储（改 DB）

### P2（可选）
- 更细论文关系表
- 多设备预留字段
- 会话多端管理
