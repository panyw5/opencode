# P2 集成收尾任务

状态：进行中；实施分支 `claude/extensions-p2-design`；不提交、不推送、不合入 dev。

## 当前阶段：正确性收尾（2026-10-01）

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
