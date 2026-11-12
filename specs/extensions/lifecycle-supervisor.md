# 生命周期重构：执行实例与准入状态

状态：**已迁至 `specs/extensions/prototypes/` 的独立实验原型，未接入生产安装器、registry 或资源删除。** 本批内部身份/准入模型、JSON 控制协议和单执行根监督不代表完整 RuntimeSupervisor 或扩展 API 代理交付；迁移后完整进程测试仍有失败，见[当前原型验证记录](./prototypes/README.md#验证与已知边界)。

生产接入前置：[隔离加固计划](./isolation-hardening-plan.md) A/B 阶段。下文历史通过结果仅描述当时运行，不覆盖当前非全绿结果。

入口：[实施计划](./lifecycle-rebuild-plan.md)；前置证据：[描述符所有权](./lifecycle-ownership.md)。现有 installer、defaultImporter、generation/data pins、retained 和真实用户 registry 保持原行为。

## 1. 身份与准入快照

`specs/extensions/prototypes/src/extension/lifecycle-state.ts` 定义独立品牌的 store、installation、generation、runtime、mutation UUID，以及精确整数 revision/epoch。generation 不是旧格式的 installId，runtime 身份不能在重启后复用。

`AdmissionSnapshot` 是**实验性版本 1 准入记录**，不是 registry v4，也不是旧 registry 的替代解码器。它记录当前部署、open/closing 准入、停止 operation 和 starting/ready/rootExited 执行实例。严格解码拒绝未知版本/字段、重复 runtime、异主部署和无效计数，不以空状态替代损坏内容。

| 操作                                | 调用前提                                                          | 返回值及限制                                                                   |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| admitRuntime                        | 持 mutation guard，store/revision 匹配，准入 open，执行身份未用过 | 增加 starting 读者并推进 revision；调用者必须先持久化，再确认准入              |
| recordRuntimeState(..., ready)      | 当前 revision 匹配，执行已登记，准入/epoch 仍有效                 | 允许后续业务提交；关闭准入后不能补报 ready                                     |
| closeAdmission                      | 持 mutation guard，当前 revision 匹配                             | 保留全部读者、关闭准入并推进 epoch/revision；相同 operation 的当前状态重试幂等 |
| recordRuntimeState(..., rootExited) | host transport 已观察根进程退出，身份和当前 revision 匹配         | 保留 rootExited 记录；不能据此移除读者、重新开放准入或完成清理                 |
| acceptsRuntime                      | 在宿主副作用提交前重读最新状态                                    | 只有 ready、open、完整身份和当前 epoch 匹配才允许提交                          |

转换函数不修改输入，也不执行 I/O。JSON 往返测试只验证可重建状态及关闭准入不丢失，不是断电耐久性证据。实际持久化、锁内读改写、提交点、恢复扫描和幂等回执仍归 DeploymentStore 实现。

revision 与 store 身份共同作 CAS；epoch 用于执行消息的失效。并发启动和停止基于同一 revision 时，至多一个转换可以在更新后的状态上成功。计数溢出拒绝变更，不能回绕或复用旧 fence。

## 2. 控制协议与执行根

`execution-protocol.ts` 定义内部协议版本 1：hello、ready、request/result/rejected、cancel、drain/drained、dispose/disposed/failed。每帧携带完整 store/installation/generation/runtime/epoch；未知版本、字段、非 JSON 值和伪造的 exit 消息被拒绝。**exit 只能由宿主的 OS/utility handle 观察，不能由 worker 自报。**

`execution-process.ts` 使用私有进程的 fd3 接收宿主命令、fd4 返回事件，stdout/stderr 单独作为日志。帧限制、启动前缓冲数量和退出等待预算由调用者显式提供；接收器处理跨 chunk UTF-8、每 chunk 多帧，并拒绝非法 UTF-8、截断、超长或无效 JSON。排队字节上限在写入前检查，不把已入队命令误报成“尚未发送”。

`execution-worker.ts` 的 `ExecutionApplication` 只包含内部 JSON request 与 dispose。loader 完成前不能接收业务；请求并发上限独立于客户端 pending 上限；取消、drain 和 dispose 不串在某个业务 Promise 后面。请求忽略取消时，dispose 仍可进入；整个 JS 线程被阻塞时则只能由外部终止根进程。

这不是 PluginInput、Hooks、BunShell、注册回调或 SDK 的序列化方案，不能把现有扩展直接装进这个接口并宣称兼容。生产 bootstrap、候选摘要校验、正式 API 代理和作者兼容声明尚未实现。

### 2.1 描述符的真实寿命

worker 必须在任何 application loader 执行前持有共享 OS 引用，并保持到**实际 OS 退出**。不能在 dispose acknowledgement、serveExecution 返回或 await-using 收尾时先释放引用，再让 timer/exit handler 继续运行。

真实夹具在仍持有引用的作用域中退出进程，由 OS 回收 FD。专门用例让应用完成 dispose、但执行根继续存活：独占者仍必须 busy；外部终止并观察根退出后才可重新取得独占所有权。该测试不使用超时来推断引用已释放。

Node 的控制 fd 使用可轮询 socket handle，Bun 使用其描述符流实现。Node 上的阻塞 filesystem read 会妨碍退出；Bun 1.3.9 的 Socket fd 适配未用于该入口。两种受测适配共享相同帧和 fence 规则，不在运行失败时偷偷更换锁或执行方式。

## 3. 单执行实例 supervisor

`execution-supervisor.ts` 为调用者已启动且已获准入的一个 transport 提供：

1. hello/readiness 状态校验与显式等待预算，ready 前拒绝调用。
2. 有界 pending 请求、取消转发、不自动重放，以及完整运行身份校验。发送前的容量拒绝只结束该请求，保留健康执行实例；其他发送错误按未知执行结果关闭准入。
3. stop 调用同步关闭本地准入并结束客户端 pending，再发送 drain、dispose，最后等待实际根退出；控制 acknowledgement 不能提前完成 stop。
4. drain/dispose/exit 等待预算耗尽时保留具体 issue，必要时调用宿主 transport 的外部终止方法；终止请求成功本身也不算 exit。
5. 不匹配身份和取消/停止后的迟到结果被丢弃；协议错误关闭准入并调用外部终止。
6. OS 退出未观察到时返回 unknown，保留 transport；不能释放所有权、宣告卸载成功或依时间清理。观察到后可再次查询/停止。
7. 根退出后解除订阅并等待本实例的宿主 pipe 关闭；release 失败保留结构化 cause，scoped disposal 同样失败，不把关闭请求当作完成。

返回值只区分 rootExited 与 unknown，**所有结果的 tree 均为 unproven**。异常根退出、dispose 失败和强杀理由仍可查询；根退出码 0 不是正常 dispose 的独立证明。`failure` 中的 cause 只供内部诊断，不应直接序列化到用户日志或持久化快照。

本地 supervisor 的 ready 不等于最新 durable epoch 仍开放。宿主在接收结果、建立注册项或提交状态之前，仍必须持 mutation ownership 重读 store 并通过 acceptsRuntime/CAS；旧 supervisor 不能凭自身内存状态向新 generation 提交副作用。

## 4. 真实进程和 Electron 验证

Node 与 Bun 各自启动同一独立 worker 入口，实际收发请求并检查 OS 引用；不是用假 transport 替代全部进程测试。测试覆盖普通调用、stdout 隔离、在途取消/停止、忽略取消的请求、dispose 抛错/挂起、启动抛错/挂起、启动期间停止、控制管道丢失、dispose 已确认但执行根仍活着，以及突然退出。

真正的 Electron 测试使用隔离无窗口 app：

- `specs/extensions/prototypes/scripts/extension-lifecycle/supervisor.cjs` 只设置私有 userData/logs 并载入测试 runner，不导入产品 main/server/用户设置。
- runner 在 Electron main 中运行同一份 source supervisor，通过 utilityProcess 的 message/exit/kill handle 管理独立 worker；不是只从外部等待测试 main 退出。
- utility 的 parentPort 承载同一协议，普通 stdout 不参与协议。用例实际发出 echo 并核对返回，验证普通退出、dispose 抛错、dispose 挂起和 activation 失败，然后检查共享引用已释放。
- Electron probe 依赖的 Effect 和原生包显式链接进私有模块目录；这是源码/依赖组合验证，不是签名、asar 或发布包交付证据。
- Electron parentPort 没有在此适配中实现可重挂接的断连恢复；测试未证明 main 被 SIGKILL 后的全部执行实例恢复，也不能用 Node/Bun 的 fd EOF 结果替代它。

纯控制测试另行验证错误协议顺序、五个 fence 字段分别不匹配、迟到响应、请求上限、未知停止结果、释放失败，以及 wire parser 的拒绝路径。私有目录由 allocator 创建，失败收尾保留对本批进程的监督；不查杀安装版应用。

## 5. 本地命令与未完成门槛

从项目根执行（依赖准备见原型 README）：

```sh
bun run --cwd specs/extensions/prototypes test:unit
bun run --cwd specs/extensions/prototypes test:process
bun run --cwd specs/extensions/prototypes test:electron
bun run --cwd specs/extensions/prototypes typecheck
```

macOS 上最终定向组合为 **76 pass / 13 skip / 0 fail**；独立并发的新执行实例组合为 **48 pass / 0 fail**；显式开启的实际 Electron 组合为 **7 pass / 0 fail**，其中四项验证本批 supervisor，三项验证已有所有权提供者。跳过项是五个未满足的 production target、七个显式 Electron 用例和一个仅非 macOS 执行的平台拒绝用例，不计为通过。

`bun run typecheck` 和三个新探针脚本的 Node 语法检查通过。CDP 9222 验证已有开发实例的 OpenCode 页面 readyState=complete；没有重启开发实例或关闭安装版应用，也没有把该页面状态当作新生命周期 GUI 验收。

本地原始证据在 `.artifacts/extension-lifecycle/phase1-supervisor.NKdPd4/`：focused.log、electron.log、independent.log、typecheck.log 和 cdp.log。以 `OPENCODE_EXTENSION_LIFECYCLE_TRACE=1` 开启的测试日志包含实际 worker/control/root-exit 事件，不含真实用户 registry 或设置值。oversized-request-red.log 保存修复前两个实际运行时的预期失败；最终组合已验证容量拒绝后普通请求仍能完成。

尚未运行发行打包、Linux/Windows、真实 WLS 生命周期及完整故障恢复验收。原有五个 production target 不因这些新测试通过而变为已实现。

生产切换仍被以下事项阻塞：

- DeploymentStore 的原子 durable admission、operation/owner 记录、恢复及故障矩阵；当前转换函数和测试中的锁内内存状态不能替代持久化提交。
- supervisor 崩溃后仍存活的运行实例发现、认证重挂接/停止、旧 owner 接管与迟到提交 fencing；不按 PID 或 TTL 猜测死亡。
- 受管子孙进程约束和退出证明、多宿主读者协调；不因所有根的 flock 已释放就删除包或数据。
- Linux/Bun 与 Node 共用协议、Windows 锁/ACL/Job Object，以及各平台实际验收。
- 正式 Electron/Node bootstrap、依赖打包、完整作者 API 代理与 RegistrationManager。

上述条件满足前，不能把本批模块接入生产清理写入器，不能将 rootExited 翻译为“卸载完成”。
