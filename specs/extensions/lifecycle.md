# 扩展生命周期：现状说明

状态：现行语义汇总（2026-11-13）。由原 `lifecycle-rebuild.md`（事实审计）、`lifecycle-rebuild-plan.md`（实施计划）、`lifecycle-foundation.md`（阶段 0 执行记录）、`lifecycle-ownership.md`（阶段 1 执行记录）四份文档合并整理，原文移至 `archive/`。T5.x 进程隔离的设计基础 `lifecycle-supervisor.md` 仍独立保留，不在合并范围。

本文描述**生产代码当前行为**与已确认的改造方向，不重复历史执行证据。生产实现：`packages/opencode/src/extension/`（`runtime/{index,slot,process,timers,hooks,module-cache}.ts`、`leases.ts`、`registry.ts`、`install.ts`、`install-service.ts`、`cleanup.ts`、`data.ts`）；前端：`packages/app/src/extensions/`。现行 slot/timeout/retry/timer 语义的落地过程见 `isolation-hardening-delivery.md`。

## 1. 后端运行时状态机（现行）

每个扩展一个 slot（`runtime/slot.ts` 的 `SlotStore`），承载 `Entry`（加载好的模块与服务）与以下正交事实：

### 1.1 generation / epoch / fence / quiesce / blocked

- **`generation`**：每扩展单调递增的代次。`invalidate`（注册表变化）、`mutation.begin`、`quiesce.begin` 都会递增；加载与激活路径在各关键点核对 `generationOf(id) === gen`，迟到的 import/activate/settings 回写不能复活旧代 entry。
- **`epoch`**：在 `mutation.begin` 与 `quiesce.begin` 时递增，供 hooks、timer、托管进程等作用域识别所属代次并丢弃迟到回调。
- **`fenced`**：安装/更新/卸载等安装器变更持有。`gated(id) = fenced || quiescing || blocked`，gated 期间拒绝新加载；fence 由安装器持有，quiesce 不会抢占（`slot.ts` 顶部注释：两类事实刻意正交）。
- **`quiescing`**：严格清理进行中。`quiesce()`（卸载/更新/重装用）丢弃 entry、abort 在途请求、dispose 进程级 service，并把 `pending` 集合排干至空闲——pending 结算时可能产生新 pending，循环等待而非只等快照。
- **`blocked`**：quiesce 超时、dispose 失败或 hooks 未回收时置位，**永不自动清除**（fence 释放也不清）→ 对外表现为 `Info.needsRestart: true`（`schema.ts`）；`POST /global/extension/:id/retry` 只重试非 blocked 错误。
- **`phaseOf`** 优先级：`blocked` → `quiescing` → `mutating`（fenced）→ `entry.status`（loading/ready/error）→ `idle`。
- **错误相位**：`import | activate | dispose | quiesce | server | timeout | timer | tool`；`server/timer/tool` 记入 `transientError` 作非粘性诊断，不阻止后续实例重试，`server` 相位在实例就绪后清除。

### 1.2 超时、限流与托管子进程

- **超时**（隔离加固 A1）：`activate()`、`server()` 各默认 10s 截止，`testing` 可覆写。`activate` 超时使 entry 进入 error 并 `invalidate`，迟到的 resolve 由 generation 检查兜住；`server` 超时只使该次调用过期，不推进全局 generation。
- **限流**（T2.6）：每扩展 RPC 并发上限 32，超限直接 `ExtensionRpcError("busy")` 不排队；`host.emit` 按扩展令牌桶（200 条/s、突发 400），溢出丢弃并按 1s 窗口聚合 warn。均经 `testing.setLimits` 可调。
- **托管子进程**（T2.5）：`host.spawn` 由 `runtime/process.ts` 实现（`node:child_process`，Bun/Node 一致）：POSIX 独立进程组 `detached` + `kill(-pid)` 整组，Windows `taskkill /T`；停止走 SIGTERM → 3s 宽限（可调）→ SIGKILL → **等待真实 exit 事件**，超时不算退出。`Entry.processKills` 在 disable/reload/quiesce/disposeAll 时排干。
- **托管 timer**（`timers.ts`）：`host.setTimeout/setInterval` 返回可撤销句柄，按进程级 activation 与每个 `server()` 实例归属；timer 抛错被归因并停掉该 timer。原生 `uncaughtException` 仍是 sidecar 级 fatal，仅有尽力归因，不构成进程隔离。

## 2. 运行引用与租约（`leases.ts`）

- **三个命名空间**：`generation`（`<registry>/ref/<installId>/`，按部署）、`operation`（`operation-ref/<operationId>/`，按事务）、`data`（`<Global.Path.data>/extensions/data-ref/<extensionId>/`，**跨 registry 全局共享**，import 前先取得）。
- **存活证明**：仅 Bun + darwin/linux 经 `bun:ffi` 使用 BSD flock；Node/Electron/Windows/FFI 不可用时写 `.unsupported` 持久标记，`inspect` 一律返回 busy（fail-closed）。永不靠 mtime/PID/TTL 推断进程死亡，`.unsupported` 不可删除后当作死亡证明。
- **`.gate`**：mkdir 互斥门，崩溃遗留不自动回收；`unlockStaleGates` 是显式用户确认的恢复路径（minAge + 目录身份核验 + 原子 rename tombstone）。
- **进程级 pin**（`runtime/index.ts`）：`generationPins`/`dataPins` 因已导入代码可能残留 timer/闭包，持有至**进程退出**而非 quiesce 成功；`canReleasePins()` 要求全部 slot 无 pending/requests/hooks/failedDisposal。因此现状仍是：dispose 成功 ≠ 所有代码停止 ≠ 数据引用已释放。

## 3. 注册表与 retained（`registry.ts` / `install.ts`）

- **卸载默认保留**：`purgeData` 默认 false，`commitRemoval` 移除 active row 并建立 `retained[id]`，保留设置、secretKeys 与数据/缓存目录。
- **retained 参与新安装身份校验**：`purging` 中拒绝 link/install；来源身份不一致拒绝数据继承（`sourceIdentity` 精确比对，archive 来源以 sha256 判同字节）——即"卸载历史会影响重装"的现行语义，也是 `archive/lifecycle-rebuild.md` §2.1 记录的 archive→release 重装被拒根因。
- **purge 流程**：`withPurge` 先持久化 `purging=true` + `purgeRevision` 再动文件，删除数据/设置/secretKeys 后置 `purgedAt` tombstone；trash 未清完保持 `purging` 作 fence，`finishPurge` 收口并标记回执 `purgeCompleted`。
- **目标契约（未达成）**：installation/generation/operation 身份分离、卸载默认清除、可恢复的幂等清理执行器——见 `archive/lifecycle-rebuild.md` §3；`lifecycle-target.test.ts` 五个红灯用例仍以 `OPENCODE_EXTENSION_LIFECYCLE_TARGET=1` 显式启用追踪缺口，不计为通过。

## 4. 前端激活生命周期（`packages/app/src/extensions/`）

- `activation.ts`：每扩展 `generation`/`epochs` 计数，激活以 generation 判 valid；`dispose` 撤销 subscriptions、styles、`rootDispose`；激活失败回滚已注入样式并推进代次。
- manifest 到达即注册贡献点 placeholder（隐式激活入口），真实注册在 `activate(ctx)` 后替换；停用撤销全部注册项、样式与挂起加载，面板状态按扩展/tab evict（T1.5）。
- 安全模式：`?extensions=off` 显式开关 + 连续页面级崩溃计数自动进入（T2.7，`extension.safeMode.crashes.v1` 经 `window.api.storeGet/storeSet` 持久化）；`OPENCODE_DISABLE_EXTENSIONS=1` / `--pure` 全局禁用。
- **保留限制**：同 realm ESM 不可卸载，任意扩展 JS/timer 的物理停止不在保证内——如需该保证必须另做可销毁执行上下文（审计 §3.3 结论，仍成立）。

## 5. T5.x 进程隔离（设计已确认，未实施）

依据 `process-isolation-design.md`（T5.0，2026-11-13 已确认，§12 全部按推荐采纳）与原型设计基础 `lifecycle-supervisor.md`：

- **进程模型**（D7）：每扩展一个宿主进程，按需启动；隐藏入口 `opencode extension-host <id>`（argv 拦截，不过 yargs middleware）；fd3/fd4 JSON 帧协议，stdout/stderr 只作日志。
- **生命周期映射**：现行 generation/epoch/fence 对应"进程实例 + 协议 epoch"；dispose 的含义是 drain → dispose → **观察到 OS 退出**，不以超时作退出依据；退出未观察到返回 `unknown` 并保留 transport。
- **崩溃策略**：异常退出 → `error` 状态 + 指数退避自动重启（1s/5s/30s，最多 3 次），之后保持 `error` 等手动 retry；在途 RPC/工具调用返回 `extension_crashed`。
- **隔离字段**（D8）：manifest `server.isolation: "process" | "inline"`，过渡期默认 `inline`；T5.8 后新安装默认 `process`，`inline` 仅允许本地 `path` 来源的开发调试。
- **进程树**：worker 以独立进程组启动，复用 T2.5 `signalGroup` TERM→宽限→KILL；宿主崩溃时 fd3 EOF 触发 worker 自退（孤儿兜底），不依赖 PID 扫描。
- **原型现状**：`specs/extensions/prototypes/`（admission/execution/ownership 协议与真实 Node/Bun/Electron 进程测试，当前验证记录见其 README），**未接入生产**；`lifecycle-supervisor.md` 仍是 T5.1–T5.3 的设计输入。

## 6. 历史文档索引

| 文档 | 内容 | 位置 |
|---|---|---|
| 事实审计与目标契约 | 2026-11 安装失败链路、retained/lease/双重状态问题清单，installation/generation/operation 目标身份模型与验收矩阵 | `archive/lifecycle-rebuild.md` |
| 重构实施计划 | 阶段 0–7 任务拆分、退出门槛、故障注入矩阵 | `archive/lifecycle-rebuild-plan.md` |
| 阶段 0 执行记录 | 资源归属清单、跨进程 API 矩阵、目标红灯测试 | `archive/lifecycle-foundation.md` |
| 阶段 1 执行记录 | 描述符所有权提供者、平台锁适配、Electron 探针 | `archive/lifecycle-ownership.md` |
| 执行实例与准入模型 | 原型 AdmissionSnapshot / 控制协议 / 单执行根 supervisor（T5.x 设计基础，**现行有效**） | `lifecycle-supervisor.md` |
| 隔离加固交付 | 现行 slot/timeout/retry/timer 语义的实施与验证记录 | `isolation-hardening-delivery.md` |
| 原型现状 | 独立原型测试记录与已知边界 | `prototypes/README.md` |
