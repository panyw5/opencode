# 发布地址安装实施任务

> 集成更新（2026-11-03）：已通过 `2cca27da78` 合入本地 dev，未推送、未发布；生成契约、构建与集成验证见 `specs/extensions/delivery.md` 顶部。公网 CLI/server release 正向验收仍未完成。以下为合入前核对及原日期历史，不代表仍未集成。

状态：核心实现与自动化回归完成，已随 `6216969c38` 本地提交，尚未完整交付。计划于 2026-10-19 获批；状态核对：2026-11-03，当前 HEAD `6faed064da`，未合入当前本地 dev。本次不提交、不推送、不合并，未操作真实用户 registry。

设计：`specs/extensions/release-install-design.md`；当前交付入口：`specs/extensions/delivery.md`。后续桌面目录已通过 renderer 下载 + 摘要校验 + 本地归档通道完成真实安装，**不等于 CLI/server release 下载器正向验收**；后者仍受本机 fake-IP 网络边界影响。公网 CLI/server、最终三形态、多服务器、故障/跨平台缺口保留。

以下记录按原日期保留；旧“未提交”“不上传”等为当轮状态与授权边界，不代表后续没有提交或分发。wls-repl 外部发布记录及 10 月 25 日目录安装证据见 `wls-repl-tasks.md`，本次未联网复核外部资产。

## 历史阶段与会话待办（2026-10-19）

- [x] 协议与兼容：release来源、显式release-current请求、版本化registry schema、首次升v3确认。
- [x] descriptor：安全获取、64KiB、严格JSON、原始字节摘要、URL规范化与单元测试。
- [x] registry：稳定source identity、格式CAS、原子v3+row+receipt、observer及retained/data回归。
- [x] installer/service：prepare快照、manifest一致性、确认绑定、commit不联网、未知结果和恢复。
- [x] HTTP/SDK/CLI：契约生成、歧义拒绝、显式release命令与专用升级授权、脱敏。
- [x] UI：发布地址无hash、固定来源更新、首次升级checkbox、多语言与真实Solid契约。
- [x] 作者工具：本地tgz生成descriptor，不联网/上传/构建/执行扩展。
- [x] 组合回归、类型检查、生产App构建、OpenAPI确定性及文档记录。
- [ ] 公网HTTPS正向、完整三形态GUI、多服务器、全故障/跨平台验收。

## 历史并行分工（2026-10-19）

- 注册表/共享schema及其测试。
- 下载helper/descriptor resolver及其测试。
- 前端请求/界面/多语言/契约测试。
- CLI/HTTP adapters及其测试。
- 主线程：installer/service集成、生成产物、端到端回归与状态收敛。

各分支在独立worktree实现，以86619dfa4a为基线；集成须保留当前未提交的按钮布局、包版本、模型快照和文档改动。不允许子任务提交、推送或修改真实注册表。

## 必须保留的门槛

- v2不因读取/prepare/取消而升v3。首次release成功提交同锁原子升v3；升版需明确确认旧进程停机前提及整个registry不兼容旧版，之后不自动降级。
- 稳定descriptor+extensionID身份；artifact版本/URL/hash可变，不自动来源迁移。旧source身份字节不变。
- 预览A只能提交A；descriptorSha256是实际原始HTTP字节摘要。完整artifact query只留内存，不进入registry/journal/UI/CLI/日志。
- 同源HTTPS摘要不是独立作者签名；人工旧进程停机确认不是存活证明。
- 未跑的验证如实保留，旧截图和旧测试不能冒充本轮证据。

## 配置导航复核（2026-10-20，更新上方GUI阻塞状态）

- 根因证据：真实`ConfigLoadingShell`有两入口（directory为空、Suspense pending），壳复用SectionButton但没有onClick。新增source字符串日志后，正常连接日志显示directory已就绪、`source=suspense`、lazy import约73ms完成、真实ConfigPage约86ms挂载；随后Extensions分区和安装弹窗可正常操作。
- 直达页面再次复现卡壳，DOM的`data-loading-source=directory`；浏览器本轮验证origin保存的默认server仍为上轮已关闭的 `http://127.0.0.1:47297`，curl确认端口拒绝连接。`auth_token`入口短期连接当前47298，重载后持久默认地址仍旧；仅修正本轮测试页defaultServerUrl并重新认证后，真实config-page/Extensions直达和重载均通过。没有证据表明`jump`或release代码破坏导航，不修改其状态逻辑。
- 改动仅增加加载壳`aria-busy`/明确Loading、两个来源标记和字符串日志，占位SectionButton显式disabled；真实分区仍按原事件处理。新增真实Solid“loading禁用→就绪点击可选中”契约，补整页Playwright用例等待真实config-page再切Extensions及打开发布安装弹窗。
- 主工作树回归：App typecheck通过，unit **1719/0（208文件）**，browser **64/0（18文件）**。新增Playwright用例仅编写，**未运行Playwright runner**；真实Ego Chromium已执行配置页点击→Extensions→安装弹窗、`?section=extensions`直达及重载。
- 实际对话框默认release，仅一个URL输入框，无hash字段；输入框/按钮各34px、间距8px。截图 `/tmp/config-nav-release-dialog-20261020.png` 已查看；这是完整真实路由及对话框入口，不再用内存fixture替代导航，但未提供公网包、未提交真实安装、未迁移真实registry。
- 旧端口卡壳为测试连接状态问题；**不承诺新增断线恢复机制**，本轮未自动清理用户浏览器profile或改写用户服务器配置。专用页面/服务已关闭；公网正向安装、Electron/内嵌形态和跨平台矩阵仍未验收。

## 独立模板（2026-10-21，本地交付完成）

- [x] 建立 `templates/extensions/server-only/`，放在workspace之外，零外部依赖、纯JS server-only、内置ping RPC和Node测试。
- [x] 标准npm离线pack及同次descriptor生成脚本、Node测试。
- [x] 复制到项目外临时目录，真实Node/npm测试与宿主归档/描述一致性核验。
- [x] README和作者文档入口、验证结果/边界记录。

主工作树实测：Node内置测试 **8/0**；宿主模板＋author＋resolver组合 **33/0（3文件，271断言）**；opencode typecheck、Prettier和diff check通过。项目外副本真实npm test/release在没有node_modules、没有安装依赖的情况下成功，模板与宿主作者工具对同一最终tgz生成的descriptor逐字段一致；scoped改名/id/预发布版本打包和真实模块加载由宿主测试覆盖。

模板最终tgz另在全新隔离registry/data/cache中经真实CLI安装/显式启用成功，Basic API ping返回version0.1.0/message extension-starter-ok；专用47300服务已停止。Node25.9.0/npm11.12.1/macOS本机验证，不宣称Node22/Windows/Linux已运行验收；公网release安装未验收。

只整理可复制本地模板，不创建GitHub仓库，不npm install/publish，不上传产物，不提交源码。模板仅源码/文档/测试，未保留artifacts或node_modules；输出和临时registry在系统临时目录。标准pack内部ignore-scripts，但作者未来添加npm-run pre/post钩子仍须自行审查，不把本地工具当沙箱。

## 本地发布与安装样例核对（2026-10-20）

- 在私有系统临时目录建立零依赖server-only `example.release-demo`（JS预构建入口），真实作者工具核对实际manifest并生成stable.json，未访问其占位HTTPS地址。
- macOS默认tar带AppleDouble根条目/扩展属性，被严格解包器正确拒绝；改用 `COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs` 后生成成功，未放宽归档保护。
- 在全新隔离registry/data/cache下，真实源码CLI本地tgz+摘要安装并显式启用，结果committed/synced=true、cleanupPending=false；临时Basic server列出ready，真实ping返回version1.0.0/message release-demo-ok。专用47299服务已停止，临时证据保留，未操作真实用户registry。
- 本地安装来源为archive，不代表release联网链完成；author＋真实resolver离线组合复跑30/0（217断言）。没有上传GitHub/npm，没有公网正向包验证。具体可复现代码/打包命令与边界见 `specs/extensions/release-authoring.md` 第6节。

## 验证结果（2026-10-19，主工作树实测；导航缺口以上方复核为准）

| 范围                                                          | 结果                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 扩展目录＋HTTP扩展/安装＋HTTP鉴权明确文件组合                 | **644 pass / 0 fail，26文件**                                                                 |
| 初次完整extension过滤选择（集成测试加入前）                   | 630/0，25文件；不是最新完整组合，不叠加                                                       |
| 真正resolver→安全transport→archive→installer→Registry新增组合 | 2/0，110断言；已纳入最终644                                                                   |
| descriptor/download/npm定向                                   | 244/0；与最终组合重叠                                                                         |
| 本地作者工具真实Bun.spawn                                     | 28/0；已纳入最终644                                                                           |
| App全量unit                                                   | **1719/0，208文件**                                                                           |
| browser-condition                                             | **63/0，17文件**；安装外层wrapper内18项真实Solid契约，不重复累计                              |
| extension-kit / hello-viewer tests                            | **17/0、14/0**                                                                                |
| opencode / App / SDK / kit / hello-viewer typecheck           | **5项通过**                                                                                   |
| SDK生成、SDK编译、OpenAPI连续两次生成                         | 通过，公共快照逐字节一致；install/update生成body白名单均含acceptRegistryUpgrade               |
| 生产App构建                                                   | 通过；存在既有动态/静态导入和大chunk警告，不是构建失败                                        |
| 定向只读代码复核                                              | v3确认、CAS、receipt、retained/secret/data、query脱敏与内容绑定范围内无新确认缺陷；非完整审计 |
| git diff --check / 修改源码Prettier                           | 通过；未做全仓格式化                                                                          |

测试覆盖预览A后描述及artifact同时变B仍提交冻结A、显式v3确认、原子版本/row/receipt、同发布地址新artifact更新、摘要篡改拒绝、卸载retained及重启receipt查询、同来源重装、secret/data来源隔离；可信fixture transport并未放宽生产HTTPS/DNS/TLS门槛。

### 实机尝试与验收缺口

- 启动专用Vite `127.0.0.1:5199` 与隔离Basic API `127.0.0.1:47297`，使用临时OPENCODE_TEST_HOME、XDG data/cache/state及OPENCODE_CONFIG_DIR、独立registry。受worktree guard约束未覆盖HOME/XDG_CONFIG_HOME；隔离变量被接受后执行，不绕过拒绝。未请求模型、未操作真实扩展数据。
- 真实API `/global/health` healthy、扩展清单为空；release prepare访问私网HTTPS被拒（502脱敏错误），清单仍为空，未产生安装或v3迁移。这只证明负向路径，不是公网正向安装成功。
- **完整Vite GUI验收阻塞**：配置页可打开，但点击Extensions分区仍停留Providers；未确认根因，未扩大修改配置页，也不宣称这是release变更引起。页面无捕获到的错误。不能将后续fixture展示替代真实导航成功。
- 同一独立浏览器页挂载真实`ExtensionInstallationForm`＋仅内存fixture，查看“发布地址无hash”、跨主机/摘要/作者未签名提示、v3警告中文显示；截图 `/tmp/release-install-v3-preview-20261019.png` 已查看。fixture不是安装服务，未提交真实安装；开发热更新使fixture页面重载后未继续像素级门禁测量，门禁由18项Solid契约覆盖。
- 浏览器任务已关闭；专用Vite/API已停止，5199/47297无监听。本轮没有启动Electron或重建内嵌二进制。
- **未验收**：公网HTTPS真实descriptor/artifact正向安装、完整Vite/Electron/内嵌Web矩阵、多服务器、全故障场景和Linux/Windows。不上传测试资产、不伪称当前发行版已支持。

### 历史兼容证据范围

- 当前基线旧实现仅ENOENT回退empty，未知版本/source拒读且所有registry写锁内重新读取；固定旧schema/写入者fixture验证文件字节不变。
- 静态核对提交 `6fd89cc1be`（P1）及 `eeac7a5adc`（P2）的registry/schema：同样仅ENOENT empty、Literal1格式及schema错误抛出；**未动态运行这些历史发行进程**，不外推所有旧版或外部写入者。
- 已运行旧runtime不会被磁盘v3自动停止。首次确认要求停/升级共享registry/data/cache的旧进程；人工声明不是机器存活证明。v3后不自动降级，卸载最后一个release也不降级。

### 保留工作区与发布边界

- 原三个包版本改动及模型快照前后SHA-256一致，本轮未重写；既有34px右侧按钮布局保留并扩展至发布地址模式。
- 本轮仅工作树实施，不暂存、不提交、不推送、不合入dev、不发布npm/GitHub资产。最低支持宿主版本待正式版本决定。
- 使用说明见 `specs/extensions/release-authoring.md`；生成器只本地计算/校验，已有输出拒绝覆盖，不提供force。
