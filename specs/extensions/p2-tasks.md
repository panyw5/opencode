# P2 集成收尾任务

状态：**已合入本地 dev，最终发布验收待完成**。实施分支 `claude/extensions-p2-design`；P2 交付提交 `eeac7a5adc`，本地合并提交 `2cca27da78`。状态核对：2026-11-03；未推送、未发布。集成结果及 Desktop 基线失败见 `specs/extensions/delivery.md` 顶部。

合入前核对记录：当时 HEAD `6faed064da` 已包含后续 P3a/release/wls-repl 与重装修复，`HEAD...dev` 为 43/91，定向复验 73/0。之后用户授权合并，文档先提交为 `c7d9be56c8`，再与 dev `17ad1e4b02` 合并；扩展版本/锁文件已对齐1.18.63。以下历史未勾选项不是当前 Git 状态，最终发布门槛以统一交付摘要为准。

以下清单保留 2026-10-14 及更早历史状态，不将当时版本、待办或旧产物验收等同于最新代码状态；后续分阶段验收不自动勾销最终基线复验。

## 历史收尾任务（2026-10-14）

- [x] 核对交付提交与分支状态：P0/P1/P2 已在独立分支提交，尚未合入 dev。
- [x] 更新进度、历史任务状态和交付说明，分开记录实现、自动化、实机与集成状态。
- [x] 复跑当前基线自动化：App 1671/0、UI 268/0、扩展服务端/HTTP 150/0、browser-condition 22/0、kit 17/0、hello-viewer 14/0；4 项 typecheck 通过。
- [x] 只读核对版本/产物：三个包当前 1.18.57，锁文件元数据滞后；示例/kit 入口与夹具已追踪，SDK v2 静态契约存在。
- [x] 版本与锁文件（2026-10-14）：Bun 1.3.9 `install --lockfile-only --ignore-scripts` 生成，仅保留 21 处 workspace 版本元数据（扩展两包 1.18.49→1.18.57，其余 1.18.56→1.18.57）；工具同时删除的 `@solidjs/start`、`ghostty-web` integrity 已恢复，frozen-lockfile 校验通过。模型快照未动。
- [x] SDK v2 扩展契约核对：隔离环境运行现有 SDK build，扩展相关类型零差异，确认已追踪契约与源码一致；其余 175 行为 dev 其他功能（浏览器/GPT-Pro 事件等）的生成漂移，已恢复不带入。
- [x] hello-viewer 产物：Web `index.js`/`index.css` 重建逐字节一致；`server.js` 仅差 Bun 打包器 `__export` 运行时辅助代码（1.3.9 与原构建版本不同），业务代码相同，保留原产物。两次构建哈希一致。
- [x] `packages/sdk/openapi.json`：原快照与 dev 相同，属 dev 整体漂移（新生成多约 60 个非扩展操作、少 13 个旧 TUI 操作）。按用户决定随扩展分支更新为完整重新生成结果；隔离生成两次逐字节一致，含 6 项扩展操作与 2 个事件。diff 包含大量非扩展接口，合入 dev 时需知悉。SDK v2 的非扩展漂移（175 行）未随之重生成，仍属 dev 侧待办。
- [ ] 生产 UI 和内嵌二进制在确定交付基线重建；静态入口存在不代表产物与源码完全一致。
- [ ] 评估最新 dev 与已验证基线的差异，另行授权同步后再验证；本轮不自动合并。
- [ ] 补最新 Vite/Electron/内嵌 Web 验收与管理页剩余场景。遵守环境限制，无法执行的场景保留未验证。
- [ ] 对扩展分支相对最新 dev 的实际差异完成合入前审查，修复确认的阻断问题并回归。
- [ ] 经明确授权整理提交、合入 dev；推送与发布需另行授权。

不扩展 P3：安装/升级/卸载/市场、运行时 i18n、自定义设置页与项目级安装。panels.open、面板持久化和跨会话草稿等现有边界不在本轮临时补做。

## 历史阶段：正确性收尾（2026-10-01 至 2026-10-05）

- [x] 恢复工作树与已验证结果，确认 P2 改动仍在独立扩展工作树。
- [x] 校验并修复进程级运行时：设置默认值、迟到实例 Hooks、多个 Layer 的清理所有权。
- [x] 校验并修复前端贡献点：工具注册响应性、Solid 挂点动态 children、onSave disposer 契约。
- [x] 定位并修复 Web 新会话草稿空白：P1 基线 `/tmp`↔`/private/tmp` 路径别名门控不一致；统一草稿与已有会话 fallback 比较，补红/绿回归并完成真实 Vite 页面复验。
- [x] 补新增缺陷的定向测试，运行组合回归与 typecheck。
- [x] 修复 RPC OpenAPI 未描述 input 请求体、重新生成 SDK 并验证空 body 兼容性。
- [x] 真实 Web 验收 `.hello` 懒激活、原始字节、RPC/SSE/子进程、启停即时清理（独立任务/临时数据目录，完成后清理服务）。
- [x] 编辑型 viewer：保留已访问标签实例、拦截 dirty 源码切换；临时夹具验证保存成功/失败、保存期间新编辑、切标签/折叠预览后保存和关闭。
- [x] Electron 核心实机验收：隔离 CDP、随机 Basic Auth、编辑保存、hello RPC/SSE/raw、启停与子进程回收。
- [x] 内嵌 Web 核心实机验收：本地内嵌 HTML 对比、CSP、鉴权 RPC/SSE/raw、启停清理；残缺模块缓存修复并补失败回归。
- [x] 修复 token-only 页面静态资源 401 与无 padding token 拒绝；2026-10-04 使用无额外 Authorization 请求头的生产页面验证入口、raw/RPC/SSE、启停恢复及敏感接口鉴权。
- [x] 修复内嵌编译二进制 hello-viewer Child ping 超时：解析真实 Bun/Node 运行时，不再执行编译后的 OpenCode `-e`；13 项测试与编译服务实际回显/停止验证通过。
- [x] 汇总最终组合回归：workspace typecheck 18/18；服务端 156、app 定向 225、browser-condition 55、UI 218、extension-kit 17、hello-viewer 13，均 0 fail。
- [x] 修复 hello-viewer 并发 Child ping 静默串答：按 child 串行排队，红测试确认多个请求拿第一回复，修复后 14/0、构建产物 17 次并发调用无错配。
- [x] 修复最终审查确认的在途 import 失效恢复与设置监听器默认值一致性；强化旧 finally/新任务去重交错回归，runtime 34 pass/0 fail、typecheck 通过。
- [x] 修复 watcher 并发订阅泄漏：主会话验证红 17/2、绿 19/0；串行 refresh 队列与目录处理队列独立，覆盖停止期间迟到订阅回收、失败重试，服务端 typecheck 通过。
- [x] 修复前端旧 refresh/reconcile 陈旧覆盖竞态；主会话整合 epoch guard 生产 helper 与 3 项回归，前端定向 228/0、browser-condition 57/0、typecheck 通过。
- [x] 修复外部文件文本更新重挂载扩展 viewer；text/revision 响应式保留，新增 4 项真实 helper 回归覆盖草稿/保存、源码更新、错误边界、加载前不挂载与卸载清理。
- [x] 完成两路最终审查、6 项确认缺陷修复及交付范围核对：服务端 164/0、前端 228/0、browser-condition 59/0、UI 218/0、kit 17/0、示例 14/0，typecheck 18/18、生产构建通过；app 全量 3 个基线失败仍保留。
- [x] 最终产物内嵌 Web 实机复验（2026-10-05）：真实文件监控更新 text/revision、mount=1 且 dirty 草稿保留，⌘S handler 写盘成功；raw/RPC/SSE/5 路并发 ping、启停清理恢复、token-only/CSP/反向鉴权通过，服务和浏览器已清理。
- [x] 整理交付清单（2026-10-05）：见 `p2-delivery.md`，逐项列出源码/测试/SDK/示例产物；101 个候选交付文件（含清单本文）与 1 个模型快照生成变化分离，未暂存或提交。
- [ ] 可选完整 Electron/Vite GUI 矩阵重跑：不借用最终内嵌 Web 证据替代其他形态；不提交、不推送、不合入 dev。

## 已有验收证据

见 `progress.md` 的 P2 节：服务端/HTTP 定向、前端宿主/设置/保存桥定向、UI 全量、SDK 生成、全工作区 typecheck、隔离 headless RPC/鉴权/启停/热重载、真实 Web 设置保存与密钥掩码。

前次审查因网关卡顿/503 中断，不计为通过；本轮两路独立审查已收口，6 项确认问题均已修复并回归。最终产物 GUI 矩阵复验为独立后续项，不能借用修复前截图宣称通过。
