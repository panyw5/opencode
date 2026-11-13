# Extensions 当前交付摘要

更新时间：2026-11-03。本文为当前交付状态入口；`p2-delivery.md` 保留 P2 历史文件清单，各任务文档保留原日期与验证范围。已实现、已提交、已验收与已发布是不同状态，不互相替代。

## 本地 dev 集成结果（2026-11-03）

**已合入本地 dev，未推送、未发布。** 合并提交 `2cca27da78`，父提交为 dev `17ad1e4b02` 与扩展分支 `c7d9be56c8`；后者先单独提交了本次交付文档更新。集成工作树为 `.worktrees/extensions-dev-integration`。主目录仍在 `fix/session-tab-sidebar-reveal`，其未提交改动未被切换、暂存或改写；扩展原工作树的 4 个搜索/模型未提交文件也未纳入合并。

- 已处理 13 个冲突文件。保留 dev 的分享/外部智能体翻译、配置页样式、Issue HTTP 路由、sidecar Issue 记录及 Electron readiness 修复；同时接入扩展 API、归档 IPC、工具注册/注销与响应式切换。新增回归确认 execute、外部工具和各 advisor 的内置 renderer 标记未丢失。
- 扩展三包与 kit fixture 已按当前 `VERSION` 对齐 **1.18.63**，锁文件同步；`bun install --frozen-lockfile --ignore-scripts` 通过。SDK v2/OpenAPI 从合并后路由重新生成，OpenAPI 第二次生成逐字节一致。未手工拼接生成类型。
- App 生产构建、Node sidecar 构建、开发 Electron 主进程/预加载/renderer 构建及 wls-repl 构建通过。构建有既有大 chunk、eval/导入警告；未制作或发布安装包，未将 wls-repl dist 改为 Git 追踪。

| 集成基线验证                                               | 结果                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端 extension + HTTP 扩展/安装/设置/鉴权                  | 655 pass / 0 fail，28 文件；首轮沙箱的监听/监控失败在获权限复跑后全部通过                                                                                                                                        |
| App unit / browser-condition / UI                          | 2018/0、79/0（含新增内置 renderer 回归）、591/0                                                                                                                                                                  |
| extension-kit / hello-viewer / wls-repl 非真实 kernel 定向 | 17/0、14/0、14/0；本轮未重跑真实 Wolfram 集成                                                                                                                                                                    |
| App / opencode / Desktop / UI / SDK typecheck              | 5 项通过                                                                                                                                                                                                         |
| Desktop sidecar 协调 + 归档摘要定向                        | 21 pass / 0 fail                                                                                                                                                                                                 |
| Desktop 全量                                               | **576 pass / 8 fail / 5 errors**；Electron app/netLog/safeStorage 导入/mock 失败仍保留，不标全量通过                                                                                                             |
| 合并前 dev 完整导出副本                                    | 573 pass / 8 fail / 5 errors，同样 8 项 Electron 导入/mock 失败；集成版多 3 个通过的归档摘要测试。副本复用同一依赖，不改主目录源码                                                                               |
| 9222 CDP / 实际 sidecar                                    | 隔离开发 Electron 配置页 Extensions 和目录条目可见；假模型发送用户消息后收到 `MERGE_SIDECAR_OK`，两方消息持久化并在 UI 显示；无真实模型调用                                                                      |
| 本地归档 IPC + HTTP 实机                                   | 独立 server-only 模板打包，摘要 → prepare → commit/enable 得 committed/synced=true；ping RPC 200 且 message=extension-starter-ok；卸载 committed/synced=true 后 RPC 404，Node purge 如实报告 cleanupPending=true |

日志：`/tmp/extensions-dev-merge-backend-unrestricted.log`、`/tmp/extensions-dev-merge-app-tests.log`、`/tmp/extensions-dev-merge-browser-tests.log`、`/tmp/extensions-dev-merge-ui-tests.log`、`/tmp/extensions-dev-merge-desktop-tests-unrestricted.log`、`/tmp/extensions-dev-merge-desktop-baseline-full.log`、`/tmp/extensions-dev-merge-desktop-focused-unrestricted.log`、`/tmp/extensions-dev-merge-electron.log` 与 `/tmp/extensions-dev-merge-fixture.log`；截图 `/tmp/extensions-dev-merge-config.png`、`/tmp/extensions-dev-merge-chat.png` 已查看。CDP 首次把导航和结果放在同次 evaluate 时出现 Promise was collected，随后独立读取服务端持久化消息并核对 UI，确认发送/接收成功，不把首次工具错误计为应用失败或丢失消息。

保留问题：Desktop 全量上述 8 项基线失败；隔离 onboarding 的 quick-assistant 路径拒绝/不存在日志，未绕过权限或额外修复。相对合并前 dev 的完整 diff check 还报告源分支自带 hello-viewer 生成 bundle 中 3 行模板字符串空白和 release-authoring.md 末尾空行，本次未为消除此警告改写历史构建产物。最终发布、真实公网 CLI/server/npm、多服务器、全故障/跨平台、生产内嵌 Web 复验仍待完成；合并不等于这些门槛通过。

以下第 1 至 4 节为**合入前核对快照**：旧 HEAD、43/91、1.18.61/1.18.58、未提交/未集成及当轮“不提交”描述只适用于该快照；当前集成状态、已解决项与测试结果以上方为准。

## 1. 分支与提交状态

- 工作树：`.claude/worktrees/extensions-p0`；实际分支：`claude/extensions-p2-design`。
- HEAD：`6faed064da`（2026-10-25，合并当时的 `fork/dev`）。扩展功能及下表修复均已在本地分支提交，不再是未提交候选。
- 本次只读核对时，本地 `dev` 为 `257fb5954d`，`fork/dev` 跟踪引用为 `ea654495ae`；`HEAD...dev` 为 **43/91**，共同祖先为 `b4225a7675`。尚未合入当前本地 `dev`，也未包含其全部新改动；后续集成前必须重新核对。
- 本次未 fetch 或查询远端，不据本地引用断言远端分支、推送或宿主发布状态。只更新文档，不暂存、不提交、不推送、不合并、不发布。
- 文档更新前已有 4 个未提交文件：`packages/opencode/src/file/index.ts`、`packages/opencode/src/session/content-search.ts`、`packages/opencode/test/session/content-search.test.ts`、`packages/opencode/src/provider/models-snapshot.js`。分别属于搜索日志、内容索引优化/测试和模型快照，不计入扩展交付；本次保留原样。

| 阶段 / 增量            | 已提交内容                                                                               | 提交依据                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P0 宿主                | viewer/tool/part 等注册表与宿主改造                                                      | `0056e8ca7e`                                                         |
| P1 Web 链路            | 本地 path-link、注册表/CLI/资源路由、Web 懒加载、kit 与 hello-viewer                     | `6fd89cc1be`、`3f1f6b76b7`、`110593dd7d`                             |
| P2 Server 与 Web 桥    | Server 运行时、RPC/事件、设置、watcher、贡献点、配置入口与启停管理                       | `eeac7a5adc`；版本/锁文件阶段整理 `8e007ed874`                       |
| P3a 安装管理           | prepare/confirm/commit、安装/升级/卸载、回执、清理与运行时协调、CLI/HTTP/SDK/UI          | `86619dfa4a`                                                         |
| 发布安装与首个业务扩展 | release descriptor、registry v3、作者工具、独立 server-only 模板、wls-repl、桌面归档拖拽 | `6216969c38`（标题虽为 wip，实际内容已提交；不等于完整交付）         |
| 内置目录与桌面安装     | wls-repl 目录条目、详情/统一卡片、renderer 下载并经本地归档通道安装                      | `ba07e86405`、`90d02610ca`、`641cb137c0`；后续样式提交见 Git 历史    |
| 清理恢复与重装收尾     | 启动/observer 恢复、purge-aware CAS、错误透传、retained 归档字节身份、目录重试           | `bab60d035f`、`8362256077`、`c0cf6a8700`、`c12de90d3b`、`604c824cab` |

P0/P1 已完成；P2 核心实现已提交。P3a、发布安装及 P4 首个业务扩展已实现且有分范围验收，**整个扩展系统仍未完成最终集成/发布验收**。P3b 远程市场未实现，内置硬编码目录不等于市场；P4 当前是 `.wls` 调试 REPL，不宣称原设计完整 Notebook 已交付。

## 2. 验证证据与更正

| 日期与范围                     | 已记录 / 本次实测                                                                                                                                                                                                                                    | 不代表什么                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 2026-10-17 P3a                 | Vite、Electron Node sidecar、内嵌生产 Web 的安装/列表/RPC/移除核心路径有历史实机记录                                                                                                                                                                 | 不是最新 HEAD 的完整三形态复验；启动清理结论见下方更正                               |
| 2026-10-19 发布安装            | 扩展目录 + HTTP/安装/鉴权组合 644/0；App 1719/0；browser-condition 63/0；kit 17/0、示例 14/0；5 项 typecheck、SDK/确定性 OpenAPI、生产 App 构建通过                                                                                                  | 历史基线与选择范围，不是当前全仓结果；不能与 589/0 相加或直接比较增减                |
| 2026-10-20 配置导航            | App 1719/0、browser-condition 64/0、App typecheck；真实 Vite 配置页导航及发布弹窗通过                                                                                                                                                                | Playwright runner 未运行，未完成公网安装                                             |
| 2026-10-24 wls-repl            | 包内 21/0，含真实 Wolfram 集成；隔离 Electron 断点/单步/变量检视/REPL/停止回收、安装副本启动通过                                                                                                                                                     | 仅 macOS；未通过真实模型请求调用工具；Windows/Linux 未验收                           |
| 2026-10-25 目录与重装          | renderer 经代理下载真实 GitHub descriptor/artifact，再经 staging + local archive 安装通过；最终 Electron 安装 → 卸载 → 立即重装通过；收尾记录扩展全量 589/0、typecheck 与 sidecar 重编通过                                                           | 桌面辅助下载不是 CLI/server 的 release 下载器正向验收；也不覆盖完整三形态/跨平台矩阵 |
| 2026-11-03 本次定向复验        | `bun test test/extension/install-service.test.ts test/extension/install.test.ts test/extension/installation-registry.test.ts`，在 `packages/opencode` 下运行，73 pass / 0 fail，3 文件、394 断言；日志 `/tmp/extensions-delivery-20261103-tests.log` | 只覆盖安装协调器/安装事务/受管注册表，不是全仓、GUI 或新构建验收                     |
| 2026-11-03 文档编辑后 CDP 检查 | 使用现有 9222 dev renderer 执行 `cdp.ts targets` / `info`，页面标题 OpenCode、`readyState=complete`                                                                                                                                                  | 仅确认现有开发窗口可响应；未切换其工作树、未操作安装版应用，不作为本扩展分支功能验收 |

**启动恢复证据更正：** 10 月 25 日确认 `recoverInstallations()` 原来没有生产启动调用点；`bab60d035f` 才接入启动，后续增加 observer 增量恢复。因此 10 月 17 日记录中的“重启后恢复清理完成”不能作为生产启动接线已验证的依据。保留原记录供追溯，但撤回该项生产集成结论；修复后的证据以 `wls-repl-tasks.md` 的启动接线、状态机及最终重装记录为准，不宣称已重跑全部历史恢复矩阵。

本次仅修改文档，不重新构建 SDK/扩展/前端/sidecar/内嵌二进制，不把历史测试、截图或临时产物升级为当前发布证明。

## 3. 版本与产物

- 当前 `VERSION`、App/opencode、extension-kit、kit fixture、hello-viewer、wls-repl 的 package.json 均为 **1.18.61**，且不是当前未提交版本改动。
- `bun.lock` 的 App/opencode 元数据为 1.18.61，但 extension-kit、hello-viewer、wls-repl 仍为 **1.18.58**。这是当前待处理的版本一致性缺口，本次只读核对，不执行安装或修改锁文件。
- hello-viewer 的 `dist/server.js`、`dist/web/index.js`、`dist/web/index.css` 及 SDK v2/OpenAPI 已追踪；本次未重生成或做逐字节一致性验证。
- wls-repl 的 `dist/` **未被 Git 追踪**，不能把历史本机构建产物当成干净 checkout 自带入口；验收/打包前需要按该包构建流程生成并核对归档。10 月 24 日外部仓库/release 的记录不等于当前 monorepo 1.18.61 产物已发布或可复现。
- 本机 fake-IP DNS 会使 CLI/server 安全下载器拒绝非公网解析；不得以绕过地址校验完成验收。桌面目录通过 renderer 下载 + 摘要校验 + 本地通道的路径已经单独实现与验证，二者必须区分。

## 4. 交付前待办与限制

- [ ] 在获明确授权后同步最新 dev，解决实际冲突并完成相对最新基线的合入前审查；推送仅限 `panyw5/opencode`，GitHub Actions 也仅限该 fork。
- [ ] 对齐扩展包锁文件版本元数据，复核 SDK/OpenAPI、hello-viewer 与 wls-repl 构建/打包产物，并验证干净 checkout 的可构建性。
- [ ] 在最终交付基线上重跑自动化、类型检查、生产构建与 Vite/Electron/内嵌 Web 验收，覆盖启停、升级、卸载/重装、启动恢复及资源回收。
- [ ] 补公网 CLI/server release descriptor + artifact 正向安装、npm/企业 registry、多服务器 A→B→A、完整故障/超时及跨进程并发矩阵。
- [ ] 补 Linux/Windows 验收，明确 Node/Windows/无 FFI 的 GC/purge 保守延后行为，以及 wls-repl 对 Unix `tail`/`ps` 的依赖。
- [ ] 最终确认版本、发行范围、兼容与迁移说明，再另行授权合并、推送和发布。更新文档不意味着这些门槛已通过。

保留边界：扩展与宿主同进程，无沙箱/逐项权限强制隔离；secret 本地明文存储（0600，API 掩码）；registry v3 不自动降级，人工旧进程停机确认不是存活证明；缺安全证明的旧包/数据不自动删除。项目级安装、自动更新、自定义设置页、运行时 i18n、跨会话草稿持久化与完整 Notebook 不在本次交付声明内。

详细证据：`progress-log.md`、`p2-delivery.md`、`p3a-tasks.md`、`release-install-tasks.md`、`wls-repl-tasks.md`。各文档带日期的旧结论只适用于当时基线；当前状态优先以本文及其明确更正为准。
