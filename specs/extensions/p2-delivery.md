# P2 交付清单

核对日期：2026-10-05。工作树：`.claude/worktrees/extensions-p0`，分支：`claude/extensions-p2-design`。

**仅整理清单，不暂存、不提交、不推送、不合入 dev。** 本文路径均相对扩展工作树根。

## 核对结果

- 清单生成前：59 个已跟踪修改文件、42 个未跟踪文件，共 101 个。
- `packages/opencode/src/provider/models-snapshot.js` 为构建重新生成的模型目录快照，建议与 P2 功能交付分离；未回退或删除该变化。
- 其余 100 个文件为本次 P2 功能、测试、依赖、SDK/示例产物与记录候选；不是已授权的 git add 列表。
- 本文是第 43 个未跟踪文件；加入本文后，候选交付总数为 101 个，另有 1 个模型快照生成变化。
- 索引为空：核对时 `git diff --cached --quiet` 成功，未暂存文件。
- 以下按核对时状态标记：`M` 已跟踪修改，`NEW` 未跟踪。后续操作前应重新核对状态，不使用 `git add .`。

## 1. 功能源码与依赖

### 服务端运行时、RPC、设置、鉴权

```text
M   bun.lock
M   packages/opencode/package.json
M   packages/opencode/src/extension/event.ts
M   packages/opencode/src/extension/index.ts
M   packages/opencode/src/extension/manifest.ts
M   packages/opencode/src/extension/registry.ts
M   packages/opencode/src/extension/schema.ts
NEW packages/opencode/src/extension/runtime.ts
NEW packages/opencode/src/extension/watch.ts
M   packages/opencode/src/plugin/index.ts
M   packages/opencode/src/tool/registry.ts
M   packages/opencode/src/server/routes/instance/httpapi/api.ts
M   packages/opencode/src/server/routes/instance/httpapi/errors.ts
M   packages/opencode/src/server/routes/instance/httpapi/groups/extension.ts
NEW packages/opencode/src/server/routes/instance/httpapi/groups/extension-rpc.ts
M   packages/opencode/src/server/routes/instance/httpapi/handlers/extension.ts
NEW packages/opencode/src/server/routes/instance/httpapi/handlers/extension-rpc.ts
M   packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts
NEW packages/opencode/src/server/routes/instance/httpapi/middleware/ui-authorization.ts
M   packages/opencode/src/server/routes/instance/httpapi/server.ts
M   packages/opencode/src/server/shared/public-ui.ts
M   packages/opencode/src/server/shared/ui.ts
```

### 前端宿主、贡献点、设置、文件保存与会话门控

```text
M   packages/app/src/app.tsx
M   packages/app/src/components/dialog-settings.tsx
M   packages/app/src/components/session/session-tabs-bar.tsx
NEW packages/app/src/components/settings-extensions-utils.ts
M   packages/app/src/context/layout.tsx
M   packages/app/src/context/session-tabs.tsx
M   packages/app/src/extensions/activation.ts
M   packages/app/src/extensions/api.ts
M   packages/app/src/extensions/context.ts
NEW packages/app/src/extensions/definition.ts
M   packages/app/src/extensions/host.tsx
NEW packages/app/src/extensions/mount.ts
NEW packages/app/src/extensions/reconcile.ts
M   packages/app/src/extensions/types.ts
M   packages/app/src/i18n/en.ts
M   packages/app/src/i18n/zh.ts
M   packages/app/src/i18n/zht.ts
NEW packages/app/src/pages/session/file-tab-keepalive.ts
NEW packages/app/src/pages/session/file-viewer-content.ts
M   packages/app/src/pages/session/file-tabs.tsx
M   packages/app/src/pages/session/session-side-panel.tsx
M   packages/ui/src/components/file-viewer-registry.ts
M   packages/ui/src/components/message-part.tsx
```

### 扩展开发契约、CSS scope、双端示例

```text
M   packages/extension-kit/package.json
NEW packages/extension-kit/scope.d.ts
NEW packages/extension-kit/scope.js
NEW packages/extension-kit/src/server.ts
M   packages/extension-kit/src/web.ts
M   packages/extension-kit/vite.d.ts
M   packages/extension-kit/vite.js
M   packages/extensions/hello-viewer/package.json
NEW packages/extensions/hello-viewer/src/child-runtime.ts
NEW packages/extensions/hello-viewer/src/server.ts
M   packages/extensions/hello-viewer/src/web.css
M   packages/extensions/hello-viewer/src/web.tsx
```

依赖变化与实现配套：opencode 使用 extension-kit；extension-kit 与 hello-viewer 使用 plugin 契约，`bun.lock` 应与对应 package.json 一起交付。

## 2. 测试与测试夹具

### 前端与 UI

```text
NEW packages/app/src/components/settings-extensions-utils.test.ts
M   packages/app/src/context/layout.test.ts
M   packages/app/src/context/session-tabs.test.ts
NEW packages/app/src/extensions/bridge.test.ts
NEW packages/app/src/extensions/contributions.test.ts
NEW packages/app/src/extensions/definition.test.ts
NEW packages/app/src/extensions/extension-scope-dom.test.ts
M   packages/app/src/extensions/host.test.ts
NEW packages/app/src/extensions/reconcile.test.ts
NEW packages/app/test-browser/extension-mount.test.ts
NEW packages/app/test-browser/file-tab-keepalive.test.ts
NEW packages/app/test-browser/file-tab-viewer-content.test.ts
NEW packages/app/test-browser/tool-registry-reactive.test.ts
M   packages/ui/src/components/file-viewer-registry.test.ts
```

### 服务端、HTTP 与 SDK 集成

```text
M   packages/opencode/test/extension/fixture.ts
M   packages/opencode/test/extension/manifest.test.ts
NEW packages/opencode/test/extension/runtime.test.ts
M   packages/opencode/test/extension/service.test.ts
NEW packages/opencode/test/extension/settings.test.ts
NEW packages/opencode/test/extension/watch.test.ts
M   packages/opencode/test/server/httpapi-authorization.test.ts
NEW packages/opencode/test/server/httpapi-embedded-auth.test.ts
M   packages/opencode/test/server/httpapi-exercise/index.ts
NEW packages/opencode/test/server/httpapi-extension-settings.test.ts
M   packages/opencode/test/server/httpapi-extension.test.ts
M   packages/opencode/test/server/httpapi-ui.test.ts
NEW packages/opencode/test/server/public-ui.test.ts
```

### extension-kit 与 hello-viewer

```text
NEW packages/extension-kit/test/fixture/package.json
NEW packages/extension-kit/test/fixture/src/web.css
NEW packages/extension-kit/test/fixture/src/web.ts
NEW packages/extension-kit/test/server.test.ts
NEW packages/extension-kit/test/vite.test.ts
NEW packages/extensions/hello-viewer/test/child-runtime.test.ts
NEW packages/extensions/hello-viewer/test/server.test.ts
```

`test/fixture/` 与示例 `test/` 已展开为具体文件，不应只交付测试入口而遗漏夹具源码。

## 3. 必须配套交付的生成产物

```text
M   packages/sdk/js/src/v2/gen/sdk.gen.ts
M   packages/sdk/js/src/v2/gen/types.gen.ts
M   packages/extensions/hello-viewer/dist/web/index.css
M   packages/extensions/hello-viewer/dist/web/index.js
NEW packages/extensions/hello-viewer/dist/server.js
```

- SDK 由 OpenAPI 重新生成，包含 RPC 可选 `{ input }` 信封、设置路由、贡献声明与事件；生成器引起的错误类型编号重排不手工拆改。
- hello-viewer 的 package exports 指向 `dist/web/index.js` 和 `dist/server.js`，这些是示例运行入口，不是可随意排除的验收垃圾。
- 尤其 `dist/server.js` 当前未跟踪；仅提交 src/server.ts 会导致干净 checkout 中示例 server 入口缺失。

## 4. 规格与进度文档

```text
M   specs/extensions/design.md
M   specs/extensions/progress.md
NEW specs/extensions/p2-tasks.md
NEW specs/extensions/p2-delivery.md
```

## 5. 排除与分离

| 文件/位置 | 处理建议 | 当前处理 |
|---|---|---|
| `packages/opencode/src/provider/models-snapshot.js` | 构建生成变化，与 P2 功能分离核对；若后续决定回退，先检查具体差异并确认 | 保留，未回退 |
| `packages/app/dist/` | 已被 Git 忽略，仅生产构建/验收使用 | 不交付 |
| `packages/opencode/dist/` | 已被 Git 忽略，编译二进制仅验收使用 | 不交付 |
| `/tmp/opencode-p2-*/` 数据、观测扩展、截图 | 本地验收证据，不复制到源码交付 | 保留在临时目录 |
| `.claude/worktrees/agent-*/` | 独立代理补丁工作树，不整树交付、不自动删除 | 保留 |
| 主 checkout 的其他 WIP | 不属于此扩展工作树的 P2 文件清单 | 未修改 |

## 6. 验证摘要

- 全 workspace typecheck：18/18。
- 服务端 extension + HTTP/鉴权/UI：164 pass/0 fail。
- app 定向：228 pass/0 fail；browser-condition：59 pass/0 fail。
- UI：218 pass/0 fail；extension-kit：17 pass/0 fail；hello-viewer：14 pass/0 fail。
- 扩展六路 HttpApi coverage/auth 各 6/0；仓库已有 19 个其他路由缺场景保留，不算全库覆盖通过。
- Vite production build、内嵌 build、修复文件 prettier check 与 git diff --check 通过。
- 最终二进制 `1.18.49-claude-extensions-p2-design.202610041109` 已完成内嵌 Web 核心实机复验：真实外部文件监控刷新时 mount=1、草稿保留、text/revision 更新、原保存 handler 写盘；raw/RPC/SSE/并发 child ping、停用清理/恢复、token-only/CSP/反向鉴权通过；服务与浏览器已清理。
- 最终产物 Electron/Vite GUI 完整矩阵未重跑，不以内嵌证据替代。

完整验收细节与历史失败见 `progress.md`；开放后续范围见 `p2-tasks.md`。

## 7. 必须保留的限制

- P2 收尾时的三个 app 全量基线失败已在 2026-10-06 独立批准范围内修复；两次独立进程 app 全量均 1359 pass/0 fail。该结果不代表 opencode 或整个仓库全量测试通过。
- secret 本地注册表明文存储（0600），API 掩码返回。
- Portal 样式逃逸；面板状态仅进程内。
- 组件草稿不保证跨会话/刷新/重启持久化。
- CLI 跨进程启停不保证运行中 server 的 SSE，使用 HTTP API 或刷新。
- 首次导航曾出现未稳定重现的加载空白，未另行归因或宣称修复。
- npm/归档安装、升级/卸载、市场、项目级安装、自定义设置页、运行时 i18n、WolframScript Notebook 不在 P2 交付范围。

## 8. 后续提交前检查（未执行）

1. 用户明确解除“不提交/不推送/不合入 dev”约束后，再讨论提交拆分。
2. 重新核对工作树与索引，不用清单直接盲目 git add。
3. 按功能/依赖/SDK/示例/测试的配套关系暂存，确保新增 helper、runtime、测试 fixture、示例 server dist 未遗漏。
4. 将模型快照生成变化单独判断，不混入 P2 功能提交。
5. 核对 staged diff 与 clean-checkout 构建/测试，再执行获得授权的提交；推送和合并另行授权。

## 9. 独立基线修复附录（2026-10-06，已验证）

以下是用户在 P2 交付清单完成后另外批准的范围，不冒充 P2 最初改动或最终二进制实机证据：

```text
M   packages/app/src/utils/prompt.test.ts
M   packages/app/src/pages/session/session-render-state.ts
M   packages/app/src/pages/session/session-render-state.test.ts
M   packages/app/src/context/comments.test.ts
M   packages/app/src/context/terminal.test.ts
M   packages/app/src/pages/session/timeline/rows.test.ts
NEW specs/extensions/app-baseline-tasks.md
```

- 注入测试仅修 fixture 并补 legacy 正例，不更改历史通知识别。
- deadline 仅保留无语义变化时的 state 引用；42 种状态穷举字段语义一致。
- UI context mock 污染从 comments/terminal 源头消除，router stub 与 rows 的已有导出面保持一致；生产 UI context 不改，真实导出保护断言已添加。
- app 全量两次独立进程均 1359/0（171 文件），三文件组合/反向参数 29/0；browser-condition 59/0、UI 218/0、workspace typecheck 18/18、production app build 与格式检查通过。
- 原第 1～4 节的 P2 文件统计保持为 2026-10-05 快照；本附录新增 6 个修改文件 + 1 个任务文档，合计 108 个候选交付文件，另有 1 个模型快照生成变化。后续暂存前重新核对。

## 10. 扩展配置迁移附录（2026-10-06，已验证）

用户要求将扩展配置从设置浮窗移入独立配置页，复用三栏导航、列表与宽表单。独立于前述 P2/基线修复，不新增安装/链接/启停/卸载/市场 UI。

```text
M   packages/app/src/pages/config.tsx
NEW packages/app/src/pages/config-extension-settings.tsx
NEW packages/app/src/pages/config-extensions.ts
NEW packages/app/src/pages/config-extensions.test.ts
NEW packages/app/src/pages/config-extensions-entry.test.ts
NEW packages/app/test-browser/config-extension-settings.test.ts
NEW packages/app/test-browser/fixtures/config-extension-settings.contract.ts
NEW packages/app/test-browser/fixtures/solid-form-loader.ts
NEW specs/extensions/config-migration-tasks.md
```

- 已有清单中的 `app.tsx`、`dialog-settings.tsx` 与 en/zh/zht 文案同步更新：配置加载骨架包含 extensions，设置浮窗不再有 extensions 标签。
- 第 1 节原 `NEW packages/app/src/components/settings-extensions.tsx` 已完成迁移并删除，不交付旧包装。原 settings-extensions-utils 及测试继续复用。
- 新测试加载器用标准 createRequire 解析 Vite/Solid 的构建依赖，不扫描 `.bun` store；仅隔离测试子进程注册 JSX transform，不污染共享浏览器测试进程。
- 当前合计 116 个候选交付文件，另有模型快照生成变化；原 108 + 本附录 9 新增候选 - 1 旧组件。清单逐项校验，无遗漏、无重复。
- 最终 app 全量 1366/0、browser-condition 60/0（另有子进程7项表单契约）、workspace typecheck 18/18、app production build、prettier/git diff --check 通过。类型推导曾误报 CommandSource 缺导出，表单翻译接口收窄至实际六键后通过，未改原命令导出。
- 实机 Vite 5194 + 隔离API47241：全局深链/项目配置三栏、普通值和密钥保存、API secret掩码、无设置扩展/安全模式/无效选择回退、浮窗旧标签移除与返回会话通过；已查看截图并清理浏览器及服务。
- 空注册表页面以已有空态逻辑及纯选择回归覆盖，未另起空注册表实机服务。内嵌二进制未重建此次入口迁移，先前二进制截图不代表新入口验收。

## 11. 配置页扩展启停管理附录（2026-10-06）

```text
NEW packages/app/src/extensions/mutation.ts
NEW packages/app/src/extensions/mutation.test.ts
NEW packages/app/src/pages/config-extension-actions.tsx
NEW packages/app/src/pages/config-extension-actions-state.ts
NEW packages/app/src/pages/config-extension-actions-state.test.ts
NEW packages/app/src/pages/config-extension-detail.tsx
NEW packages/app/test-browser/config-extension-actions.test.ts
NEW packages/app/test-browser/fixtures/config-extension-actions.contract.ts
NEW specs/extensions/toggle-management-tasks.md
```

- 既有清单的API/host/host.test、config/表单/入口测试、语言文案与表单契约同步变更；不改server/codegen，不增安装链接卸载市场。
- API调用SDK并校验/normalize响应；host启停与页面设置共享mutation锁，symbol身份防旧release删新锁；成功经reconcile+strict refresh，同步失败不假回滚，client/provider守卫拒绝迟到污染。
- UI右详情统一按钮、停用两步确认取消零请求、dirty/saving/busy门禁、无效数字编辑仍dirty且可取消；安全模式不可绕过，incompatible/error不伪装实际激活。
- 最终app1387/0、browser61/0（另有隔离子进程10动作+10表单契约）、workspace typecheck18/18、production app build、后端启停/settings34/0、定向helper/API/bridge53/0通过。
- 页面实测确认停用/取消、列表/详情状态、viewer/CSS撤销与恢复、文件标签保留、child PID退出；已查看截图。恢复后RPC/dirty门禁后续浏览器操作被明确拒绝，按用户选择保留未验证项；真实多server/provider完整并发未实测，不以静态审读或helper测试冒充。
- manager内部settings更新不参与页面mutation锁（迟到守卫存在）；可产生短暂last-writer快照，为现有边界。新前端未重建内嵌二进制。
- 本轮浏览器/API/前端均清理。交付总数125候选（116+9），另有1模型快照生成变化；未暂存/提交/推送/合入dev。

