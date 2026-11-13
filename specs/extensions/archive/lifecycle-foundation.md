# 生命周期重构：阶段 0 基础与执行记录

> 已被 `../lifecycle.md` 取代（2026-11-13）。本文仅作历史参考，不再更新。

状态：**阶段 0 部分实施；生产生命周期没有切换。进程原型已迁入独立的 `specs/extensions/prototypes/`，当前原型完整测试非全绿，见其 README；下文为历史证据。**

入口：[实施计划](./lifecycle-rebuild-plan.md)；目标与事实来源：[审计](./lifecycle-rebuild.md)。实现基线 `abc63ce659`，本阶段内容为 API 清单、测试夹具和目标后置条件测试。不使用测试 teardown 释放 pin 的结果证明生产卸载成功。后续描述符所有权及实际 Electron utility 证据见[阶段 1 记录](./lifecycle-ownership.md)。

## 1. 本阶段决定

### 1.1 状态存储

选择扩展 registry 的**单一原子快照**存放 installation、generation 指针、非终态 operation、资源清单及最小终态回执，不另设一个可以独立提交成功的 operation 数据库。文件系统上的包、数据与 quarantine 仍由已落盘 intent 协调，不声称多个文件系统间有原子事务。

沿用 JSON 的原因是目前安装记录、设置和 secret 已在 registry 中原子更新，当前问题是生命周期事实缺失与双重状态，而不是必须引入另一套数据库。新写入器只在阶段 3/5 连通后启用；新格式版本拟为 4，最终 schema 与迁移夹具一起提交。本轮不升版本、不重写现有文件，也不复用当前按 TTL 处理的 registry flock 作为新安全证明。

快照提交必须满足：取得 OS 所有权 → 校验 revision/epoch → 在同一目录独占创建 0600 临时文件 → 写入并 sync → 原子替换 → 平台支持的目录/元数据持久化 → 返回 durable revision。rename 前失败不得发布新决定；替换后无法证明持久化时停止后续破坏性步骤，并对账，而不是报“未提交”。Windows 的原子替换与持久化语义、断电一致性尚未实测，仍是启用前门槛。

operation 只含目标、决定、资源归属和脱敏错误，不复制设置值、secret、认证头或下载 query。终态回执采用计划中的 30 天/1000 条双上限；非终态不按时间删除。备份、临时快照可能含敏感设置，必须纳入资源所有权与卸载验证，不能把“active row 已删除”当作 secret 已清除。

### 1.2 前端停止保证

本次保证托管 viewer、工具渲染器、panel、命令、订阅、样式和宿主 RPC/token 的撤销，以及迟到响应不恢复注册。当前 Solid component/HTMLElement/API 依赖同 realm，不能把这些对象直接搬入 worker，也不能保证扩展私建 timer 或任意 JS 的物理消失。

如果验收要求任意前端 JS 物理停止，则需要另行实现可销毁执行上下文和 UI 代理，并将它加入交付门槛；当前测试与本方案都不将 dispose/scope 清理当作这一保证。离线客户端的远程停止证明也不在现有同 realm 模型能力内。

### 1.3 授权与身份

更新保留 installation，部署变化产生 generation；卸载销毁 installation，重装不继承。现有 `installId` 表示部署路径，迁移时映射 generation，不能直接用作新安装实例身份。source 渠道切换仍需确认，不再充当旧数据所有权。

旧 retained 是以前明确允许保留的数据，升级不得未经授权删除；迁移 dry-run 必须列出清理清单。旧 `.unsupported` 和崩溃 gate 需要退出证明或受控停机接管，不能通过删文件解除。多个 registry 使用同一全局数据命名空间时必须先对账全部使用者。

## 2. 资源归属清单

记号：`R` 为 canonical registry 父目录，`D` 为 `Global.Path.data/extensions`，`C` 为 `Global.Path.cache/extensions`，`T` 为 `Global.Path.tmp/extension-modules`。下表描述当前路径，不是允许按这些模式进行全局递归删除的授权。新 executor 只能删除已登记并核验归属的具体资源。

| 资源                          | 当前创建/使用者与位置                                       | 当前证明与限制                                                          | 目标归属/撤销/验证                                                     |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Active row                    | registry.ts，registry JSON 的 extensions[id]                | source/revision/installId；不等于运行实例                               | installation + active generation；按 revision detach；验证不再可路由   |
| 设置和 secret                 | registry.ts，row.settings/secretKeys                        | secret 明文存文件，外部 Info 才遮罩                                     | installation；精确删除存储键；验证所有敏感副本不再含该安装数据         |
| Retained                      | registry.ts，retained[id]                                   | 默认卸载保留，影响未来安装批准                                          | 仅迁移为已授权清理任务；终结后不存在，不转为继承权                     |
| Purged tombstone              | registry.ts，retained.purgedAt                              | 清理后仍保留                                                            | 迁移对账后删除；最小回执不参与身份                                     |
| 主快照临时文件                | registry.ts，R/.<registry>.<pid>.<uuid>.tmp                 | 可能含其他扩展设置和 secret                                             | store 的写事务；按事务认领并清理；不能按某扩展 ID 删除整份共享快照     |
| v1 备份                       | registry.ts，<registry>.v1.bak                              | 可含历史设置，当前读取 v1 会创建并写迁移                                | 迁移器管理敏感副本；逐安装处理或授权销毁；保留其他扩展数据             |
| 操作 staging                  | install.ts，R/staging/<operation>/                          | ownership.json、operation.json、journal.jsonl，能力只在内存             | operation；过期/取消/失败均持久化清理；完成后目录不存在                |
| staging 中 token 材料         | install.ts，operation.json.tokenHash                        | 验证材料仍是敏感元数据；不是完整 outcome                                | operation；不复制到公开日志，终结后清理                                |
| 托管包                        | paths.ts/cleanup.ts，R/packages/<installId>/                | installation.json 绑定 registry hash、operation、摘要                   | generation；读者退出、指针解除后 quarantine；完成后包与归属文件不存在  |
| 包依赖/链接                   | install.ts/runtime.ts，package/node_modules                 | import copy 可能链接原包依赖                                            | generation；先撤销所有运行引用；删除链接本身，不跟随目标               |
| import copy                   | runtime.ts，T/<safe extension ID>/<fingerprint>/            | 直接 import 到宿主；按扩展 ID 保留最近副本，可能含 node_modules symlink | generation/runtime；不再用 copy 规避同进程模块缓存；迁移后精确认领清理 |
| copy 临时/损坏目录            | runtime.ts，fingerprint.<pid>.<uuid>.tmp/.stale             | 并发复制与修复可能留下目录                                              | operation/runtime；验证身份后恢复清理，未知内容阻塞                    |
| data                          | data.ts/runtime.ts，D/data/<id>/                            | **全局按 extension ID 共用，不随 registry 改变**                        | installation；迁移 owner 对账；停止所有使用者后本根 quarantine         |
| cache                         | data.ts/runtime.ts，C/<id>/                                 | 同样全局共享                                                            | installation；精确认领、删除并验证                                     |
| data owner                    | data.ts，D/data-ownership/<id>.json                         | source hash、目录 hash，未绑定新 installation                           | installation；安全迁移；完整卸载后不存在                               |
| data purge journal            | data.ts，D/data-purge/<id>.json                             | 记录 dev/ino 和 rename 目标                                             | operation 的步骤；迁移恢复后删除，不能成为新安装权限                   |
| data/cache trash              | data.ts，D/data-trash/<uuid>、C/data-trash/<uuid>           | 依赖 purge journal 对账                                                 | operation；每个文件系统内单独 rename；幂等删除并复核                   |
| 包/候选 trash                 | cleanup.ts，R/trash/<uuid>/                                 | recover 仅 deferred                                                     | operation + 原 generation；intent 与路径绑定，可重启继续删除           |
| cleanup claim                 | cleanup.ts，R/cleanup-claims/<uuid>/owner                   | mkdir claim，崩溃后不接管                                               | executor OS 所有权；已证明原 owner 死亡后可继续，不凭年龄删除          |
| generation 引用               | leases.ts，R/ref/<id>/owner.json 和 proof                   | Bun POSIX flock 或永久 unsupported                                      | generation + runtime；所有读者 OS 证明释放后才能回收                   |
| operation 引用                | leases.ts，R/operation-ref/<id>/                            | 同上                                                                    | operation；进程退出可接管，完成后不留下永久阻塞                        |
| data 引用                     | leases.ts，D/data-ref/<extension ID>/                       | 跨 registry 共用；与 registry 根不同                                    | installation；共享 owner 列表必须迁移和对账                            |
| gate                          | leases.ts，各引用根的 .gate/owner                           | 崩溃后永久保守阻塞                                                      | OS 互斥 + epoch；无 TTL，接管需可证明原 owner 不再执行                 |
| 后端模块/service              | runtime.ts，entries、service、module cache/pins             | dispose 不使任意 closure/timer 消失                                     | 独立执行进程；退出证明后释放 generation/data 引用                      |
| 项目级 Hooks/tool cache       | runtime.ts + Plugin/ToolRegistry + InstanceState            | 存在项目级生命周期及缓存 finalizer                                      | runtime/project handle；先关准入和回调，再销毁；不提前释放共享进程     |
| 后端注册与订阅                | settings listener、events、workspace adapter、auth/provider | 嵌套函数可能持有宿主对象                                                | runtime + epoch 的可撤销 handle；旧回调不能重新注册                    |
| kernel/子孙进程               | 扩展 server、shell/child_process                            | extension 自行启动；当前不是统一 supervisor 所有                        | runtime；受管启动、平台树约束；逐项确认退出，不能按进程名误杀          |
| 前端激活根                    | app/extensions/activation.ts                                | rootDispose、valid/generation；同 realm                                 | server/installation/generation token；撤销与迟到检查                   |
| viewer/renderer/panel/command | app/extensions/context.ts、host.tsx、UI registries          | Disposable 和 placeholder 注册分开                                      | frontend runtime；真实注册与 placeholder 都撤销；打开的实例卸载        |
| CSS/前端模块                  | activation.ts、modules.ts                                   | style remove 可以撤销样式，ESM 本身不可卸载                             | frontend realm/token；样式与托管 UI 清除，任意 JS 停止另立保证         |
| 前端 RPC/事件/设置            | context.ts、host.tsx                                        | connection/owner 影响异步结果                                           | server/store/runtime token；取消、退订、拒绝过期结果，重连先对账       |
| 宿主日志/审计                 | Core Log、extension event、operation receipt                | 日志共享，不能整文件视为某扩展私有                                      | 宿主有界保留；禁止记录 secret；只留最小回执，不参与安装身份            |
| Desktop 下载暂存              | desktop extension-download/archive + app install-desktop    | 传输进程与服务器 registry 不同                                          | 传输 operation，确认移交与本地收尾；不把客户端成功当服务端完成         |
| 开发目录与用户文档            | source.path、项目 .wls/.nb、系统 Wolfram                    | 非宿主包/数据，绝不能认领整个目录                                       | 仅移除链接注册与宿主资源；源代码、文档和系统程序始终排除               |

**迁移注意：** 当前 `registry.readStore()` 遇到 v1 会写备份并升级。只读 dry-run 不能直接复用这个读入口，必须使用不会修改原文件的旧格式解析器。当前测试夹具 teardown 只删自身随机 ID 和私有临时目录，不运行全局垃圾清理。

## 3. 跨进程 API 矩阵

机器维护入口：`packages/opencode/test/extension/lifecycle-api-matrix.test.ts`。`satisfies Record<keyof API, Transfer>` 使上层 API 新增成员而未分类时 typecheck 失败；分类测试不是适配器已实现的证据。嵌套回调及实际编码验收仍需阶段 2 完成。

| API                                                                   | 协议表达                                       | 作用域与失败/销毁要求                                                |
| --------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| ServerExtension.id                                                    | 字符串，与 manifest 校验                       | generation；不允许替换公开身份                                       |
| activate(host) / service                                              | activate 请求、service handle、能力描述        | process-level；激活失败可观察，迟到结果立即撤销                      |
| server(input, options) / Hooks                                        | project 实例创建、hook handle 表               | directory/worktree 实例；项目销毁不影响其他项目                      |
| ExtensionHost 基础字段                                                | id/version/data/cache 路径、URL 字符串显式复原 | installation/generation；路径由宿主提供，不由扩展决定删除目标        |
| settings.get/onDidChange                                              | 请求与订阅句柄                                 | 明文仅给所属扩展进程；settings 更新事件有序，取消后不再调用          |
| emit / log                                                            | 有界事件/结构化日志                            | runtime/epoch；过滤 secret，旧运行实例事件拒收                       |
| PluginInput.client                                                    | 保留请求语义的宿主 SDK 代理或受限认证连接      | project/subject；不把函数或宿主客户端对象传到子进程                  |
| PluginInput.project/directory/worktree                                | 序列化上下文快照                               | project；不依赖子进程全局 cwd 隐式切换                               |
| PluginInput.serverUrl                                                 | URL 编码                                       | server identity；不能自动切换连接目标                                |
| PluginInput.$ / BunShell                                              | 托管 shell/进程能力，保留调用、流和退出语义    | runtime；当前 BunShell API 不能靠普通 JSON 保留，兼容适配需专项验证  |
| experimental_workspace.register                                       | 注册 adapter 描述及方法句柄                    | project/runtime；登记可撤销，不只转发一次 register                   |
| WorkspaceAdapter.configure/create/remove/target                       | 回调请求、configure 输出、URL/headers 编码     | handle；删除回调不等于删除 extension 数据目录                        |
| Hooks.event/dispose                                                   | 异步调用句柄                                   | project；dispose 有界，退出由外部 supervisor 证明                    |
| Hooks.config                                                          | 发送配置快照，返回明确修改结果                 | project；不能丢弃原地修改                                            |
| chat.message/params/headers                                           | 输入快照 + output 编码返回并按调用顺序应用     | request；不转发模型对象函数；取消和过期结果拒收                      |
| permission.ask/command.execute.before                                 | output 状态/parts 返回                         | request；权限处理不能在失联时默认为允许                              |
| tool.execute.before/after                                             | args/title/output/metadata 返回                | tool call；不可自动重放有副作用调用                                  |
| shell.env/tool.definition                                             | env 或描述/schema 修改结果返回                 | request；保留原有顺序和参数语义                                      |
| assistant.response.before/after                                       | output/error 显式编码                          | response；异常不是无修改成功                                         |
| experimental.chat.messages/system.transform                           | messages/parts/system 返回                     | request；不能依赖跨进程对象引用                                      |
| experimental.session.compacting/compaction.autocontinue/text.complete | context/prompt/enabled/text 返回               | request；取消与请求完成有唯一结局                                    |
| ToolDefinition.args                                                   | JSON Schema/等价声明 + 子进程原 schema 验证    | generation；Zod transform/refinement 不能直接序列化，禁止无声丢弃    |
| ToolDefinition.execute                                                | args + context + result 编码                   | tool call；支持字符串或完整 ToolResult                               |
| ToolContext.abort                                                     | cancel(requestId)                              | request；pre-abort、调用中取消、断连均有定义                         |
| ToolContext.metadata/ask                                              | 反向有序回调句柄、权限应答                     | request；等待权限期间可停止，不制造回调死锁                          |
| ToolResult.metadata/attachments                                       | metadata 数据，attachment 的 mime/url/filename | request；明确大小/二进制传输策略，不能漏掉附件                       |
| auth.loader / methods                                                 | 嵌套回调表，auth() 反向请求                    | auth 流程；返回 secret 不写 journal/log                              |
| auth prompts.validate/condition、OAuth callback                       | 每个嵌套函数独立 handle，method/when 为数据    | auth flow；UI 关闭/卸载时释放，迟到认证结果不能写新安装              |
| provider.models                                                       | 方法句柄、模型数据编码                         | generation/provider；确认模型中不可序列化字段并明确拒绝或编码        |
| RPC handler / context                                                 | requestId、directory、input、响应、cancel      | runtime/project/request；不直接克隆 AbortSignal                      |
| web.activate/component/Accessor/HTMLElement                           | 继续前端 realm，仅宿主 RPC/事件跨进程          | frontend runtime；不把 Solid component 宣称成 worker 可传数据        |
| web viewer/toolRenderer/panel/command                                 | frontend disposer + generation token           | 每个已打开实例与注册均撤销；估高函数与 toolbar/save handler 同步清理 |
| web assets/log/rpc/events/settings                                    | token 化宿主服务与订阅                         | connection；A → B → A 不复用过期 handle                              |

所有后端调用还必须携带 store/installation/generation/runtime/project/request 身份中适用的字段及 epoch。handle 只能在所属 runtime 反向调用，不能被另一扩展复用；不支持的协议版本在执行代码前拒绝，不退回同进程 importer。

## 4. 可执行测试与平台能力

### 4.1 进程夹具

`specs/extensions/prototypes/test/extension/fixtures/lifecycle-process.mjs` 是不依赖 Bun API 的 ESM 执行单元；Node 与 Bun 启动同一文件。它提供真实子/孙进程、挂起调用、取消确认、常驻 timer、dispose 抛错/挂起、忽略 SIGTERM 和父进程崩溃场景。`lifecycle-process.ts` 只管理这个私有夹具，不是已经接入产品的 supervisor。

测试通过 JSON 行握手定位进度，不靠固定 sleep 等待启动或停止。测试 owner 在 acquisition 后立即通过 async disposer 注册清理；强制结束仅向自己创建的进程或 POSIX group 发信号，并等待 close。10 秒只限定等待时间，不用于判定进程死亡。

强制杀组后 stdio 关闭只证明这个夹具的继承管道关闭，不能证明任意扩展脱离进程组后的退出。根进程 exit 测试明确验证其后代仍活着，防止未来实现用根进程退出代替树退出证明。Windows Job Object、OS 锁与崩溃 owner 接管仍待阶段 1 实现。

### 4.2 目标契约红灯

`lifecycle-target.test.ts` 经真实 `installation()`、registry、默认 importer 和实际文件系统执行，不 mock commit/cleanup 结果。正常测试运行启用“拒绝非隔离存储”和“损坏候选不改 A”两项绿灯；五个目标用例必须用显式环境变量启用，并在当前基线失败，不能被统计为通过。

```sh
cd packages/opencode
bun test --timeout 30000 test/extension/lifecycle-api-matrix.test.ts test/extension/lifecycle-target.test.ts
# 进程原型从项目根另行运行：bun run --cwd specs/extensions/prototypes test:process
OPENCODE_EXTENSION_LIFECYCLE_TARGET=1 bun test --timeout 30000 test/extension/lifecycle-target.test.ts
bun run typecheck
```

红灯分别检查：默认卸载后无 retained/secret 分类；已激活扩展卸载后包与数据实际消失；更新 B 后 A 包消失；B 激活失败后 A 恢复；archive 卸载后 release 安装不被历史来源否决。release 使用 prepareRelease 的本地 descriptor/归档移交通道，不依赖公网或真实目录资产。

夹具要求包级 preload 提供隔离 data/cache，使用随机 extension ID、独立 registry 和临时归档，拒绝非测试 data/cache 根；收尾只删除自己创建的目录。新协调器引入异步完成协议后，应改测试适配器为等待 durable 终态，但不能降低上述后置条件。

### 4.3 当前证据

执行环境：macOS，Node `v25.9.0`，Bun `1.3.9`。

| 检查                      | 本轮结果                               | 不能外推                                              |
| ------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Node/Bun 共享夹具进程测试 | 两种运行时各 6 项通过，共 12 项        | 不是生产扩展 supervisor，不是跨平台锁证明             |
| API transfer 分类         | 已加入并执行；完整性由 typecheck 约束  | 不是完整跨进程适配已完成                              |
| 损坏候选隔离              | 已执行并通过                           | 不等于切换后 rollback 已实现                          |
| 目标契约                  | 已观察五个预期缺口；完成态测试仍为红灯 | 不得计入成功用例                                      |
| 实际 Electron sidecar     | 本阶段尚未完成监督原型集成             | 普通 Node 不能替代 Electron utility process           |
| Linux / Windows           | 未执行                                 | macOS 进程组结果不能替代 Job Object 或 Linux 退出语义 |
| OS 锁与旧 owner 接管      | 未实现/未验证                          | 没有可用证明前禁止新清理写入器上线                    |

本轮新增组合最终为 **16 pass / 5 skip / 0 fail**：12 个 Node/Bun 进程场景、1 个启动失败/句柄关闭场景、1 个 API 分类测试、2 个存储/候选隔离测试。独立测试进程同时执行进程夹具组合，**13 pass / 0 fail**；两个进程使用独立 PID 数据根与进程组，结束后宿主检查无剩余夹具进程。

显式启用目标契约的命令最终为 **2 pass / 5 fail**，退出码 1；五处失败均为上述目标后置条件缺口，不是网络、夹具启动或归档解析失败。`bun run typecheck` 与新增文件 Prettier 检查通过。只读运行 `bun packages/desktop/scripts/cdp.ts info` 确认现有开发 Electron 页面 readyState 为 complete，未重启应用；这不是 sidecar 生命周期功能验收。

本地原始记录在 `.artifacts/extension-lifecycle/phase0.GEzsC2/{focused,independent-process,target-red,typecheck}.log`，属于忽略的运行产物，不随源码交付。历史审计和此前 WLS 截图不算本次实现证据。

## 5. 尚未完成与后续顺序

阶段 0 尚缺：恢复边界故障注入矩阵的可执行覆盖、完整新状态转换/身份 schema、平台持久化原型及最终前端保证确认。不能据此勾选整个阶段 0 完成。

后续进度由[阶段 1 记录](./lifecycle-ownership.md)维护；仍需证明 supervisor 崩溃后的接管、全部读者退出以及各平台运行资源回收，再接完整 Hooks 代理与 Store。不添加 unsupported 成功分支。
