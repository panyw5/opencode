# OpenCode 扩展（Extensions）系统设计

状态：设计稿，待评审。本文只规定方案，不代表相关功能已实现。

项目路径：`/Users/lelouch/apps/opencode`

覆盖范围：扩展包格式、安装与注册表、server 运行时、HTTP API、前端扩展宿主（ExtensionHost）、前端扩展 API、宿主改造、开发工具链、WolframScript Notebook 案例、安全模型、分阶段实施。

已确认的决策：

- 前端信任模型：**安装即信任，同进程运行**。扩展前端代码与 app 运行在同一个 JS 上下文中，不做 iframe 沙箱。
- 扩展由 server 统一管理，UI 从 server 获取清单和资源。

## 1. 目标与边界

### 1.1 目标

- 可选功能（新的文件预览器、WolframScript notebook 运行时等）以扩展包形式下载、安装、启用、停用、卸载，不需要重新构建或发布 opencode。
- 一个扩展包可以同时包含前端部分（web）和后端部分（server），两部分通过固定的 RPC 通道和事件通道通信。
- 前端扩展点：文件预览器、工具调用渲染器、会话侧栏面板、命令、设置页。
- 后端扩展点：沿用现有 plugin `Hooks`（`tool`、`event`、`chat.*` 等），新增 RPC 和进程级服务。
- Web（server 内嵌 UI）、Desktop（Electron）、连接远程 server 三种形态行为一致。
- 未使用的扩展不增加启动成本：启动时只读 manifest，代码按需加载。
- 停用、卸载后无残留：注册项、样式、事件订阅、子进程全部回收，不需要重启应用。

### 1.2 不做的事情（首个版本）

- 不做 iframe/Worker 沙箱，不强制执行权限声明（权限只在安装时展示）。
- 不允许扩展注册任意 HTTP 路由、新的消息 Part 类型或新的 Bus 事件类型。
- 不允许扩展替换会话页、配置页等宿主核心页面。
- 不支持扩展之间的依赖关系。
- 不做签名、付费和自动更新；市场索引先用静态 JSON。
- 不恢复 TUI 插件。

### 1.3 已确认的基线

以下是写作本文时核实过的代码事实，设计以此为前提。

- **后端 plugin 体系完整。** `packages/plugin/src/index.ts` 定义了 `PluginInput`、`Hooks`、`PluginModule { id?, server }`。`packages/opencode/src/plugin/loader.ts` 负责解析、安装、兼容性检查和 `import()`，其中兼容性检查读取 `engines.opencode`（`plugin/shared.ts:194`）。npm 包经 `Npm.add` 安装到 `Global.Path.cache/packages/<pkg>`（`packages/core/src/npm.ts`，基于 Arborist，`ignoreScripts: true`）。
- **插件入口按目标区分。** `PluginKind = "server" | "tui"`（`plugin/shared.ts:37`），分别从 `exports["./server"]`、`exports["./tui"]` 解析。TUI 已从本 fork 移除，`"tui"` 目标目前没有使用方；`cli/cmd/plug.ts:178` 的 `PluginCommand` 也没有在 `src/index.ts` 中注册。
- **server 插件按实例（目录）加载。** `Plugin.state` 是 `InstanceState`。外部插件先被复制到 `Global.Path.tmp/plugin-modules/<hash>` 再导入（`loader.ts:134`），用来隔离不同项目的模块状态。实例销毁时调用各插件的 `dispose`（`plugin/index.ts:332`）。
- **Desktop 的 server 运行在 Node 上。** `PluginInput.$` 只在 Bun 下存在（`plugin/index.ts:373`）。Desktop 的 server 运行在 Electron `utilityProcess` 中（`packages/desktop/src/main/server.ts:266`），是 Node 运行时。
- **插件工具进入 ToolRegistry。** 插件经 `Hooks.tool` 注入工具（`tool/registry.ts:296`）。工具执行中可以调用 `context.metadata()` 推送实时 metadata，返回结果支持 `attachments`（`packages/plugin/src/tool.ts`）。
- **事件链路。** 用 `BusEvent.define()` 注册的事件会进入 OpenAPI 的事件联合类型（`bus/bus-event.ts` 的 `effectPayloads()`），经 `GlobalBus` 由 `/global/event` SSE 推给 UI。UI 在 `context/global-sdk.tsx` 中用 `listenAll` 分发。
- **HTTP 路由。** 使用 Effect HttpApi，路由树在 `server/routes/instance/httpapi/server.ts`。UI 静态资源是最后的 catch-all 路由 `uiRoute`（`:185`）。编写约定见同目录的 `AGENTS.md`。
- **鉴权。** 使用 Basic Auth，也接受 `?auth_token=`（`middleware/authorization.ts`）。Desktop 每次启动都为 sidecar 生成随机密码（`desktop/src/main/index.ts:385`），所以 Desktop 下**鉴权始终开启**。
- **CSP 与 CORS。** 内嵌 Web UI 的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`、`img-src 'self' data: https:`、`media-src 'self' data:`、`connect-src * data:`（`server/shared/ui.ts:11`）。Desktop renderer 从 `oc://renderer` 加载（scheme 注册为 `secure`、`standard`），没有 CSP 头。CORS 已放行 `oc://renderer` 与 localhost（`server/cors.ts`）。
- **文件读取接口不能当字节通道用。** `/file/content` 对按扩展名判定为二进制的文件返回空内容（`file/index.ts:526`），对文本内容会做 `trim()`（`:547`）。宿主没有通用的文件写接口。
- **前端注册表没有注销能力。** 现有的两个注册表是 `ToolRegistry.register`（`packages/ui/src/components/message-part.tsx:1676`，未命中时回退到 `GenericTool`，`:1771`）和 `registerPartComponent`（`:981`）。
- **文件预览分发是硬编码的。**
  - `file-tabs.tsx:94-95` 用正则判断 md 和 pdf。
  - `packages/ui/src/pierre/media.ts` 固定了 `MediaKind = "image" | "audio" | "svg" | "pdf"`。
  - `packages/ui/src/components/file-media.tsx:70` 的 `previewKind()` 只识别 csv/tsv，但已经实现了“预览/源码”切换。
- **时间线高度估算按工具名写死。** 会话时间线是虚拟列表，高度估算按工具名特判（`pages/session/timeline/estimate.ts:185`）。
- **命令注册依赖 Solid owner。** `useCommand().register(key, cb)` 靠当前 owner 的 `onCleanup` 注销（`context/command.tsx:455`）。
- **侧栏标签值只有三类。** 分别是 `"context"`、`"review"`、`"file://<path>"`。对非 `file://` 的值，`pathFromTab` 返回 `undefined`（`context/file/path.ts:166`）。
- **技术栈版本。** solid-js 1.9.10、vite 7.1.4、electron 41.2.1。

## 2. 总体架构

### 2.1 概念与术语

| 术语 | 含义 |
| --- | --- |
| 扩展（Extension） | 一个 npm 包形态的目录：`package.json` 中带 `opencode` manifest，含可选的 web 入口、server 入口和静态资源 |
| web 部分 | 在 UI 中运行的 ESM 模块，默认导出 `defineWebExtension(...)` |
| server 部分 | 在 opencode server 进程中运行的 ESM 模块，默认导出 `defineServerExtension(...)` |
| 贡献点（Contribution） | 扩展向宿主注册的能力：文件预览器、工具渲染器、面板、命令、设置 |
| 激活（Activation） | 加载扩展代码并调用其 `activate` 的过程 |

与现有 plugin 的关系：扩展的 server 部分沿用 plugin 的 `Hooks` 形态，所以扩展可以看作“带前端、带管理界面的 plugin”。但扩展由独立的全局注册表管理，不写进 `opencode.json` 的 `plugin` 数组（理由见 §2.3 D2）。

### 2.2 架构图

```
┌──────────────────────────── 扩展包 ─────────────────────────────┐
│ package.json   "opencode": { id, contributes, activation, ... } │
│ dist/server.js defineServerExtension({ activate, server })      │
│ dist/web/      index.js + index.css + chunk 与静态资源            │
└─────────────────────────────────────────────────────────────────┘
          │ 安装（npm / 归档 / 本地路径）
          ▼
┌──────────────────────────── opencode server ────────────────────────────┐
│ Extension.Service（进程级）                                              │
│   registry.json：安装、启停、设置                                         │
│   activate()：进程级服务（如 KernelManager）                              │
│ Plugin.Service（实例级）                                                 │
│   原有 plugin hooks + 扩展 server() 返回的 hooks（tool / event / rpc）     │
│ HTTP                                                                    │
│   /global/extension*             管理与清单                               │
│   /extension/:id/rpc/:method     RPC（实例路由）                          │
│   /extension-asset/:token/...    web 资源（能力令牌路径）                  │
│   /file/raw                      精确字节读取                             │
│ Bus：extension.status / extension.event ──► /global/event（SSE）          │
└─────────────────────────────────────────────────────────────────────────┘
          │ HTTP + SSE
          ▼
┌──────────────────────────── packages/app ───────────────────────────────┐
│ ExtensionHostProvider                                                   │
│   清单 → 静态贡献占位 → 按需 import() → activate(ctx)                     │
│   共享模块桥：solid-js、@opencode-ai/ui 组件                               │
│ 注册表：FileViewerRegistry / ToolRegistry / 面板 / 命令 / 设置             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 关键设计决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D1 | server 是唯一事实来源 | 连接远程 server、打开多个窗口时看到同一套扩展；web 与 server 部分版本一致 |
| D2 | 独立的全局注册表，不写入 `opencode.json` 的 `plugin` | `plugin_origins` 在实例内计算，拿不到全局清单；web 部分是全局的；安装、启停、卸载不改动用户的配置文件 |
| D3 | server 入口沿用 plugin `Hooks` | 工具、事件、chat 钩子直接复用现有执行路径和按会话关闭钩子的 HookControl |
| D4 | 前端同进程，共享宿主的 Solid 实例 | 可以直接使用宿主组件、主题和上下文；notebook 这类交互密集的界面体验最好 |
| D5 | web 资源走能力令牌路径 | `import()` 带不上鉴权头；入口里相对导入的 chunk 和 CSS `url()` 会丢失查询参数 |
| D6 | manifest 静态声明贡献点，代码懒加载 | 未使用的扩展没有启动成本 |
| D7 | 固定的 RPC 与事件通道 | 不破坏 HttpApi、OpenAPI、SDK 的类型化路由体系 |
| D8 | 扩展 server 模块在进程内只导入一次 | 进程级服务（如 kernel）需要跨实例共享；实例级状态放在 `server()` 的闭包里 |

### 2.4 生命周期总览

1. **安装**：server 下载或链接扩展，校验 manifest，写入注册表（默认启用）。
2. **server 侧启用**：第一次需要时导入 server 入口并调用 `activate()`。之后每个初始化的实例都会调用扩展的 `server()` 取得 hooks。
3. **UI 启动**：`ExtensionHostProvider` 请求 `GET /global/extension`，按 manifest 注册静态贡献占位，此时不加载扩展代码。
4. **激活**：激活事件触发时注入 CSS、`import()` web 入口、调用 `activate(ctx)`。激活事件包括打开匹配的文件、渲染对应工具、执行命令、打开面板，以及 `onStartup`。
5. **运行**：web 部分通过 `ctx.rpc.call()` 调用 server，通过 `ctx.events.on()` 接收 server 推送。
6. **停用或卸载**：server 调用进程级 `dispose()` 并重建实例；UI 收到 `extension.status` 后销毁扩展的 owner，移除样式和全部贡献。

## 3. 扩展包格式

### 3.1 目录结构

```
my-extension/
├── package.json
├── dist/
│   ├── server.js          # server 入口（ESM，已打包依赖）
│   └── web/
│       ├── index.js       # web 入口（ESM）
│       ├── index.css
│       ├── chunk-*.js     # 可选：代码分割产物
│       └── icon.svg
└── README.md
```

web 部分和 server 部分都是可选的，但至少要有一个。

### 3.2 manifest

```json
{
  "name": "@acme/opencode-wolfram",
  "version": "0.1.0",
  "type": "module",
  "engines": { "opencode": ">=1.19.0" },
  "exports": {
    "./server": "./dist/server.js",
    "./web": "./dist/web/index.js"
  },
  "opencode": {
    "manifestVersion": 1,
    "id": "acme.wolfram-notebook",
    "displayName": "Wolfram Notebook",
    "description": "以 notebook 形式运行 WolframScript，并与 Agent 共享 kernel",
    "icon": "./dist/web/icon.svg",
    "web": { "apiVersion": 1, "styles": ["./dist/web/index.css"] },
    "activation": ["onFileViewer:notebook", "onTool:wolfram_eval", "onCommand:restartKernel"],
    "contributes": {
      "fileViewers": [
        { "id": "notebook", "title": "Wolfram Notebook", "extensions": ["wlnb"], "priority": 100, "mode": "replace" }
      ],
      "toolRenderers": [{ "tool": "wolfram_eval" }],
      "commands": [{ "id": "restartKernel", "title": "重启 Wolfram Kernel", "category": "Wolfram" }],
      "panels": [],
      "settings": {
        "wolframscriptPath": { "type": "string", "title": "wolframscript 路径", "default": "" },
        "exposeTool": {
          "type": "string",
          "title": "向 Agent 暴露 wolfram_eval",
          "enum": ["always", "matching-projects", "never"],
          "default": "matching-projects"
        }
      }
    },
    "permissions": ["process:spawn", "fs:write", "tools"]
  }
}
```

### 3.3 字段规则

| 字段 | 规则 |
| --- | --- |
| `opencode.manifestVersion` | 必填，当前为 `1` |
| `opencode.id` | 必填；小写，`publisher.name` 形式，正则 `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`，长度不超过 64；`opencode.` 前缀保留给官方扩展 |
| `version` | 取 `package.json` 的 `version`，必须是合法 semver |
| `engines.opencode` | 可选；沿用 `checkPluginCompatibility` 的语义，不满足时标记为 `incompatible`，不加载 |
| `opencode.web.apiVersion` | 有 web 部分时必填；宿主不支持该版本时跳过 web 部分并报告 |
| `exports["./server"]`、`exports["./web"]` | 入口解析沿用 plugin 的规则，路径必须位于包目录内 |
| web 资源根目录 | `./web` 入口所在的目录；资源路由只提供该目录内的文件；`styles`、`icon` 必须在其中 |
| `opencode.activation` | 省略时等价于 `["onStartup"]` |
| `opencode.contributes.*[].id` | 在扩展内唯一；全局 ID 为 `<extensionID>:<id>`；命令的全局 ID 为 `ext.<extensionID>.<id>` |
| `opencode.permissions` | 只用于展示：`process:spawn`、`fs:read`、`fs:write`、`network`、`tools`（向 LLM 暴露工具） |

manifest 中的静态文本（`displayName`、`title` 等）首个版本只支持单一语言，本地化放到后续版本。

### 3.4 构建产物约束

- server 入口必须是打包好的 ESM JavaScript。Desktop 中 server 运行在 Node 上（Electron `utilityProcess`），不能直接 `import` `.ts` 文件，也没有 `Bun` 全局对象（`PluginInput.$` 为 `undefined`）。
- server 入口不应依赖 native addon，否则必须与 Electron 的 Node ABI 匹配。需要本地能力时应启动外部进程，WolframScript 本身就是这种形态。
- web 入口必须是 ESM，并且不能把 `solid-js` 与共享的 `@opencode-ai/ui` 模块打包进去（由 kit 的 vite 插件处理，见 §10.2）。
- 允许代码分割，chunk 之间必须用相对路径引用。
- 不能依赖安装期脚本，因为安装器使用 `ignoreScripts: true`。
- 推荐打包成没有运行时依赖的产物（`dependencies` 为空），这样安装只需解包，不必解析依赖。

## 4. 安装与注册表

### 4.1 存储布局

```
<Global.Path.data>/extensions/
├── registry.json                 # 注册表（flock 保护）
├── packages/<id>/<version>/      # 解包后的扩展目录（只读使用）
├── data/<id>/                    # 扩展持久数据，跨版本保留，卸载时询问是否删除
└── staging/<nonce>/              # 安装临时目录
```

缓存目录为 `<Global.Path.cache>/extensions/<id>/`，可以随时清理。

扩展不放在 `Npm.add` 默认使用的 `Global.Path.cache` 下，因为缓存可能被清理，而已安装的扩展必须持久存在。

### 4.2 registry.json

```json
{
  "version": 1,
  "extensions": {
    "acme.wolfram-notebook": {
      "name": "@acme/opencode-wolfram",
      "version": "0.1.0",
      "source": { "type": "npm", "spec": "@acme/opencode-wolfram@0.1.0" },
      "dir": "<data>/extensions/packages/acme.wolfram-notebook/0.1.0",
      "enabled": true,
      "installedAt": 1790000000000,
      "settings": { "wolframscriptPath": "" }
    }
  }
}
```

`source` 有三种：`{ type: "npm", spec }`、`{ type: "archive", url, sha256 }`、`{ type: "path", path }`。`path` 用于开发链接，此时 `dir` 直接指向该目录。

server 启动时读取注册表，并监听 `registry.json` 的变化，这样 CLI 在 server 运行期间修改注册表也能生效（见 §4.6）。

### 4.3 安装来源

| 来源 | 流程 | 用途 |
| --- | --- | --- |
| npm | 调用 `Npm.install(stagingDir, { add: [{ name, version }] })`，从 `node_modules/<name>` 取出包目录；`ignoreScripts: true` | 公开分发 |
| 归档 | 下载 `.tgz` 或 `.zip`，**必须**提供 `sha256`，校验通过后解压；拒绝绝对路径和含 `..` 的条目 | 私有分发、离线安装、GitHub Release |
| 本地路径 | 不复制，注册表直接指向该目录；server 监听其变化（见 §7.8） | 扩展开发 |
| 市场索引 | 静态 JSON 列出 `{ id, displayName, description, source, versions }`，最终落到上面三种之一 | 浏览与发现 |

### 4.4 安装流程

1. 在 `staging/<nonce>` 下获取包内容（npm 或归档）。
2. 读取 `package.json`，校验 manifest（§3.3）、入口路径、`engines.opencode` 和 `opencode.web.apiVersion`。
3. 检查 ID 冲突：已安装同 ID、同包名视为升级；包名不同但 ID 相同则拒绝。
4. 原子地移动到 `packages/<id>/<version>/`，在 flock 下更新 `registry.json`。
5. 发布 `extension.status`（`installed`）；如果要求启用，进入 §4.5 的启用流程。
6. 任何一步失败：删除 staging 目录，注册表保持不变，把错误返回给调用方，并发布 `extension.status`（`error`）。

### 4.5 启用、停用、卸载、升级

| 操作 | server 部分 | web 部分 |
| --- | --- | --- |
| 启用 | 导入 server 入口，按需调用 `activate()`；若有实例级 `server()`，重建所有实例 | UI 收到 `extension.status` 后注册静态贡献，按激活事件加载 |
| 停用 | 调用进程级 `dispose()`；若有实例级 `server()`，重建所有实例 | 销毁扩展 owner，移除样式和贡献；已打开的扩展标签页显示“扩展不可用” |
| 卸载 | 先停用，再删除 `packages/<id>`；`data/<id>` 是否保留由用户选择 | 同停用 |
| 升级 | 安装新版本 → 停用旧版本 → 启用新版本 → 删除旧目录 | 用新的资源 URL（版本段不同）重新导入 |

实例重建复用 `disposeAllInstancesAndEmitGlobalDisposed()`（`server/global-lifecycle.ts`，也就是 `POST /global/dispose` 走的路径）。它可能中断正在运行的会话，所以有会话忙碌时 UI 要先确认。只有 web 部分的扩展启停时不需要重建实例。

之所以要重建实例，是因为扩展 hooks 在实例初始化时注入，工具列表也在 `ToolRegistry` 的实例状态中缓存。运行时增量注入需要改动 `ToolRegistry` 的缓存机制，首个版本不做。

### 4.6 CLI

```
opencode extension list
opencode extension install <npm-spec | url#sha256=<hex> | path.tgz>
opencode extension link <dir>             # 开发：注册本地目录
opencode extension enable <id>
opencode extension disable <id>
opencode extension uninstall <id> [--purge-data]
opencode extension update <id> [--version <x.y.z>]
```

CLI 在 flock 下直接修改注册表；运行中的 server 通过监听 `registry.json` 完成同步（§4.2）。

### 4.7 与 `opencode.json` 中 plugin 的关系

- 扩展与 `opencode.json` 的 `plugin` 数组相互独立。
- 如果同一个包同时出现在 `plugin` 配置里，server 加载插件时跳过它并记录警告，避免 hooks 被注册两次。
- `--pure`（`flags.pure`）与新增的环境变量 `OPENCODE_DISABLE_EXTENSIONS=1` 都会跳过全部扩展。

## 5. Server 运行时

### 5.1 Extension.Service

职责：

- 读写注册表，处理安装、启停、卸载、升级和设置。
- 为每个启用的扩展维护进程级运行时 `{ module, service, settings, status }`。
- 生成资源令牌，把资源请求解析为扩展目录内的文件。
- 为 `Plugin.state` 提供本实例应加载的扩展 hooks。
- 路由 RPC，发布 `extension.status` 和 `extension.event`。

接口草案：

```ts
export interface Interface {
  readonly list: () => Effect.Effect<ExtensionInfo[]>
  readonly get: (id: string) => Effect.Effect<ExtensionInfo, ExtensionNotFoundError>
  readonly install: (
    source: ExtensionSource,
    options?: { enable?: boolean },
  ) => Effect.Effect<ExtensionInfo, ExtensionInstallError>
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<ExtensionInfo, ExtensionNotFoundError>
  readonly uninstall: (id: string, options?: { purgeData?: boolean }) => Effect.Effect<void, ExtensionNotFoundError>
  readonly update: (id: string, version?: string) => Effect.Effect<ExtensionInfo, ExtensionInstallError>
  readonly updateSettings: (
    id: string,
    patch: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, ExtensionNotFoundError | ExtensionSettingsError>
  readonly instanceHooks: (input: PluginInput) => Effect.Effect<Array<{ id: string; hooks: ExtensionHooks }>>
  readonly rpc: (input: {
    id: string
    method: string
    payload: unknown
    directory?: string
    signal: AbortSignal
  }) => Effect.Effect<unknown, ExtensionRpcError>
  readonly asset: (input: {
    token: string
    id: string
    version: string
    path: string
  }) => Effect.Effect<string, ExtensionAssetNotFoundError>
}
```

Extension.Service 必须是**进程内单例**：Plugin 层和 HTTP 处理器必须拿到同一个实例。实现时要确认 `webHandler` 使用的 `memoMap` 能否保证这一点；如果不能，就把运行时状态放在模块级单例里（与 `GlobalBus` 的做法相同），Effect 服务只做一层薄封装。`opencode run` 等不启动 HTTP 的入口同样会用到 Plugin，因此也要提供这个层。

### 5.2 server 入口模块

```ts
import { defineServerExtension } from "@opencode-ai/extension-kit/server"

export default defineServerExtension({
  id: "acme.wolfram-notebook",

  // 进程级，可选：第一次需要时调用一次；停用、卸载或 server 退出时 dispose
  async activate(host) {
    const kernels = new KernelManager(host)
    return {
      rpc: {
        "kernel.eval": (input, ctx) => kernels.eval(parseEval(input), ctx.signal),
        "kernel.restart": (input) => kernels.restart(parsePath(input)),
      },
      dispose: () => kernels.shutdownAll(),
    }
  },

  // 实例级，可选：每个实例（目录）初始化时调用，返回值就是 plugin Hooks
  async server(input) {
    return {
      tool: { wolfram_eval: createEvalTool(input.extension.service) },
      rpc: { "notebook.save": (payload) => saveNotebook(input.directory, payload) },
    }
  },
})
```

类型：

```ts
export type ServerExtension = {
  id: string
  activate?: (host: ExtensionHost) => Promise<ExtensionService | void>
  server?: (input: ExtensionPluginInput, options?: PluginOptions) => Promise<ExtensionHooks>
}

export type ExtensionHost = {
  readonly id: string
  readonly version: string
  readonly dataDir: string
  readonly cacheDir: string
  readonly serverUrl: URL
  readonly settings: {
    get(): Record<string, unknown>
    onDidChange(listener: (next: Record<string, unknown>) => void): () => void
  }
  emit(name: string, data: unknown, options?: { directory?: string }): void
  readonly log: Record<
    "debug" | "info" | "warn" | "error",
    (message: string, extra?: Record<string, string | number | boolean>) => void
  >
}

export type ExtensionService = {
  rpc?: Record<string, RpcHandler>
  dispose?: () => Promise<void>
}

export type ExtensionPluginInput = PluginInput & {
  extension: ExtensionHost & { service: ExtensionService | undefined }
}

export type ExtensionHooks = Hooks & { rpc?: Record<string, RpcHandler> }

export type RpcHandler = (input: unknown, ctx: { directory?: string; signal: AbortSignal }) => Promise<unknown>
```

规则：

- 与 plugin 不同，扩展 server 模块**不做**按实例复制，进程内只导入一次（D8）。`server()` 在每个实例中调用一次，实例级状态必须放在闭包里，不能放在模块顶层。
- `activate()` 在第一次需要时执行：第一个实例初始化或第一个进程级 RPC 到达时。结果会缓存，保证 `server()` 拿到的 `input.extension.service` 已经就绪。
- 返回的 hooks 以 `extension:<id>` 作为插件 ID 进入 `HookEntry`，所以可以被现有的 HookControl 按会话关闭。
- 工具名不能与内置工具重名；重名时跳过该工具并报告。建议工具名带扩展前缀，例如 `wolfram_eval`。

### 5.3 接入 Plugin.Service

在 `Plugin.state` 中，加载完外部插件之后、调用 `config` 钩子之前，追加扩展的 hooks：

```ts
const extensionHooks = yield* extensions.instanceHooks(input) // 已跳过停用、出错、不兼容的扩展
for (const item of extensionHooks) hooks.push({ id: `extension:${item.id}`, hooks: item.hooks })
```

- 执行顺序依次是内置插件、配置中的外部插件、扩展，用户显式配置的插件先执行。
- `server()` 抛错时只记录日志并发布错误，不影响其他插件。
- 实例销毁时扩展 hooks 的 `dispose` 走现有的 finalizer（`plugin/index.ts:332`）。
- 工具定义会随每次请求发给 LLM，占用 token。扩展应当提供工具暴露策略的设置（例如 §3.2 的 `exposeTool`），在 `server()` 中据此决定是否返回工具。用户也可以用现有 agent 配置中的 `tools` 或 `permission` 关闭这些工具。

### 5.4 RPC

- 端点为 `POST /extension/:id/rpc/:method?directory=<dir>`，请求体 `{ input: unknown }`，响应 `{ result: unknown }`。
- 查找顺序：带 `directory` 时，先查该实例 `server()` 返回的 `rpc`，再查进程级 `activate()` 返回的 `rpc`；不带 `directory` 时只查进程级。
- 客户端断开连接时 abort `ctx.signal`。默认超时 120 秒，可用请求头 `x-opencode-rpc-timeout` 调整，上限 10 分钟。
- 错误映射：
  - 扩展不存在或已停用：404。
  - 方法不存在：404。
  - handler 抛出 `ExtensionRpcError(code, message)`：400，原样返回 `code`。
  - 其他异常：500，响应中只包含 `message`。
- 输入由扩展自己校验，推荐使用 zod。
- 长任务的做法是 RPC 立即返回任务 ID，进度通过 §5.5 的事件推送。首个版本不做流式 RPC 响应。

### 5.5 事件

```ts
export const Event = {
  Status: BusEvent.define(
    "extension.status",
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      state: Schema.Literals(["installing", "installed", "enabled", "disabled", "uninstalled", "error", "changed"]),
      error: Schema.optional(Schema.String),
    }),
  ),
  Custom: BusEvent.define(
    "extension.event",
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      data: Schema.Unknown,
    }),
  ),
}
```

- `host.emit(name, data, { directory })` 带 `directory` 时经实例 Bus 发布，UI 按目录路由；不带时以 `directory: "global"` 发到 `GlobalBus`，与 `handlers/global.ts` 发布 `global.config.updated` 的做法一致。
- 事件会广播给所有已连接的 UI，多个窗口因此自然保持同步。
- `data` 序列化后建议不超过 256 KB。更大的数据（例如大图）写入文件，或者由 UI 通过 RPC 按需获取。
- 扩展不能定义新的 Bus 事件类型，只能在 `extension.event` 内用 `name` 区分。

### 5.6 设置

- 扩展在 manifest 的 `contributes.settings` 中声明 schema，支持 `string`、`number`、`boolean` 和 `enum`，字段有 `title`、`description`、`default`、`secret`。
- 设置值存在注册表的 `settings` 中，通过 `PATCH /global/extension/:id/settings` 修改。server 校验类型后保存，调用 `host.settings.onDidChange` 的监听器，并发布 `extension.status`（`changed`）让 UI 刷新。
- `secret: true` 只影响 UI 的掩码显示。首个版本中这些值仍然明文存在本地注册表里（见 §14）。
- 只和界面显示有关的偏好（例如 notebook 字号）由 web 部分存进 `ctx.storage`，不必经过 server。

### 5.7 故障隔离

- 所有扩展代码调用（`activate`、`server`、hooks、RPC、`dispose`）都用 `Effect.tryPromise` 包裹，异常不会外泄。
- `activate()` 失败时状态置为 `error` 并发布 `extension.status`；在扩展文件或设置变化之前不重试。
- `dispose()` 设 10 秒超时，超时只记录日志。
- server 进程内的未捕获异常无法完全隔离。约定把 CPU 密集或不稳定的工作放到子进程中；首个版本不做 worker 隔离。
- 日志统一带上 `service: "extension"` 和 `extension: <id>` 字段，写入现有的日志目录。

## 6. HTTP API

### 6.1 端点

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| GET | `/global/extension` | 全局 | 已安装扩展列表 `ExtensionInfo[]`，含状态、manifest、web 资源 URL |
| GET | `/global/extension/:id` | 全局 | 单个扩展 |
| POST | `/global/extension/install` | 全局 | 请求体 `{ source, enable? }`；进度通过 `extension.status` 推送 |
| POST | `/global/extension/:id/enable` | 全局 | 启用 |
| POST | `/global/extension/:id/disable` | 全局 | 停用 |
| POST | `/global/extension/:id/update` | 全局 | 请求体 `{ version? }` |
| DELETE | `/global/extension/:id` | 全局 | 查询参数 `purgeData` |
| PATCH | `/global/extension/:id/settings` | 全局 | 请求体为部分设置 |
| GET | `/global/extension/market` | 全局 | 读取市场索引（P3） |
| POST | `/extension/:id/rpc/:method` | 实例 | 见 §5.4 |
| GET | `/file/raw` | 实例 | 查询参数 `path`，返回精确字节，见 §6.3 |
| GET | `/extension-asset/:token/:id/:version/*` | 原始路由 | web 资源，见 §6.2 |

HttpApi 组放在 `groups/extension.ts` 和 `handlers/extension.ts`。全局端点参照 `groups/global.ts` 加入 `RootHttpApi`；RPC 端点挂 `InstanceContextMiddleware`、`WorkspaceRoutingMiddleware` 和 `Authorization`，参照 `groups/presentation.ts`。

```ts
type ExtensionInfo = {
  id: string
  name: string
  version: string
  displayName: string
  description?: string
  icon?: string // 资源 URL
  source: ExtensionSource
  enabled: boolean
  state: "ready" | "disabled" | "error" | "incompatible"
  error?: string
  activation: string[]
  contributes: Contributes
  permissions: string[]
  settings: Record<string, unknown> // secret 值以掩码返回
  web?: { base: string; entry: string; styles: string[]; apiVersion: number }
  server?: { hasService: boolean; hasInstanceHooks: boolean }
}
```

### 6.2 资源路由与鉴权

要解决的问题：

- Desktop 下鉴权始终开启，而 `import(url)` 无法携带 `Authorization` 头。
- 用 `?auth_token=` 可以让入口文件通过鉴权，但入口中的 `import "./chunk-x.js"` 和 CSS 里的 `url(./font.woff2)` 解析出的 URL 不带查询参数，会返回 401。
- 把 Basic 凭据放进 URL，还会让密码出现在 DOM、日志和 Referer 中。

方案是**能力令牌路径**：

- server 启动时生成随机令牌 `crypto.randomBytes(18).toString("base64url")`，只保存在内存里，进程重启后失效。
- 需要鉴权的 `GET /global/extension` 返回 `web.base`，形如 `/extension-asset/<token>/<id>/<version>/`。
- 入口、chunk、CSS、字体、图片都在同一个前缀下，相对 URL 会自然带上令牌。
- `authorizationRouterMiddleware` 对 `^/extension-asset/<当前令牌>/` 放行，做法与 `hasPtyConnectTicketURL` 相同。令牌不匹配时返回 404 而不是 401，避免被探测。
- 处理器还要校验：
  - `id` 属于已启用的扩展。
  - `version` 与当前版本一致；开发链接的扩展用内容哈希作为版本段。
  - `Filesystem.contains(webRoot, file)` 防止路径越界，并且只提供普通文件。
- 响应头：`content-type` 由 `AppFileSystem.mimeType` 决定。正式版本使用 `cache-control: public, max-age=31536000, immutable`，开发链接使用 `no-cache`。
- 该路由是原始的 `HttpRouter.use` 层，在 `createRoutes` 中与 `uiRoute` 并列。实现时必须确认它的匹配优先于 `/*` catch-all。

备选方案是把资源路径完全公开（加入 `isPublicUIPath` 一类的白名单）。这样实现更简单，但任何能访问该端口的网页都能探测用户装了哪些扩展。建议采用令牌方案。

### 6.3 `/file/raw`

- 背景：`/file/content` 对二进制扩展名返回空内容，对文本做 `trim()`，而扩展的查看器和编辑器需要精确的内容。
- `GET /file/raw?path=<相对路径>&directory=<dir>` 返回原始字节，`content-type` 为文件的 MIME。
  - 路径必须在实例目录内，沿用 `File.read` 的 `containsPath` 检查。
  - 默认上限 50 MB，超过时返回 413。
  - 参照 `groups/presentation.ts`，用 `HttpApiSchema.asUint8Array` 声明响应。
- 前端通过 `ctx.files.readBytes()`（带鉴权头的 fetch）使用。
- 首个版本不提供通用的写接口。需要保存文件的扩展通过自己的 server RPC 写入（server 部分本身已被信任），写入时应当用 mtime 或哈希做冲突检查。

### 6.4 CSP 与 CORS 核对

| 形态 | web 入口如何加载 | 结论 |
| --- | --- | --- |
| 内嵌 Web UI（与 server 同源） | `/extension-asset/...` 同源，符合 `script-src 'self'` | 可行 |
| 代理上游 UI（`UI_UPSTREAM`） | UI 经本地 server 转发，仍是同源 | 可行 |
| Desktop 连接本地 server | 从 `oc://renderer` 跨源访问 `http://127.0.0.1:<port>`；renderer 没有 CSP；module script 需要 CORS，`isAllowedCorsOrigin` 已放行 `oc://renderer`；127.0.0.1 属于可信来源，不受 mixed content 限制 | 可行 |
| Desktop 连接远程纯 http server | `oc://renderer` 注册为 `secure`，module script 与 fetch 一样受 mixed content 规则约束 | 需实测 |
| app 开发服务器（Vite，localhost） | 跨源，CORS 已放行 localhost | 可行 |

需要调整的地方：

- 在内嵌 UI 的 CSP 中，`img-src` 和 `media-src` 加入 `blob:`，并新增 `worker-src 'self' blob:`。这样预览扩展可以使用 `URL.createObjectURL` 和 Worker（例如 PDF 或 3D 模型查看器）。`script-src` 保持不变。
- 扩展 CSS 通过 `<link>` 同源加载，符合 `style-src 'self' 'unsafe-inline'`，不需要调整。

### 6.5 SDK 与类型

- 新增端点和事件后，运行 `packages/sdk/js/script/build.ts` 重新生成 SDK。`extension.status` 和 `extension.event` 会随 `BusEvent.effectPayloads()` 进入事件联合类型。
- server 扩展的类型在 `@opencode-ai/plugin` 的基础上扩展，由 `@opencode-ai/extension-kit/server` 重新导出，版本随 opencode 发布。

## 7. 前端扩展宿主（ExtensionHost）

### 7.1 位置

`ExtensionHostProvider` 放在 `AppShellProviders`（`packages/app/src/app.tsx:412`）内，紧跟 `CommandProvider`：

```tsx
<CommandProvider>
  <ExtensionHostProvider>
    <HighlightsProvider>
      <Layout>{props.children}</Layout>
    </HighlightsProvider>
  </ExtensionHostProvider>
</CommandProvider>
```

- 它位于 `GlobalSDKProvider`、`GlobalSyncProvider` 和 Router 之下，可以获取 server 连接、事件流、命令、设置、布局和路由信息。
- 切换 server 时 `ServerScopedApp` 会整体重建，扩展宿主也随之重建，自然实现“每个 server 一套扩展”。
- 代码放在 `packages/app/src/extensions/`：`host.tsx`、`modules.ts`、`context.ts`、`registry/*.ts`。

### 7.2 状态机

```
            清单到达
 (none) ───────────► idle ──激活事件──► loading ──成功──► active
                       ▲                  │                 │
                       │              失败 │     停用 / 变更 │
                       │                  ▼                 ▼
                       └──────────────── error ◄──── deactivating
```

- `idle`：只注册了 manifest 中的静态贡献占位。
- `loading`：注入 CSS、`import()`、校验导出、调用 `activate`。
- `active`：真实的贡献已注册。
- `error`：显示错误并允许手动重试；静态贡献退回宿主的默认行为。
- 每次激活分配一个递增的 generation。停用后迟到的异步结果属于过期 generation，直接丢弃，防止出现停用后才完成的注册。

### 7.3 加载流程

1. 请求 `GET /global/extension` 并保存清单，同时订阅 `extension.status`。
2. 为启用且兼容的扩展注册静态贡献占位（§7.4）。
3. 激活时：
   1. 为 `web.styles` 中的每一项插入 `<link rel="stylesheet" data-extension="<id>">`，等待加载完成（加载失败不阻塞后续步骤）。
   2. 执行 `import(new URL(web.base + web.entry, serverUrl).href)`。
   3. 校验默认导出：`id` 与清单一致、`apiVersion` 受支持、`activate` 是函数。
   4. 创建 ExtensionContext 与扩展 owner（§7.6），调用 `activate(ctx)`，超时 10 秒。
   5. 检查 manifest 中声明、并由本次激活事件触发的贡献是否已经注册，缺失时报告错误。
4. 收到 `extension.status` 时：
   - `disabled` 或 `uninstalled`：停用。
   - `changed` 且版本或资源哈希有变化：停用后重新加载。
   - `enabled` 或 `installed`：刷新清单。

### 7.4 懒激活

| 激活事件 | 触发时机 | 激活前宿主的表现 |
| --- | --- | --- |
| `onStartup` | 宿主加载清单后立即激活 | 无 |
| `onFileViewer:<id>` | 某个文件被解析到该预览器 | 标签页显示加载占位 |
| `onTool:<tool>` | 时间线中出现该工具的调用 | 先用 `GenericTool` 渲染，激活后替换 |
| `onCommand:<id>` | 执行该命令 | 命令面板中用 manifest 里的标题显示 |
| `onPanel:<id>` | 打开该面板 | 标签页显示加载占位 |

manifest 静态声明“匹配”信息（文件扩展名、工具名、命令标题），代码只提供实现。不在 manifest 中声明的贡献也可以在激活后动态注册，但不参与懒激活。

### 7.5 共享模块桥

宿主在加载任何扩展之前先设置全局对象：

```ts
globalThis.__OPENCODE_EXTENSION_HOST__ = {
  apiVersion: 1,
  versions: { "solid-js": "1.9.10", opencode: platform.version },
  modules: {
    "solid-js": Solid,
    "solid-js/web": SolidWeb,
    "solid-js/store": SolidStore,
    "@opencode-ai/ui/button": Button,
    // ……
  },
}
```

- 扩展构建时，kit 的 vite 插件把这些裸导入改写成虚拟 shim 模块。例如 `solid-js` 对应 `const m = globalThis.__OPENCODE_EXTENSION_HOST__.modules["solid-js"]; export const createSignal = m.createSignal; ...`。导出名列表由 kit 在构建时从同版本的包中枚举生成。
- 不用 import map，原因有二：import map 需要内联的 `<script type="importmap">`，与 `script-src 'self'` 冲突；而且它必须在第一个模块加载前确定，无法在运行时追加。
- JSX 由 `vite-plugin-solid` 编译成对 `solid-js/web` 的调用，同样经过 shim，所以扩展与宿主共用一套响应式运行时和事件委托。
- 首批暴露的模块属于 apiVersion 1 的契约，改动需要升级 apiVersion：
  - `solid-js`、`solid-js/web`、`solid-js/store`。
  - `@opencode-ai/ui/` 下的 `button`、`icon-button`、`icon`、`spinner`、`tabs`、`select`、`dropdown-menu`、`dialog`、`toast`、`tooltip`、`switch`、`checkbox`、`scroll-view`、`markdown`。
- 共享库只保证存在、不属于 API 契约，版本在 `versions` 中给出：`katex`、`dompurify`。
- 兼容性：kit 把 `solid-js` 声明为 `~1.9` 的 peer 依赖；宿主加载时比较 minor 版本，不一致时警告但继续加载。
- 扩展组件作为宿主 JSX 的子节点渲染，因此可以读取宿主的 Solid 上下文（例如 `useDialog`）。非 Solid 实现走 `mount` 形态（§8.3），拿不到上下文，只能使用 `ctx` 提供的 API。

### 7.6 Owner 与清理

- 每次激活对应一个 `createRoot`，通过 `runWithOwner(hostOwner, ...)` 创建在宿主 owner 之下，所以 `useCommand`、`useDialog` 等上下文可用。
- `ctx` 上的所有注册方法内部都用 `runWithOwner(extensionOwner, ...)` 执行。Solid 的 owner 只在同步调用栈中有效，这样即使注册发生在 `activate` 里的 `await` 之后，`onCleanup` 也仍然挂在扩展 owner 上。
- 所有注册方法都返回 `Disposable`，并自动加入 `ctx.subscriptions`。
- 停用顺序：
  1. 调用 `activate` 返回的清理函数。
  2. 依次 dispose `ctx.subscriptions`。
  3. 销毁扩展 root，触发 `onCleanup`。
  4. 移除 `<link>` 样式。
  5. 按扩展 ID 批量清除各注册表中的残留项。
  6. 让当前 generation 失效。
- ES 模块无法卸载。重新加载时用新的资源 URL（版本段或哈希段不同）导入，旧模块留在内存中。开发时频繁热重载会带来少量内存增长，属于可以接受的代价。

### 7.7 错误边界与安全模式

- 扩展渲染的每个组件都包在 `<ErrorBoundary>` 中，外层是 `<div data-extension="<id>" class="oc-extension-root">`（也用于样式作用域，见 §8.8）。出错时显示扩展名、错误信息、“重新加载”和“停用扩展”按钮；文件预览器出错时回退到宿主的源码视图。
- `activate` 抛错或超时：状态置为 `error`，弹出 toast，并在扩展管理页中显示。
- 安全模式：宿主在 UI 存储中记录“启动中”标记。如果连续两次启动都没能到达“已就绪”，下次启动跳过所有 `onStartup` 扩展，并提示用户到扩展管理页处理。URL 参数 `?extensions=off` 或 Desktop 菜单项可以手动进入安全模式。

### 7.8 开发链接的热重载

- server 监听 `source.type = "path"` 的扩展的 web 根目录和 server 入口，防抖 300 ms。
- web 部分变化时，重新计算内容哈希作为版本段，发布 `extension.status`（`changed`）；UI 停用扩展后按新 URL 重新导入，已打开的扩展视图重新挂载。
- server 部分变化时，把 server 入口复制到 `Global.Path.tmp/extension-modules/<id>/<hash>/` 再导入。不能用查询参数刷新模块缓存，因为 Bun 会规范化 file URL 的查询参数（见 `loader.ts:133` 的注释）。之后先 `dispose` 旧服务，再 `activate` 新服务，最后重建实例。
- 开发者只需让 `vite build --watch` 输出到 `dist/`，不需要额外的开发服务器。

## 8. 前端扩展 API

### 8.1 入口

```ts
import { defineWebExtension } from "@opencode-ai/extension-kit/web"

export default defineWebExtension({
  id: "acme.wolfram-notebook",
  apiVersion: 1,
  activate(ctx) {
    ctx.fileViewers.register({ id: "notebook", component: NotebookView })
    ctx.toolRenderers.register({ tool: "wolfram_eval", component: WolframEvalTool, estimateHeight })
    ctx.commands.register({ id: "restartKernel", run: () => restartCurrentKernel(ctx) })
    return () => {
      // 可选：额外的清理
    }
  },
})
```

`defineWebExtension` 是恒等函数，只用于类型推断，可以直接打包进扩展。

### 8.2 ExtensionContext

```ts
export interface ExtensionContext {
  readonly id: string
  readonly version: string
  readonly manifest: ExtensionManifest
  readonly subscriptions: Disposable[]

  // 贡献点
  readonly fileViewers: ContributionRegistry<FileViewerContribution>
  readonly toolRenderers: ContributionRegistry<ToolRendererContribution>
  readonly panels: PanelRegistry
  readonly commands: ContributionRegistry<CommandContribution>
  readonly settingsPages: ContributionRegistry<SettingsPageContribution>

  // 与 server 通信
  readonly rpc: {
    call<T = unknown>(
      method: string,
      input?: unknown,
      options?: { directory?: string; signal?: AbortSignal; timeoutMs?: number },
    ): Promise<T>
  }
  readonly events: {
    on(name: string, listener: (data: unknown, meta: { directory?: string }) => void): Disposable
  }
  readonly sdk: () => OpencodeClient // 当前 server 的 v2 SDK 客户端

  // 环境
  readonly workspace: {
    directory: Accessor<string | undefined> // 当前路由的项目目录
    sessionID: Accessor<string | undefined>
  }
  readonly files: {
    readBytes(path: string, options?: { directory?: string }): Promise<Uint8Array>
    readText(path: string, options?: { directory?: string }): Promise<string>
    open(path: string, options?: { viewer?: string }): void // 在当前会话的侧栏中打开
  }
  readonly settings: {
    get<T = unknown>(key: string): Accessor<T | undefined>
    set(key: string, value: unknown): Promise<void>
  }
  readonly storage: {
    global: KeyValueStore
    workspace(directory: string): KeyValueStore
  }
  readonly assets: { url(relativePath: string): string }
  readonly theme: { mode: Accessor<"light" | "dark"> }
  readonly i18n: {
    locale: Accessor<string>
    register(dictionaries: Record<string, Record<string, string>>): void
    t(key: string, params?: Record<string, string | number>): string
  }
  readonly ui: {
    toast(options: { title?: string; description: string; variant?: "info" | "success" | "error" }): void
    dialog(render: () => JSX.Element): Disposable
  }
  readonly log: Record<"debug" | "info" | "warn" | "error", (message: string) => void>
}

export interface ContributionRegistry<T> {
  register(contribution: T): Disposable
}

export type Disposable = { dispose(): void }
```

说明：

- `rpc.call` 在未显式传入 `directory` 时自动带上 `ctx.workspace.directory()`，并使用宿主的鉴权头和 `platform.fetch`。
- `events.on` 基于 `globalSDK.listenAll`，只投递 `extension.event` 中 `id` 等于本扩展的事件。
- `storage` 复用 `Persist`（`utils/persist.ts`），键名自动加上 `ext:<id>:` 前缀；Desktop 下经 Electron 存储桥持久化。
- `log` 只接受字符串，遵守项目“前端日志必须以字符串形式输出”的规范，输出时带 `[ext:<id>]` 前缀。

### 8.3 文件预览器

```ts
export interface FileViewerContribution {
  id: string
  component: Component<FileViewerProps> | MountView<FileViewerProps>
  // 以下匹配字段通常在 manifest 中声明，运行时可以补充
  title?: string
  extensions?: string[] // 不含点，大小写不敏感
  filenames?: string[] // 完整文件名，如 "Dockerfile"
  mime?: string[] // 支持 "image/*"
  test?: (file: FileRef) => boolean // 只在运行时生效
  priority?: number // 默认 10；宿主内置预览器为 0
  mode?: "replace" | "preview" // 默认 "replace"
}

export interface FileViewerProps {
  file: { path: string; absolutePath: string; directory: string; name: string; extension: string }
  text: Accessor<string | undefined> // 宿主文件缓存中的文本，文件变化时刷新（注意已被 trim）
  revision: Accessor<number> // 磁盘上的文件每变化一次加一
  readBytes(): Promise<Uint8Array> // 精确字节（/file/raw）
  readText(): Promise<string> // 精确文本
  setDirty(dirty: boolean): void // 标签页的未保存标记
  onSave(handler: () => Promise<void>): Disposable
  showSource(): void // preview 模式下切换到源码视图
}

export interface MountView<P> {
  mount(element: HTMLElement, props: P): { update?(props: P): void; dispose(): void }
}
```

解析规则 `resolveFileViewers(file)`：

1. 收集候选：`extensions`、`filenames`、`mime`、`test` 任一命中即入选；未激活的扩展按 manifest 中的匹配信息入选。
2. 按 `priority` 降序排序，同优先级按扩展的安装顺序。
3. 用户在“打开方式”中为该扩展名选定的预览器优先于排序结果，关联记录保存在 UI 设置中。
4. 宿主源码视图（现有 `File` 组件的文本模式）永远是最后一个候选。

两种模式：

- `replace`：扩展组件接管整个标签页内容区，适合 notebook 这类需要完整控制的视图。
- `preview`：沿用 `file-media.tsx` 中现有的“预览/源码”切换条。“预览”渲染扩展组件，“源码”渲染宿主的文本视图，保留行选择、行评论等能力。CSV/TSV 表格预览会成为这种模式的第一个内置条目。

作用范围：首个版本只作用于侧栏的文件标签页。审查面板的 diff、消息附件和 `present_file` 都不经过这个注册表。

### 8.4 工具渲染器

```ts
export interface ToolRendererContribution {
  tool: string
  component: Component<ToolProps> // 与宿主 ToolRegistry 使用的 props 相同（message-part.tsx:1646）
  estimateHeight?: (input: { part: ToolPart; width: number; open: boolean }) => number
  defaultOpen?: boolean
}
```

- 注册时调用 `ToolRegistry.register`；返回的 Disposable 负责注销，并恢复之前的同名渲染器（如果有）。
- 时间线是虚拟列表（`pages/session/timeline/`），首次渲染依赖高度估算。没有提供 `estimateHeight` 时使用通用工具的默认高度，渲染后由测量修正；提供了则接入 `estimateToolPartHeight`（`estimate.ts:185`）前面新增的估算注册表。
- 工具的实时输出不需要额外通道：server 端工具执行中调用 `context.metadata()`，UI 通过 `message.part.updated` 收到新的 `metadata`，渲染器按 `props.metadata` 响应式更新即可。
- 不允许覆盖内置工具（`bash`、`edit`、`read` 等）的渲染器，注册时直接拒绝。

### 8.5 会话侧栏面板

```ts
export interface PanelContribution {
  id: string
  title: string | Accessor<string>
  icon?: string // 宿主图标名，或 ctx.assets.url(...)
  component: Component<PanelProps>
}

export interface PanelProps {
  state: Accessor<Record<string, string>>
  setState(patch: Record<string, string>): void
  close(): void
  directory: Accessor<string | undefined>
  sessionID: Accessor<string | undefined>
}

export interface PanelRegistry extends ContributionRegistry<PanelContribution> {
  open(id: string, state?: Record<string, string>): void
}
```

- 标签值格式为 `ext://<extensionID>/<panelID>`，多实例时附加 `?key=<value>`。它不是 `file://`，所以 `pathFromTab` 返回 `undefined`，`createSessionTabs` 会把它当作普通标签保留。`layout.tsx:246` 的标签规范化对非 `file://` 的值原样返回，不需要修改。
- `session-side-panel.tsx` 需要新增分发逻辑：以 `ext://` 开头的标签渲染 `ExtensionPanelContent`，`SortableTab` 从扩展宿主读取标题和图标。
- 扩展缺失或已停用时不自动删除标签，而是显示“扩展不可用”和关闭按钮，避免用户持久化的布局被悄悄改掉。
- 首个版本只支持会话右侧面板，侧边栏和底部面板以后再加。

### 8.6 命令

```ts
export interface CommandContribution {
  id: string // 扩展内 ID；全局 ID 为 ext.<extensionID>.<id>
  title?: string // manifest 中已声明时可以省略
  category?: string
  keybind?: string // 默认绑定，用户可以在设置中修改
  slash?: string
  disabled?: Accessor<boolean>
  run(source?: "palette" | "keybind" | "slash" | "menu"): void | Promise<void>
}
```

- 宿主在扩展 owner 下调用 `useCommand().register("ext:" + id, () => options)`（`context/command.tsx:455`），owner 销毁时命令自动注销。
- 扩展未激活时，manifest 中的命令以占位项出现在命令面板中；执行时先激活扩展，再调用 `run`。
- 默认 keybind 与内置命令冲突时不生效并给出警告；用户在 `settings.keybinds` 中的自定义始终优先。

### 8.7 设置页

- manifest 中声明了 `contributes.settings` 的扩展，管理页会自动生成设置表单，读写走 `PATCH /global/extension/:id/settings`。
- 需要自定义界面时调用 `ctx.settingsPages.register({ component })`，它渲染在该扩展详情页的“设置”区域。
- web 端通过 `ctx.settings.get(key)` 读取设置值。返回值是响应式的，收到 `extension.status`（`changed`）后刷新。

### 8.8 样式与主题

- 宿主的 Tailwind v4 在构建时按实际使用裁剪类名，扩展源码中写的 Tailwind 类不会生成样式，所以扩展必须自带 CSS。
- 样式作用域：宿主把每个扩展渲染的内容包在 `<div data-extension="<id>">` 中；kit 的 PostCSS 步骤给扩展 CSS 的每个选择器加上 `[data-extension="<id>"]` 前缀，防止污染宿主。少数必须全局生效的规则（如 `@font-face`）保持原样。
- 颜色、字体、间距使用宿主主题的 CSS 变量，例如 `--background-base`、`--background-stronger`、`--surface-base`、`--text-base`、`--text-weak`、`--text-strong`、`--border-weak-base`，完整列表见 `packages/ui/src/styles/theme.css`。暗色模式通过根元素上的 `[data-color-scheme="dark"]` 切换，变量值随之变化，扩展不需要单独处理。
- 优先使用共享的 `@opencode-ai/ui` 组件，让外观与宿主保持一致。

### 8.9 i18n

- `ctx.i18n.register({ zh: {...}, en: {...} })` 注册词典，键名自动加上 `ext.<id>.` 前缀。
- `ctx.i18n.t(key)` 按当前语言查找；缺失时回退到英文，再回退到键名。

## 9. 宿主改造

### 9.1 FileViewerRegistry

- 位置：`packages/ui/src/components/file-viewer-registry.ts`。`File`、`FileMedia` 都在 ui 包中，app 和 ui 都要用这个注册表。
- 接口：

```ts
export const FileViewerRegistry = {
  register(entry: FileViewerEntry): () => void
  resolve(file: FileRef): FileViewerEntry[] // 已排序
  entries: Accessor<FileViewerEntry[]> // 响应式：注册变化时，已打开的标签页会重新解析
}
```

- 迁移顺序，每一步都保持行为不变，可以单独合入：
  1. 引入注册表与 `resolve`。`file-tabs.tsx` 在渲染 `fileComponent` 之前先查询；没有扩展时结果为空，走原来的逻辑。
  2. 把 CSV/TSV 表格预览（`file-media.tsx:70` 的 `previewKind`）改成内置的 `preview` 模式条目，`previewKind` 改为查询注册表。
  3. 在标签页操作区（`OpenInApp` 旁边）加入“打开方式”菜单，列出所有候选。
  4. markdown、pdf、图片、音频、svg 暂不迁移。它们与 `File` 组件的内部状态（行选择、markdown 渐进渲染、媒体加载）耦合较深，以后按需迁移。
- `file-tabs.tsx:94-95` 的 `md()`、`pdf()` 保留，只在最终落到宿主视图时使用。

### 9.2 ToolRegistry 与消息渲染

- `registerTool` 返回注销函数；注销时如果之前有同名渲染器，就把它恢复。
- `registerPartComponent` 同样返回注销函数。它只供宿主内部使用，首个版本不向扩展开放。
- 在 `packages/app/src/pages/session/timeline/estimate.ts` 旁新增工具高度估算注册表，`estimateToolPartHeight` 先查询它。
- 内置工具名单固定，扩展不能覆盖。

### 9.3 侧栏扩展标签页

需要修改的地方见 §8.5：`session-side-panel.tsx` 的内容分发、`SortableTab` 的标题和图标，以及新增的 `ExtensionPanelContent` 组件。

### 9.4 扩展管理界面

- 位置：配置页（`pages/config.tsx`）新增“扩展”分区，与现有的技能市场并列；设置对话框（`components/dialog-settings.tsx`）的“服务器”分组中加一个跳转入口。
- 列表：名称、版本、来源、状态（启用、停用、错误、不兼容）、启停开关，以及更新、卸载、打开数据目录等操作。
- 详情：描述、权限、贡献点、设置表单、错误信息和日志路径。
- 安装：输入 npm 包名、归档 URL（需要 sha256）或本地路径；P3 加入市场浏览。
- 启停需要重建实例且有会话正在运行时，先弹出确认。

## 10. 开发工具链

### 10.1 packages/extension-kit

```
packages/extension-kit/
├── src/web.ts          # defineWebExtension 与全部 web 类型（ExtensionContext、贡献点、ToolProps 等）
├── src/server.ts       # defineServerExtension 与 server 类型（基于 @opencode-ai/plugin）
├── src/vite.ts         # vite 插件
├── src/shims.ts        # 共享模块的导出名清单（构建时生成）
├── src/manifest.ts     # manifest 校验（server 安装器与 kit 共用）
└── templates/          # 脚手架模板
```

- 包名为 `@opencode-ai/extension-kit`，导出 `./web`、`./server`、`./vite`。
- manifest 校验逻辑只写一份，server 安装器和 kit 的构建检查共用。
- 类型的版本随 opencode 发布；`apiVersion` 是运行时契约的版本。
- 注意与已有的 `packages/extensions/zed`（Zed 编辑器扩展）区分命名。

### 10.2 vite 插件

- 配置 `vite-plugin-solid`，以库模式输出 ESM：web 入口输出到 `dist/web/index.js`，CSS 提取到 `dist/web/index.css`。
- 把 §7.5 中的共享模块替换为虚拟 shim。
- 用 PostCSS 给选择器加上 `[data-extension="<id>"]` 前缀。
- 另设一个 server 构建目标：Node ESM，把全部依赖打包进 `dist/server.js`，不改写任何导入（server 部分不共享宿主模块）。
- 构建结束时校验 manifest、入口路径，并检查产物中是否残留 `solid-js` 副本，发现时报错。

### 10.3 开发流程

```bash
bunx @opencode-ai/extension-kit create my-viewer   # 生成模板
cd my-viewer && bun install
bun run dev                                        # vite build --watch
opencode extension link .
```

保存改动后，server 检测到 `dist/` 变化并推送 `extension.status`（`changed`），UI 自动重新加载扩展（§7.8）。

### 10.4 最小示例

`package.json`：

```json
{
  "name": "opencode-hello-viewer",
  "version": "0.1.0",
  "type": "module",
  "exports": { "./web": "./dist/web/index.js" },
  "opencode": {
    "manifestVersion": 1,
    "id": "example.hello-viewer",
    "displayName": "Hello Viewer",
    "web": { "apiVersion": 1, "styles": ["./dist/web/index.css"] },
    "activation": ["onFileViewer:hello"],
    "contributes": {
      "fileViewers": [{ "id": "hello", "title": "Hello 预览", "extensions": ["hello"], "mode": "preview" }]
    }
  }
}
```

`src/web.tsx`：

```tsx
import { For } from "solid-js"
import { defineWebExtension, type FileViewerProps } from "@opencode-ai/extension-kit/web"

function HelloView(props: FileViewerProps) {
  const lines = () => (props.text() ?? "").split("\n").filter(Boolean)
  return (
    <ul class="hello-list">
      <For each={lines()}>{(line) => <li>{line}</li>}</For>
    </ul>
  )
}

export default defineWebExtension({
  id: "example.hello-viewer",
  apiVersion: 1,
  activate(ctx) {
    ctx.fileViewers.register({ id: "hello", component: HelloView })
  },
})
```

## 11. 案例：WolframScript Notebook

这个案例用来检验扩展 API 能否支撑“前端视图 + 常驻后端进程 + LLM 工具”的组合。扩展本身的详细设计另写文档。

### 11.1 目标体验

- 在侧栏打开 `.wlnb` 文件（或使用 Wolfram 内核的 `.ipynb`），以 notebook 形式显示代码单元、Markdown 单元和输出。
- 单元可以编辑和运行（`Shift+Enter`）。输出支持纯文本、TeX 公式（用 KaTeX 渲染）、图形（PNG 或 SVG）、消息与错误。
- Agent 通过 `wolfram_eval` 工具在**同一个 kernel** 中执行代码：用户定义的变量 Agent 可以直接使用，反之亦然。Agent 的执行结果可以追加为 notebook 单元。
- 工具调用在对话时间线中以单元的样式渲染，图形作为附件回传给多模态模型。

### 11.2 文件格式

- 推荐直接使用 Jupyter nbformat 4，`metadata.kernelspec.language` 为 `"Wolfram Language"`。这样 GitHub 等工具可以直接渲染，也有机会与 WolframLanguageForJupyter 互通（kernelspec 名称需要实测确认）。
- 预览器匹配 `.wlnb` 扩展名；对 `.ipynb` 则通过 `test` 检查 kernelspec，只接管 Wolfram 内核的 notebook。`.wlnb` 的内容同为 nbformat JSON，用于不想与其他 Jupyter 工具关联的场景。
- `.nb`（Mathematica 原生格式）不在首个版本范围内。
- 可选（P2）：以 `preview` 模式把 `.wl`、`.wls` 中的 `(* ::Section:: *)`、`(* ::Input:: *)` 等单元标记解析成只读的 notebook 视图。

### 11.3 Kernel 协议

server 部分为每个 notebook 启动一个常驻进程 `wolframscript -file bridge.wls`，`bridge.wls` 随扩展分发。之所以常驻：每个单元都单独执行 `wolframscript -code` 要付出数秒的冷启动，而且无法保留状态。

stdin 每行一个 JSON 请求：

```json
{"id":"e1","op":"eval","code":"Plot[Sin[x],{x,0,2Pi}]","formats":["text","tex","png"],"timeoutSeconds":120}
```

stdout 中以 `\u001e`（RS 控制字符）开头的行是协议消息，其他行视为当前单元的 `Print` 输出：

```
\u001e{"id":"e1","type":"message","text":"Power::infy: Infinite expression 1/0 encountered."}
\u001e{"id":"e1","type":"result","text":"-Graphics-","tex":null,"png":"iVBORw0KGgo...","timing":0.21}
\u001e{"id":"e1","type":"done","success":true}
```

bridge 的实现要点（都需要实测）：

- 用 `EvaluationData` 收集结果、消息和耗时。
- 用 `TimeConstrained` 限制单元时长。
- 图形和图像用 `ExportByteArray[..., "PNG"]` 转成 base64。
- 公式用 `ToString[TeXForm[...]]` 生成。

中断：首个版本的“中断”就是重启 kernel，状态会丢失，界面要明确提示。以后再研究向 kernel 发送中断信号的可行性。

### 11.4 server 部分

- `activate()` 创建进程级的 `KernelManager`（§5.2）：
  - 以 notebook 的绝对路径为键管理 kernel；工具没有指定 notebook 时，使用以会话 ID 为键的临时 kernel。
  - 每个 kernel 串行执行请求队列；空闲 30 分钟自动退出。
  - 默认最多同时运行 2 个 kernel（Wolfram 许可证可能限制并发内核数），可以在设置中调整。
  - 首次启动前检查 `wolframscript` 是否可用、是否已激活，失败时返回带指引的错误。
- 进程级 RPC：`kernel.status`、`kernel.eval`（立即返回 `executionID`）、`kernel.restart`、`kernel.shutdown`。
- 事件：`cell.output`、`cell.done`、`kernel.status`（启动中、空闲、忙碌、已退出）。
- 实例级 `server()`：
  - RPC `notebook.attach` 和 `notebook.detach`：打开或关闭 notebook 视图时登记，server 据此知道哪些 notebook 正在界面中编辑。
  - RPC `notebook.save`：在实例目录内写文件，带 `expectedMtime` 冲突检查。
  - 工具 `wolfram_eval`，参数 `{ code: string; notebook?: string; appendCell?: boolean }`：
    - 通过 `input.extension.service` 使用共享的 KernelManager。
    - 执行中用 `context.metadata()` 推送部分输出。
    - 结果的 `output` 为文本和 TeX，图形放进 `attachments`（`data:image/png;base64,...`）。
    - `appendCell` 为真时：如果该 notebook 已在界面中打开，就发出 `notebook.appendCell` 事件，由视图插入单元并标记为未保存；否则由 server 直接写文件。
  - 工具暴露策略（设置项 `exposeTool`）：
    - `always`：总是返回工具。
    - `matching-projects`（默认）：项目中存在 `.wl`、`.wls`、`.wlnb` 文件才返回工具；用 glob 检查，找到第一个匹配即停止。
    - `never`：不返回工具。

### 11.5 web 部分

- 文件预览器 `notebook`：`replace` 模式，匹配 `.wlnb`，以及 kernelspec 为 Wolfram 的 `.ipynb`。
- 单元编辑器：扩展自带 CodeMirror 6，Wolfram 语法可以用 `@codemirror/legacy-modes` 中的 mathematica 模式；编辑器按需加载为独立的 chunk。
- 输出渲染：`CellOutput` 组件同时供预览器和工具渲染器使用；TeX 使用共享的 `katex`，PNG 以 data URL 显示。
- 保存：用 `onSave` 注册保存处理函数，内部调用 `notebook.save` RPC；`setDirty` 驱动标签页的未保存标记。
- 命令：`restartKernel`、`runAll`、`clearOutputs`。
- 工具渲染器 `wolfram_eval`：显示代码和输出，并提供按代码行数和输出类型计算的 `estimateHeight`。

### 11.6 风险

| 风险 | 应对 |
| --- | --- |
| wolframscript 未安装或未激活 | 启动前检测，错误信息给出安装和激活指引 |
| 冷启动慢（数秒） | kernel 常驻；打开 notebook 时预热 |
| 死循环或长时间计算 | `TimeConstrained`，必要时重启 kernel |
| 许可证并发限制 | 默认最多 2 个 kernel，其余请求排队并显示状态 |
| 用户与 Agent 同时修改 notebook | notebook 打开时由视图负责写入；server 写入时做 mtime 冲突检查 |
| 输出的图片过大 | 事件中只放缩略信息，完整图片由 UI 通过 RPC 获取 |

## 12. 安全模型

- 信任边界：安装扩展就等于信任它。web 部分与 app 权限相同，可以用 SDK 调用任意 server API，包括让 agent 执行命令；server 部分在 server 进程内运行任意代码。
- 降低风险的措施：
  - 安装确认页展示来源、发布者（npm scope 或 URL 域名）、版本、声明的权限和贡献点。
  - 归档安装必须校验 sha256；npm 安装沿用 registry 的完整性校验；安装过程不执行任何脚本。
  - 不自动更新；更新时展示版本差异，权限有变化时再次确认。
  - 可以随时一键停用。`OPENCODE_DISABLE_EXTENSIONS=1`、`--pure`、UI 安全模式都能绕开有问题的扩展。
  - 渲染不可信内容（HTML、SVG、Markdown 中的原始 HTML）的预览器必须使用不带 `allow-same-origin` 的 `sandbox` iframe，或用 DOMPurify 清洗（宿主已依赖 `dompurify`，作为共享库暴露）。
  - 资源令牌只能读取已启用扩展的 web 目录，每次 server 重启都会更换。
- 远程 server：扩展安装在 server 所在的机器上，UI 只负责加载。连接一个陌生的远程 server 等于运行它的扩展前端代码，连接前的提示中应当说明这一点。

## 13. 分阶段实施与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 宿主改造 | FileViewerRegistry 与“打开方式”菜单；CSV/TSV 迁移为内置条目；`registerTool` 和 `registerPartComponent` 返回注销函数；工具高度估算注册表；侧栏 `ext://` 标签的分发骨架 | 现有测试和 typecheck 通过；md、pdf、图片、csv 的预览行为不变 |
| P1 web 扩展链路 | 注册表与 `opencode extension link/list/enable/disable`；只含 web 部分的 `Extension.Service`；`/global/extension`、资源路由、`extension.status`；`/file/raw`；CSP 调整；ExtensionHost、共享模块桥、懒激活、安全模式；`extension-kit` 的 web 类型与 vite 插件；hello-viewer 示例 | Desktop（鉴权开启）、内嵌 Web、Vite 开发三种形态下，`link` hello-viewer 后都能用它打开 `.hello` 文件；停用后预览器消失且不需要刷新；资源路由的越界和错误令牌测试通过 |
| P2 server 部分 | `defineServerExtension`（`activate` + `server`）；接入 `Plugin.state`；RPC 端点；`extension.event`；设置；开发链接的热重载 | 示例扩展包含 RPC 回显、事件流和一个 LLM 工具；停用时子进程全部退出；热重载后 server 与 web 部分都更新 |
| P3 分发与管理 | npm 与归档安装、卸载、升级；扩展管理页与设置表单；市场索引；安装确认 | 从 npm 和带 sha256 的归档都能安装成功；校验失败、版本不兼容、ID 冲突各有明确的错误信息 |
| P4 首批扩展 | WolframScript Notebook；新的文件预览扩展 | 按 §11.1 逐条验证体验；Agent 与用户共享 kernel 状态 |

测试要点：

- server：manifest 校验、注册表并发（flock）、安装失败回滚、资源路由的越界与令牌校验、RPC 路由与超时、`activate` 和 `dispose` 的失败处理。测试夹具放在 `packages/opencode/test/extension/fixtures/`。
- 前端：注册与注销；owner 清理（停用后没有残留的命令、样式、事件监听）；懒激活占位；generation 失效；错误边界。用 happy-dom 做单测（`packages/app` 的 `bun test --preload ./happydom.ts`）。
- 端到端：按仓库约定，在开发版 Electron 上用 CDP 验证（`bun packages/desktop/scripts/cdp.ts`）。

## 14. 待定问题

1. 是否需要项目级启用，即只在部分项目中加载 server 部分或暴露工具？首个版本是全局启用，再加上扩展自己的工具暴露策略。
2. `secret` 类型的设置是否接入现有的认证存储，避免明文写进注册表？
3. 通用的 `.ipynb` 查看器将来由谁提供？Wolfram 扩展只接管 Wolfram 内核的 notebook，其他的交给将来的 Jupyter 扩展或宿主源码视图。
4. 市场索引托管在哪里？例如 GitHub 仓库里的静态 JSON；是否与技能市场（`config-skill-market.ts`）共用获取逻辑？
5. 现有的 Math Mode（`config.math.disabled` 开关、`pages/session/math-*`、`cli/cmd/math.ts`）是否迁移为官方扩展，作为扩展 API 的第二个验证用例？
6. 是否需要为扩展视图提供按焦点生效的快捷键作用域？例如 notebook 编辑器中的 `Shift+Enter`、`Mod+S` 如何与全局 keybind 协调。
7. 扩展的 web 部分是否需要在未连接 server 的界面（例如 server 选择页）中可用？首个版本不支持。
