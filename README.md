# dsh-win-bash

在 Windows 上给 DeepSeek Harness 增加一个真正的 GNU bash 工具，避免模型把 PowerShell 语法当 bash 写。

DSH 自带的 `bash` 执行器只支持 POSIX（`@deepseek-ai/dsh-bash-local` 把 bash 路径写死），Windows 预设里 `tool-bash` 是按平台禁用的，所以 Windows 会话默认只有 `pwsh`。这个 bundle 不改宿主、不碰配置，只做一件事：注册一个 `bash` 工具，通过 `ctx.subprocess` 调 Git Bash，工作目录和文件系统与其它工具看到的是同一个。

## 边界（先看这条）

**只支持 `danger-full-access` 会话。** 受限沙箱下 Windows 给子进程的是 `WRITE_RESTRICTED` + Low integrity 令牌，MSYS 的 signal pipe 起不来（`couldn't create signal pipe, Win32 error 5`）。本包不携带 Niubash 载荷、也不做 IPC 代理，所以：

- 完全权限会话：正常执行；
- 其它模式：工具照常出现在工具列表里，但每次调用返回 `status: failed`、`failure.code: EXECUTOR_UNAVAILABLE`，**不会**在不带沙箱的情况下裸跑。

`pwsh` 不会被隐藏。找不到 bash 时插件不注册工具，改为发布一段 `bash is unavailable` 的系统提示词，模型会知道该走 pwsh；受限会话下则返回上面那条 `EXECUTOR_UNAVAILABLE`。

## 安装

要求：Windows 10/11、已安装 [Git for Windows](https://git-scm.com/download/win)（或任意 MSYS2 的 `bash.exe`）、DSH 桌面端。

在 Windows 上三选一：

1. **npm**（推荐）：

   ```powershell
   dsh plugin --profile desktop add @chenwei116057/dsh-win-bash
   ```

2. **界面**：Plugins → Add plugin → 选择本目录（本地目录安装）。
3. **挂本地目录**（开发时用，改完重载即生效）：

   ```powershell
   dsh plugin --profile desktop add link:D:\path\to\dsh-win-bash
   ```

装完在 Plugins 里应该看到 `@chenwei116057/dsh-win-bash`（本地目录安装则显示目录名），日志里有一行：

```
dsh-win-bash: registered "bash" -> C:\Program Files\Git\bin\bash.exe (well-known).
```

工具名固定为 `win_bash`，不会去抢宿主自己的 `bash`；只有 `win_bash` 已被别的插件占用时才退回 `bash`，并在日志里说明。

## 配置

行配置在 `cordis.patch.yml` 里，也可以在 Plugins 的配置面板改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `bashPath` | 空 | 显式指定 `bash.exe`。**配了就只认它**，路径不存在会直接不注册并打日志，不会偷偷换成别的安装。`C:\Windows\System32\bash.exe`（WSL 启动桩）会被明确拒绝。 |
| `timeoutMs` | `120000` | 默认超时，上限 `600000`。单次调用可以用参数覆盖。 |
| `extraGuidance` | 空 | 追加到系统提示词的额外路由说明，比如团队自己的构建约定。 |

不配 `bashPath` 时按顺序探测：`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles%\Git\usr\bin\bash.exe`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Programs\Git`、scoop、chocolatey、`C:\msys64` 等，最后扫 `PATH`。

## 工具行为

- 每次调用是一个新 shell，`cd` 不跨调用保留；用 `workdir` 参数。
- `workdir` 接受 `D:/repo`、`/d/repo`、`/cygdrive/d/repo`、UNC 路径；相对路径按会话工作区解析。**无盘符的 `/tmp`、盘符相对路径 `D:child` 会被拒绝**，否则会静默落到别的盘上执行。
- `command` 与 `script_path` 二选一。命令行超过 30000 字符会提示改用 `script_path`（Windows 命令行上限 32767）；脚本较长或含 heredoc、反斜杠、嵌套引号、非 ASCII 时，先用 `write` 落盘再传 `script_path`。
- **未知参数直接拒绝**并列出可接受的参数名。宿主对普通 tool definition 只校验 `output.schema`，不校验 `parameters`，未声明的键会被静默丢弃——`run_in_background` 被吞掉就等于前台跑满整个超时，所以这里自己拦（`run_in_background`、`sandbox_permissions`、`justification` 另有专门提示）。
- 输出：stdout 原样，stderr 单独一段；超过 64KB 截断并给出 spill 文件路径；退出码以 `[exit code: N]` 结尾，非零不算工具失败。截断时文本是尾部片段，不代表完整输出。
- `status` 只在干净退出（exit code 0、无超时、无信号、无引擎错误）时是 `completed`，其余都是 `failed`——超时也会让 exit code 0 的调用算 `failed`。
- 没有产生命令结果时返回 `failure: { code, message, effectState, retry, nextAction? }`，渲染成 `[CODE; effects: none; retry: after-input-change] 原因`。`effectState: unknown` 表示命令可能已经动过文件系统，重试前先确认副作用；`retry: never` 表示原样重试没有意义。
- 前台执行：没有 `run_in_background`、没有 job id；服务器、watch 进程会一直占住这次调用直到 `timeoutMs`。
- 终端卡片：`presentCall` 拿命令首行当标题，带上 `description` 和 `cwd`；`presentResult` 把输出和退出码交给 UI 画 exit pill，UI 不支持时回落到上面的文本块。
- 超时会终止整个进程树（`graceMs = 3s`），并标注 `[timed out after Nms]`。
- 环境变量只覆盖 `TERM=dumb`、`NO_COLOR=1`、`PAGER=cat`、`GIT_PAGER=cat`、`LC_MESSAGES=C`，其余继承宿主（宿主负责先清洗凭据）。
- spill 文件写在系统临时目录，宿主不按时间回收，长跑任务要自己清。

## 验证清单（Windows 实机）

装好后开一个 **完全权限** 会话，依次验证：

1. `command: 'uname -s; echo $BASH_VERSION; pwd'` → 形如 `MINGW64_NT-10.0-…` 和 `5.2.x`，`pwd` 是会话工作区。
2. `workdir: 'D:/repo'` 与 `workdir: '/d/repo'` 指向同一目录。
3. `workdir: '/tmp'` → 明确报 "drive-less path"。
4. `command: 'sleep 5'`, `timeoutMs: 1000` → 1 秒左右结束，带 `[timed out after 1000ms]`。
5. 中文输出：`echo 中文` 不乱码；`printf` 混合 stderr 时两段分开。
6. 切到工作区写入（workspace-write）会话再调 → 返回 `runs only in danger-full-access`，命令没有执行。
7. Plugins 里把 `bashPath` 改成一个不存在的路径并重载 → 插件不注册，日志指出路径，系统提示词里出现 `bash is unavailable` 一节。
8. `command: 'echo hi'` 同时带 `run_in_background: true` → 返回 `[INVALID_ARGUMENT; effects: none; retry: after-input-change] unknown argument: run_in_background…`，命令没有执行。
9. 终端卡片：这次调用显示为 terminal 卡，标题是命令首行；完成后 exit code 胶囊显示真实退出码（`status: failed` 但 exit code 2 时显示 2）。

## 未验证 / 已知限制

- 没有在 Windows 实机上跑过；`ctx.subprocess`、`tools.register`、`systemPrompt.section` 的用法来自本机 DSH 0.2.2 源码与 dsh-ops 的同类实现，执行路径需要在上面清单里实机确认。
- 结果契约（`status`、`failure`、`presentCall`、`presentResult`）已对安装的 DSH 0.2.2-rc.3 跑过 `assertSupportedJsonSchema` 与 `validateJsonSchemaValue`，但**终端卡片的实际渲染**和 Windows 上的真实 spawn 路径仍未实机验证。
- 测试里 spawn 之后的路径靠 stub 覆盖（`fs.statSync` 与假 subprocess handle），真机上的超时、信号、spill 行为只能靠上面的清单确认。
- 不支持后台任务（`run_in_background` 会被明确拒绝）、不隐藏 `pwsh`、不做受限沙箱兼容。
- 每次调用都重新解析 `bashPath` 吗？不——解析在插件加载时做一次，改配置需要重载插件。
