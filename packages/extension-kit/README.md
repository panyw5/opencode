# @opencode-ai/extension-kit

OpenCode 扩展开发工具包（SDK）。提供四个入口：

| 导入路径 | 用途 |
|---|---|
| `@opencode-ai/extension-kit/web` | web 入口类型与 `defineWebExtension` |
| `@opencode-ai/extension-kit/server` | server 入口类型、`defineServerExtension`、`ManagedProcess` 契约 |
| `@opencode-ai/extension-kit/rpc` | `defineRpc` 类型化 RPC 契约、`ExtensionRpcError`、Standard Schema |
| `@opencode-ai/extension-kit/vite` | web 构建插件（共享模块 shim、CSS 作用域、solid 版本戳） |

官方示例见 [`packages/extensions/hello-viewer`](../extensions/hello-viewer)：覆盖本指南大部分主题（fileViewer 贡献点、typed RPC、事件、`host.spawn`、LLM 工具、process 隔离 manifest）。

---

## 快速开始

```bash
# 从模板创建（两者均为零依赖、纯 ESM，可整体复制到独立仓库）
opencode extension create my-ext --template web-and-server   # 或 server-only

cd my-ext
opencode extension validate .        # 用安装同款规则检查 manifest/入口/打包路径
opencode extension pack .            # validate + npm pack，产出 .tgz 与 sha256
```

本地开发用 `link` 挂入（新链接默认启用；重链接保留启停状态）：

```bash
opencode extension link /abs/path/my-ext
```

宿主监听**实际导出入口**（`exports["./web"]`/`exports["./server"]` 解析到的文件）的内容指纹变化并热重载。改动源文件后要确保构建器已写出产物；不协作的后台任务可能留下 `needsRestart`，按提示重启开发实例即可。

模板自带 `npm test` 与离线打包/发布脚本（`scripts/release.mjs`），不依赖 monorepo；在本仓库内开发的扩展（如 `packages/extensions/*`）直接用 Vite + `bun build` 构建后 link。

---

## 扩展包结构

```
my-ext/
├── package.json          # exports + opencode manifest + files 白名单
├── dist/server.js        # server 入口：打包好的 ESM（依赖已内联）
└── dist/web/index.js     # web 入口：ESM + index.css
```

- web/server 至少有一个；`exports["./web"]`、`exports["./server"]` 声明入口，路径必须位于包目录内。
- 产物应为**打包后无运行时依赖**的 ESM：`dependencies` 为空，安装只解包不解析依赖；不能用安装期脚本（安装器 `ignoreScripts`）；不能依赖 native addon。详见 `specs/extensions/design.md` §3.4。
- `files` 白名单建议显式声明；`validate` 会预演 npm 打包清单并检查入口/样式/图标都被覆盖。

## Manifest 字段参考

扩展 manifest 是 `package.json` 的 `opencode` 对象。Schema 权威定义见 `packages/opencode/src/extension/schema.ts`。

### `package.json` 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | npm 包名 |
| `version` | 是 | 合法 semver；扩展版本独立维护，不跟随主仓库 |
| `engines.opencode` | 否 | 宿主版本范围（semver range）；不满足时加载即 `incompatible`。宿主 dev 版号（如 `1.18.64-local.5`）按去掉 prerelease 段的基版本比较 |
| `exports["./web"]` / `exports["./server"]` | 至少一个 | 入口文件；`./web` 存在时 manifest 必须声明 `opencode.web`，反之亦然 |
| `files` | 建议 | 打包白名单；缺失时 `validate` 警告并按全目录预演 |

### `opencode.*` 字段

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `manifestVersion` | 是 | — | 恒为 `1`；其他值**硬拒绝**（`incompatible`） |
| `id` | 是 | — | `publisher.name` 形式：`^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`，≤64 字符；`opencode.` 前缀保留给官方 |
| `displayName` | 是 | — | UI 显示名 |
| `description` | 否 | — | 描述文本 |
| `icon` | 否 | — | 图标路径；有 web 部分时必须位于 web 根目录内，否则在包目录内 |
| `web.apiVersion` | 有 web 必填 | — | 当前恒为 `1`；未知值只**丢弃 web 部分**并告警（`web.apiVersion:<n>`），server 部分照常 |
| `web.styles` | 否 | `[]` | CSS 文件路径数组，必须位于 web 根目录内 |
| `server.isolation` | 否 | `"process"` | server 执行后端，见下文"隔离模式"节 |
| `server.apiVersion` | 否 | `1` | 恒为 `1`；未知值丢弃 server 部分并告警（`server.apiVersion:<n>`） |
| `activation` | 否 | `["onStartup"]` | 激活事件，见下文 |
| `contributes` | 否 | — | 贡献点，见下文 |
| `permissions` | 否 | `[]` | 固定词表自述权限，见下文 |

### `permissions` 词表与语义

`fs:read`、`fs:write`、`process:spawn`、`network`、`tools`、`settings:secret`。

权限是**扩展自述**：词表外条目只打 warn 日志并在 UI 标"未知权限"，不阻止安装；UI 统一注明"声明，不强制"。唯一的执行点在 **process 隔离模式**下（见"隔离模式"节）：未声明 `tools` 时宿主丢弃扩展注册的全部 LLM 工具；未声明 `process:spawn` 时 `host.spawn` 调用被拒。`inline` 模式下全部声明不强制。

## 贡献点与激活事件

### `contributes` 类型

| 贡献点 | 条目字段 | 说明 |
|---|---|---|
| `fileViewers[]` | `id`、`title`、`extensions?`、`filenames?`、`mime?`、`priority?`、`mode?`（`replace`/`preview`）、`content?`（`text`/`self`） | 文件查看器；三个 matcher 至少一个 |
| `toolRenderers[]` | `tool` | 为某个（本扩展的）工具定制渲染器；`tool` 写**未加前缀的裸名** |
| `commands[]` | `id`、`title`、`category?`、`keybind?`、`slash?` | 命令 |
| `panels[]` | `id`、`title`、`icon?` | 会话侧栏面板 |
| `settings`（record） | `{type,title,description?,default?,enum?,secret?}` | 设置项，见"Settings 与 secrets"节 |

校验规则：viewer/command/panel 的 `id` 在扩展内唯一；`default`/`enum` 必须与 `type` 匹配。

### 激活事件

合法词形：`onStartup`、`onFileViewer:<id>`、`onTool:<tool>`、`onCommand:<id>`、`onPanel:<id>`。

- **`onStartup` 是唯一有运行时含义的事件**：声明后宿主加载清单即激活。省略 `activation` 等价于 `["onStartup"]`——**不声明反而总是立即激活**，想要懒加载就显式写出贡献点事件。
- 其余事件是**声明性提示，不是门控**（D2）：每个贡献点都注册占位，被用到即隐式激活；贡献点缺对应事件只记 info 日志。
- 悬空引用仍是错误：`onFileViewer:x` 指向未声明的贡献点会校验失败。
- 贡献点 `id` 只需扩展内唯一；viewer/panel 全局 ID 为 `<extensionID>:<id>`，命令为 `ext.<extensionID>.<id>`（design.md §3.3）。

## Web API（`@opencode-ai/extension-kit/web`）

web 入口默认导出 `defineWebExtension({...})`；`id` 必须与 manifest 一致，`apiVersion` 当前恒为 `1`。`activate(context)` 可返回清理函数。

`ExtensionContext` 提供：`fileViewers`/`toolRenderers`/`panels`/`commands` 的 `register(...)`（均返回 `Disposable`）、`assets.url(relativePath)`（web 根目录内资源的 URL）、`log`、`rpc`、`events`、`settings`。组件是 Solid `Component`——`solid-js` 与 `@opencode-ai/ui/*` 由宿主共享模块机制提供，**不要打进产物**（kit vite 插件会把这些 import 改写成宿主 shim 并给 CSS 加 `[data-extension="<id>"]` 作用域前缀，同时在入口写入 `__opencodeBuild.solid` 版本戳供宿主做 minor 版本核对）。

## Server API（`@opencode-ai/extension-kit/server`）

server 入口默认导出 `defineServerExtension({...})`，两个生命周期钩子均可选：

```ts
export default defineServerExtension({
  id: "publisher.name",            // 必须与 manifest id 一致
  // 进程级：每扩展一次，activate() 有 10s 截止；不要在里等待无限循环
  async activate(host): Promise<ExtensionService | void> {
    return {
      rpc: { echo: async (input, ctx) => ({ ... }) },   // service.rpc
      async dispose() { /* 清理 */ },
    }
  },
  // 实例级：每个打开的项目目录一份 hooks
  async server(input, options): Promise<ExtensionHooks> {
    return {
      tool: { mytool: tool({...}) },                    // LLM 工具
      rpc: { ... },                                      // 实例级 RPC（优先于 service.rpc）
      event: async ({ event }) => { ... },              // 订阅宿主 Bus 事件
      async dispose() { ... },
    }
  },
})
```

`ExtensionHost`（`host` / `input.extension`）提供：`id`、`version`、`dataDir`、`cacheDir`、`serverUrl`、`settings`、`setTimeout`/`setInterval`（**托管计时器，后台任务一律用它**）、`spawn`、`emit`、`log`。`input.extension.service` 指向 `activate()` 返回的 service，实例代码可直调其中的 rpc。

后台任务与错误隔离约定见 `specs/extensions/isolation-authoring.md`（托管计时器、quiesce、needsRestart 语义）。

## RPC 与事件

### 类型化契约：`defineRpc`

```ts
// src/contract.ts —— web/server 共享
export type Contract = { echo: { input: { message?: string }; output: { echo: string } } }
export const rpc = defineRpc<Contract>()
```

- server 侧 `service.rpc = rpc.handlers({ echo: { input: schema?, handle } })`：handler 可以是裸函数或 `{ input, handle }`；`input` 接受任意 **Standard Schema V1** 校验器（zod/valibot/arktype 或手写对象），校验失败抛 `ExtensionRpcError("invalid_input")`，成功时 handler 收到的是校验器（可能经过 coercion 的）`value`。
- web 侧 `const call = rpc.bind(context.rpc); await call("echo", { message: "hi" })`：转发到底层 `rpc.call`，只加类型。契约缺方法/多方法两端都会 typecheck 失败。
- 无类型路径 `context.rpc.call<T>(method, input, options)` 兼容可用；`options` 支持 `directory`、`signal`、`timeoutMs`。
- handler 内 `ctx.directory` 是请求来源实例目录（`service.rpc` 可能为 `undefined`），`ctx.signal` 随客户端断开 abort。
- 错误约定：抛 `ExtensionRpcError(code, message)` 让 `code` 原样传给调用方；其他异常只回 `message`。宿主侧有每扩展 **32 并发上限**（超限 `code:"busy"`）与实例查找顺序（带 `directory` 先实例 rpc 后 service rpc；见 `design.md` §5.4）。

### 事件：`host.emit` / `context.events`

- `host.emit(name, data, { directory? })` 复用单一 `extension.event` 总线事件，以 `name` 复用区分——**约定用 `<extId>/<event>` 命名**（如 `example.hello-viewer/greeting`）。不带 `directory` 广播到全局；带 `directory` 按实例路由。
- web 侧 `context.events.on(name, listener)` 返回 `Disposable`。
- `data` 需可 JSON 序列化，建议 ≤256 KB；`emit` 有令牌桶限流（200/s、突发 400），超出丢弃并记聚合 warn。

## Settings 与 secrets

在 `contributes.settings` 声明 schema（`string`/`number`/`boolean`、`title`、`default`、`enum`、`secret`），用户值存注册表、按 key 覆盖 default。

- **server 侧**：`host.settings.get()` 拿到解析后的**明文**（扩展有权读自己的 secret）；`onDidChange` 监听变更。
- **web 侧**：`context.settings.get(key)` 返回响应式 `Accessor`；**secret 值永远是掩码 `********`**，扩展看不到明文。`context.settings.update(patch)` 局部更新：`null` 删除该键回到 manifest default；patch 里的掩码值会被剥离、不回写。
- 声明 `secret: true` 的设置建议同时声明 `settings:secret` 权限（自述约定）。

## `host.spawn` 托管子进程

```ts
const child = host.spawn("wolframscript", ["-file", "bridge.wls"], { stdio: ["pipe", "pipe", "pipe"] })
```

- 返回 `ManagedProcess`：`stdin/stdout/stderr`（对应 stdio 为 `"pipe"` 时非 null）、`pid`、`exited`、`killed`、`exitCode`、`exitSignal`、`onExit`、`onError`、`kill("TERM"|"KILL")`。
- 子进程在**独立进程组**中运行：扩展 disable/reload/卸载/宿主退出时由宿主按 TERM → 宽限（默认 3s）→ KILL → 等待真实 exit 的顺序整组回收，孙进程也逃不掉。**不要**自行 `child_process.spawn`——绕过托管的进程不会被代际清理。
- `stdio: "inherit"` 在 process 隔离下并入宿主日志流（worker 没有 tty）。
- **pid 异步语义**：process 隔离下 `spawn()` 先返回代理对象，`pid` 可能短暂为 `undefined`，待宿主握手后回填；spawn 被拒（权限/失败）走 `onError` + `exited` 终态。`onExit` 是唯一可靠的完成信号。
- `kill()` 是 fire-and-forget；观察 `onExit` 确认退出。
- 编译二进制形态下 `process.execPath` 不可作 JS runtime；需要派生 JS 子进程时参考 hello-viewer 的 `resolveChildRuntime`（回退 PATH/`OPENCODE_JS_RUNTIME`）。

## 工具命名空间 `<extName>_<tool>`

实例 hooks 注册的 `tool` 以**裸名**声明（如 `wolfram_eval`），宿主并入 ToolRegistry 时统一改名为 `<ns>_<tool>`：`ns` 取扩展 id 最后一段、`-` 转 `_`。例如 `local.wls-repl` 的 `wolfram_eval` 对 Agent 暴露为 `wls_repl_wolfram_eval`。

- manifest 的 `toolRenderers[].tool` 和 `onTool:<name>` 都写裸名，作者无需关心前缀。
- 改名后与内置工具或其他扩展冲突：该扩展进 `error` 状态并记 error 日志。
- 旧工具名（未命名空间化）的历史会话：渲染器兼容匹配一个版本。

## 隔离模式（`server.isolation`）

| 值 | 语义 |
|---|---|
| `"process"`（默认） | server 入口在独立的 `extension-host` worker 进程中运行，每扩展一进程、按需启动；崩溃只影响本扩展 |
| `"inline"` | 在 sidecar 进程内执行，**仅限本地 `path` 来源**（开发调试）；受管来源声明 inline 仍按 inline 运行（回退兼容）但携带稳定告警码 `server.isolation:inline` |

**边界声明**：process 隔离提供**故障隔离 + API 级限制，不是安全沙箱**。worker 内代码仍可自行 `import("node:child_process")`、读任意文件——`host.spawn` 的拒绝只封代理通道。信任模型不变：只安装你信任的扩展。

process 模式下的 API 限制（详见 `specs/extensions/process-isolation-design.md` §3/§6）：

- `input.$`（BunShell）：访问即抛错，迁移到 `host.spawn`。
- `input.client`：v1 打桩，访问即抛错（凭据通路已预留）。
- `input.experimental_workspace.register`：抛错。
- 实例 hooks 只允许 `tool`/`rpc`/`event`/`dispose`；返回其他键（`chat.*`、`permission.*`、`config`、`auth`、`provider` 等 mutable-output 钩子）会在 `instance.start` 报错。
- 权限粗粒度执行：未声明 `tools` → 工具描述符被丢弃（不置 error）；未声明 `process:spawn` → `host.spawn` 返回 `denied`。
- `host.settings` 语义不变（本地快照 + `settings.changed` 推送）；`setTimeout`/`setInterval` 为 worker 本地实现、随进程消亡。
- 冷启动开销：源码环境粗测**冷激活约 0.75s**（vs inline 约 2ms），RPC p50 约 +15%；扩展崩溃后按 1s/5s/30s 指数退避最多自动重启 3 次。
- 全局 kill-switch：`OPENCODE_EXTENSION_ISOLATION=inline` 优先于 manifest。

## 发布流程

```bash
opencode extension pack .          # → <name>-<version>.tgz + sha256
opencode extension install ./<name>-<version>.tgz --sha256 <sha> --yes   # 本地验证
```

发布到 `panyw5/open-extensions`（官方分发仓库，见根 `AGENTS.md` 例外条款）由 `script/extension-publish.ts <name>` 自动化：

1. 校验 monorepo 扩展目录干净，记录 commit → 写入描述符 `source.commit`（溯源）。
2. `bun run build` → `npm pack` 产出 tgz → `gh release create <name>-v<version>` 上传。**产物不可变**：同 tag 摘要一致则跳过，不一致报错要求升版本。
3. `script/extension-release.ts` 生成 `stable.json` 描述符（`artifact.url/sha256`、单调递增 `sequence`），用 `OPENCODE_EXTENSION_SIGNING_KEY`（Ed25519，仅环境变量注入）签 `stable.json.sig`。
4. 只把 `stable.json` + `.sig` 提交推送到发布仓库；源码不同步。

独立发布（不用 publish 脚本）可用 `script/extension-release.ts --archive <tgz> --artifact-url <https://...> --output stable.json [--signature stable.json.sig]` 手工生成描述符；`script/verify-pack.ts` 验证 kit 打包后在仓库外的真实构建链路。

用户侧安装语义：描述符 URL 落在受信 origin 内**必须验签**；`sequence` 回退被拒（`rollback_detected`）；`engines.opencode` 不满足标记 `incompatible`。描述符签名协议见 `specs/extensions/release-install-design.md`。

## 依赖声明约定

扩展的 `package.json` 遵循统一约定：

- **`devDependencies` 放一切会被打包进产物的内容**：`@opencode-ai/extension-kit`、`@opencode-ai/plugin`、以及扩展自带的库（如 `@opencode-ai/wolfram-lang`、`virtua`）。web 产物由 Vite 打包、server 产物由 `bun build` 打包，运行时不解析 `node_modules`，所以这些依赖只需要在构建期存在。
- **宿主共享的模块不打包，也不声明为运行时依赖**：`solid-js`、`@opencode-ai/ui` 由宿主通过共享模块机制提供（见 kit 的 Vite 插件与 `shims.js`），构建时会被替换为宿主 shim。它们留在 `devDependencies` 只是为了类型检查。
- **`dependencies` 保持为空或不写**：扩展包发布后不会经历 `npm install`，声明运行时依赖没有意义，只会误导读者。

## 深入阅读

- `specs/extensions/design.md`——扩展系统总体设计（包格式 §3、运行时 §5、web API §8、激活 §7.4、权限 §3.3/§12）
- `specs/extensions/process-isolation-design.md`——进程隔离代理面、限制与崩溃策略
- `specs/extensions/isolation-authoring.md`——后台任务/计时器/错误隔离作者约定
- `specs/extensions/release-install-design.md`——描述符签名与安装信任链
