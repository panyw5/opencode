# wls-repl（WolframScript REPL + 断点调试）任务记录

> 集成更新（2026-11-03）：已通过 `2cca27da78` 合入本地 dev，未推送、未发布。本包及锁文件已对齐1.18.63，构建和非真实 kernel 定向14/0通过；真实 Wolfram、最终分发/跨平台矩阵未重跑，dist 仍未追踪。当前证据见 `specs/extensions/delivery.md` 顶部，以下保留合入前及原日期历史。

状态：**v1 + wolfram_eval 工具已实现，macOS 定向验收通过**。主体已随 `6216969c38` 提交，目录安装与重装修复也已本地提交；状态核对：2026-11-03，当前 HEAD `6faed064da`。这是扩展系统 P4 计划中的首个业务扩展（design.md §11 的 `.wls` 方向变体：断点调试 REPL + 共享 kernel 工具），不是完整 Notebook 或跨平台交付。

当前交付入口：`specs/extensions/delivery.md`。本包 manifest 为 1.18.61，锁文件条目仍为 1.18.58；`dist/` 未被 Git 追踪，历史本地已构建/外部已发布不代表干净 checkout 自带当前产物。本次只改文档、不重建、不提交、不推送、不发布。下方记录保持原日期，旧“未提交”及临时产物描述不代表当前 Git/发行状态；最新修正优先于早期结论。

## 交付物

- `packages/extensions/wls-repl/`：manifest（`local.wls-repl`，replace-mode viewer 匹配
  `.wls`，设置 wolframscriptPath/statementTimeoutSeconds/maxKernels）、`src/bridge.wls`、
  `src/server.ts`、`src/web.tsx`、`src/web.css`、测试 3 文件、已构建 `dist/` 产物。
- `bun.lock`：新增 wls-repl workspace 条目；顺带把工作树中已改为 1.18.58 的
  extension-kit/hello-viewer 版本元数据同步进锁文件（此前 release 工作未完成的对齐）。

## 设计要点（相对 design.md 的新增决策）

- 断点机制为全新设计（design.md §11 只有 notebook 的 eval 桥，无断点概念）：
  kernel 内动态插桩 —— `Read[s, HoldComplete[Expression]]` 逐条切分 + `StreamPosition`
  行号映射，断点命中即进入阻塞暂停循环，经 stdout 协议行上报变量快照并服务
  inspect/continue/step/abort 指令。
- 控制通道改道：spike 实测 stdin/FIFO/socket 全不可用（见包 README 的"关键事实"），
  改为控制文件 + `!tail -f` 跟随读。
- bridge 独立 `WLSBridge`` context + `Off[General::shdw]`；用户代码跑在 `User`` context。
- 协议行 `RS + 8 位 hex nonce + 压缩 JSON`，防用户 Print 伪造。

## 验证证据（2026-10-24，macOS / wolframscript 13.3.1 ARM）

自动化（`bun test test`，16/0）：

| 文件                                   | 覆盖                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `test/server.test.ts`（7）             | 假 kernel：ctl 命令写入、协议路由/状态机、busy 门禁、非法输入、dispose、kernel-exit、maxKernels LRU 逐出                    |
| `test/bridge-integration.test.ts`（6） | 真实 wolframscript：断点暂停+变量快照+检视+继续+结果行、step/abort、语句超时中止、语法错误、Stop 终止进程、死亡宿主孤儿清扫 |
| `test/web.test.ts`（3）                | 定义文本美化（`HoldPattern[a] :> 1` → `a = 1` 等）                                                                          |

实机（隔离 dev Electron：`OPENCODE_TEST_ONBOARDING=1` + `OPENCODE_CDP_PORT=9255`，唯一
临时 userData/XDG，隔离 registry `opencode extension link`；全部由本人经 CDP 操作）：

- 打开 `.wls` 自动懒激活，viewer 渲染（状态徽标/行号/控制台/输入框）。
- gutter 点击设置断点（7、9 行红点）；Run → 停在首个断点，当前行高亮，变量面板显示
  `nums = {1, 4, 9, 16, 25}`、`total` 等实时值；Continue 后 `total = 55` 更新。
- 暂停态 `inspect>` 输入 `total * 2` → 110；Step 单语句推进（9→10，`mean = 11` 出现）。
- 跑完后空闲 `In>` REPL：`mean * 3` → 33（状态保持）。
- Stop → status "kernel stopped"、console "kernel exited (code 0)"、`ps` 确认 0 残留。
- Restart → 状态重置提示；服务器模块热重载（重建 dist）自动 dispose 旧 kernel 并重载。
- 配置页 Extensions 分区显示条目 + 三项设置 + Disable/Update/Remove 操作。
- 截图：`/tmp/wls-paused-final.png`、`/tmp/wls-paused-clean.png`、`/tmp/wls-config-page.png`。

## 修复过程中确认的缺陷（均已修复并有回归）

1. 暂停循环 `While` 多一个参数 → 整个暂停机制失效（spike 抓到）。
2. `Definition[Symbol[name]]` 触发 `Definition::ssym`；`With`/`Evaluate` 传入会先取 own
   value。最终惯用法 `ToExpression[...] + RuleDelayed`。
3. bridge Module/Table 名污染 `Global`` → 用户变量 `b`/`t`撞名`shdw` 告警。
4. wolframscript 忽略 SIGTERM + unref 升级定时器在宿主快速退出时不触发 → 测试孤儿泄漏；
   改为 shutdown 命令 → SIGTERM → await 路径内 SIGKILL。
5. 宿主被直接 kill 时不 dispose → detached kernel 孤儿；`kernel-pids.json` 记录
   hostPid，激活时清扫宿主已死的 kernel（并发活宿主不误杀，`ps` 命令行校验）。
6. stderr 噪音过滤正则 `$` 锚点/前导空格两轮修正。

## 明确边界（v1 不含）

编辑器/保存桥、notebook(.wlnb)、`wolfram_eval` Agent 工具（design §11 的共享 kernel 工
具，作为下一增量）、Step Into、断点跨刷新持久化、语法高亮/CodeMirror、Windows/Linux 验
收（`tail`/`ps` 为 Unix 依赖）、多服务器矩阵。未提交、未推送、未合入 dev；真实用户
registry 未触碰（全程隔离 registry）。

## 增量：`wolfram_eval` Agent 工具 + 变量面板修正（2026-10-24 第二轮）

- 实例级 `server()` hooks 注册 `wolfram_eval`（`@opencode-ai/plugin` 的 tool 契约）：
  `code` 必填、`path` 可选；带 `path` 复用该文件 kernel（Agent 与用户共享变量，验证
  design.md §11 的组合目标），否则用目录级共享 kernel（`.wolfram-tool` 键）。运行时
  `instanceHooks` 先 `ensureService` 再 `callServer`，工具执行时 `input.extension.service`
  必然可用（无模块级状态）。
- 服务新增内部 RPC `kernel.evalAwait`：发 eval 并等待同 id 的 `eval-result`/
  `inspect-result` 协议行后返回（工具无法消费事件流）；超时 = 语句超时 + 30s 冷启动余量。
- 设置 `exposeTool`（enum always/never，默认 always）在工具执行时实时读取；manifest 权限
  增加 `tools`；结果文本截断 4000 字符。
- 变量面板去掉 `name = name = value` 冗余（own-value 剥前缀，函数定义保留签名）。
- 验证：包内测试 **21/0**（假 kernel 工具执行/禁用不 spawn + 真实集成：用户文件 kernel
  定义 `q = 6` 后工具 `q * 7` → 42、目录 kernel 独立、`r = 5`→`r + 1` → 6 状态保持）；
  typecheck/prettier/构建通过；dev Electron 回归：viewer 正常、断点暂停、变量面板显示
  `nums => {1, 4, 9, 16, 25}`（截图 `/tmp/wls-tool-vars-clean.png`），实例 hooks 注册无错
  误日志。未发起真实模型请求调用工具（执行路径由直连测试覆盖）。
- 清理注意：本轮结束清理 dev 实例时误杀了主仓库 9222 dev 实例的 `bun` wrapper（其
  Electron 本体存活且 9222 仍响应，需要时可重新 `bun run dev:desktop`）。

## 增量：自包含归档独立安装（2026-10-24 第三轮）

- 依赖结构改为可分发：`@opencode-ai/extension-kit`/`plugin` 移入 devDependencies（仅构建期需要），新增 `files: ["dist", "README.md"]` 白名单。产物自包含已核实：`dist/server.js` 仅 `node:*` 导入，`dist/web/index.js` 零裸导入。
- `npm pack --offline` 产出 80KB 归档（package/dist + package.json + README，bridge.wls 随 dist）；sha256 `b668519c…e5345`（随构建变化，不作为固定值）。
- 隔离 CLI 安装：`state=committed committed=true synced=true cleanupPending=false`，`extension list` 显示 ready、来源为 tgz+sha256。
- dev Electron（TEST_ONBOARDING 隔离 registry）安装归档后：打开 `.wls` 自动激活、断点 Run → paused line 7、变量面板 `nums => {1,4,9,16,25}`；`ps` 证实 kernel 由 `extension-modules/local.wls-repl/<内容指纹>-<uuid>/dist/bridge.wls`（安装副本，非源码目录）启动；配置页显示 Disable/Update/Remove 与全部四项设置。
- 受管移除实测：两步确认（review → Confirm operation）后条目消失，kernel 进程清零（dispose 清理链在安装来源上同样有效）。
- 仍不可行/未做：npm 公网安装（kit 未发布）；release URL 公网安装（需先上传归档+发布 descriptor，未做上传决策）；本轮归档与安装全部在临时隔离环境（/tmp/wls-pkg、mktemp HOME/XDG、TEST_ONBOARDING root），日常 registry 未触碰；未提交。

## 增量：GitHub 公开仓库与 release 分发（2026-10-24 第四轮）

- 新仓库 https://github.com/panyw5/opencode-wls （PUBLIC，用户创建并明确授权推送）：
  扩展包整体为仓库根目录（src/test/dist/tsconfig/vite.config/README/LICENSE/.gitignore），
  两个提交（初始内容 + stable.json/README 修正）。dist 保留提交——web 构建依赖 kit 的
  vite 插件（未公开发布），monorepo 外暂不可构建，README 已注明。
- 分发链路：仓库内 `npm pack --offline` 产出 81759 字节归档 → `gh release create
v1.18.58` 上传资产 → `script/extension-release.ts` 生成 `stable.json`（artifact URL
  指向 release 资产，sha256 `22d0d61f…2432`）→ 提交到仓库根，raw URL 公网可达（200）。
  curl 复核资产下载 200、字节数与摘要逐位一致。
- **首次真实公网 `--release` 在线安装尝试失败并定位为环境边界**：CLI 无 `--release`
  标志时把 descriptor URL 当归档直链拒绝（需补标志，README 已修正）；带标志后下载器
  报 `DNS returned a non-public address`——本机代理为 fake-IP 模式（GitHub 全部域名解析
  为 198.18.0.0/15），`publicAddress` 按设计拒绝该段，默认 transport 用 node:dns 系统
  解析、无代理路径。这是公网正向验收的首个真实发现，未绕过安全校验。
- **替代闭环完成**：curl 经系统代理下载 release 资产 → 摘要与 descriptor 完全一致 →
  本地归档入口安装同一字节：隔离 CLI `committed/synced`，list 显示 ready 且来源为
  tgz+sha256；dev Electron（隔离 registry）安装后打开 `.wls` 自动激活、断点 Run →
  paused line 7、变量面板正常，kernel 由安装副本（`extension-modules/<id>/<指纹>-<uuid>/dist/bridge.wls`）启动。
- 未做：真实公网 `--release` 在线正向安装（需非 fake-IP 网络，如手机热点或代理 real-IP
  模式后复测）；npm 公网安装（kit 未发布）。所有安装均在临时隔离环境，日常 registry
  未触碰；monorepo 侧改动仍未暂存/提交。

## 增量：桌面拖拽安装 .tgz（2026-10-24 第五轮）

- 用户需求：拖入 .tgz 完成安装（替代手填 sha256 的 CLI 流程）。设计原则：拖拽承担"选文件"，**不承担"免确认"**——摘要核对仍强制。
- 安全边界保持：HTTP prepare 仍拒绝 local（"CLI-only" 边界原样），新增**桌面 sidecar IPC 通道**：renderer → preload（window.api.extensionArchiveDigest/Op）→ main（重算 sha256 作为可信校验）→ sidecar parentPort 命令（extension-archive prepare/commit/status/cancel）→ sidecar 进程内调用与 CLI/HTTP 同一 `installation()` 服务（node.ts 新增该导出）。digest 由主进程读文件计算并显示，用户与发布页核对一致才启用 Prepare；服务端 prepare 最终校验。
- 渲染层：`InstallationSource` 增 local 变体（desktop-only，HTTP install-api.ts 显式拒绝）；dialog 增本地模式（路径只读 + 计算摘要展示 + 期望摘要输入 + 匹配徽标）；config Extensions 分区挂 `ExtensionArchiveDropTarget`（模块级单例消费者注册表 `takeArchiveDrop`，layout drop handler 在文件全为 .tgz 时优先交给它，否则落回附件路由）；web 环境自动降级（platform 方法缺失即不注册）。
- 附带修复：electron.vite renderer dev server 加 `strictPort` + `OPENCODE_RENDERER_PORT` 覆盖——本机另一项目 dev server 绑 `*:5173` 造成模块串线（页面从错误 server 取到陈旧 layout transform），strictPort 使冲突显式失败。
- 验证：新增单测 11 个（digestMatches/local operations/drop 注册表/archive digest）全绿；app 115 定向测试 0 fail；desktop archive-digest+server 21/0；app/desktop typecheck、prettier、electron-vite build、build-node 通过。
- **CDP 实机全链路**（隔离 dev Electron，端到端）：`Input.dispatchDragEvent` 真实拖拽 → 弹窗本地模式（计算摘要 22d0d61f… 正确显示）→ 错误摘要被拒（mismatch 徽标 + Prepare 禁用）→ 正确摘要 → Review → 预览（信任警告/权限 process:spawn/贡献点/Settings:4）→ Enable 勾选 + Confirm → 安装成功 → 配置页列表 Enabled → 打开 .wls 断点暂停、变量面板正常，**kernel 由安装副本（extension-modules 内容指纹目录）启动**。截图 `/tmp/wls-draginstall-paused.png`。清理后零残留进程。
- 排错记录（写入日志的教训）：① patch 断言失败导致 layout 拦截段静默未写入（import 行在而逻辑段不在）——对同一文件多次 patch 必须整体验证；② sidecar parseCommand 未识别新命令导致请求静默丢弃；③ virtual 模块声明（env.d.ts）与 bun build 平铺导出形态不一致；④ 5173 端口串线见上。清理时再次波及主仓库 9222 dev 实例（Electron 本体被误杀，可 bun run dev:desktop 恢复；安装版 app 未动）。
- 边界：拖拽安装仅桌面端；web/远程 UI 无此入口（也无本地路径概念）；registry v3 升级不适用（archive 本地源不触发，release 源才有 v3）；未提交。

## 增量：内置目录占位条目（2026-10-24 第六轮）

- 用户需求：wls-repl 作为内置占位条目介绍给用户、可选择安装。实现为硬编码目录 `packages/app/src/extensions/catalog.ts`（纯数据 + `pendingCatalogEntries` 过滤），不做远程获取（P3b marketplace 未来替换数据源而非消费者）。
- 配置页 Extensions 分区头部新增 `ConfigExtensionCatalog` 卡片（`data-catalog-entry` 锚点）：仅当该 id 未安装（任意来源）时显示；"Install" 打开既有 DialogInstallExtension，新增 `InstallationIntent { kind:"install"; releaseUrl }` 变体预填 `sourceType=release` + URL。全部走既有 release 安装确认链（摘要、v3 升级确认）；不自动安装、不静默下载。
- i18n en/zh/zht 三键（含 fake-IP 网络下拖拽归档替代路径的提示）；卡片文案用全局 useLanguage（弹窗语言接口用适配器传入）。
- 验证：catalog 单测 2/0（URL 校验 + 已安装过滤）；app 扩展定向 118/0（含 parity）；typecheck 0 错误；prettier 通过；CDP 实机（隔离 dev Electron）：卡片随未安装状态出现、点击 Install 后弹窗 sourceType=release 且 URL 预填为 stable.json 地址（截图 /tmp/wls-catalog-dialog.png）；安装→断点调试链路此前已验收，本轮验证到预填。清理后零残留。
- 边界：占位目录与 app 同版本发布（更新条目需发版）；release 直装受 fake-IP DNS 校验边界影响（卡片文案已提示拖拽替代）；未提交（本轮以独立提交留在本地分支）。

## 增量：目录卡片改两栏交互（2026-10-24 第六轮修正）

- 用户反馈：中栏卡片只保留标题、作者，详细信息与安装按钮移到右栏详情区。
- 重构：中栏改为紧凑行（`ConfigExtensionCatalogEntry`，标题 + 作者，复用 `state.pick` 选择机制，新增 `catalog:<id>` pick 前缀）；右栏新增 `ConfigExtensionCatalogDetail` 分支（名称/作者/描述/安装来源/Install 按钮，优先于已安装扩展详情匹配）；catalog 数据增加 `author` 字段；i18n 补 `catalog.source` 键。
- 验证：app 118/0（含 parity）、typecheck 0 错误；CDP 实机：中栏行仅显示标题+作者、点击后右栏详情出现、详情 Install 按钮弹窗预填 release URL（截图 /tmp/wls-catalog-twopane.png）。已提交。

## 增量：目录安装改走 renderer 辅助下载（2026-10-25，用户实测反馈修复）

- 用户实测目录卡片 Install 后，release 直装弹窗出现"请检查来源和校验值"（archive 模式 + 空 sha256 的破碎状态）——且本机 fake-IP 网络下 release 直装（sidecar 直连下载被 publicAddress 校验拒绝）注定失败。
- 根治：目录安装改为 **renderer 辅助下载 + 本地归档通道**。新 `catalog-install.ts` 流程：renderer fetch descriptor（fetch 走系统代理，Chromium 校验 https + redirect:"error"）→ fetch artifact（release 资产必然 302 到 CDN，允许跟随；摘要核对是安全闸）→ WebCrypto 摘要核对 descriptor → main 新增 staging IPC（字节写临时文件，commit/cancel 后自动清理）→ 既有 local prepare/commit 通道（enable 默认 true）。descriptor id 与目录条目匹配校验。
- UI：详情面板 Install 按钮驱动流程，阶段标签（读取描述/下载归档/校验通过/准备/提交/完成）内联展示；无 desktop 通道时显示拖拽归档提示（降级）。
- 验证：单测 6 个（descriptor 解析/拒绝矩阵、注入 fetch 的全流程、摘要不符中止、id 不符中止）；app 124/0 含 parity；typecheck 0 错误。**CDP 实机（隔离实例）：目录 Install 一键真装成功**（renderer 代理下载 GitHub descriptor+归档 → staging → local prepare/commit → Enabled），打开 .wls 断点暂停正常，kernel 由安装副本启动（截图 /tmp/wls-catalog-installed.png）。
- 过程教训：CDP 判断"超时"实为 flow 完成后 DOM 卸载导致轮询元素消失（误报）；多实例残留在 9255 造成旧 main/新 renderer 混合假象——清理必须 lsof 确认端口归属。未提交（本轮独立提交）。

## 增量：目录条目并入中栏列表（2026-10-25 修正二）

- 用户反馈：目录条目未安装时也应作为普通列表行放进中栏扩展列表，点击后右栏显示详情（去掉分区头部的独立大卡片）。
- 实现：中栏列表在已安装 `For` 之后追加目录 `For`，复用 `ListButton`（title=name、meta=author、note="未安装"、active 联动 `catalog:<id>` pick）；无已安装扩展且目录有条目时抑制"尚未链接扩展"空态；右栏 `ConfigExtensionCatalogDetail` 不变；移除旧的 header 卡片与 `ConfigExtensionCatalogEntry` 组件。i18n 补 `catalog.notInstalled`。
- 验证：app 124/0、typecheck 0 错误；CDP 实机：列表行 `WolframScript REPL | Not installed | panyw5`，点击右栏详情出现（截图 /tmp/wls-catalog-list.png）。已提交。

## 增量：目录卡片样式对齐 AGENTS.md 卡片（2026-10-25 修正三）

- 用户反馈：卡片样式参考其它配置页的卡片。复用 `ProjectListGroup`（AGENTS.md 分区）的视觉语言：`rounded-[14px]` 卡片、图标方块（dot-grid）、状态 pill（NOT INSTALLED）、chevron、顶部渐变高光线；active 态对齐 open 态。
- 中栏列表的 ListButton 行替换为 `ConfigExtensionCatalogEntry` 卡片（恢复导出，新增 note prop）。CDP 实机确认渲染与点击联动（截图 /tmp/wls-catalog-cardstyle.png）。已提交。

## 修正：卸载弹窗按钮文案（2026-10-25，用户反馈）

- 用户发现 Remove extension 弹窗的准备按钮显示 "Review installation"。根因：按钮标签固定用 `install.preview` 键，不区分操作类型。
- 修复：`previewLabel()` 按 intent.kind 返回 preview/previewUpdate/previewUninstall 三键（en/zh/zht 新增），`installationTranslationKeys` 同步注册。CDP 实机验证安装弹窗 "Review installation"、卸载弹窗 "Review uninstallation"。

## 增量：已安装扩展统一卡片样式（2026-10-25 修正四）

- 用户反馈：已安装扩展的行还是旧 ListButton 样式。将卡片组件泛化为 `ExtensionCardRow`（title/subtitle/note/warn props），已安装行（subtitle=`id · v版本`、note=状态、warn 红色 pill）与目录行（subtitle=author、note=未安装）共用。
- 期间用户窗口再次出现 ConfigExtensionCatalogEntry 缺失导出的 SyntaxError——根因同前：其窗口连接的 dev server 被清理后模块图失效；新实例即恢复。以后给用户开检查实例前先杀旧 server。
- 验证：app 118/0、typecheck 0 错误；CDP 实机：目录卡片点击 → 一键安装 → 目录卡片消失、已安装行以同款卡片显示"已启用"（截图 /tmp/wls-uniform-installed.png）。已提交。

## 修正：重装 conflict 的真正根因（2026-10-25，用户二次反馈）

- 用户重启后重装仍 conflict——排除"进程 pin"解释。深挖发现 **`recoverInstallations` 自 P3a 写好后从未接线**（无任何生产调用点，仅测试使用）：卸载时 kernel 存活导致 purge 延后（cleanupPending=true + retained 记录），重启后无人恢复清理，retained 永久阻塞同 id 重装。P3a 文档声称的"重启后恢复清理完成"实际从未生效——P3a 未标记完整交付状态下的集成遗漏。
- 修复：extensions 启动 layer（watcher/observeInstallations 旁）调用 `recoverInstallations()`，失败/仍 pending 记日志不阻塞启动。install-service 测试 12/0、全量 587/0。dist/node 重新构建（sidecar 生效需此步，dev 重启不会自动重编）。
- 用户操作：重启开发版（sidecar 携带修复）→ 启动恢复清理 retained → 目录重新安装。

## 状态机重构（2026-10-25，用户要求系统性整理）

用户明确要求：重新整理安装/卸载/启动载入流程，不补丁式修复，状态管理避免竞态。全量探索（安装状态机、registry 状态布局、清理机械、三入口、测试基线 ~355 用例）后交付：

1. **重装与 retained 解耦（purge-aware CAS）**：install.ts 的 commit/fenced CAS 区分两种 retained 变化——tombstone 被自身清理消费（消失）→ 安全放行；被另一个 removal 改写 → ABA 拒绝。registry.ts 的 purging-in-progress 报独立可行动错误（"cleanup still running; retry"）。commitInstallation 保留 `!current && retained && revision !== expected` 的 ABA 检查（purged tombstone 不阻塞）。commitRemoval 的 expectedRetainedRevision 参数保持（曾误删致 "data changed"，已复原）。
2. **observer 增量恢复**：registry 每次 diff 后去重触发 recoverInstallations（写 receipt/retained 可解锁被推迟的清理，不再等重启）。
3. **错误透传**：InstallError 的消息在源头精修（无 URL/凭据/路径），CLI/HTTP 透传而非替换为按 code 的固定文案。
4. **评估后放弃**：prepare 阶段的跨进程 staging 互斥——按扩展 id 互斥会阻塞合法并发装/卸意图，且 commit CAS + generation lease 已正确裁决竞争（"loser cannot remove winner" 被 pin）；prepared receipt 持久化进 registry——与 ~30 处 registry.json 精确断言和观察者假设广泛冲突，且 staging 目录本身已是 prepared 状态的持久化（operation.json + cleanup.recover 的 lease-gated 恢复已存在）。

验证：全量 589/0、typecheck 0 错误、dist/node 重编。保留边界：leases/flock 双锁体系、非原生 runtime lease busy、quiesce blockers sticky、registry v3 格式——均未动（另案）。

## 状态机重构收尾：重装场景三连修复（2026-10-25 深夜）

状态机重构后实机复现"卸载→立即重装"仍失败，逐层定位出三个独立缺陷（每层都是上层的错误文案掩盖了真实原因）：

1. **sidecar parseCommand 未放行 `cleanup-retained` op**：命令被静默丢弃，main 的 pending promise 永不返回（UI 表现为卡在某阶段）。教训：新增 op 必须同步 sidecar 运行时白名单。
2. **sidecar commit 错误透传缺失**：`ExtensionInstallError` 被 main 进程 catch 后归一为通用 "Extension changed..."，真实原因（"Extension data belongs to a different installation"）不可见。现在 InstallError 的 code+message 原样回传（消息在源头精修，无敏感内容）。
3. **根因——retained 继承的 archive 身份用临时路径**：`sourceIdentity(archive)=archive:${location}`，而 location 是 staging 临时文件路径，同一字节内容的两次安装路径必不同 → 卸载后的同包重装被判"不同安装"。修复：继承判定改为 **location 匹配 OR sha256 匹配**（archive tombstone）——字节相同即继承；真正不同的包仍拒绝（防止数据跨来源泄漏的保护保留）。曾尝试纯 sha256 身份（全局 sourceIdentity），被 41 个测试否决（update 场景不同版本 sha 必不同）；OR 语义通过全量 589/0。

附带：catalog 流程对 in-flight purge 做短暂等待重试（此前立即失败）。

**实机闭环验证**（隔离 dev，最终构建）：目录一键安装(ENABLED) → Remove(purge, deferred) → **立即重装成功**（relisted=true、flow 无错误、截图 /tmp/wls-reinstall-success.png）。此前该场景连续失败的观察技巧教训：flow 完成后 DOM 即卸载，轮询元素消失会被误读为 timeout；错误文案映射(code→固定文案)会掩盖根因——两者在本次调试中都造成了误导。
