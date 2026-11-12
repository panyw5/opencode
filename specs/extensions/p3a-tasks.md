# P3a 安装、升级、卸载与确认页任务

> 集成更新（2026-11-03）：已通过 `2cca27da78` 合入本地 dev，未推送、未发布。实际归档 IPC 安装/启用、RPC200、卸载后 RPC404 已复验；Node purge 仍按设计延后，不宣称完整恢复/跨平台交付。当前证据见 `specs/extensions/delivery.md` 顶部，以下为合入前核对与阶段历史。

实施基线：`3a0d101b22`（dev 1.18.58）；分支 `claude/extensions-p2-design`。主实现已本地提交为 `86619dfa4a`（57文件，+14793/−194）；后续 release/拖拽/目录安装与状态机修复也已提交，当前 HEAD `6faed064da`。状态核对：2026-11-03；未完成最终交付，未合入当前本地 dev，未联网核实远端。本次只更新文档，不提交、不推送、不合并。

当前范围、提交、验证与待办见 `specs/extensions/delivery.md`。本次安装相关 3 文件复验 73/0；不把该定向结果当成 GUI 或完整恢复矩阵验收。

**证据更正（2026-11-03）：** 10 月 25 日确认 `recoverInstallations()` 缺生产启动调用点，`bab60d035f` 才接入，后续加入 observer 增量恢复。因此下方 10 月 17 日“重启后恢复清理完成”撤回为生产启动集成通过的依据。原观察记录保留供追溯；修复后的状态机与最终 Electron 重装证据见 `wls-repl-tasks.md`，未完整重跑历史恢复矩阵。

以下各节为原日期的历史记录；“本轮”“未提交”、版本及旧分叉数字不是当前状态。

## 历史收尾（2026-10-18）

- 最后UI要求已落实：预览安装放到npm包名/更新版本输入框右侧并等高；archive使用URL右侧，SHA-256独立下一行；卸载保留底部入口。不改变安装服务、提交确认、blocked/pending及取消逻辑。
- 新增布局契约覆盖npm/version/archive的同行顺序、单一预览入口及34px高度约定，并检查卸载底部入口。隔离Solid契约12项通过（外层wrapper1/0，不重复累计）。修改后App全量1710/0（207文件）、browser-condition63/0（17文件）、App typecheck通过。
- 真实Chromium独立页挂载当前源码表单，npm和archive的可见输入框与按钮均34px，上下沿一致、间距8px；已查看截图 `/tmp/extensions-install-layout-20261018.png`。这是布局验证，不是重新执行安装/服务端/三形态端到端验收；未连接安装服务、未操作真实registry，验证页已关闭，原有桌面进程未重启。
- 本轮修改前复验：后端extension选择439/0（23文件）、kit17/0、示例14/0、App/opencode/kit typecheck通过。选择范围不同于历史516/1skip组合；后端/kit/示例随后未修改，不声称重跑全仓后端或全部workspace。
- 进度文档已记录本地提交和本轮验证，保留本清单的事务/生命周期完整验收门槛。已有三个包版本1.18.57→1.18.58及模型快照改动保持原状；本轮未重生成产物、未验证锁文件/发布一致性。
- 集成待办：本地HEAD...dev为20/7，未fetch/merge；公网npm/HTTPS、多服务器、故障全场景与跨平台缺口仍按下方记录，不因按钮修正而标记完整交付。

## 范围

- P3a 初始范围为 npm 与自包含预构建 `.tgz`，管理页支持 npm/HTTPS URL，本地归档当时仅服务器 CLI。后续已加入桌面本地 IPC 拖拽/目录安装；HTTP 仍拒绝 local，Web/远程 UI 不提供本地路径入口。
- 准备/预览/确认/提交、升级、卸载、默认保留数据及显式 purge。
- P3b 市场、ZIP、自动更新、沙箱、项目级安装不在本批。

## 会话清单

- [x] 检查工作区干净、HEAD 与 Bun 1.3.9，建立任务记录。
- [x] 基础模块：registry v1→v2、来源/安装身份、revision、原子提交回执、保留配置与受管目录边界；仍需核实共享旧进程迁移门禁，不代表完整上线协议完成。
- [x] 安全获取模块：HTTPS/摘要校验、受限 tgz reader、npm registry-only 图与无脚本物化；未做公网/企业 registry 验收。
- [ ] 事务：prepare/token/TTL/取消、幂等 commit、并发 CAS 已有模块与回归；已接受管孤儿扫描和有证明的 GC/purge，未知trash与平台不支持状态保守延后，仍非全场景自动恢复。
- [ ] 生命周期：runtime持有generation/data整进程引用，strict quiesce不提前释放；已接跨进程内核锁证明与延后GC。Node/Windows/无FFI持久阻止自动清理，完整跨平台验收未完成。
- [x] 接口：HTTP/错误、SDK/OpenAPI、CLI 已接同一安装器；生产CLI离线归档冒烟通过。
- [x] 页面：安装确认、更新/卸载、dirty/saving/server 切换与同步反馈已实现，真实Solid契约与Vite最小实机通过。
- [x] 回归：安全、故障、并发、扩展运行时、App/UI/browser与6包typecheck、生产前端构建通过；完整交付验收仍待最终复核。
- [x] 隔离实机：Vite/Electron/内嵌生产 Web 已完成核心链路验收；公网npm/HTTPS、多服务器矩阵、全量故障场景明确未验收，未绕过权限拒绝。
- [x] 更新本轮progress与P3a任务记录，给P2 delivery增加历史范围提示。
- [ ] 最终交付前同步design与完整delivery，复核发布产物、限制和实际证据。

## 必须保留的门槛

确认前不执行扩展；归档链接/路径越界/超限拒绝；npm危险协议先拒绝再解析。注册表指针与回执原子写入；所有写入口共享revision与锁。升级不泄漏旧secret，不覆盖并发设置。旧包/用户数据无安全释放证据不删除；开发链接只unlink。已持久化但运行时失败明确报告，不伪造事务回滚。权限、沙箱与secret存储仍按P2边界。

## 结果记录

## 实机验收（2026-10-17，清理门闩修复后当前代码）

隔离环境均为临时 XDG/HOME/registry（0700）+专用端口+Basic 鉴权；无模型请求、无真实用户配置、未访问公网模型源（构建用 MODELS_DEV_API_JSON 指向当前快照）。

- **Vite 源码形态**（隔离 API 47257 + Vite 5197）：生产 CLI 安装 v1 --enable → 页面无刷新列出 → 鉴权 RPC 1.0.0 → CLI update v2 → RPC 2.0.0，且服务进程存活时旧代包目录保留（进程 pin 生效）→ 页面移除+显式 purge → RPC 404，两代包目录、数据证明文件、2 条 pending receipt 均保留 → 重启同 registry → 恢复清理回收两代包并删除数据，pending 0、purgedAt 落盘。
- **Electron 桌面**（当前 Node sidecar 经 build-node.ts 用当前快照构建 + electron-vite 当前 renderer；OPENCODE_TEST_ONBOARDING 隔离 userData、临时 HOME/XDG/registry、CDP 9257）：CLI 安装共享临时 registry → 桌面页面列出 → CDP 内存内 fetch 清单 200、RPC 200（"2.0.0"）→ 页面确认移除 → RPC 404，Node 运行时无内核引用证明，purge 按设计延后（durable unsupported 标记 1 条，pending receipt 保留）。
- **内嵌生产 Web**（当前编译二进制 `1.18.58-claude-extensions-p2-design.202610171333`，离线构建冒烟通过）：CLI 安装 → 内嵌页面列出扩展 → RPC 2.0.0 → 页面确认移除 → RPC 404；返回 HTML 与本地 app/dist/index.html 逐字节一致，CSP 响应头存在。
- 模型快照哈希构建前后经 shasum 校验未变；截图证据 `/tmp/extensions-p3a-electron-install-dialog.png`、`/tmp/extensions-p3a-electron-loaded.png`、`/tmp/extensions-p3a-electron-removed.png`、`/tmp/extensions-p3a-embedded-removal-current.png`。
- 桌面认证凭据仅在同一 CDP evaluate 内存调用内使用，未写入磁盘（一次将密码持久化到 /tmp 的尝试被权限拒绝，已遵从改用内存方式）。
- **明确未验收**：公网 npm/HTTPS 真实包安装、多服务器 A→B→A 全矩阵、完整故障/超时场景、Linux/Windows。验收后专用实例全部退出，端口 47257/5197/47259/9257 已释放，浏览器任务已关闭；临时目录保留为证据。

## 清理恢复定向审查结果（2026-10-17）

- 三项已修并有红/绿证据：generation已隔离到trash但删除未完成时，按原UUID关联精确pending，不能因原路径missing误清对应receipt；同源path relink恢复retained settings/secretKeys并校验迁移、消费墓碑；数据目录为空时仍校验已有owner来源，不删除另一来源的记录。
- 额外行为决策已由用户明确选择：拒绝把受管安装副本当开发链接。新增link以及旧path row的hydrate/linked/runtime import前检查受管ancestor身份，跨registry回归确认不import；普通源码目录不受影响。保留同registry目录引用的GC防线，兼容未带metadata的历史记录。
- 主线程最终组合：**513 pass / 1 skip / 0 fail（25文件）**；opencode/App typecheck、完整browser-condition **63/0（17文件）**、git diff --check通过。没有重新执行真实GUI或跨平台验收，没有SDK契约变更。
- 清理门闩阻塞后续已修：全局generation/operation门闩仅覆盖证明检查与rename，精确UUID的cleanup-claims通过原子mkdir独占整个隔离删除生命周期；递归删除在全局门闩外执行。新增两种慢删除暂停回归确认其他ID仍能acquire、同quarantine重复collector被拒，以及crash claim永不按TTL抢占。清理模块22/0；完整主区组合 **516 pass / 1 skip / 0 fail（25文件）**，opencode typecheck、git diff --check通过；只读复核未发现新的确定问题。未重跑实机，不宣称跨平台完整验收。
- 审查工具三项最小修复组合435/0（23文件）与主线程513/1skip/25文件范围不同，分别记录；红/绿日志在 `/tmp/extensions-cleanup-review-red.log`、`/tmp/extensions-cleanup-review-green.log`。未提交、未推送、未合入dev，模型快照未改。

## 清理与恢复实施（2026-10-17）

- 新增leases/cleanup/data模块。注意core Flock为目录心跳过期锁，不能当进程存活证明；引用使用所有driver共享的无过期mkdir gate＋Bun POSIX内核flock，稳定inode/完整proof清单。Node/Electron/Windows或无FFI仍允许运行，但写持久unsupported标记，GC/purge始终延后；遗留gate不按TTL抢占。
- runtime在任何扩展import前固定全局data引用，managed额外固定generation引用；导入过的引用整进程保留，disable/reload/strictstop都不释放，防脱管timer/raw closure。测试reset才可显式释放干净fixture引用，生产没有提前释放API。
- installer在mkdir前持operation/generation引用，写0600的host ownership；prepared lifetime持operation，物化/CAS/协调/清理全程持generation；最终回执反映真实cleanupPending，不一概写true。
- GC先排除活引用，再在registry锁内排除installId及任何指入目录的path row，只重命名host-ownedUUID目录到private trash，锁外递归unlink/rmdir不跟链接。恢复只读无secret ownership.json，扫描有上限；缺证明/损坏/未知/不安全权限一律保留。已有未知trash只报告pending，不猜测删除。
- 数据purge需全局ID引用exclusive＋当前retained revision；新managed数据有来源ownership，legacy未知数据不被adopt/接管/删除。先记录purging intent，完整quarantine journal落盘后rename；journal校验目标inode并支持rename后中断续清理。只有finish成功才解除namespace fence；purgeCompleted与registry原子保存，重装后仍能确认旧回执完成。不同操作cleanupPending独立判断，不被无关残留永久污染。
- 最终主工作区组合：**507 pass / 1 skip / 0 fail（25文件）**，opencode与App typecheck通过；App全量 **1710/0（207文件）**，browser-condition **63/0（17文件）**；git diff --check通过。测试期间强化来源保护曾暴露runtime夹具复用ID跨来源污染，仅清理经身份核验的fixture ownership后全组合通过，未放宽生产保护。未提交、未推送、未合入dev。
- 已实跑：真实Bun多进程共享、SIGKILL后内核释放、真实Node unsupported、TTL无关、proof缺失/替换inode、globaldata跨registryoverride；leases20/0。受限清理模块18/0，数据journal4/0，purge/registry/服务针对性30/0；前述506/1skip/0fail为中间组合结果。没有公网/模型请求/真实用户配置改动。
- 本阶段没有重新运行GUI、Electron或编译内嵌形态；跨平台Linux/Windows仅安全分支实现，未本机运行验收。不宣称全仓opencode suite通过；既有IM失败独立保留。

## 审查与修复（2026-10-17）

高强度定向审查覆盖 tracked/untracked 实现。最初8个候选中7项已修复并补回归；npm祖先自身peer候选未实施：其运行时可解析前提不普遍成立，现有安装布局不保证支持，保持fail closed，不作为已确认且已修复的缺陷。

1. retained data 的来源身份保护同时覆盖 managed install 与 development link，避免不同来源接管相同ID的磁盘数据；不移动/删除旧数据。
2. runtime 跟踪已交付的工具及普通hooks调用；捕获代际，旧闭包在换代后拒绝，保留this和同步/异步形状，工具取消信号合并且释放监听；quiesce不能只等待RPC。
3. mutation期间缺失hooks的初始化失败而非成功缓存；真实InstanceState失败TTL重试覆盖。首装尚无row的空缓存由release后有界二次失效覆盖；失败仍保留committed=true/synced=false。
4. 已损坏旧manifest允许同身份有效包修复；secret分类缺失时保守遮罩/阻止降密。
5. registry observer同步开发目录watcher；等baseline后再测试修改。观察器捕获registry并在读取前后核对当前runtime来源，避免旧Effect层监控另一个registry时停掉同ID新实例。
6. recovered committed状态与commit共用strict refresh；刷新失败保留已提交并报告待同步，不显示假成功。
7. path来源只禁止update，保留安全unlink入口；仍遵守dirty/saving/busy/safe-mode限制。

审查后主线程重新验证：服务端扩展/安装/鉴权/snapshot组合 **449 pass / 1 skip / 0 fail（22文件）**；App全量 **1710/0（207文件）**、UI **282/0（34文件）**、browser-condition **63/0（17文件，安装wrapper内部11项）**；App/opencode typecheck通过，git diff --check通过。生产App构建通过（22.52s，有大chunk警告，不是构建失败）。审查后未重跑Vite实机、Electron或内嵌二进制，不将此前截图计为修复后实机证据。SDK契约未改变；未提交/推送/合入dev。

## 服务与接口接线结果（2026-10-17，审查前记录）

- 已接安装服务：候选验证和物化在停机前完成；持有runtime fence后重读revision并CAS，hooks失效/strict quiesce不确定时保留needsRestart。注册表观察器共享启动Promise与幂等release，首次强制对账，原子snapshot避免混合版本；local commit在fence内记精确generation，避免observer二次停新代。
- 新管理HTTP组：prepare/install/update/uninstall/status/cancel；共用Authorization；capability仅header，不放URL；HTTP拒绝local，pure/disableExtensions在adapter前403，错误脱敏。生成SDK与OpenAPI已更新，新增SDK→HttpApi确认信封回归。
- CLI install/update/uninstall支持--yes/--enable/--sha256/--purge-data；非TTY无确认则预览并取消，不执行扩展。已走真实src/index.ts离线归档安装/list，非仅测试runner。
- 配置页有安装、更新、卸载入口，预览展示权限/版本变化/来源风险；新装默认停用，未知提交只查询不盲目重装。切服务器迟到prepare由原client取消；旧preview取消不向新server发送token。
- 本轮服务端组合 **437 pass / 1 skip / 0 fail（22 文件）**，opencode/App/SDK/UI/kit/示例typecheck通过；App全量 **1709/0（207 文件）**，UI全量 **282/0（34文件）**，完整browser-condition **63/0（17 文件）**，其中新增隔离Solid契约子进程10/0，不重复叠加计数。Vite生产构建通过，有既有大chunk警告。两次OpenAPI生成逐字节一致。
- Vite实机：专用API47257/Vite5197，临时XDG/registry与本地归档；生产CLI安装后页面无刷新列出、默认Disabled，页面启用后RPC ping=smoke-ok；页面卸载预览/确认后列表移除、RPC404，结果提示cleanupPending。已查看截图 `/tmp/extensions-p3a-removal-smoke.png`；浏览器任务已关闭，专用服务与端口已清理。没有模型请求/真实用户数据改动。Electron与内嵌二进制未执行本轮验收。
- 安全复核：修复SDK默认redirect:follow可能转发capability至另一origin；prepare/commit/status/cancel统一redirect:error，12项封装回归明确断言该选项。共用Basic仍不提供独立浏览器身份，不声称客户端身份绑定。
- 冒烟修复可信registry父路径的macOS `/tmp`别名规范化；临时Bun.Archive夹具起初未gzip，被解压器正确拒绝，修正为真实tgz后通过。临时诊断日志撤除。

以下为基础阶段历史记录。

最终基础组合（含snapshot）：**416 pass / 1 skip / 0 fail（19 文件）**；后端typecheck、本轮18个TS文件prettier check、git diff --check通过。全extension目录格式检查仍在4个未修改文件报告既有警告（index.ts、fixture.ts、registry.test.ts、settings.test.ts），未扩大格式化范围。不暂存、不提交、不推送。

首轮主工作区基础组合：扩展全组 + HTTP/设置/鉴权 **346 pass / 0 fail（17 文件）**，后端 typecheck 通过；observer 格式修正后 8/0 再验通过。补入目录边界3项与runtime门禁8项后，组合为 **357 pass / 0 fail（18 文件）**，后端typecheck通过。前端既有宿主/入口兼容89/0、App typecheck通过。尚未运行 App/UI 全量、生产构建或三形态实机，不代表 P3a 完成交付。既有 IM dispatcher 失败与 P2 最新 GUI 验收缺口保持独立。

基础阶段当时新增模块：archive/download/npm/install/paths/registry-watch，以及 registry/schema 的基础扩展。当时CLI/HTTP/SDK/UI尚未接入；该限制已由上方“服务与接口接线结果”更新，不应作为当前状态。

已知保守限制：

- npm 完整图上限与嵌套布局，不支持循环、alias、Git/file/workspace、自动 peer；optional 不静默跳过，已知 native/build 标记拒绝，不能静态判断任意脚本是否必需。scripts 永不执行。
- 解压器只接受 package/ 根、自包含预构建且不带 node_modules/安装配置/链接；CLI 本地路径先经 realpath 可信父目录处理。
- prepare/capability 进程内存绑定；已提交操作可由 receipt 查询，未提交 graph 不跨重启恢复；启动会扫描具有完整ownership及引用退出证明的残留，未知对象保留。
- 有安全证明的未引用generation和新式owned数据可回收；活进程曾加载的generation/data固定到进程退出。legacy无来源证明的数据保守不自动采用/删除，Node/Windows/无FFI清理保持pending。
- quarantine后中断有数据purge journal可续清；未知历史trash只报告待协调，不自动重试删除。
- archive 来源身份按原完整 location 绑定，切换 URL 的升级当前 fail closed；需明确确认迁移协议后才能支持。
- 类型和独立模块测试通过不等于完整 provider/多服务器生命周期安全，当前已接运行时门禁与registry观察器，跨进程并发实机矩阵仍未完整验证。
- quiesce 需由安装服务先持 beginMutation，再协调 Plugin hooks 失效与停机，finally release；超时/不配合任务保留永久 needsRestart，只有重启解除，不冒称任意扩展代码已停止。
- 多个子任务遭遇推理网关 503/watchdog，中断的 HTTP/运行时任务没有计为通过。
