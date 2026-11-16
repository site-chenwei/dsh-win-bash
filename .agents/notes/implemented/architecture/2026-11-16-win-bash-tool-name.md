# Agent Note: 工具名固定 win_bash，配置入口仍是 profile 补丁

Status: implemented

## Problem

插件原先优先注册 `bash`、被占用时才退到 `win_bash`。在 Windows 上这会让插件遮蔽宿主自己的 `bash` 工具，用户无法从工具名判断这一发到底跑的是 Git Bash 还是宿主方言；同时用户希望在 DSH 的插件管理页里直接填 `bashPath`，而不是手改 YAML。

## Decision

`TOOL_NAME` 改为 `win_bash`，`bash` 降级为「`win_bash` 已被别的插件占用」时的兜底；`index.js:29-34` 的注释写明这个顺序的原因。`DESCRIPTION` 里原本写死的「Use bash for POSIX work」改成「Use this tool」，避免工具名与实际注册名不一致。guidance 段落本来就用真实注册名插值，因此回退路径不会出现提示词与工具名不符。

配置界面维持现状：`bashPath`、`timeoutMs`、`extraGuidance` 仍写在 profile 的 `cordis.patch.yml` 里，用 `- id: win-bash` 定位覆盖。

## 为什么插件管理页给不出表单

插件管理页的「配置 X」按钮不是由 `Config` schema 生成的，而是由客户端槽位 `plugins.row.config` 驱动的：该槽位是 `keyed`、键为 `<包名>#<row id>`，需要某个**客户端插件**注册对应键，页面才显示按钮（`dsh-client-ui-plugin-manager/src/client/slot-contract.ts:160-167`、`src/client/config-ledger.ts:40-67` 里 `configure().has(row)` 查的就是这个 ledger）。服务端的 `Config` 只参与两件事：`cordis/src/fiber.ts:51-53` 的 `runtime.Config['~standard'].validate(config)` 校验，以及 `cordis-plugin-loader/src/index.ts:114-118` 用 `[simplify]` 把运行值写回 YAML。本包只有服务端入口，没有客户端 bundle，所以那一行按钮不会出现——把 `Config` 导出来也不会出现。

## Alternatives considered

- **导出 `Config` 让页面自动出表单**：不成立。表单不由 schema 生成，理由同上条；导出 `Config` 只能拿到校验与默认值。
- **补一个客户端插件注册 `plugins.row.config`**：可行但要新增客户端入口（`lib/client.js` 的 `window.__ModuleLoader__.load` 形式或构建链）、React 组件、`@deepseek-ai/dsh-client-ui-primitives` 一类 peer 依赖，以及把编辑结果写回 profile 补丁的 API 调用。成本远超当前 872 行零依赖零构建的单文件，且会让这个包的安装面变复杂，暂不做。
- **在插件里自带一个改配置的命令行入口**：DSH 没有为插件提供这样的注册面，做出来只能绕过 loader 直接改 YAML，和手工编辑等价，收益不足。

## Consequences

Windows 上的调用方会看到 `win_bash` 这个名字；宿主若自带 `bash`，两者互不遮蔽，日志里 `registered "win_bash" -> ... (config|well-known|PATH)` 就是实际注册名。配置仍需手改 `cordis.patch.yml`，写错 `bashPath` 时显式路径不回落到自动探测，工具随之不注册，并由 `dsh-win-bash:unavailable` 段落说明原因。
