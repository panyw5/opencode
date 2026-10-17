# Extensions 实施进度

更新时间：2026-10-17

## P3a 当前实施摘要（优先于下方历史状态）

- 基线 `3a0d101b22`（dev 1.18.58）；P3a 正在实施，**尚未提交、未合入 dev、未推送，不标记完整交付**。P3b 市场留后续。
- npm/自包含tgz获取、registry v2/revision/receipt、prepare/confirm/commit、runtime fence/quiesce、registry观察器与安装服务、HTTP/SDK/CLI、配置页安装/更新/移除确认已实现并接通。
- 审查收敛：8个候选中7项修复；npm祖先自身peer解析保留fail closed（原可解析前提不普遍成立，不宣称已支持）。补齐工具/普通hooks在途与旧闭包代际跟踪、真实缓存失效重试/首装空缓存、retained来源隔离、broken安装修复、CLI开发链接热重载、committed状态恢复strict sync与path unlink入口。
- 审查后主线程回归：服务端扩展/安装/鉴权/snapshot组合449 pass、1 skip、0 fail（22文件）；App全量1710/0、UI全量282/0、browser-condition63/0（安装wrapper内部11项），App/opencode typecheck和生产App构建通过（大chunk警告）。SDK契约未改变；审查前opencode/App/SDK/UI/kit/示例typecheck通过，OpenAPI两次生成一致。
- 审查前隔离Vite实机：生产CLI安装本地tgz后UI无刷新同步、默认停用；页面启用后RPC回显成功；页面卸载确认后列表移除、RPC404且明确cleanupPending。截图已查看，专用浏览器/API/Vite清理完成。审查后未重跑真实浏览器；Electron与内嵌二进制本轮未验收，不借用旧截图。
- 清理恢复阶段：进程生命周期generation/data引用、真实内核锁活性证明、受管ownership、引用与registry双门禁GC、显式purge隔离日志及回执恢复已接通。后续清理审查修复精确trash回执、path保留设置恢复、空目录owner来源保护；用户明确选择拒绝受管副本开发链接。最终组合513 pass、1 skip、0 fail（25文件），App/opencode typecheck、browser63/0通过；App1710/0、UI282/0与生产构建为此前阶段结果。未重做实机。
- 清理门闩阻塞已修：检查与隔离目录后释放namespace gate，递归删除由精确UUID的quarantine claim独占，其他ID引用不再被慢删除阻塞。新增并发/崩溃claim回归通过，完整组合516 pass、1 skip、0 fail（25文件），后端typecheck通过；定向只读复核无新确认问题。
- 实机验收（2026-10-17，清理门闩修复后当前代码）：Vite 源码形态完成安装→启用→RPC→升级→移除→重启恢复全链路，进程存活时旧代包/数据保留（进程 pin 生效）、重启后恢复清理完成；Electron 桌面（当前 Node sidecar 构建）安装/列表/RPC/移除通过，Node 运行时 purge 按设计延后（unsupported 标记）；内嵌生产 Web（当前编译二进制）安装/RPC/移除通过，HTML 与本地构建逐字节一致。模型快照哈希构建前后未变。公网 npm/HTTPS、多服务器矩阵、故障全场景未验收。详见 `specs/extensions/p3a-tasks.md`。
- 保留限制：Node/Windows/无FFI仍可使用扩展，但持久unsupported证明会使GC/purge延后；遗留gate/未知trash/legacy无来源数据不猜测删除，Linux/Windows未本机验收；archive换URL升级受来源身份约束；npm循环/alias/Git/file/workspace/自动peer不支持。secret存储和同进程信任边界不变。详情见 `specs/extensions/p3a-tasks.md`。

下方为截至2026-10-14的P2收尾历史摘要，旧工作区/提交/产物待办不代表当前状态。

## 当前状态（2026-10-14历史摘要）

- **P0/P1 已完成；P2 核心实现、配置入口迁移和启停管理已提交，集成收尾待完成。** 不再以历史章节中的“待提交”“进行中”判断当前状态。
- 工作分支：`claude/extensions-p2-design`；工作目录：`.claude/worktrees/extensions-p0`。设计文档：`specs/extensions/design.md`。
- P2 交付提交：`eeac7a5adc`（2026-10-07，125 个文件，包含源码、测试、SDK、示例产物和任务记录）；JPEG 转换契约测试修复：`660c95bdd3`（2026-10-10）。
- 当前验证基线：`c6e6629773`，已合并当时的本地 dev `9e1aa02c57`。2026-10-14 核对时本地 dev 已前进至 `967c1d4703`，远端跟踪引用 fork/dev 为 `620a327482`；本轮未 fetch/合并，不能称扩展分支已包含最新 dev。
- **尚未合入 dev；本轮不暂存、不提交、不推送、不发布。** 当前已有未提交改动为三个扩展包版本和模型目录快照，本轮保留，不混入文档交付。
- 后续顺序：P2 文档/版本/产物核对 → 最新交付基线自动化与实机验收 → 合入前审查 → 明确授权后集成。P3 分发、市场和 P4 首批业务扩展尚未完成。

### 本轮验证（2026-10-14）

| 检查 | 实际结果 |
| --- | --- |
| App 全量 unit suite | 1671 pass / 0 fail，205 文件 |
| UI 全量 suite | 268 pass / 0 fail，32 文件 |
| opencode extension + 选定 HTTP/鉴权/UI tests | 150 pass / 0 fail，13 文件 |
| 扩展相关 browser-condition tests | 22 pass / 0 fail，6 文件；计数按本轮 runner 汇总，不与历史隔离契约计数叠加 |
| extension-kit browser-condition tests | 17 pass / 0 fail，3 文件 |
| hello-viewer tests | 14 pass / 0 fail，2 文件 |
| App / opencode / extension-kit / hello-viewer typecheck | 4 项通过 |

本轮未重新构建 SDK/示例/生产 UI/内嵌二进制，未运行全仓 opencode suite、完整 workspace typecheck 或最新 GUI 矩阵。测试通过不等于所有运行形态发布验收完成。历史 Web/Electron/内嵌验收仍按原日期、产物和范围保留。

### P2 收尾边界

- 仅支持本地 path-link；npm/归档安装、升级、卸载、市场、项目级安装、自定义设置页和运行时 i18n 不在本轮。
- 扩展代码与宿主同进程，permissions 为声明信息，不是沙箱/逐项权限强制隔离；只加载可信扩展。secret 在本地注册表明文存储（0600），API 掩码不等于加密。
- 文件标签保活/保存桥不保证跨会话、刷新、重启草稿持久化；面板状态仅内存，面板不参与文件标签 keepalive，公开 panels API 仅 register、无 open。
- 保留 CSS/Portal 样式边界、CLI 跨进程启停 SSE 边界及页面内部 settings 更新与管理页锁的既有边界。
- 待验收：最新版本完整 Electron/Vite/内嵌生产 Web 核心矩阵，以及管理页启用恢复后的 RPC、dirty/saving 门禁、真实多服务器切换。曾被环境拒绝的操作不得绕过；未执行项保持“未验证”。
- 收尾任务见 `specs/extensions/p2-tasks.md`；交付核对见 `specs/extensions/p2-delivery.md`。以下章节为历史实施与验收记录，原结果、旧限制和当时操作授权不覆盖本摘要。
- 产物修复（2026-10-14）：锁文件版本元数据已对齐（integrity 保留、frozen 通过）；SDK v2 扩展契约经重生成确认一致；hello-viewer 产物可复现且与原产物等价；`openapi.json` 确认为 dev 整体漂移，按用户决定随扩展分支更新为完整重新生成结果。详见 `p2-delivery.md`。
- 本轮只读产物核对发现：三个包 manifest 当前 1.18.57，但 bun.lock 对应版本元数据滞后；追踪的 `packages/sdk/openapi.json` 缺六项扩展操作及 `extension.status`/`extension.event`。示例/kit 入口及夹具已追踪，SDK v2 契约存在，不等于完整生成一致性；本轮不重建/生成，缺项列为交付前检查门槛。

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

状态：**已完成并提交（2026-09-27）；下列验证结果为历史记录。**

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

## P2：server 扩展运行时与 Web 桥（核心实现已提交，历史验收记录）

- 已落盘：server-only/Web+Server manifest 与独立内容指纹、`extension-kit/server` 契约、进程级激活和实例 Hooks、RPC/自定义事件、设置校验与掩码、tool/panel/command 前端贡献点、路径链接目录 watcher、hello-viewer 双端示例。
- 运行时 server module 复制到内容指纹目录，禁用/热更新时清理服务与缓存；Web/编辑型 viewer、Electron 和内嵌 Web 核心链路已有实机证据。token-only 入口、草稿路径别名门控及内嵌编译二进制 Child ping 已于 2026-10-04 修复并完成对应实机验证；完整组合回归与两路最终审查的确认缺陷修复已完成；最终产物内嵌 Web 核心链路已于 2026-10-05 实机复验；完整 Electron/Vite GUI 矩阵未重跑，不应把定向验收等同于全仓无已知问题。
- 已验证（2026-09-29，当前工作树）：全 workspace typecheck 18/18；opencode 扩展 + HTTP 定向 101 pass、0 fail（含首次显式目录 RPC、不存在目录 404、停用时在途 RPC 中断与 watcher 重启）；app 扩展 + layout + 设置 UI 定向 107 pass、0 fail；UI 全量 217 pass、0 fail；app browser-condition 39 pass、0 fail；extension-kit browser-condition 17 pass、0 fail；hello-viewer 服务端示例 9 pass、0 fail。HttpApi exerciser 对新增 RPC/设置路由 coverage/auth 均 PASS，全量两模式各 182 pass、0 fail，但仓库原有 19 个未覆盖路由导致 `--fail-on-missing` 退出 1。
- 已完成隔离 headless server 实机冒烟：使用临时 registry/数据目录和 127.0.0.1 专用端口，CLI 链接 hello-viewer；真实 Basic Auth RPC echo/greet、手动启动并 ping 子进程、HTTP 停用后子进程退出且 RPC 404、再次启用后 RPC 恢复、无凭据 401、非法设置键 400。另用临时测试扩展验证 Server 文件修改后 RPC 从 `server-one` 更新为 `server-two`；Web CSS 修改后资源 URL 改版，旧 URL 404、新 URL 200。
- 真实隔离 Vite Web 页面验收：Settings → Extensions 能显示临时扩展设置，保存普通文本与密钥后前端 toast 成功、服务端清单值更新且密钥仅返回 `********`。2026-10-01 使用已创建会话绕开前次草稿空白门控，`.hello` 文件自动懒激活；Inspect bytes 返回 30 bytes；页面按钮 RPC echo、greet→SSE 事件显示、child ping 全通过。停用后无刷新撤销 viewer/CSS，保留文件源码标签；重新启用后 viewer/CSS 自动恢复。已查看实机截图并关闭专用浏览器任务，隔离 API/Vite 服务均已停止。前次草稿路由空白仍未取得根因重现证据，不因本次成功而视为已修复。
- 已接入最小 manifest 驱动的设置编辑入口（Settings → Extensions）、CSS selector 自动 scope（viewer/panel/tool renderer 的宿主挂点）和 replace-mode 文件查看器保存/dirty/阻止关闭桥；Portal 样式逃逸等仍是已知边界。
- Electron 实机验收（2026-10-02）：重建 Node sidecar，使用 `OPENCODE_TEST_ONBOARDING=1` 唯一临时 userData 和专用 CDP 9251； renderer 来自扩展工作树 Vite 5174，Node utilityProcess sidecar 使用随机 Basic Auth。未经鉴权清单请求 401，鉴权请求 200；编辑型查看器加载并通过真实 CDP 键盘保存写入临时文件；hello-viewer RPC echo、greet→SSE 页面显示、raw 29 bytes 通过。显式 child.start 后 HTTP 停用扩展，child PID 退出、viewer/CSS 撤销、文件标签保留；再次启用 viewer/CSS 自动恢复。已查看实机截图；通过本实例 IPC 停 sidecar 再停止主 PID，9251/sidecar 端口均释放；未关闭其他实例。
- 编辑型查看器实机验收（2026-10-01）：临时扩展对临时文件进行正常/失败/慢保存。正常快捷键保存写盘；模拟磁盘满时原文件不变且关闭被阻止；保存期间新编辑保持 dirty。修复文件切换卸载草稿问题后，已访问文件标签保持挂载（inactive hidden/inert），未访问后台标签仍懒加载；切文件与折叠预览保留草稿；dirty Source/打开方式切换被拦截；关闭提示可保存隐藏标签；成功保存后正常关闭并清理 handler。已看截图、关闭专用浏览器任务并停止隔离服务。跨会话导航、页面刷新及应用重启不承诺保留组件本地草稿，仍是已知边界。
- 本阶段修复前端工具占位的响应式切换、CSS 挂点对 accessor/嵌套 children 的渲染、onSave 裸 disposer 契约、重复注销、异步保存期间新编辑的 dirty 状态；运行时补齐设置默认值、迟到实例 Hooks 回收及多个独立 Effect scope 的资源所有权。修复后显式目录 RPC 会重新 materialize Plugin.state，避免局部热重载后命中旧的实例缓存。
- 最新验证（2026-10-01）：全 workspace typecheck 18/18，opencode 扩展 + HTTP 定向 113 pass/0 fail；app 宿主/layout/设置逻辑定向 105 pass/0 fail；browser-condition 55 pass/0 fail；UI 全量 218 pass/0 fail；extension-kit browser-condition 17 pass/0 fail；Vite Web production build 通过。RPC OpenAPI 已描述可选 `{ input }` 请求体并重新生成 SDK，端到端 SDK→HttpApi 测试确认输入信封正确，空 body 与非法 body 测试通过。
- 内嵌生产 Web 实机验收（2026-10-03）：`build --single --skip-install` 构建本机可执行文件，HTML 与本地 app/dist/index.html 逐字节一致，CSP 响应头生效，确认未代理远端 UI。发现共享模块缓存目录残缺（目录在但 dist/server.js 不在）导致扩展导入失败；新增失败回归并修复缓存恢复逻辑（不再仅凭目录存在判定复制成功），重建后二进制 RPC 正常。同源生产页面 hello-viewer 加载、RPC echo、greet→SSE 显示、raw 34 bytes、停用撤销 viewer/CSS 和再次启用恢复通过，验收期间 CSP violation 记录为空，已查看截图。浏览器任务与隔离服务已清理。入口限制：本次为专用页面配置 Basic Auth 请求头；仅 auth_token 导航不能鉴权后续静态资源（401），base64url 无 padding 的导航 token 也被拒绝，不计为通过。
- 缓存修复后的定向回归：opencode 扩展/HTTP 114 pass、0 fail，服务端 typecheck 和内嵌生产二进制重建通过。
- token-only 鉴权修复及生产复验（2026-10-04）：query token 支持严格 Base64 失败后回退无 padding Base64URL，按首个冒号拆分凭据；仅 UI fallback 公开 manifest 精确命中的 GET 静态资源，不引入 Cookie、不公开整个 assets 前缀。上一轮 5 个鉴权/UI 测试 42 pass/0 fail、服务端 typecheck 与内嵌 build 通过；本轮复跑同 5 文件仍为 42 pass/0 fail，独立只读边界核对未发现本次修复的实质安全缺陷。
- 使用隔离 registry/XDG、47231 端口与内嵌二进制 `1.18.49-claude-extensions-p2-design.202610031626`，在专用 ego-browser 页面仅通过无 padding auth_token 导航，未设置额外 Authorization header，禁用缓存。UI 正常挂载且清除 URL token；JS/CSS/字体 200，HTML 与本地 app/dist/index.html 逐字节一致，CSP 响应头存在。Hello Viewer 懒激活、raw 31 bytes、echo RPC、greet→SSE 页面显示通过；停用后 viewer/CSS 无刷新撤销且文件标签保留，再启用后自动恢复；监测期间 CSP violation 为空，已查看实机截图。独立 curl 验证标准 padded Base64 与 unpadded Base64URL 导航 200、畸形 token 401；无凭据 HTML/global extension/session/raw/RPC/SSE/doc 401，静态 JS 200，错误扩展资源 token 404。专用浏览器任务已关闭、服务 PID 与测试 child PID 已退出、47231 已释放；测试目录与截图保留为证据。
- 本轮独立失败：生产编译二进制的 Child ping 返回 500（`child ping timed out after 5000ms`），不能计为子进程桥通过。`hello-viewer/src/server.ts` 使用 `spawn(process.execPath, ["-e", CHILD_SCRIPT])`，编译后 execPath 指向 OpenCode 二进制而非 Bun/Node，疑似入口不兼容；已同步 P2 runtime 会话确认/修复。先前的源码/Vite/Electron 子进程通过记录不代表此编译形态通过。
- 编译子进程修复及复验（2026-10-04）：协作会话新增 `child-runtime.ts`，源码模式复用真实 Bun/Node，编译模式通过 `OPENCODE_JS_RUNTIME` 或 PATH 查找脚本运行时，缺少运行时时明确失败；hello-viewer 服务端产物已重建。示例测试 13 pass/0 fail；协作会话编译服务 47233 回显 `compiled-child-ok`，停用后 child PID 退出并清理服务。本会话独立复验编译服务 child.start/ping/stop，回显 `compiled-child-recheck`、stopped=true 且 child PID 已退出，原超时复现已闭合。
- 草稿空白修复及复验（2026-10-04）：确认是 P1 基线中 `/tmp`↔`/private/tmp` 路径别名门控不一致，草稿路由与标签 fallback 统一 `sameWorkspacePath`；独立核对补出已有会话 fallback 漏用别名的分支，先红测试 119 pass/1 fail，再修复为 120 pass/0 fail（session-tabs + layout helpers），app typecheck 通过。使用本工作树 Vite 5183 + 隔离编译 API 47231，新建草稿显示主体与输入框、已有会话/草稿标签往返、同一草稿切换 `/tmp` 别名路由、别名项目入口复用已有会话、认证别名会话重新导航均通过；未发送模型请求，已查看截图并清理浏览器/API/Vite，47231/5183 均释放。首次导航曾出现一次主体加载空白，后续未稳定重现；未把该瞬态现象归因于别名或宣称已另行修复，跨刷新/重启草稿持久化仍不保证。
- 本轮额外全量 app 测试为 1332 pass/3 fail，失败与已有记录一致（injection preview、session-render-state、rows 的 useData export）；不计为全量通过。完整 P2 最终审查与交付范围核对仍待完成。
- 最终组合回归（2026-10-04，包含别名 fallback 补漏）：workspace typecheck 18/18；opencode extension + HTTP/鉴权/UI 156 pass/0 fail（15 文件）；app 扩展/layout/session-tabs/helpers/设置逻辑 225 pass/0 fail（10 文件）；app browser-condition 55 pass/0 fail（12 文件）；UI 全量 218 pass/0 fail（25 文件）；extension-kit browser-condition 17 pass/0 fail；hello-viewer 13 pass/0 fail。SDK/示例 typecheck、别名补漏后的 Vite production build 和 `git diff --check` 通过；HttpApi exerciser 本轮 extension 六路 coverage/auth 各 6 pass/0 fail（未启用 fail-on-missing；仍报告仓库已有 19 个其他路由缺场景）。最终 `build --single --skip-install` 亦通过，二进制 `--version` 为 `1.18.49-claude-extensions-p2-design.202610040416`（此次新产物仅构建/入口冒烟，实机证据来自前述编译服务与最新源码 Vite 页面）。
- 编译子进程后续并发修复（2026-10-04）：最终审查实证发现多个 Child ping 会同时解析第一行而静默串答（不是超时）；新增红测试 13 pass/1 fail 后，按 child 串行排队，修复后 14 pass/0 fail、示例 typecheck/服务端产物重建通过，独立构建产物复现脚本 17 次调用均正确对应、0 错配/0 超时。
- 最终审查后 watcher 修复（2026-10-04）：refresh 扫描串行化且与目录处理队列分离，防止并发重复订阅覆盖泄漏；主会话将隔离补丁回归整合后确认红 17 pass/2 fail（3 并发实际创建 3 订阅）、绿 19 pass/0 fail，服务端 typecheck 通过，覆盖停止期间迟到订阅、每订阅只退订一次及失败重试；修复后服务端 extension + HTTP/鉴权/UI 组合回归 164 pass/0 fail（15 文件）。
- 最终审查后前端刷新修复（2026-10-04）：主会话检查 host.tsx 基线 hash 后整合生产 reconcile helper，epoch 守卫贯穿异步 deactivate 恢复处并在 provider 清理时失效；3 项生产 helper 回归、前端定向 228 pass/0 fail、browser-condition 57 pass/0 fail、app typecheck 通过。viewer 外部文本更新修复及 ErrorBoundary/loaded 懒挂载边界已由主会话补测完成，见最终审查修复状态节。
- 安全边界：`secret` 设置本地注册表以明文存储，文件采用 0600 权限，API 清单以掩码返回。npm 安装/市场、自定义设置页、运行时 i18n 留到后续阶段。

## P2 最终审查修复状态（2026-10-04）

- 两路完整审查已收口，保留 6 项确认问题：失效 import 恢复、watcher 重复订阅、设置监听器默认值、示例并发 ping 串答、前端陈旧 refresh 覆盖、文本更新重挂载 viewer。
- 6 项均已完成对应修复与回归；viewer 采用 text/revision accessor，恢复加载分支内创建，ErrorBoundary 延迟创建 Dynamic。主会话新增并复跑 4 项真实 helper 测试，覆盖草稿与 handler 保留、源码更新、异常 fallback、加载前不挂载及卸载清理；未自动清除未保存 dirty 状态。
- 修复后最终组合：服务端 164 pass/0 fail、前端定向 228 pass/0 fail、browser-condition 59 pass/0 fail、UI 218 pass/0 fail、extension-kit 17 pass/0 fail、hello-viewer 14 pass/0 fail，全 workspace typecheck 18/18，修复文件 prettier check 与 git diff --check 通过。Vite production build 与内嵌 build --single --skip-install 通过，二进制入口版本为 `1.18.49-claude-extensions-p2-design.202610041109`。该最终产物的内嵌 Web 核心链路已于 2026-10-05 实机复验（见下文）；完整 Web/Electron GUI 矩阵未重跑。
- 撤回或不修的候选：真实 context 的 stale guard 已阻止迟到注册；事件域名/目录映射正确；跨会话草稿是既有排除边界；面板同键不同 query 种子不成立。未自动清除未保存 dirty 状态，避免通过清标记掩盖草稿损失。

- [x] 最终产物内嵌 Web 实机复验（2026-10-05）：使用最终二进制 `202610041109`、隔离 registry/XDG 与 47211，显式启用 `OPENCODE_EXPERIMENTAL_FILEWATCHER=true`。仅通过 unpadded auth_token 导航，未配置额外 Authorization header；HTML 与本地 app/dist/index.html 一致，CSP 生效。临时编辑扩展显示真实宿主 text/revision 与挂载计数：外部写盘经文件监控重读后 text 更新、revision 1→2、mount 始终 1、dirty 草稿不变；真实 ⌘S 经原 handler 保存后 revision 2→3、mount 仍 1、status=saved，磁盘 28 bytes 与草稿逐字节一致。未强行注入前端状态/事件，未发送模型请求。
- 最终生产 Hello Viewer：raw 29 bytes、Echo RPC、Greet→SSE、页面 Child ping 均通过；真实编译服务 5 路并发 Child ping 各自正确对应，全部 200。HTTP 停用后 viewer/CSS 无刷新撤销、文件标签保留、child PID 46866 退出；重新启用后 viewer/CSS 自动恢复且 Echo RPC 再次成功。监测期间 CSP violation 为空，已查看保存与恢复截图；无凭据 HTML/extension API/raw/RPC 均 401。专用浏览器任务已关闭、服务 PID 88312 已退出、47211 已释放，临时数据及截图保留。该结果覆盖最终内嵌 Web 核心链路，不代表重新执行完整 Electron/Vite GUI 矩阵。

## P2 交付范围核对（2026-10-04）

- 交付范围：server `activate`/实例 Hooks、RPC/自定义事件/设置桥、path-link watcher、Web/Server 独立指纹、tool/panel/command 贡献点、编辑型 viewer 保存与标签保活。
- 不包含：npm/归档安装、升级/卸载、市场、项目级安装、自定义设置页和运行时 i18n（后续阶段），WolframScript Notebook（P4）。
- 必须保留的限制：secret 注册表明文 0600 + API 掩码；Portal 样式逃逸；跨会话/刷新/重启不保证组件草稿持久化；面板状态仅进程内；CLI 跨进程启停不保证运行中 server SSE；全量基线失败与首次导航瞬态空白不宣称已解决。
- 交付文件包含新建 runtime/watch/RPC/设置/测试源码、extension-kit 契约、重新生成的 SDK 和 hello-viewer `dist/web`/`dist/server.js` 示例产物。逐项清单已于 2026-10-05 落盘 `p2-delivery.md`：101 个候选交付文件（含该清单）与 1 个模型快照生成变化分离；`dist/server.js` 与多份新源码当前仍未跟踪，后续整理提交时不能漏掉。索引为空，本轮不暂存、不提交、不推送、不合入 dev。
- app/opencode 的生产 dist 与内嵌二进制为忽略的验收产物，不纳入源码交付；`models-snapshot.js` 构建生成变化需与功能改动区分。
- 完整 P2 high 强度代码审查首次因推理网关 503 中断，未取得结论、不计为通过；已改用两路独立服务端/前端只读审查继续。服务端确认在途 import 失效未清 loading、watcher 并发重复订阅、设置监听器缺默认值三项并进入红/绿修复；示例并发 Child ping 串答已修复验证。runtime 两项最小修复后 34 pass/0 fail（144 assertions）、服务端 typecheck 通过；独立精准复现的 fresh import 返回 pong，增强双门控用例已验证旧 finally 不删新 loading、第三请求复用新导入、停用重启后新请求不受旧挂起阻塞；runtime/RPC/设置 HTTP 组合复验 68 pass/0 fail（3 文件）；独立只读复核与精准复现确认旧加载恢复、身份守卫及通知期间 get()/payload 默认值快照一致，无新增发现。前端审查已收口并确认旧 refresh/reconcile 陈旧覆盖、文本更新重挂载 viewer 两项，均进入生产链路红/绿修复；跨会话组件草稿不保证按既有边界保留，面板“同键不同 query 种子”候选因 tab value 本身包含 query 而撤回。完整修复后的验证结果见“P2 最终审查修复状态”节；6 项确认问题已通过对应回归。

## app 基线失败独立修复（2026-10-06）

用户在 P2 验收与交付清单完成后另行批准修复三个既有 app 全量失败；不修改历史 P2 结果、不扩大页面显示或注入协议。

- 注入预览：非注入 fixture 使用了合法 legacy Background shell 通知，改为真正非注入内容并补 completed/failed 无 metadata 正例；生产识别不改。
- render state：deadline 无字段变化时返回原对象，保留原 `toBe` 契约；42 种状态穷举字段语义与修复前一致，27 种 no-op 保留原引用。
- rows 导入：comments/terminal 整体 UI context 窄 mock 抹掉 useData，改从源头删除 mock，router stub 与 rows 已有导出面一致；新增真实 context 导出断言，生产导出不改。
- 红/绿：原二文件 8 pass/2 fail，增强 reducer 红 4/2，局部绿 13/0；前两项修后全量 1342/1；第三项整合后主工作树三文件组合及反向参数均 29/0，两次独立进程 app 全量均 **1359 pass/0 fail（171 文件）**。
- 最终 workspace typecheck 18/18、browser-condition 59/0、UI 218/0、production app build、六文件 prettier check 与 git diff --check 通过。没有运行模型请求；这些局部契约/测试修复不冒充更新后二进制实机证据。
- 详见 `app-baseline-tasks.md`；交付清单独立附录包含 6 个修改文件与 1 个任务文档。候选交付总数现为 108，另有模型快照生成变化。未暂存、不提交、不推送、不合入 dev；本结果仅说明 app 全量通过，不等于全仓/opencode 全量通过。

## 扩展配置入口迁移（2026-10-06）

- 用户要求扩展系统配置从设置浮窗移动到独立配置页。新增 extensions 栏目，复用配置页三栏：左导航、中全部扩展列表（名称/版本/状态）、右宽设置表单/无设置空态；Plugin 与 Extension 分开。全局 `/config?section=extensions&pick=extension:<id>` 与项目配置路由均可进入。
- 删除 DialogSettings 的扩展标签与旧 settings-extensions.tsx 包装；单扩展表单迁到 config-extension-settings.tsx，复用原 patch/default/secret/touched 校验，按扩展 ID keyed，异步保存捕获身份并在卸载后不写回。config loading shell、en/zh/zht 文案同步。
- 初轮选择/入口/保存工具回归 21/0；最终 app 全量 **1366/0（173文件）**、browser-condition **60/0（14文件）**，其中隔离子进程另执行7项真实表单契约。测试 JSX loader 使用标准模块解析，仅子进程注册，无全局测试mock污染；workspace typecheck18/18、production app build、prettier/git diff --check通过。
- 实机 Vite5194 + 临时API47241：全局深链选中、项目配置入口、普通值/密钥保存与API掩码、无设置项扩展空态、安全模式禁编辑、无效pick回退、浮窗旧标签消失及返回原会话通过；查看最终宽表单截图。浏览器/两个服务已清理，端口释放。空注册表未另起实机服务，纯选择/空态契约覆盖，不宣称已实机验证空注册表。
- 类型检查曾出现 CommandSource 导出解析错误（源文件已有export）；表单翻译依赖收窄为实际六键后复跑通过，未修改原命令上下文。独立标准tsc交叉检查暴露既有UI泛型诊断，不扩展本次修复范围；权威workspace tsgo已全绿。
- 不新增安装/链接/启停/卸载/市场UI，不改服务器协议或secret存储。此次新入口未重建内嵌二进制；此前内嵌截图不能作为本次迁移实机证据。
- 任务见 config-migration-tasks.md，交付清单更新为116个候选文件与1个独立模型快照变化；已删除旧未跟踪组件，无遗漏重复。未暂存、不提交、不推送、不合入dev。

## 配置页扩展启停管理（2026-10-06）

- 复用现有SDK enable/disable与服务端清理，新增API响应ID/enabled/state/同源资源校验；host setEnabled经reconcile应用权威响应并strict refresh收敛，返回info/synced，不把同步失败当持久化回滚。设置保存与页面启停共用同ID/服务器mutation锁。
- 主会话额外发现旧release可能误删同URL新lock，新增红6/1后改symbol身份守卫，绿7/0；client身份防跨服务器迟到写回，reconcile/strict refresh后再查失效，strict epoch supersede拒绝假同步成功；SSE disabled迟到回调不能清理新server/新代注册。
- 右详情统一动作支持无设置项扩展：停用两步确认/取消零请求；dirty/saving/busy禁止操作，增加取消设置修改；无效数字未形成patch仍dirty。安全模式禁止单项绕过，不兼容停用项禁止启用，error/incompatible响应保留真实状态；异步切扩展/连接/卸载后不显示旧反馈。
- 验证：helper/API/bridge定向53/0，后端启停/settings34/0；最终app全量1387/0（175文件）、browser61/0（15文件，子进程另验10动作+10表单）、workspace typecheck18/18、app production build与格式检查通过。独立只读复核确认token锁/响应guard/epoch机制；无真实provider装配的完整并发集成回归，不能把纯helper测试说成完整生命周期保证。
- 页面实测Vite5194+临时API47241：先在会话打开hello viewer并页面child ping，再进入配置页。取消停用后无状态变化；页面确认停用后列表/详情Disabled，CSS撤销；返回原会话文件标签保留、viewer/CSS缺席，child PID30016已退出；从页面启用后返回会话viewer/CSS恢复。已查看停用截图。剩余恢复RPC/dirty门禁实测操作被环境明确拒绝，用户选择保留限制并收尾；不再绕过，也未真实验证多server切换。
- 浏览器/前端/API已清理，5194/47241释放；无真实用户数据修改。manager内部settings更新已有迟到守卫但不参与页面mutation锁，仍可与页面设置形成短暂last-writer快照，作为边界保留。本次前端启停未重建内嵌二进制，不冒充旧内嵌验收。
- 详见toggle-management-tasks.md；交付清单现为125候选与1模型快照变化，未暂存/提交/推送/合入dev。不加入安装/链接/卸载/市场或更改后端语义。

## 后续阶段

- P3：npm/归档安装、升级、卸载、管理界面和市场索引。
- P4：WolframScript Notebook 与首批文件预览扩展。
