# 后台真实应用截图

YOYcode 可以在独立进程中隐藏运行工作区内的 CommonJS 与 ESM Electron 项目，保留真实主进程、预加载脚本、渲染界面和 IPC。截图来自离屏渲染帧，返回 PNG 文件和模型可见的图片内容。

## 使用入口

设置 → 电脑操控 → 后台应用工作台。项目目录填写工作区相对路径，工作区根目录填写 `.`。先构建目标项目，保证 `package.json` 的 `main` 指向存在的 `.cjs`、`.mjs` 或 `.js` 文件，然后依次后台运行、检查界面、截图。`.js` 入口遵循最近一级 `package.json` 的 `type`，支持构建目录拥有独立模块格式。多窗口应用可以选择窗口。

工作台支持直接点击截图中的控件，也可以按选择器定位。点击截图后可发送文字或快捷键，画面自动更新；使用“刷新窗口”获取当前窗口列表，切换窗口时会清除旧图。离开这个设置页面会关闭手动启动的后台应用；智能体会话的后台应用单独归属该会话，关闭会话或切换工作区时回收。

## 智能体工具

桌面桥接会在工具作用域筛选后提供以下工具，并在所有动态工具注入后重新执行专家权限筛选。只读专家无法通过动态注入获得启动应用、点击、填写或继续派生智能体的权限。

| 工具 | 参数和用途 |
| --- | --- |
| `background_app_open` | `path`，可选 `width` / `height`；返回 `appId`、窗口列表和 `windowId` |
| `background_app_windows` | `appId`；直接列出当前窗口 ID、标题、加载状态与隐藏状态，不依赖旧窗口仍然存在 |
| `background_app_inspect` | `appId`，可选 `windowId`；返回真实 DOM 文字、元素选择器、窗口状态和渲染错误 |
| `background_app_click` | `appId`，`selector` 或 `x` / `y` 二选一；坐标使用完整截图中的像素，支持可选 `button` / `double` / `windowId` |
| `background_app_fill` | `appId`、`selector`、`value`，可选 `windowId` |
| `background_app_type` | `appId`、`text`，可选 `selector` / `windowId`；在焦点编辑框输入 Unicode 文字 |
| `background_app_key` | `appId`、`key`，可选 `selector` / `windowId`；发送渲染器内的真实按键，支持 `Control+A`、`Tab`、`Enter` 等 |
| `background_app_screenshot` | `appId`，可选 `windowId`；返回真实 PNG 和 `computerImage` |
| `background_app_close` | `appId`；结束当前会话所属的后台应用 |

推荐流程：打开 → 检查 → 截图 → 单次交互 → 再次检查和截图 → 关闭。启动属于执行代码操作，遵循 shell 审批；交互遵循写入审批。拒绝审批时不会启动子进程。单会话最多同时运行两个后台应用，启动和单次操作有超时，不会自动循环重试。

启动页关闭或窗口新增后，先调用 `background_app_windows` 刷新并选择窗口。已经关闭的窗口 ID 会立即失败，不会等到操作超时，也不会把操作转到另一个窗口。存在多个窗口时，点击、填写、输入和按键必须明确指定 `windowId`。操作中窗口关闭会结束旧渲染器上的等待，其他窗口继续运行。

坐标点击和按键通过目标渲染器的输入通道完成，Canvas 可收到真实指针事件，编辑框支持全选、Tab 焦点移动和 Enter 默认提交；文字输入不借助系统剪贴板。完整截图坐标会转换成当前渲染器坐标，已验证 150% 页面缩放。被遮挡的选择器、越界坐标、没有编辑焦点时的输入会返回明确错误。直接操作截图时，界面会处理预览缩放和留白。

工具参数现在优先使用明确的 JSON Schema；后台应用、浏览器 URL / 文件二选一参数和 MCP 原始结构参数都会保留类型与必填关系。旧提示推断也不会再从相邻数字误判字符串字段。OpenAI Chat、Responses、Anthropic 和 Gemini 请求均有协议回归；Gemini 的用户图片和工具截图按图片数据发出，不再丢失多模态部分。本轮验证检查本地请求体，没有调用付费模型做在线视觉验收。

## 数据与支持范围

独立应用数据位于工作区 `.aicode/background-apps/<appId>/`，截图位于 `.aicode/screenshots/`。工具历史保存图片类型和路径，完整图片通过消息图片部分送入模型，避免在工具记录中重复存储 Base64。现有历史不迁移、不重写。

窗口强制隐藏和离屏渲染，阻止显示、聚焦、最大化显示、开发者工具及网页弹出新窗口。截图使用新渲染帧，PNG 像素尺寸和逻辑视口分别返回。支持不同 Windows 缩放设置，后台渲染使用固定比例。

ESM 通过独立进程里的模块加载钩子接入同一套隐藏窗口；默认导入、具名导入、动态导入及 Electron 子路径别名都使用该实现。目标模块的异步初始化在 `app.ready` 前完成，主进程的协议注册等初始化可以保持原有时序。

Windows 启动应用代码前先建立独立 Job Object。守护进程验证目标 PID、唯一数据目录标记与进程创建时间后才建立归属关系；应用派生的进程自动进入同一 Job。关闭应用、启动或操作超时、应用崩溃、宿主进程异常退出时都会关闭 Job 并回收所属进程树。该机制不按程序名称批量结束进程；独立运行的其他 Node / Electron 应用不受影响。守护进程使用隐藏的 PowerShell 子进程，不改动全局执行策略或权限配置。

此功能执行受信任的工作区代码，不是代码安全沙箱。目前不支持任意原生 EXE、原生文件选择框或外部应用自动化，也不会自动改用前台桌面操作。键盘能力的证据覆盖渲染器默认编辑与网页表单动作，不保证原生菜单或系统级快捷键。Windows 进程树回收有真机测试证据，其他操作系统未做同范围验证。

## 验证

- `npm run test:bg-app`：真实 Electron 子进程、隐藏状态、新 PNG 帧、交互后的像素变化、真实 preload / IPC、会话隔离、进程关闭。
- `node scripts/background-app-smoke.cjs --self`：额外隐藏启动 YOYcode 真实主入口并截图。
- `npm run test:bg-app-compatibility`：`.mjs`、模块 `.js`、嵌套 ESM 与嵌套 CommonJS 四种入口；校验异步初始化时序、全部 Electron 导入别名、真实 preload / IPC 和截图。
- `npm run test:bg-app-lifecycle`：Windows 下正常关闭、启动失败、启动卡死、操作卡死、应用崩溃、宿主崩溃六种路径，确认应用及其派生 worker 都退出，并确认不相关的 Node 进程仍然存活。
- `npm run test:bg-app-windows`：关闭启动页、刷新列表、拒绝多窗口歧义写入、按指定窗口截图、只关闭辅助窗口；旧行为的失败证据保留在 `out/background-app-windows/baseline.json`。
- `npm run test:bg-app-input`：真实截图坐标、可信输入事件、Unicode、Tab / Enter、Canvas 双击与右键、遮挡与越界拒绝、150% 缩放。
- `npm run test:app-background-ui`：完整 App 设置入口经过正式 preload / IPC 操作后台应用。
- `npm run test:app-workflows`：合并本地 Git 阅读、写入、同步及后台应用入口流程。
- CLI 的 `tests/background-app.test.ts`：参数、审批、图片校验、真实智能体下一轮图片输入、工具记录去重和只读子智能体权限边界。
- CLI 的 `tests/provider-schema-vision.test.ts`：四种请求格式的结构参数、MCP 长嵌套参数、旧类型推断回归与 Gemini 图片请求体。

证据保存在 `out/background-app-review/`、`out/background-app-compatibility/`、`out/background-app-lifecycle/`、`out/background-app-windows/`、`out/background-app-input/` 和 `out/app-review/`。构建和验证不会对用户源码仓库提交或创建分支；Git 提交仅用于带归属标记的本地测试仓库。
