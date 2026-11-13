# hello-viewer — 官方扩展示例

一个刻意保持小巧但覆盖完整 API 面的 OpenCode 扩展（`example.hello-viewer`）：为 `.hello` 文件提供替换式查看器，同时带一个 server 部分演示 RPC、事件、`host.spawn` 和一个 LLM 工具。对照 [`@opencode-ai/extension-kit` README](../../extension-kit/README.md) 各节阅读本目录。

## 结构导览

```
package.json          # exports ./web ./server + opencode manifest + engines.opencode
src/
├── contract.ts       # typed RPC 契约：defineRpc<Contract>() + 手写 Standard Schema 校验器
├── server.ts         # server 入口：activate() → service.rpc + dispose；server() → hooks.tool
├── web.tsx           # web 入口：defineWebExtension + fileViewer 注册 + rpc.bind + events.on
├── web.css           # 带 [data-extension="example.hello-viewer"] 作用域前缀的样式
├── child-runtime.ts  # 派生 JS 子进程时的 runtime 解析（execPath → PATH/OPENCODE_JS_RUNTIME 回退）
test/                 # server 单元测试（用非托管 spawn 替身）+ child-runtime 测试
vite.config.ts        # extensionKit() 插件一行接入
```

## 对照作者指南看代码

| 主题（kit README 节） | 代码位置 |
|---|---|
| 扩展包结构与 manifest | `package.json`：`exports`、`opencode.*`（含 `server.isolation:"process"`、`permissions`） |
| 贡献点与激活事件 | `opencode.contributes.fileViewers` + `activation:["onFileViewer:hello"]`；web.tsx 注册同名 `id:"hello"` |
| Server API | `server.ts`：`activate(host)` 返回 `{rpc, dispose}`；`server(input)` 返回 `{tool:{greet}}` |
| RPC 与事件 | `contract.ts` 共享契约；`server.ts` `rpc.handlers({...})`（`echo`/`greet`/`child.*`）；`web.tsx` `rpc.bind(context.rpc)`；`host.emit` ↔ `context.events.on`（`example.hello-viewer/greeting`） |
| `host.spawn` | `server.ts` `startChild`/`stopChild`/`pingChild`：懒启动、行协议 stdin/stdout、`onExit/onError`、TERM 回收 |
| 工具命名空间 | `server.ts` 工具裸名 `greet` → 对 Agent 暴露为 `hello_viewer_greet` |
| 共享模块/构建 | `vite.config.ts` 用 `extensionKit()`；`web.tsx` 直接 import `solid-js` 与 `@opencode-ai/ui/*`（构建期改 shim） |

注意 `web.tsx` 对 `context.rpc`/`context.events` 做了**可用性降级**：宿主不提供桥接时查看器仍可纯渲染——这是个好习惯，server 部分并非所有宿主都启用。

## 构建与本地调试

```bash
bun install
bun run --cwd packages/extensions/hello-viewer build          # vite build + bun build server
bun run --cwd packages/opencode src/index.ts extension link "$PWD/packages/extensions/hello-viewer"
```

新建一个 `.hello` 文件打开即可看到查看器；`bun run dev`（vite --watch）可持续产出 web 产物供宿主热重载。

## 测试

```bash
bun run --cwd packages/extensions/hello-viewer typecheck
bun run --cwd packages/extensions/hello-viewer test
bun run --cwd packages/extensions/hello-viewer build
```
