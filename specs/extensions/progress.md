# Extensions 实施进度

更新时间：2026-09-27

## 当前状态

- 总体状态：**P0 已完成并验证，待提交**。
- 工作分支：`claude/extensions-p0`
- 工作目录：`.claude/worktrees/extensions-p0`
- 设计文档：[`design.md`](design.md)
- 下一阶段：P1（web 扩展加载链路）。

## P0：宿主改造

状态：**已完成**

### 已完成内容

- 新增 `FileViewerRegistry`：
  - 支持按扩展名、完整文件名、MIME 和自定义 `test` 匹配。
  - 支持优先级排序。
  - 注册方法返回 disposer，扩展停用后可撤销注册。
- 将 CSV/TSV 表格预览迁移为内置 `preview` viewer。
- 文件标签页支持 `replace` viewer：
  - 有候选 viewer 时显示“打开方式”。
  - 可在默认源码查看器和自定义 viewer 之间切换。
  - 无候选 viewer 时不显示额外入口。
- `registerTool` 和 `registerPartComponent` 支持注销并恢复之前的注册项。
- 新增工具调用高度估算注册表，并接入虚拟时间线高度估算。
- 新增 `ext://<extensionID>/<panelID>` 面板标签骨架：
  - 标签解析与生成。
  - 面板注册与注销。
  - 标题、图标、组件和初始 query state。
  - 组件级 `ErrorBoundary`。
  - 扩展停用后保留标签并显示“扩展不可用”。
- 新增英文、简体中文、繁体中文文案。
- 完成扩展系统完整设计文档。

### 主要文件

- [`packages/ui/src/components/file-viewer-registry.ts`](../../packages/ui/src/components/file-viewer-registry.ts)
- [`packages/ui/src/components/file-table-preview.tsx`](../../packages/ui/src/components/file-table-preview.tsx)
- [`packages/ui/src/components/file-media.tsx`](../../packages/ui/src/components/file-media.tsx)
- [`packages/ui/src/components/message-part.tsx`](../../packages/ui/src/components/message-part.tsx)
- [`packages/app/src/pages/session/file-tabs.tsx`](../../packages/app/src/pages/session/file-tabs.tsx)
- [`packages/app/src/extensions/panel-tab.ts`](../../packages/app/src/extensions/panel-tab.ts)
- [`packages/app/src/extensions/panel-registry.ts`](../../packages/app/src/extensions/panel-registry.ts)
- [`packages/app/src/extensions/panel-content.tsx`](../../packages/app/src/extensions/panel-content.tsx)
- [`packages/app/src/pages/session/timeline/tool-height.ts`](../../packages/app/src/pages/session/timeline/tool-height.ts)

## 验证结果

### 自动化测试

- `packages/ui` typecheck：通过。
- `packages/app` typecheck：通过。
- UI 测试：**207 pass，0 fail**。
- P0 app 定向测试：**233 pass，0 fail**。
- app browser 测试：**39 pass，0 fail**。
- `git diff --check`：通过。

### Electron CDP 实机验证

使用 worktree 构建并启动开发版 Electron，验证完成后已停止该开发实例；未关闭安装版 OpenCode。

已验证：

- CSV 表格预览及“预览/源码/预览”切换正常。
- TSV 表格预览正常。
- Markdown 预览正常。
- PNG base64 预览正常。
- TypeScript 和未知扩展名回退源码查看器正常。
- 动态注册 `.hello` replace viewer 后：
  - 自定义 viewer 能接管文件。
  - `path`、`text` props 正确。
  - “打开方式”菜单正确显示并切换 viewer。
  - 注销后恢复默认源码查看器，菜单入口消失。
- 动态注册 `ext://test.demo/notes?key=fixture&foo=bar` 面板后：
  - 标题、图标、组件和初始 state 正确。
  - 注销后标签保留，并显示“扩展不可用”。
- 开发版日志未发现与本次改动相关的未捕获异常。
- 所有 CDP 临时探针均已移除。

## 已知限制

- PDF 标签页仍显示现有的“PDF不可预览”fallback。
- 根因是现有 `/file/content` 对 PDF 返回空二进制内容，而当前文件标签页没有可用的原始字节读取通道。
- 这不是 P0 引入的回归；设计中的 P1 `/file/raw` 会解决该问题。
- 扩展面板 `setState` 当前是进程内内存状态，不改写 tab URL，也不跨应用重启持久化；完整持久化留给 ExtensionHost。

## P1：web 扩展加载链路

状态：**已完成并验证，待提交**

已完成：

1. 本地 path extension manifest 严格校验与版本兼容检查。
2. flock + 原子 rename 的全局 registry；link/list/enable/disable CLI。
3. 模块级 capability token 与薄 `Extension.Service`，支持 `--pure` / `OPENCODE_DISABLE_EXTENSIONS=1`。
4. `/global/extension` 清单与启停 API、`extension.status` 事件及 SDK 生成。
5. 安全的 `/extension-asset/...` 路由：精确 token、真实路径 containment、symlink/HTML 拒绝、CORS/MIME/cache 头。
6. `/file/raw` 精确字节读取：50 MB 上限、越界和 symlink 防护、HTML 下载安全 MIME。
7. CSP 的 blob image/media/worker 支持。
8. `@opencode-ai/extension-kit` web API、Vite shared-module shim 与 Solid runtime parity 测试。
9. `hello-viewer` 示例 extension 及可分发的 `dist/web` 产物。
10. 前端 ExtensionHost：静态 viewer placeholder、懒激活、generation、同源校验、CSS/owner/disposer 清理、事件启停与显式安全模式。
11. Desktop dev 支持 `OPENCODE_CDP_PORT`，可与其他开发会话并行验收。

## 验证结果

### 自动化

- 全 workspace typecheck：18 个可执行 package 全部通过。
- manifest/registry/CLI/service + management/asset routes：20 tests，0 fail。
- management/asset/raw/CSP 定向组合：35 tests，0 fail。
- ExtensionHost + panel：17 tests，0 fail。
- FileViewerRegistry：9 tests，0 fail。
- extension-kit shared shim parity：7 tests，0 fail。
- app browser-condition tests：39 tests，0 fail。
- UI 全量测试：207 tests，0 fail。
- HttpApi exerciser 的新增 extension 与 raw route 在 coverage/auth 模式全部通过；全命令仍因仓库基线已有 19 个其它 route 缺少 scenario 而退出 1。
- app 全量 unit suite 仍有 3 个基线失败：`injectionPreviewFromParts`、`session-render-state` identity 断言、`rows.test.ts` 的 `useData` export；P1 定向与 browser tests 全通过。
- opencode 全量 suite 也包含多个既有并发/环境失败；P1 定向 tests 全通过。

### Vite Web（server Basic Auth 开启）

- 通过 `auth_token` 连接 `127.0.0.1:4196`，打开 `.hello` 自动 lazy activate。
- entry 与 CSS 从 capability-token server URL 加载；共享模块表只含宿主 Solid/UI。
- `Inspect bytes` 经 `/file/raw` 返回 **28 bytes**。
- HTTP disable 经 SSE 无刷新撤销 viewer、CSS、owner，并回退源码；enable 后当前标签自动恢复 viewer。
- `?extensions=off` 禁止加载并持久化；`?extensions=on` 恢复。

### 内嵌 Web UI

- server 内嵌 UI 正常返回。
- CSP 含 `img-src ... blob:`、`media-src ... blob:`、`worker-src 'self' blob:`，原有 script hash 保留。
- tokenized entry/CSS 资源返回正确 MIME、`nosniff`、`no-cache`。

### Electron Desktop（sidecar Basic Auth）

- 另一开发会话占用 9222，因此使用 `OPENCODE_TEST_ONBOARDING=1` 和 `OPENCODE_CDP_PORT=9233` 隔离启动 worktree Electron；未终止或修改另一实例。
- renderer 为 worktree Vite 5174，sidecar 为随机端口 64369。
- `.hello` viewer、tokenized CSS、宿主 shared runtime、raw 28 bytes 全部正常。
- 使用 sidecar 随机 Basic credentials 调 disable，SSE 即时撤销 viewer/CSS/owner。
- 验证后已停止 9233 Electron；其它开发实例保持运行。

## 已知边界

- P1 只有 path-link；npm/归档安装、卸载、更新、市场在 P3。
- P1 不监听 link 目录；目录 watcher/HMR 在 P2。CLI 在另一个进程启停运行中 server 时不会跨进程发 SSE，需通过 HTTP API 启停或刷新 UI。
- P1 稳定 API 仅 file viewer；panel/tool/command 扩展 API 待完整懒激活链路后开放。
- 扩展面板 `setState` 仍为进程内状态；完整持久化留给后续。
- CSS 自动 selector scope、运行时 i18n、viewer 偏好持久化和 crash-strike 自动安全模式尚未实现。
- Desktop onboarding 隔离模式会产生既有 quick-assistant 目录缺失日志，但扩展链路无相关错误。

## 后续阶段

- P2：server 扩展入口、RPC、事件、设置和开发热重载。
- P3：npm/归档安装、升级、卸载、管理界面和市场索引。
- P4：WolframScript Notebook 与首批文件预览扩展。
