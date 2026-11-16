# Agent Note: bash 工具按宿主契约报失败并给出终端卡片

Status: implemented

## Problem

v0.1.0 的执行路径是对的，但「调用没有产生命令结果」这件事表达不出来，而且模型能传的参数会被静默吞掉：

1. 参数错误、受限会话拒绝只靠 `kind: 'rejected'` 加一段 `error` 字符串表达，`exitCode` 为 `null`、`stderr` 为空。模型无法区分「命令跑了但没输出」和「命令根本没跑」，UI 也拿不到退出码或信号。
2. `parameters` 写了 `additionalProperties: false`，但宿主对普通 tool definition 只校验 `output.schema`（`dsh-tools/src/index.ts:128-153`），模型参数原样进 `execute`。未声明的键被静默丢弃——`run_in_background` 被吞掉就等于前台跑满整个 `timeoutMs`。
3. 解析不到 bash 时只 `logger.warn` 后 `return`，模型侧完全不知道这台机器没有 bash，仍会写 bash 命令。
4. 没有 `presentCall` / `presentResult`，这条工具在 UI 里只能是文本块，没有标题、cwd 和退出码胶囊。

## Decision

1. 结果判别式从 `kind` 换成 `status: 'completed' | 'failed'`，新增可选 `failure: { code, message, effectState, retry, nextAction? }`；`error` 字符串并入 `failure.message`。`status` 由 `withStatus` 派生：只有 `exitCode === 0` 且无超时、无信号、无 `failure` 才算 `completed`，超时会让 exit code 0 的调用也算 `failed`。
2. `runCall` 第一步调用 `assertKnownArguments`：未声明参数直接拒绝，附带可接受参数名；`run_in_background` 提示「只有前台」、`sandbox_permissions` / `justification` 提示「没有按调用授权的参数」。
3. 失败码固定为下表，`effectState` 只在命令可能已经启动时取 `unknown`：

   | code | effectState | retry | 触发点 |
   | --- | --- | --- | --- |
   | `INVALID_ARGUMENT` | none | after-input-change | 参数、workdir、脚本路径校验 |
   | `CANCELLED` | none | never | 调用开始前信号已 abort |
   | `EXECUTOR_UNAVAILABLE` | none | never | 非 `danger-full-access` 会话 |
   | `SPAWN_FAILED` | none | never | `ctx.subprocess.spawn` 抛错 |
   | `SUBPROCESS_ERROR` | unknown | never | `handle.done` 拒绝、输出流读不出来 |
   | `INTERNAL_ERROR` | unknown | never | 其余前置阶段的意外抛出 |

   渲染成一行 `[CODE; effects: <effectState>; retry: <retry>] <message> <nextAction>`。
4. 展示层用宿主自带的视图：`presentCall` 返回 `{ card: 'terminal', title, description?, cwd? }`（标题取命令首行，`script_path` 时是 `bash <path>`），`output.presentationMeta` 把 `exitCode` / `signal` 投影进 `result.meta`，`presentResult` 再用它画退出码胶囊。只依赖参数与 meta，不读执行状态。
5. 解析不到 bash 时改为发布 `dsh-win-bash:unavailable` 系统提示词段（同一 `TOOL_BASH` 顺序位），说明没有 bash 并让模型走 `pwsh`。

## Alternatives considered

- **参数错误直接 throw**（v0.1.0 之前的常见做法）：宿主把抛出的错误折成 `{ error }` 值，这个值**不满足** `output.schema`，宿主报 `returned invalid output`，真正的字段名与原因一起丢失。所以失败必须自己返回 schema 合法的数据，不能靠 throw。
- **抢官方 `bash` 名字**（`tools.restrict` 顶掉宿主工具）：`restrict` 要求 agent 作用域 context（`dsh-tools/src/index.ts:162-170`），参考实现 dsh-ops 为此额外写了 227 行就绪校验和约 700 行 publication 防回环。本插件保留 `bash` → `win_bash` 的回退，名字冲突时降级更便宜。
- **自带 bash 载荷（Niubash）以覆盖受限模式**：需要随包二进制加 IPC 代理（dsh-ops `src/bash-ipc.ts` 603 行，含 provenance 哈希校验），超出「一个 Windows bash 工具」的范围；受限模式明确拒绝更诚实。
- **实现 `run_in_background` 与 job id**：宿主 pwsh 的后台能力绑在 `ctx.jobs`（`dsh-tool-pwsh/src/index.ts:300-331`），要另立作业注册表、回收与 UI 生命周期，在本插件只有一个前台 bash 的前提下收益低于「明确拒绝并说明会占住调用」。
- **复用 `ctx.shell` 方言接口**：`ShellExecRequest` 没有方言字段（`dsh-shell/src/types.ts:61-104`），一个 `ctx.shell` 只能承载一种 shell，bash 与 pwsh 并存时走不通，所以独立工具加 `ctx.subprocess` 是唯一可行路线。

## Consequences

- 收益：模型能区分「没跑」与「跑了没输出」；未知参数不再静默；UI 拿到标题、cwd 和退出码胶囊；没有 bash 时提示词说得清楚。
- 代价：结果契约断裂（`kind` / `error` 移除），所以版本从 0.1.0 升到 0.2.0；过去「多传一个无害键」的调用现在会失败，这是有意的严格化。
- 代价：`presentResult` 依赖 `presentationMeta` 落进 `result.meta`；宿主若未持久化 meta，退化结果只是没有退出码胶囊，不影响文本。
- 验证：`node --test test/` 18 项通过（含 `apply` 注册与不可用分支）；对安装的 DSH 0.2.2-rc.3 跑过 `assertSupportedJsonSchema`（`output` 与 `parameters` 均 SUPPORTED）和 `validateJsonSchemaValue`（`completed`、非零退出、超时、`SUBPROCESS_ERROR`、参数拒绝、`CANCELLED`、`EXECUTOR_UNAVAILABLE` 七种取值均 VALID）。
- 未覆盖：Windows 实机上的超时终止、信号、spill 行为，以及终端卡片在真实 UI 里的渲染。
