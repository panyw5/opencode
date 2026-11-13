# 扩展系统生命周期重构实施计划

状态：**阶段 0/1 实验原型已迁入 `specs/extensions/prototypes/`，生产生命周期尚未切换。** 后续生产接入以前置完成 [isolation-hardening-plan.md](./isolation-hardening-plan.md) 的 A/B 为条件；原型完整进程测试仍有失败，当前证据见其 README，不能用历史绿灯替代本轮验收。

依据：[生命周期事实审计与目标契约](./lifecycle-rebuild.md)。代码核对基线：`abc63ce659`。本计划不修改原审计，不恢复 archive → release 来源兼容补丁，不操作真实用户 registry，不授权提交、推送或发布。

## 1. 目标、边界与交付原则

目标是让安装、更新、卸载、崩溃恢复成为同一套可验证的生命周期。完成的判据是磁盘、进程、注册项与持久化状态满足后置条件，而非弹窗关闭、registry 写入成功或 `dispose()` 返回。

必须保持以下约束：

1. 更新候选准备失败不影响当前版本；运行切换失败有持久化、可重启继续的恢复决策。
2. 卸载删除所有已确认归属的托管资源，包括设置与 secret；执行期间显示“移除中”，未删除完显示“移除失败”，不能显示成功或让用户查询内部状态。
3. 卸载后重装产生全新的 installation，不继承历史 retained，不因历史 source 拒绝安装。
4. 不删除项目文件、`.wls`、`.nb`、开发链接目标、系统 Wolfram 安装以及其他非扩展拥有的文件。
5. 不能用 TTL、删除全部锁、忽略 `.unsupported`、跳过归属验证换取进度。
6. 不把可信扩展进程隔离描述成安全沙箱；对管理目录之外的任意扩展副作用不承诺回滚。
7. 各阶段可以分 PR 集成基础设施，但在最终门槛前不对用户宣称“干净卸载已交付”。旧、新写入器不能同时管理同一套生产状态。

本次范围包括现有后端扩展 API 的进程代理、宿主注册项撤销、三条生命周期、持久化与旧状态迁移、所有管理入口和真实平台验收。不包括任意扩展数据的通用事务回滚、隐藏保留模式、自动恢复旧数据，以及通用不可信代码沙箱。

### 当前移除界面

生产弹窗确认后只展示“移除中”“移除成功”或“移除失败”，不展示 coordinator、内部回执、原始 warnings 或“查询状态”按钮。当前接口确认 committed 且 synced 时显示移除成功，表示扩展已移除且宿主同步完成，不表示旧包或保留数据已全部清除。cleanupPending 还汇总旧包回收、租约释放和清理回执更新，不能单独作为卸载失败的依据。未提交成功、同步失败或结果未知显示失败。这些标志不能替代本计划要求的进程退出、资源归属和完整清理验收。

提交响应丢失时，界面自动读取原操作结果；重试不得在结果未知时另建操作。确认未提交后可使用原授权提交，确认失败且未产生变更后可重新准备。已经产生变更但同步未完成时，显示失败和关闭。旧后端没有可靠的继续清理接口，不能把重读回执当作清理重试；旧包回收等维护任务的待处理标志保留在结果与日志中，不额外展示给用户。保留数据的默认选择及显式删除数据选项保持不变。

## 2. 目标架构与职责

```text
UI / CLI / HTTP / Desktop IPC
          ↓
ExtensionLifecycle
  ├─ ArtifactResolver       获取并冻结候选，不执行扩展代码
  ├─ DeploymentStore        安装、代际、操作日志及原子状态变更
  ├─ RuntimeSupervisor      执行进程、调用准入、退出与运行引用
  ├─ RegistrationManager    后端/前端托管注册、资源 token 撤销
  └─ CleanupExecutor        归属验证、quarantine、幂等删除及恢复
```

| 模块                | 唯一负责的事实                                         | 禁止承担的职责                        |
| ------------------- | ------------------------------------------------------ | ------------------------------------- |
| ArtifactResolver    | source、摘要、manifest、冻结候选                       | 继承旧数据、执行扩展、修改 active     |
| DeploymentStore     | durable operation、安装身份、generation 指针、资源清单 | 通过内存结果覆盖持久化事实            |
| RuntimeSupervisor   | 谁在运行、什么调用可进入、何时已确认退出               | 把 dispose 成功视为进程死亡           |
| RegistrationManager | token/epoch、注册句柄、撤销确认                        | 接受旧 generation 的迟到注册          |
| CleanupExecutor     | 每项资源的清理进度与阻塞原因                           | 按 extension ID 扫描任意目录          |
| ExtensionLifecycle  | 决策顺序、恢复、重试及完成验证                         | 让 UI 或 IPC 自行补事务               |
| 入口适配器          | 身份验证、字节传输、展示与刷新                         | 独立重装、清 tombstone 或改变卸载语义 |

### 2.1 身份与目录

- `extensionId`：公开扩展名称，不代表数据所有权。
- `installationId`：一次干净安装；更新不变，卸载完成即失效，重装新建。
- `generationId`：一次不可变部署；更新产生新值。当前代码中的 `installId` 同时用于部署路径，迁移时必须明确转换，不能直接当作新 installationId。
- `runtimeInstanceId`：一次执行进程；崩溃重启后变化。
- `operationId`：一次 prepare/应用/恢复事务，绑定服务器、registry 和授权主体。
- `mutationEpoch`：单调递增的变更代次；配合 installation/generation/runtime 身份拒绝过期写入、事件与 RPC 响应。

新数据、缓存和设置按 installation 归属；包按 generation 归属；staging、临时文件和 quarantine 按 operation 归属。资源清单记录资源类别、根目录标识、不可变相对路径、归属身份及验证材料，不接受客户端传入任意绝对删除路径。不同文件系统的数据根分别建立私有 quarantine，不假设跨盘 rename 原子。

source 只控制当前候选与更新渠道；更换更新渠道仍需明确授权和候选确认，但不再决定旧数据访问权。卸载后不同来源的新安装也不能读取旧 installation 的命名空间。

### 2.2 持久化事实与事务

逻辑上由一个 DeploymentStore 提交安装记录、指针和 operation 决策。阶段 0 固定物理存储选择：复用原子 registry 快照，或使用具备事务的数据库；不得把 registry 与 journal 当作两个可独立成功的事实来源。若保留文件布局，必须有可实测的提交点、日志重放规则及文件和目录刷盘策略，不能仅以 rename 推导断电耐久性。

最少持久化以下内容：

- 格式版本、store 身份、revision；installation、generation、active/previous 指针及启用方式。
- operation 的类型、主体、幂等键、候选摘要、预期 revision、当前阶段、已持久化决定。
- 每个副作用步骤的 intent、目标资源、执行结果、重试信息与清理验证结果。
- 更新的 rollback 决定、A/B 身份以及恢复进度；卸载的完整资源清单。
- 脱敏结构化错误及独立的后置条件验证结果。

任何 rename/delete/start/stop 等副作用都先持久化 intent，再执行，再记录结果。恢复时根据现实资源和原 intent 对账；“已记录开始”不意味着“尚未执行”，“没有收到响应”不意味着“没有提交”。

## 3. 操作状态、完成标准与失败所有权

### 3.1 状态语义

| 状态                | 含义                                   | 可执行动作                   |
| ------------------- | -------------------------------------- | ---------------------------- |
| prepared            | 候选和授权快照已冻结，尚未应用         | 确认、取消、过期清理         |
| applying            | 已取得变更所有权，正在部署或停止/切换  | 查询；不得重复创建替代事务   |
| synchronizing       | 对齐运行状态、协议和托管注册           | 查询、恢复                   |
| cleaning            | 主变更已生效，但资源删除未完成         | 查询、同 operation 重试      |
| rollingBack         | 已决定恢复 A，正在执行                 | 查询、恢复，不得改回继续 B   |
| rolledBack          | 已验证 A 恢复且失败候选清理完成        | 查看原失败、新建后续操作     |
| blocked             | 外部占用、权限或归属不明阻止推进       | 查看具体步骤、解除原因后重试 |
| failed              | 已确认失败且应做的收尾完成             | 查看原因、新建操作           |
| completed           | 对应操作的所有完成条件已验证           | 查看回执                     |
| cancelled / expired | 未应用候选已取消或过期，且候选清理完成 | 新建操作                     |

`unknown` 是查询无法确定 durable outcome 时的对外报告，不是把明确拒绝改写成未知的持久化决定。清理或 rollback 尚未完成时，不提前进入 failed、rolledBack、cancelled 或 completed；保留相应执行态或 blocked，并记录原始失败。

主要流转：`prepared → applying → synchronizing → cleaning → completed`。更新失败可转入 `rollingBack → cleaning → rolledBack`。可恢复步骤受阻进入 blocked，解除后回到记录的 resumePhase。未发布候选失败先清理，再进入 failed。状态转换与 revision 一起校验，不能由客户端直接设置。

### 3.2 后置条件

| 操作 | completed/终态必须满足的条件                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装 | 新 installation 已发布；generation 完整；对应启用方式的同步检查通过；本次 staging/临时资源不存在                                             |
| 更新 | installation 未变化；B 是已验收 active；A 无运行引用且旧包清除；staging 清除；数据与设置保留                                                 |
| 卸载 | 无 active installation；无相关执行进程和受管子进程；托管注册/token 撤销；包、数据、缓存、设置、secret、staging、trash 清除；资源清单复核通过 |
| 回滚 | A 指针和运行/禁用状态恢复并验证；B 已停止且失败部署清除；原错误仍可查询                                                                      |

禁用或按需激活的扩展只验收静态部署、宿主代理协议和已声明注册可用性，不为预览或 readiness 偷偷调用 activate。其首次真实激活属于单独的运行健康状态，不能声称安装时已验证扩展业务。启用扩展的 readiness 必须覆盖真实 activate 和必要注册，且在业务准入前完成。

### 3.3 错误与重试

错误至少携带 `code`、`phase`、`operationId`、资源类别、`retryable`、建议动作和受限诊断引用。区分 conflict、artifactInvalid、runtimeExitUnproven、runtimeReadinessFailed、rollbackFailed、resourceBusy、permissionDenied、ownershipUncertain、storeUnreadable 等稳定类别，不以字符串解析决定恢复。

协调器负责恢复决策；supervisor 负责停止及退出证明；executor 负责删除重试；入口负责本地化展示。后台出错也必须持久化并可见。客户端刷新失败是独立展示错误，不改变已确认的服务端结果。

重试复用 operationId 和步骤幂等键。配置化退避与并发上限；永久错误不自动无限热循环，进入 blocked。启动必扫描非终态操作，执行器持续调度到终态或明确 blocked，不依赖 registry observer 恰好触发。prepared 的有效期只能使候选过期，不能作为进程死亡或删除锁的证据。

## 4. 分阶段实施

下述工作量仅用于拆分：S 约 1–3 人日，M 约 4–7 人日，L 约 8–15 人日；包含阶段内测试，不是交付承诺。跨平台原型、前端执行模型和旧宿主识别验证后再估总工期，不用简单相加替代排期。

### 阶段 0：冻结契约、资源清单与失败测试（M）

**依赖：** 无。**目标：** 在实现前确定清理对象、可兑现的保证和不可绕过的门槛。

- [x] P0.1 逐项盘点 `schema.ts`、`paths.ts`、`data.ts`、`registry.ts`、`runtime.ts` 和前端 scope：包、import cache、数据、缓存、设置/secret、staging、trash、lease、日志、注册项、进程及项目级实例；清单见[阶段 0 记录](./lifecycle-foundation.md#2-资源归属清单)。
- [ ] P0.2 每类资源写明创建者、归属键、位置、所有使用者、撤销方法、删除权限和最终验证方式；尤其记录目前全局 data/cache 按 extension ID 命名而非 registry 隔离的情况。
- [ ] P0.3 固定身份类型、状态转换、存储原子提交方案、幂等语义、预览授权和版本升级规则；以状态转换表与持久化样例形成实现输入。品牌身份及实验性准入快照已实现，完整 registry/operation schema 和 durable 提交尚缺，见[执行实例记录](./lifecycle-supervisor.md)。
- [ ] P0.4 决定前端保证：本次保证托管 UI/注册/token 撤销；若产品要求任意前端 JS 物理停止，必须增加可销毁 realm 的实施阶段，并在交付前完成，不得靠清 scope 声称消灭任意 timer。
- [ ] P0.5 建立真实进程测试夹具：常驻 timer、挂起 RPC、迟到注册、dispose 抛错/超时、子进程和孙进程、忽略停止信号、父宿主突然死亡。
- [ ] P0.6 建立当前实现会失败的后置条件测试：同进程卸载清理、跨来源干净重装、明确 conflict 保留原因、重启继续 trash、更新失败恢复 A。
- [ ] P0.7 形成平台能力表：Node/Electron/Bun 的启动、IPC、锁、退出等待、进程树约束、Windows 文件占用；缺一项即记录阻塞，不设 unsupported 成功分支。

**产物：** 资源清单、版本化协议草案、状态图、失败测试和平台原型任务。**退出门槛：** 每类托管资源均有归属与验收手段，存储和前端保证没有未注明的关键空缺。

### 阶段 1：跨平台监督、退出证明与变更所有权（L，高风险）

**依赖：** 阶段 0。先做最小执行进程，不迁移完整扩展 API。

- [ ] P1.1 为每个后端 installation/generation 建立独立执行进程；同一进程可包含该扩展的多个项目实例，但不能混入其他扩展，防止停止一个扩展影响全部 sidecar。
- [ ] P1.2 定义 supervisor 控制协议：hello/能力协商、runtime 身份、ready、drain、dispose、exit。控制通道不能被普通 RPC 的排队完全阻塞；无法响应时仍可外部终止。内部 JSON 版本/fence/准入及控制协议已实现并在真实 Node/Bun/Electron 验证；正式能力协商和 API 代理尚缺。
- [ ] P1.3 实现停止顺序：关闭新调用准入 → 取消/有界排空 → dispose → 等待进程退出 → 超时升级终止整个受管进程树 → 确认退出 → 释放运行引用。单根进程流程和引用保持到 OS 退出已覆盖；全部子孙进程证明未完成，返回值固定标明 tree=unproven。
- [ ] P1.4 在 macOS/Linux 验证进程组、子进程登记、父进程崩溃及重挂接；在 Windows 验证 Job Object 或等价可证明机制。进程组本身不等于任意脱离进程的回收能力；无法约束的托管启动方式必须拒绝或显式阻塞，不能忽略。
- [ ] P1.5 定义扩展启动子进程的受管 API 和归属登记；适配现有 shell/child_process 用法。可信扩展私自脱管造成的外部副作用明确不在保证内，不把任意 PID 扫描当受管证明。
- [ ] P1.6 实现 Node/Electron 与 Bun 共用的互斥/运行引用协议，优先评估维护中的跨平台实现；验证 native 打包与 ABI。OS 持有的锁或监督句柄在进程死亡后可恢复，不依赖心跳 TTL。macOS 描述符提供者和实际 utility 验证已加入，Linux/Windows 与发行打包仍阻塞，见[所有权记录](./lifecycle-ownership.md)。
- [ ] P1.7 所有权接管结合 store 身份、owner 身份、epoch 和 OS 证明；抵抗 PID 复用与旧 owner 迟到写入。清理 executor 也使用可接管的同类所有权机制，不再使用永久 mkdir claim。
- [ ] P1.8 确定多宿主策略：变更前协调所有登记的读取者停止；无法访问的活跃读取者阻塞变更。不能只证明当前 sidecar 的子进程退出就删除共享 generation。

**改动范围：** 新 supervisor/process/ownership 模块，`leases.ts` 的替代实现，desktop sidecar 打包入口和平台测试。

**退出门槛：** 实际 Electron Node 与 Bun 均通过退出/崩溃/并发夹具；所支持操作系统有实际锁与进程树证据。不满足时停止后续生产切换，不回退到永久 pin 或 unsupported。

### 阶段 2：完整扩展 API 的跨进程代理（L，高风险）

**依赖：** 阶段 1。**目标：** 扩展代码不再 import 进长期宿主，且不是只让 WLS RPC 工作。

- [ ] P2.1 逐项列出 `extension-kit/src/server.ts`、`plugin/src/index.ts`、`plugin/src/tool.ts` 的协议映射：activate/service、项目级 server、Hooks、tool、auth/provider、workspace adapter、事件、settings、日志、SDK client 与 shell。
- [ ] P2.2 为函数、回调、流、URL、schema、取消信号定义显式编码；函数使用受作用域约束的 handle，tool schema 使用可校验的序列化描述。不得直接 structuredClone `PluginInput`、Hooks 或 BunShell。
- [ ] P2.3 明确 Hooks 的原地修改/返回语义：请求输出在子进程编码返回，宿主按原约定应用；不能只发送输入副本而丢掉 hooks 修改。
- [ ] P2.4 分离 process-level activate 与 directory/worktree 级 server，定义实例创建/销毁、service 共享和项目关闭行为；某项目销毁不能提前释放其他项目使用的进程资源。
- [ ] P2.5 所有请求/事件带完整运行身份、requestId 与 epoch；实现取消转发、断连传播、流式背压、消息大小限制和迟到响应拒绝。RPC 断开不得自动重放有副作用的工具调用。
- [ ] P2.6 宿主服务通过代理暴露；注册返回可撤销句柄并归属于运行实例。认证回调、workspace adapter 与 settings listener 同样需要生命周期管理，不能遗漏嵌套函数。
- [ ] P2.7 将现有扩展/API 声明逐项标为直接兼容、代理兼容或需作者升级；不支持的能力在安装验证或激活前明确拒绝，不静默降级至 in-process importer。
- [ ] P2.8 用 hello-viewer、WLS、mathematica-notebook 及合成全能力扩展验证代理；更新 author kit、模板和兼容文档。需要破坏性 API 变更时统一升级最低宿主/协议版本。

**改动范围：** `runtime.ts`、`extension-kit`、Plugin/ToolRegistry 的扩展适配、RPC handler、扩展样例和模板。

**退出门槛：** API 能力清单全部有实现或明确版本拒绝；真实 WLS 求值经过独立执行进程；宿主无扩展模块永久引用；停止后旧 RPC、事件和回调无法写入新 generation。

### 阶段 3：DeploymentStore、durable operation 与恢复执行器（L）

**依赖：** 阶段 0 的存储决定、阶段 1 的所有权接口。可与阶段 2 部分并行。

- [ ] P3.1 引入 installation/generation/operation/resource 的持久化模型和严格解码；新版本只能由新写入器修改，旧版本拒写，未知版本明确报错。
- [ ] P3.2 原子提交 active 指针与 operation 决定，绑定 expected revision、候选摘要、授权主体和 operation token；同 operation 重试只能继续原决定。
- [ ] P3.3 prepare 候选可恢复或明确过期，并绑定摘要/manifest/权限/确认内容；令牌只存验证材料，不在普通日志输出。候选过期清理也交给持久化 executor。
- [ ] P3.4 status、commit、启动恢复、后台重试统一读取 operation；内存仅缓存 revision，不保留能独立宣告终态的 result。
- [ ] P3.5 清理步骤采用 `planned → quarantined → deleted → verified`；支持源已移走但回执未落盘、部分删除、目标已不存在、重启接管、跨文件系统根分别执行。
- [ ] P3.6 清理前核验清单与归属：路径不越界，不跟随 symlink，检查目录替换和身份不匹配。归属不确定进入 blocked，不能把异常统一当不存在。
- [ ] P3.7 设置/secret 删除使用所属存储的精确键并验证，失败仍阻塞卸载。journal、错误和审计历史不得复制设置值、secret、带凭据 URL 或完整令牌。
- [ ] P3.8 实现启动扫描、可中断后台队列、持久化 nextAttempt 和用户重试；区分可自动重试与需人工解除的错误。执行器退出后不得留下不可接管 claim。
- [ ] P3.9 回执默认同时受“最多 30 天、最多 1000 条终态”限制，以先触及者清理；作为明确配置与测试策略。非终态任务不被历史配额删除。卸载终态只保留不含敏感数据的最小回执，不保留影响未来身份的 tombstone。

**退出门槛：** 对每个持久化/rename/delete 前后注入异常及杀进程，重启后无丢失任务、无误删、无伪终态；多进程竞争只能一个 owner 推进，旧 owner 写入被拒绝。

### 阶段 4：统一安装、更新、卸载协调器（L）

**依赖：** 阶段 2、3。**目标：** 用同一状态机替换 `install.ts` 与 `install-service.ts` 的分散编排。

#### 安装

- [ ] P4.1 实现 `resolve → verify → validate → prepared`；不运行扩展、不改变旧 active，保留现有下载/解压安全校验。
- [ ] P4.2 确认后取得所有权，重新检查 revision 和卸载任务；旧 uninstall 未终结时推进或展示阻塞，不能新建同 ID 实例绕过它。
- [ ] P4.3 创建新 installation 与不可变 generation、干净命名空间；发布后同步运行/注册，再清 staging 并验证。发布后激活失败必须明确撤销新安装并清理，或停留可见失败恢复态，不留下“失败但其实已启用”的半安装。

#### 更新

- [ ] P4.4 在 A 可服务时准备 B；候选失败只清 B。确认后 fence A、撤销准入、停止所有 A 使用者并证明退出，再切换 B。
- [ ] P4.5 B 在关闭业务准入的状态完成 readiness；确认前保留 A 包和恢复材料。成功后持久化接受 B 的决定，再开放 B、回收 A，最终完成。
- [ ] P4.6 readiness 失败先持久化 rollback 决定，停止 B，恢复 A 指针和运行/禁用状态并验证；rollback 自身失败进入 blocked，显示 A/B 实际状态和恢复动作。
- [ ] P4.7 在任意 stop/switch/ready/accept/rollback 边界重启，按最后 durable decision 继续，不靠“看到 B 文件存在”猜是否成功。接受 B 之后的清理故障只继续清理，不回滚已对外服务的业务副作用。
- [ ] P4.8 本次不支持破坏性数据迁移；要求 B 在首次 activate/readiness 和 rollback 窗口对共享数据保持向后兼容。无法声明兼容则拒绝自动更新；后续备份/迁移协议单独设计，不能假装恢复指针就恢复了数据。

#### 卸载

- [ ] P4.9 先持久化卸载 intent 和资源快照，再撤销 frontend/API 准入，停止并验证所有运行使用者，detach installation，然后逐项 quarantine/删除。
- [ ] P4.10 删除 generations、import cache、data/cache、settings/secrets、staging、trash、临时元数据；验证托管注册/token 已撤销，最后复核资源清单，删除恢复任务并产生最小终态回执。
- [ ] P4.11 开发链接只删除链接登记及宿主资源；真实源目录不进删除清单。并发卸载、重复请求和响应丢失均返回同 operation 的现实状态。
- [ ] P4.12 重装只在旧卸载验证完成后允许；同来源与 archive/release/npm 跨来源均产生干净 installation，不读取 retained。

**退出门槛：** 三条流程通过实际独立进程和真实文件系统集成测试；将旧“更新后旧 server.js 仍存在”的断言移至明确的 cleaning/blocked 用例，完成态必须断言旧资源不存在。

### 阶段 5：旧 registry、retained、租约与遗留垃圾迁移（L，高风险）

**依赖：** 阶段 3、4。迁移代码可提前开发，但不能在新协调器不完整时写入真实状态。

- [ ] P5.1 提供只读 dry-run，列出 active、retained、generation、数据/缓存、`.unsupported`、`.gate`、trash/claim 和归属冲突，给出逐项迁移决定及阻塞原因。
- [ ] P5.2 建立旧宿主停用屏障：识别共享数据根的旧实例，协调其正常退出；不能仅凭 registry 升版、用户勾选确认或 PID 文件宣称旧代码已停止。
- [ ] P5.3 无可靠身份的 `.unsupported`、旧 gate 和 orphan claim 不直接删除。若无法证明相关使用者退出，保持 blocked 并给出精确操作说明；必要时要求受控全宿主停机/系统重启后，在新启动屏障下接管。不得误杀安装版 OpenCode。
- [ ] P5.4 active 旧安装映射为新 installation，旧部署映射 generation；搬迁现存 data/cache/settings 保留内容和 secret 分类。迁移过程本身有 journal，可在中途退出后继续。
- [ ] P5.5 retained 不成为新安装继承权，而成为显式旧卸载清理任务。升级前展示破坏性清理清单并取得授权；未授权则阻塞迁移，不以“升级”名义静默删除以前承诺保留的数据。
- [ ] P5.6 多 registry 共用 extension ID 数据时先对账所有 owner；冲突不能随意分给一个 installation，更不能由一个 registry 删除另一个正在使用的数据。
- [ ] P5.7 各数据根的迁移与存储格式提交按 durable 步骤恢复；新格式启用后不自动降级。迁移备份按敏感信息管理，禁止日志输出，明确保留/销毁策略；卸载完成不得因无限期备份仍保留该 installation 的设置和 secret。
- [ ] P5.8 使用脱敏真实遗留布局夹具覆盖 archive retained → release 重装、purged tombstone、半完成 trash、损坏归属及混合宿主。禁止用手动删锁后的结果作为迁移通过证据。

**退出门槛：** 可恢复迁移、明确破坏性授权、旧宿主占用阻塞和不误删均有自动化证据；实际应用数据迁移前完成 dry-run 审阅。停止或回滚代码发布不能让旧程序重写新格式。

### 阶段 6：前端撤销与全部入口收敛（M–L）

**依赖：** 阶段 4 的协议，生产启用还依赖阶段 5。

- [ ] P6.1 HTTP、CLI、Desktop IPC、目录/归档/发布安装统一调用 ExtensionLifecycle；Desktop 下载只负责传输和暂存，服务器继续验证冻结候选。
- [ ] P6.2 更新 `install-schema.ts`、HTTP API group/handler、OpenAPI、SDK 生成物和实际存在的其他语言消费者；删除 purgeData 可选语义，旧客户端明确拒绝或协议升级，不能静默忽略 `purgeData=false`。
- [ ] P6.3 对话框与扩展卡片展示完整阶段：已部署但同步中、清理中、阻塞、回滚及恢复失败。明确 rejected 保留 code，unknown 只用于结果不可读；提供原 operation 的查询/重试入口。
- [ ] P6.4 commit 成功但列表刷新失败显示“已安装，界面刷新失败”；卸载 cleanup 未完成时不显示“已卸载”。CLI JSON、退出码与人类可读输出遵守同一终态规则，约定等待/超时/查询模式。
- [ ] P6.5 scope 覆盖 viewer、工具渲染器、panel、命令、事件、style、挂起加载和订阅；每项有 disposer。切换先撤销 generation token，异步结果到达时检查身份，不能复活旧 UI。
- [ ] P6.6 前端连接按 server/store 身份隔离 operation 和 token；A → B → A 切换不把 A 响应应用到 B。断连不自动对另一服务器重发 commit。
- [ ] P6.7 定义连接中、断连中、离线客户端的撤销行为：服务端永久拒绝已撤销 token，重连先对账；无法确认某客户端卸载托管资源时不伪造 ack。远端不能证明离线同 realm 任意 JS 已停止，保证与限制必须在 API 和产品文档一致。
- [ ] P6.8 更新所有现有 locale、作者文档与兼容说明；真实开发 Electron CDP 9222 验证，不以 fixture 界面替代实际安装链。

**退出门槛：** UI/CLI/HTTP/IPC 对同 operation 的阶段与错误一致；迟到响应不能重新注册；展示后置条件与磁盘/进程检查一致。如果阶段 0 要求物理终止任意前端 JS，可销毁执行上下文必须在本阶段前交付，否则不得宣称满足该保证。

### 阶段 7：删除旧机制、集成验收与切换（M–L）

**依赖：** 阶段 1–6 全部通过门槛。**目标：** 不保留两个生产生命周期系统。

- [ ] P7.1 删除默认 retained、来源继承审批、永久 generation/data pin、unsupported 租约退化分支、不可接管 gate/claim、只 deferred 的 trash 恢复和内存 result/receipt 双重状态。
- [ ] P7.2 保留旧格式只读识别与迁移，不保留旧写入路径；移除旧 purge 开关、客户端私有清理/重装协议及被替代测试。保留仍有价值的下载、解压、路径归属和来源授权测试。
- [ ] P7.3 跑下节验收矩阵，并对每项终态自动核查资源清单、进程树、设置/secret 和注册项，不仅核查 JSON state。
- [ ] P7.4 在隔离数据根连续执行 20 次 install/update/uninstall，包、数据、缓存、trash、托管进程和句柄不增长；审计回执数量符合策略。
- [ ] P7.5 用实际 WLS 完成安装、求值、更新期间持续求值、失败回滚、卸载运行中 kernel、同来源/跨来源重装；记录真实 RPC、版本、PID 与删除前后资源差异。
- [ ] P7.6 真实 Electron 走 CDP 9222，Bun CLI/server 与远程管理入口分别执行；支持的 macOS/Linux/Windows 分别提供证据。只完成本机时保持其他平台为阻塞，不外推。
- [ ] P7.7 更新发布/升级说明和验收记录，分列已运行、未运行与受阻项目。生产切换要么启用完整新协调器，要么继续标记旧能力，不向用户发布伪清理成功。

**退出门槛：** 所有必需平台与后置条件有当前代码证据，旧写入器不可达；无无法解释的资源残留。只有到此才能标注“生命周期重构交付”。

## 5. 依赖、并行与 PR 切分

```text
阶段 0 契约/失败测试
  ├─ 阶段 1 监督与所有权 ── 阶段 2 完整 API 代理 ─┐
  └─ 阶段 3 Store/清理（接阶段 1 所有权接口）───────┤
                                                  ↓
                                         阶段 4 协调器
                                           ├─ 阶段 5 迁移
                                           └─ 阶段 6 入口/UI
                                                  ↓
                                         阶段 7 删除与验收
```

建议按以下可审阅单元拆 PR，而不是一次改全仓：

1. 契约、资源清单、黑盒失败测试与平台原型。
2. 跨平台 ownership/进程树监督及打包验证。
3. 执行协议与 host-service 代理。
4. 完整 Hooks/tool/auth/workspace 代理及扩展迁移。
5. Store/schema/operation journal 与原子提交。
6. 清理 executor、调度与崩溃恢复。
7. 安装/更新编排及 rollback。
8. 卸载/干净重装与终态验证。
9. 旧状态 dry-run、停机屏障与可恢复迁移。
10. HTTP/SDK/CLI/Desktop 入口收敛及前端撤销、状态展示。
11. 删除旧机制、真实平台和 WLS 验收。

并行组可以是监督/协议、Store/清理、客户端/协议夹具；同一 schema、状态机与持久化写入只有一个负责人整合。每个 PR 必须包含对应测试和文档；未连通的基础设施只在隔离测试中使用，不创建会污染真实 registry 的半成品模式。

## 6. 验收设计与故障注入矩阵

### 6.1 测试分层

| 层级         | 验证内容                                            | 不能替代的内容                  |
| ------------ | --------------------------------------------------- | ------------------------------- |
| 单元/模型    | 状态转换、身份、CAS、权限、错误类别、回执限额       | 真实进程退出、文件锁与 Electron |
| 文件系统集成 | materialize/quarantine/delete、归属、权限、跨盘处理 | 跨平台 OS 占用语义              |
| 多进程集成   | owner 接管、读者退出、进程树、并发、SIGKILL 恢复    | 实际打包运行时与 GUI            |
| API/SDK 契约 | token、幂等、明确拒绝、丢响应后查询、多服务器       | 业务求值及可见 UI 撤销          |
| 前端契约     | scope、迟到响应、状态文案、连接切换                 | 真实 Electron 安装与卸载        |
| 真实形态     | Electron Node、Bun、远程入口、WLS 与磁盘/进程核验   | 其他未执行平台                  |

### 6.2 必须覆盖的失败点

- 候选：断网、摘要不符、非法 manifest、解压失败、空间不足、权限变化；A 始终可用。
- 运行：activate/dispose 抛错或挂起、RPC 在切换时完成、子孙进程不退出、父宿主死亡、控制通道无响应。
- 更新：stop A、switch B、B ready、接受 B 决定、恢复 A 的前后杀进程；每条路径恢复到唯一 durable decision。
- 删除：rename 前后、已删除一半、资源已不存在、归属被替换、Windows 文件占用、另一个宿主持有引用。
- 状态：commit 响应丢失但提交成功、明确 rejected、store 读取失败、刷新失败、客户端退出、prepared 过期清理。
- 迁移：旧 retained、purged tombstone、`.unsupported`、`.gate`、trash claim、共享全局数据、损坏记录、旧进程仍存活。
- 前端：卸载时 viewer 打开、样式已加载、工具正在渲染、事件排队、迟到 import、断连后重连、A → B → A。
- 并发：两个客户端/两个宿主同时安装、更新、卸载同一扩展；旧 owner 恢复执行；PID 复用；不同扩展不相互误停。

故障注入必须对每个副作用边界建立用例表，至少覆盖“intent 已落盘、副作用未执行”和“副作用已执行、结果未落盘”；不能只在函数入口 throw。进程测试用握手/屏障对齐注入点，不靠固定 sleep 推断完成。

### 6.3 证据格式

每次验收保存代码 revision、OS/运行时/应用形态、隔离数据根、operation/installation/generation/runtime 身份、注入点、终态、资源核查结果与脱敏日志路径。成功截图只能作为展示证据；清理证据必须包含资源与进程检查。失败要能定位阻塞步骤并在重启后继续。

实施时从工作区包目录执行定向测试，不运行根目录 `bun test`。测试选择示例为 opencode 的 extension/server 契约测试、extension-kit 协议测试、app 的 extensions 单元与 browser-condition 测试，加各自 typecheck；新增用例路径和平台 runner 随实现确定。真实 Electron 只操作开发实例，启动前检查现有实例，不关闭安装版应用。本方案编写不构成这些测试已运行。

## 7. 风险与停止条件

| 风险                             | 必须先取得的证据                     | 不允许的捷径                    |
| -------------------------------- | ------------------------------------ | ------------------------------- |
| Node/Electron 无可用运行引用证明 | 实际打包运行时锁/退出/崩溃接管通过   | 保留 unsupported 但显示卸载成功 |
| 旧 API 不可直接序列化            | 全量能力映射及代理行为测试           | 仅适配 WLS，其他偷偷同进程加载  |
| 任意子进程脱离管理               | 受管启动 API、平台约束与保证范围     | 按名称/PID 扫描杀进程           |
| 多宿主使用共享 data/cache        | 全部 owner 对账与停止协议            | 只停当前 sidecar 就删除全局目录 |
| B 修改数据后无法回滚             | 向后兼容声明或未来独立迁移协议       | 以恢复 A 指针声称数据已恢复     |
| 旧租约无法识别使用者             | 可证明停机/受控接管，或明确 blocked  | 超时删锁、清空所有证明文件      |
| 同 realm 前端代码无法物理停止    | 收窄至托管撤销，或实现隔离执行上下文 | dispose 返回即宣称所有 JS 消失  |
| 新格式上线后代码回退             | 旧版明确拒读/拒写与发布恢复预案      | 自动降级并让旧写入器接管        |

阶段 1、2、5 是主要不确定项。任一项无法达到保证时，回到契约和架构调整，不在安装层增加来源特例或隐藏残留。

## 8. 当前执行状态与下一步

阶段 0 已加入资源清单、API transfer 矩阵、目标契约测试以及品牌身份/准入模型；存储沿用单一原子 registry 快照。阶段 1 的[描述符提供者](./lifecycle-ownership.md)与[单执行根监督](./lifecycle-supervisor.md)已在 macOS Node/Bun/Electron 验证，包括真实收发、取消、启动/停止失败、外部终止和引用保持。模块未接入安装器，未迁移用户数据、未执行 WLS 重构验收。

下一步实现 durable admission/owner/operation 提交与崩溃恢复，将当前纯状态转换接入 Store；补齐 supervisor 死亡后的执行实例接管、完整受管进程树、多宿主协调、Linux/Windows 和原生依赖交付。已有根退出和 JSON 往返证据不能替代这些门槛，前置条件未通过前不推进真实资源清理。
