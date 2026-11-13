# Server 扩展进程隔离设计（T5.0 设计确认）

状态：**已确认**（2026-11-13，§12 全部按推荐采纳）。依据 `remediation-plan.md` Phase 5（T5.0–T5.8）与决策记录 D7（一扩展一进程）、D8（inline 仅本地调试）、D3（权限词表 + 粗粒度执行）。
本文只回答设计问题，不含实现代码；协议消息给出类型骨架。确认后才进入 T5.1。

原型：`specs/extensions/prototypes/src/extension/execution-{protocol,process,process-bun,supervisor,worker}.ts`，设计基础 `lifecycle-supervisor.md`。
生产现状：`packages/opencode/src/extension/runtime/index.ts`（slot/entry/gen/epoch/quiesce）+ `runtime/process.ts`（T2.5 进程组托管）+ `runtime/timers.ts`、`runtime/hooks.ts`。

---

## 1. 进程模型（D7）

### 1.1 拓扑

```
sidecar (bun 编译二进制 | Electron utilityProcess | bun run src/index.ts)
   │  child_process.spawn，stdio = [ignore, pipe, pipe, pipe, pipe]
   │  fd3 = host→worker 命令，fd4 = worker→host 事件，stdout/stderr = 日志
   └─► extension-host 进程 ×N（每个启用且 isolation=process 的扩展各一）
```

- **一扩展一宿主进程，按需启动**：worker 随 `ensureEntry` 创建，与 `Entry` 一一对应；`Entry` 被 drop（disable/reload/quiesce/uninstall/update）即停掉对应 worker。多实例目录（`server()` per directory）共享同一个 worker——实例级状态本来就是 `server()` 闭包，放在同一进程语义不变。
- **不用 `utilityProcess`**：它只能由 Electron main 创建，而扩展宿主由 sidecar 进程（CLI 二进制或 Electron utility）创建，只能走 `node:child_process`。
- **worker 以独立进程组启动**（POSIX `detached: true`，Windows 依赖 `taskkill /T`）：`kill(-pid)` 能覆盖扩展在 worker 内绕过 `host.spawn` 直接 `child_process.spawn` 的子孙。supervisor 复用 `runtime/process.ts:63-86` 的 `signalGroup` TERM→宽限→KILL 模式。
- **孤儿兜底**：宿主崩溃/被 kill 时 fd3 关闭，worker 的控制通道收到 EOF 即自行退出（原型 `execution-worker.ts:110-114` 的 `disconnected` 路径）。这是跨平台一致的孤儿清理，不依赖 PID 扫描。

### 1.2 worker 入口：`opencode extension-host <id>`

隐藏子命令，但**不能作为普通 yargs command**：`src/index.ts:102-158` 的全局 middleware 会做 `Log.init`、`Heap.start`、env 注入、sqlite `JsonMigration` 检查——worker 不该碰数据库和全局日志初始化。

**方案：在 `yargs(args)` 构造之前拦截 argv**。`src/index.ts` 顶部（约第 82 行 `let cli = yargs(args)` 之前）检查 `args[0] === "extension-host"`，成立则动态 `import` worker 入口并退出，完全不经过 yargs/middleware。三种启动形态统一：

| 场景 | 解析结果 | 说明 |
|---|---|---|
| 源码 dev（`bun run src/index.ts` / Node type-stripping） | `[execPath, script, "extension-host", ...]` | `resolveSelfArgv` 已处理（`math/spawn.ts:115-126`） |
| 编译二进制（`opencode` CLI、bun 打包 sidecar） | `[execPath, "extension-host", ...]` | 单文件可执行，argv 直达 |
| Electron utilityProcess sidecar | 用 `OPENCODE_CLI_PATH` → `resources/sidecars/opencode-cli-<target>` | `process.execPath` 是 Electron 二进制，直接拒绝（`math/spawn.ts:127-129`）；desktop 已注入 `OPENCODE_CLI_PATH`（`server.ts:127`、`native.ts:456-475`） |

复用 `math/spawn.ts` 的 `resolveSelfArgv`/`selfArgv`（上移到共享位置或按同模式拷贝，遵守"不跨包引用"先例）。**已知缺口**：dev 下 `--conditions=browser` 等 `process.execArgv` 标志不会随 `resolveSelfArgv` 传递，worker spawn 需把相关 execArgv 一并带上（见 §11 未决）。

worker 进程内职责（对应 `execution-worker.ts` 的 `serveExecution` + `ExecutionApplication` 升级为真实扩展加载）：

1. 打开 fd3/fd4 控制通道 → 发 `hello`；
2. 等宿主 `init` 命令（携带扩展 dir、entry、settings 快照、identity）→ `import()` server entry；
3. 执行 `activate(proxyHost)` → 成功发 `ready`，失败发 `failed{phase:"readiness"}`；
4. 之后服务 `service.rpc`、`instance.start`、`instance.rpc`、`tool.execute`、`host.call` 应答、cancel、drain、dispose。

`server()` 实例钩子在同一 worker 内按目录惰性建立（`instance.start` 命令驱动），与现状 `entry.instances: Map<directory, hooks>`（`runtime/index.ts:887`）对应。

### 1.3 请求生命周期状态机

完整状态机（宿主侧 supervisor 视角，`execution-supervisor.ts:74-80` 的 `starting|ready|closing|exited` 扩展为含 drain/dispose 的阶段）：

```
spawned ──hello──► starting ──ready──► ready ──drain──► draining ──drained──► disposing ──disposed──► exited
                      │                  │                                  │
                      └─failed──────────►│  任意阶段超时/协议错误 → terminate()→等待 exit → 未知则 unknown
```

逐条对应原型语义（`lifecycle-supervisor.md` §3）：

| 阶段 | 宿主命令 | worker 应答 | 超时处理 |
|---|---|---|---|
| 就绪 | — | `hello` → `ready` | `readinessMs` 超时 → fail + terminate |
| 业务 | `request{requestId,method,value}` | `result` / `rejected{code}` | `maxPending` 上限拒绝；`cancel{requestId}` 中止；迟到结果按 identity 丢弃 |
| 排空 | `drain` | worker 停收新请求、等在途 settled 后发 `drained` | `drainMs` 超时记录 `drainDeadline`，仍进入 dispose |
| 处置 | `dispose` | worker 跑 `service.dispose()`+`hooks.dispose`→`disposed`；抛错→`failed{phase:"dispose"}` | `disposeMs` 超时 → 强杀 |
| 退出 | — | **exit 只能由宿主经 OS handle 观察**（`exited: Promise<RootExit>`），worker 不能自报 | `exitMs` 超时 → `terminate()`（SIGKILL 进程组）→ 仍未观察到 = `StopResult{status:"unknown"}` |

`StopResult` 区分 `rootExited` 与 `unknown`，**所有结果的 `tree` 均为 `unproven`**（`execution-supervisor.ts:25-27`）：观察到根退出 ≠ 子孙死绝，删除安装/数据目录的授权另归 installer 的 lease/pin 体系。

## 2. 控制协议

### 2.1 分帧与序列化

- **换行分隔 JSON 帧**，专用管道：fd3 下行命令、fd4 上行事件；stdout/stderr 只进宿主日志（`execution-process.ts:233-235`）。
- 严格解析：`Schema.decodeUnknownSync(..., {onExcessProperty:"error"})`，未知字段、版本不符、非 JSON、超长帧、截断 UTF-8 一律拒绝并关闭通道（`execution-protocol.ts:66-85`、`execution-process.ts:26-71`）。
- 每帧携带完整 fence 身份 `{version, identity:{store, installation, generation, runtime, epoch}}`；`sameRuntime` 不匹配的帧丢弃（`execution-supervisor.ts:114-117`）。
- 预算显式传入：`frameBytes`（单帧上限）、`bufferedFrames`（启动前缓冲）、队列字节上限在写入前检查，capacity 拒绝只结束该请求（`execution-supervisor.ts:297-303`）。

### 2.2 消息骨架（在原型基础上扩展的部分用 ★ 标注）

```ts
// ── 宿主 → worker ────────────────────────────────
type HostCommand =
  | { type: "init"; value: InitPayload }                          // ★ hello 之后下发：entry 路径、settings 快照、凭据
  | { type: "request"; requestId; method; value }                  // service.rpc / instance.rpc / tool.execute / instance.start / instance.dispose / host.spawn / proc.kill / proc.stdin-end
  | { type: "cancel"; requestId }
  | { type: "drain" } | { type: "dispose" }
  | { type: "host.result"; callId; value }                        // ★ 应答 worker→host 请求
  | { type: "host.rejected"; callId; code; message? }             // ★
  | { type: "notify"; method; value }                             // ★ settings.changed / instance.event / proc.stdin / proc.credit

// ── worker → host ────────────────────────────────
type WorkerEvent =
  | { type: "hello" } | { type: "ready" } | { type: "drained" } | { type: "disposed" }
  | { type: "result"; requestId; value }
  | { type: "rejected"; requestId; code: "closed"|"cancelled"|"requestFailed"|"capacity"|"denied" } // ★ denied = 权限拒绝
  | { type: "failed"; phase: "readiness"|"dispose"|"protocol" }
  | { type: "host.call"; callId; method; value }                  // ★ tool.ask / proc.stdout 信用之外无需应答的走 notify
  | { type: "notify"; method; value }                             // ★ host.emit / host.log / tool.metadata / proc.stdout / proc.stderr / proc.exit / proc.error / proc.credit
```

- **反向请求（`host.call`/`host.result`）**是原型没有、生产必须新增的：`ctx.ask` 在 `tool.execute` 在途期间由 worker 反向请求宿主（mathematica-notebook 实测使用，`packages/extensions/mathematica-notebook/src/server.ts:366`）。`callId` 与宿主 `requestId` 各自独立计数；`tool.ask` 携带宿主 requestId 以便宿主把应答路由回对应的 `toolCtx.ask`。
- **notify 不携带 requestId**，语义 fire-and-forget；`proc.*` 流帧按 processId 寻址并带序号。

### 2.3 传输预算建议值（写入 testing 覆盖）

| 参数 | 建议值 | 说明 |
|---|---|---|
| `frameBytes` | 1 MiB | `proc.stdout` 单帧 chunk ≤ 64 KiB |
| `bufferedFrames` | 64 | 启动前缓冲 |
| `readinessMs` | 10 000 | 与 `ACTIVATE_TIMEOUT_MS` 对齐（`runtime/index.ts:148`） |
| `drainMs` / `disposeMs` / `exitMs` | 5 000 / 10 000 / 5 000 | dispose 与 `DISPOSE_TIMEOUT_MS` 对齐 |
| `maxPending` | 32 | 与 `RPC_CONCURRENCY_LIMIT` 对齐（`runtime/index.ts:156`） |
| proc 流信用 | 初始 256 KiB/进程 | worker 消费后回 `proc.credit`，宿主超信用暂停读流 |

## 3. 宿主 API 代理面（按实测最小集）

### 3.1 实测基线

对三个扩展 `server.ts` + e2e fixture 逐字段核实（grep 全量）：

| API | hello-viewer | wls-repl | mathematica-notebook | 代理方式 |
|---|---|---|---|---|
| `host.id/version` | — | — | — | `init` 载荷静态值 |
| `host.dataDir` | — | ✓（kernel 记录文件 `server.ts:223`） | — | `init` 载荷 |
| `host.cacheDir` | — | — | — | `init` 载荷 |
| `host.serverUrl` | — | — | — | `init` 载荷 |
| `host.settings.get()` | — | ✓（`server.ts:138`） | ✓（`kernel.ts:33,52,148`、`server.ts:354`） | 本地缓存快照（见 3.2） |
| `host.settings.onDidChange` | — | — | — | `settings.changed` notify |
| `host.emit` | ✓（`server.ts:172,222`） | ✓（`server.ts:257`） | ✓（`server.ts:274,312,318`） | notify `host.emit`（含 `directory`） |
| `host.log.*` | ✓ | ✓ | ✓ | notify `host.log{level,...}` |
| `host.spawn` → `ManagedProcess` | ✓（`server.ts:48`） | ✓（`server.ts:62`） | ✓（`kernel.ts`） | request + proc 流/事件（见 3.3） |
| `host.setTimeout/setInterval` | — | — | — | **worker 本地实现**，零 IPC（见 3.4） |
| `service.rpc[method]` | ✓ | ✓ | ✓ | request `service.rpc` |
| `service.dispose` | ✓ | ✓ | ✓ | `dispose` 命令 |
| `server()` → `hooks.tool` | ✓ | ✓ | ✓ | `instance.start` → 工具清单 + `tool.execute` request |
| `server()` → `hooks.rpc` / `event` / `dispose` | — | — | — | `instance.rpc` request / `instance.event` notify / `instance.dispose` request |
| `ctx.sessionID/directory/worktree/agent/messageID` | ✓ sessionID | — | ✓ directory | `tool.execute` 载荷值 |
| `ctx.abort` | — | — | ✓（`server.ts:380` 作 signal 透传） | cancel 帧 |
| `ctx.metadata()` | ✓（`server.ts:229`） | — | — | notify `tool.metadata` |
| `ctx.ask()` | — | — | ✓（`server.ts:366`） | **反向 request** `host.call{method:"tool.ask"}` |
| `input.extension` | ✓ emit | ✓ settings/service | ✓ settings/service | **worker 内真实对象，无需代理**（同进程） |
| `input.directory` | ✓ | ✓ | ✓ | `instance.start` 载荷 |
| `input.worktree/project` | — | — | — | `instance.start` 载荷（可序列化值） |
| `input.serverUrl` | — | — | — | `init`/`instance.start` 载荷 |
| `input.client` | — | — | — | worker 用 serverUrl+凭据自建（见 3.5） |
| `input.$` | — | — | — | **不提供**，调用抛明确错误 |
| `input.experimental_workspace` | — | — | — | **不提供**，register 抛明确错误 |
| `chat.*`/`permission.*`/`config`/`auth`/`provider`/`tool.definition` 等 mutable-output 钩子 | — | — | — | **不支持**：worker 返回钩子清单时宿主逐项检查，出现未支持键 → 报错并说明（T5.0 第 3 条） |

裸 `process.*` 语义变化（worker 本地，不代理）：`process.pid`/`execPath`/`env`/`cwd`/`kill` 都是 worker 进程的值——wls-repl 的 `sweepStaleKernels`（`server.ts:222-243`）记录 `hostPid=process.pid`，进程模式下记录的正是"易崩的 worker pid"，死 host 清理语义反而更准。`hello-viewer` 的 `resolveChildRuntime`（`child-runtime.ts:28-41`）已处理 `execPath` 为编译二进制的情形（回退 PATH/`OPENCODE_JS_RUNTIME`），无需改动。

### 3.2 settings

- `init` 载荷携带 `resolveSettings` 结果（`runtime/index.ts:245-252`）；`host.settings.get()` 返回 worker 本地缓存的副本——**同步 API 不变**。
- `notifySettings`（`runtime/index.ts:1134`）→ notify `settings.changed{values}`：worker 更新缓存并触发注册的 listener。先更新缓存再回调，保证 listener 内 `get()` 看到新值（与现行 `settings.ts` 语义一致）。

### 3.3 `host.spawn` 代理（最重的一项）

`host.spawn` 在宿主侧执行（T5.0 第 3 条明确列入 host 侧代理面），理由：**宿主观察到 worker 退出后，必须能连根清理其托管子进程**——这正是 `makeProcessScope`（`runtime/process.ts`）已有的语义，scope 改为按 `(workerRuntime)` 绑定而非 `(gen)`，worker 退出即 TERM→宽限→KILL 其全部 spawn。若 spawn 落在 worker 本地，SIGKILL worker 会孤儿化全部内核进程。

```ts
// spawn 握手
worker → host: request{ method:"host.spawn", value:{ command, args, env, cwd, stdio } }
host   → worker: result{ processId, pid }          // 宿主侧经 makeProcessScope.spawn
// 数据面（均带 processId + seq）
host   → worker: notify{ method:"proc.stdout"|"proc.stderr", value:{processId, seq, data(base64)} }
worker → host: notify{ method:"proc.stdin",  value:{processId, data(base64)} }
worker → host: notify{ method:"proc.credit", value:{processId, bytes} }   // 消费回执，宿主恢复读
host   → worker: notify{ method:"proc.exit",  value:{processId, code, signal} }
host   → worker: notify{ method:"proc.error", value:{processId, message} }
worker → host: request{ method:"proc.kill",  value:{processId, signal:"TERM"|"KILL"} }
```

- worker 侧把 `proc.stdout/stderr` 事件喂给代理 `Readable`，`proc.stdin` 落到宿主 child.stdin；`onExit/onError/kill/pid/exited/killed/exitCode/exitSignal` 按 `ManagedProcess` 契约（`extension-kit/src/server.ts:28-49`）在 worker 端组装。
- **流控**：`proc.stdout` 出账、worker 消费回 `proc.credit`；超信用宿主暂停 child.stdout `read`（防 worker 不消费时内存膨胀）。stdin 方向同机制可后置（三个扩展只写少量行）。
- `stdio:"inherit"` 语义变化：worker 没有用户可见的 tty，宿主侧 `inherit` 映射为并入日志流——文档写明。

### 3.4 零 IPC 项

`host.setTimeout/setInterval` 在 worker 内实现：timer 的生命周期本来就是"代际"——而**进程模式下 worker 进程本身就是代际**，worker 退出 = 全部 timer 消失。worker 内部维护一个 timer scope（复用 `runtime/timers.ts` 形状），`dispose` 命令到达时清空。实测三扩展全部用裸 `setTimeout`（如 `wls-repl/server.ts:347,352`、`mathematica-notebook/preview-service.ts:95`），裸 timer 同样随进程消亡，语义反而比 inline 更干净（无泄漏入 sidecar 的可能）。

### 3.5 `PluginInput` 与凭据

- 序列化值：`directory`、`worktree`、`serverUrl`、`project`（均为 JSON 值，`lifecycle-api-matrix.test.ts:47-55` 已按 "value" 标记）。
- `input.client`：worker 用 `serverUrl` + 凭据自建 `createOpencodeClient`。**凭据经 fd3 `init` 载荷传递**，不进 env/argv/日志（T5.0 第 5 条）。现状 `input.client` 用的是 in-process `app.fetch`（`plugin/index.ts:366-371`），进程模式下改为真实 HTTP + `ServerAuth.headers()` 等效凭据。三个扩展均未使用 `client`——v1 允许"懒建"：首次访问才构造，凭据缺失时抛明确错误。
- `input.$`（BunShell）：**不提供**。`input.$` 赋值为调用即抛错的对象并带迁移指引（"用 host.spawn"）。`experimental_workspace.register` 同理（会改写宿主状态）。
- `input.extension`：`ExtensionHost & {service}` 是 worker 内**真实对象**——`activate`/`server` 同进程，`input.extension.service?.rpc` 直调本地 handler（wls-repl `server.ts:669`、mathematica `server.ts:363` 依赖此路径），零协议开销。

### 3.6 工具代理

- `instance.start` 应答包含 `tools:[{name, description, parameters(JSON Schema)}]`。worker 侧把 `tool({args: zodShape})` 的 zod 参数转 JSON Schema：**复用宿主 `registry.ts:311-321` 的模式**——`"_zod" in value` 鸭子检查 → `z.object` → `z.toJSONSchema`（zod 4.1.8，跨 bundle 副本结构兼容）；非 zod 走 `legacyJsonSchema` 裸 JSON Schema 直通（`registry.ts:599-608`）。
- 宿主注册代理 `Tool.Def`：`execute` → request `tool.execute{directory, tool, args, ctx:{sessionID,messageID,agent,directory,worktree}}`；`ctx.abort` ↔ cancel 帧（`bindHook` 的 requests AbortController 合并逻辑 `hooks.ts:62-74` 保持原样，cancel 帧在代理 execute 内发出）；`ctx.metadata` → notify 回灌 `toolCtx.metadata`；`ctx.ask` → 反向 `host.call` 应答/拒绝（拒绝 → worker 侧 ask 抛错，与宿主 deny 语义一致）。
- 命名空间与冲突检测不变：代理工具以**原始声明名**进 `hooks.tool`，`ToolRegistry` 的 `extensionToolName`/`markToolConflict`（`registry.ts:398-408`、T2.1）原样生效。

## 4. 生命周期一致性

### 4.1 gen/epoch/fence/quiesce 映射

| inline 语义（现状） | process 语义 | 位置 |
|---|---|---|
| `slot.generation`：invalidate/mutation 自增，防迟到副作用 | 同一 generation 数字直接作为 `RuntimeIdentity.generation`；worker 换 code（fingerprint 变化）时 generation 必变 | `slot.ts:131-149` |
| `slot.epoch`：mutation.begin/quiesce.begin 自增，`instanceHooks`/`rpc` 的 CAS 检查 | `RuntimeIdentity.epoch`；每帧携带，stale epoch 帧 worker/host 互丢 | `slot.ts:138,146` |
| `Entry`（module/service/instances/requests） | Entry 保留，但 `module`/`service` 字段由"代理描述符 + supervisor 句柄"替代；`instances` 映射为 `instance.start` 已建目录集 | `slot.ts:9-27` |
| `pending`/`requests` 跟踪 | pending = 在途协议 request + supervisor stop；`bindHook` 的 requests AbortController → cancel 帧 | `runtime/index.ts:576-578`、`hooks.ts:58-91` |
| `quiesce`：disposeService→drain pending→超时即 blocked | drain→dispose→**观察 OS 退出**；`unknown` → `markBlocked`/`needsRestart`，语义不变 | `runtime/index.ts:580-624` |
| `disable`/`reload`：dispose resources→abort requests→disposeService | 同序：abort 在途 request（cancel）→ drain/dispose → 观察 rootExit；`drainProcessKills` 由宿主进程 scope 覆盖 | `runtime/index.ts:1090-1128` |
| 模块指纹热替换（`module-cache.ts` 复制+重导入） | **不需要**：worker 直接 `import` 源 entry，新 generation = 新进程 = 天然新鲜模块。`module-cache`/`defaultImporter` 对 process 路径跳过（T5.7 评估删减） | `runtime/module-cache.ts` |
| emit 令牌桶 / rpc 并发上限 | **不动**：emit 经 notify 进宿主同一 `emitLimiter`（`runtime/index.ts:386-411`）；并发上限在宿主 request 准入 + worker `maxRequests` 双层 | T2.6 |

### 4.2 双后端同语义验证

- `lifecycle-api-matrix.test.ts`（`test/extension/lifecycle-api-matrix.test.ts`）是 API 传输决策的类型级契约，`process` 后端逐项满足其 "value|handle|mutable-output|schema-codec|managed-process|frontend-realm" 标注——§3 表格逐行即按此标注设计（mutable-output 类全部"不支持"）。
- 测试参数化方案：抽出共享 **lifecycle 契约套件**（激活→rpc→tool→emit→settings 推送→disable→enable→update→uninstall→blocked），以 `isolation: "inline" | "process"` 参数化跑两遍（T5.3 验收）；`runtime.test.ts`/`service.test.ts`/`runtime-process.test.ts` 现有断言保持为 inline 回归网；`lifecycle-target.test.ts` 的 OS 级用例（真实 installId/lease/卸载）增加 process 变体显式开启。
- `ExtensionRuntime` 对外接口（`instanceHooks/rpc/quiesce/disable/reload/notifySettings/describe/retry/invalidateHooks`，`runtime/index.ts:1210-1223`）签名不变；slot 按 `Loaded.isolation` 选择执行后端（T5.3 第 1 条）。

## 5. 崩溃与重启策略

| 项 | 设计 |
|---|---|
| 检测 | **唯一权威信号 = 宿主观察到 `transport.exited`（exit code + signal）**。worker 不能自报 exit（原型协议硬约束）。控制通道 EOF/写失败按 transport 错误处理 → terminate + 等退出。 |
| 心跳 | **v1 不引入周期 ping**：在途请求有调用方超时/abort，drain/dispose 有 deadline，死循环经"stop 时超时→terminate"覆盖（T5.3 死循环测试即走此路径）。若实测出现"活着但全部静默挂死"场景再加 `ping`（列入未决）。 |
| 崩溃归因 | `exited` 到达且非 stop 流程发起 → `slots.transition` 记 `entry.error`/`runtime.error`，`publishError` 推 `extension.status=error`（`event.ts:35-41`）。在途 RPC/工具请求统一以 `ExtensionRpcError{code:"extension_crashed"}` 拒绝。 |
| 自动重启 | 指数退避 **1s / 5s / 30s，最多 3 次**（T5.0 第 7 条默认值）：仍 error → 停在该状态等手动 `retry`（现有 `retry(id)` 路由，`extension/index.ts:141-149`）。重启受 fence 约束：`gated(id)` 或 gen/epoch 已变 → 放弃重启；重启成功 → `invalidateHooks()` 重建 Plugin/Tool 缓存。重启 worker 换新 `runtimeId`、同 gen/epoch。 |
| `needsRestart` 语义 | **不变**：仅 `stop→unknown`（进程未观察到退出）置 `blocked`。观察到的崩溃是 error 可自愈，不是 blocked——与 `describe()`/`markBlocked`（`runtime/index.ts:517-540,1185-1201`）语义对齐。 |
| 托管子进程 | worker 退出被观察 → 宿主按 worker 身份 kill 其 `makeProcessScope` 组（TERM→宽限→KILL→等 exit），与 `drainProcessKills`（`runtime/index.ts:306-309`）衔接。 |

## 6. 权限粗粒度执行（D3 → T5.6）

| 权限 | 执行点 | 机制 |
|---|---|---|
| `tools` | 宿主侧：`instance.start` 应答含工具清单时检查 `manifest.permissions` 含 `tools`（`runtime/host-worker.ts` 的 `instanceStart`） | 未声明 → 丢弃全部工具描述符 + warn 日志（`service:"extension"`，`permission:"tools"`）；实例其余 hooks（rpc/event/dispose）照常注册，扩展**不置 error**。**worker 无法绕过**——工具进 ToolRegistry 必经宿主 |
| `process:spawn` | 宿主侧：`host.spawn` 的 `host.call` 准入（`runtime/host-worker.ts` 的 `onHostCall`） | 未声明 → warn 日志 + `host.rejected{code:"denied"}`；worker 侧代理 `ManagedProcess` 收到 onError + 终态 exit（`application.ts` `spawnProxy`） |
| `fs:read/fs:write/network/settings:secret` | 不执行 | 维持"声明不强制"（T2.4 文案已写进 UI） |
| inline 后端的 `tools`/`process:spawn` | 不执行 | D3 语义：进程隔离后才对这两条做粗粒度执行；inline 只用于本地 `path` 来源调试（D8），保持声明不强制 |
| Node `--permission` | 评估后**不采用为 v1 默认** | 见下方评估结论；仅当 sidecar/worker 均为 Node 且版本支持 `--permission` 时可作为 hardening flag 列入未决 |

**Node `--permission` 评估结论（T5.6）**：不给 worker 加 `--permission --allow-fs-read=<extDir>,<dataDir> --allow-fs-write=<dataDir>`，三条理由：

1. **Bun 无对等机制**：生产 worker 全部是 bun 编译二进制（Q1），该 flag 覆盖不了唯一实际部署形态；加了只在 Node dev 路径生效，语义不一致反而误导。
2. **`fs:read` 边界收敛不了**：`--allow-fs-read` 必须在 worker spawn 时固定，而扩展合法读取面含**每个实例的项目目录**（如 mathematica-notebook 读 `<directory>` 下的 `.nb` 文件）——实例目录随会话变化、spawn 时未知；只能放宽到接近全盘读，等同不设限。
3. **`--allow-child-process`/`--allow-worker` 与目标冲突**：现有扩展已在 worker 内裸用 `spawnSync("ps")`（wls-repl `sweepStaleKernels`）和 `worker_threads`（mathematica preview）。授予则"阻止裸 spawn"的目标失效；不授予则破坏存量功能。升级路径是先消减这些 worker 内裸调用，再谈收紧。

若未来要启用，前置条件：worker 固定 Node 运行时（≥20，权限模型稳定的版本）、实例目录可知或按需重启、worker 内裸 `child_process`/`worker_threads` 全部收敛到 `host.spawn` 或显式授权位。

**边界声明（必须写进作者文档与 design.md）**：进程隔离提供的是**故障隔离 + API 级限制，不是安全沙箱**。worker 内扩展代码仍可 `import("node:child_process")` 自行 spawn、读任意文件——`host.spawn` 的拒绝只封住代理通道，封不住同进程内的直接调用（Bun 下没有 `--permission` 可用，见上）。信任模型与"安装即信任"一致（`design.md:1162`），隔离收益是崩溃不拖垮 sidecar 与其他扩展、生命周期可控、经 `host.spawn` 的子进程可连根清理。

## 7. manifest `isolation` 声明

```jsonc
// package.json 的 opencode manifest 新增 server 对象
{ "opencode": { "server": { "isolation": "process" | "inline", "apiVersion": 1 } } }
```

- **schema 位置**：`schema.ts` `Manifest`（`schema.ts:94-104`）新增 `server: Schema.optional(Schema.Struct({ isolation: Schema.optional(Schema.Literals(["process","inline"])), apiVersion: Schema.optional(Schema.Number) }))`；`manifest.ts` `Loaded` 增加 `isolation`/`serverApiVersion` 字段与解析。
- **默认值**：过渡期 `inline`（无 `server.isolation` 字段 = inline）；T5.8 切换为 `process`，切换后 `isolation` 缺省即 process（D8）。
- **inline 收敛**：T5.8 后非 `path` 来源的扩展声明 `inline` → warn 日志 + `Info.warnings` 加稳定码 `server.isolation:inline` + UI 提示；`path` 来源（本地开发）保留 inline 合法。
- `server.apiVersion`：为协议演进预留，本期恒 1；未知版本按 `web.apiVersion` 同款优雅降级（丢 server 部分 + warning），`manifestVersion` 硬拒不变（`manifest.ts:194-204`）。

## 8. 打包与分发验证点

| 验证点 | 方法 |
|---|---|
| `extension-host` 子命令在 bun 编译产物中可用 | `script/build.ts` 产物执行 `./opencode extension-host --help`（或 `--version` 等价物）；因为入口在 yargs 之前拦截，编译前后行为一致 |
| desktop 打包后 worker 用对二进制 | sidecar 内 `OPENCODE_CLI_PATH` → `bundledCliPath()` → `Resources/sidecars/opencode-cli-*`（`native.ts:456-475`）；打包产物中对该二进制实测 `extension-host` 冒烟 |
| dev 环境 | `bun run src/index.ts extension-host` 直接起 worker；`--conditions=browser` 等 `process.execArgv` 需随 spawn 透传（缺口，见 §11） |
| fd 适配矩阵 | sidecar=Bun(darwin 已验证) / Node(utilityProcess 路径) × worker=Bun(编译二进制) / Node(dev)。**Bun 适配目前硬限 darwin**（`execution-process-bun.ts:25`），Linux/Windows 的 Bun.spawn 额外 fd 语义需在 T5.1 补适配或限定 worker 启动方式 |
| Electron utilityProcess 特殊性 | utilityProcess 是 Node 语义，`node:child_process` 的 fd3/fd4 原生可用——host 侧 Node 适配已验证；sidecar 退出 → supervisor `disposeAll` → 全部 worker 收 drain/dispose，Electron main 退出由 `child-process-gone`/`app will-quit` 兜底（`server.ts:169-176` 已有同名机制）；**宿主侧猝死由 worker 的 fd-EOF 自杀兜底**，不留 `extension-host` 孤儿（T5.4 用 `ps` 验收） |
| 签名/asar | extension 入口是普通文件路径 `import()`，不涉及 asar 内模块；worker 二进制与 sidecar 同一构建产物，签名链不变 |

## 9. 三扩展迁移清单（T5.5 逐个执行）

| 扩展 | 审计项 | 结论 |
|---|---|---|
| hello-viewer | hooks：`tool.greet`（ctx.sessionID/metadata/directory）；`host.spawn` echo 子进程；`resolveChildRuntime` 用 `process.execPath` | execPath=编译二进制时走 PATH 回退（已处理，`child-runtime.ts:34-41`）；`$`/`client` 未用；**无阻塞项** |
| wls-repl | `host.spawn` wolframscript 内核 + `host.settings` + `dataDir` 记录文件 + `sweepStaleKernels` 的 `process.pid`/`process.kill`/`spawnSync("ps")` | hostPid 语义 = worker pid（崩溃后新 worker 清扫旧内核，行为改善）；`spawnSync` 属 worker 本地直调（API 限制外，记录为已知边界）；`input.extension.service.rpc` worker 内直调；**无阻塞项** |
| mathematica-notebook | `node:worker_threads` preview worker（`preview-service.ts:16-20`）；`ctx.ask`（必须反向请求）；`ctx.abort` 透传为 rpc signal；`process.cwd()` 兜底（`server.ts:55`） | worker_threads 为 worker 内线程，进程边界不受影响；`ctx.ask` 依赖 §2.2 反向请求落地；worker cwd 固定为扩展 dir，ctx.directory 为权威路径来源；**无阻塞项** |

每个扩展切换时的统一检查：① manifest 加 `server.isolation:"process"`；② hooks 键审计（只允许 `tool/rpc/event/dispose`）；③ `$`/`client`/`experimental_workspace` 引用审计；④ 内核进程必须经 `host.spawn`（已满足）；⑤ 切换前后对比 RPC p50/p95 延迟、首次激活耗时、RSS（写实施记录）。

## 10. 可回退性与 T5.7 边界

| 步骤 | 回退 |
|---|---|
| 每扩展灰度 | `isolation` 按 manifest 逐扩展生效；回退 = 改回 `inline` 或删除字段，代码路径共存 |
| 全局兜底 | 环境变量 `OPENCODE_EXTENSION_ISOLATION=inline` 作为 kill-switch，优先级高于 manifest（进 testing 覆盖接口） |
| inline 路径 | T5.8 之前**不删不改**；`module-cache`、pin、fence 分支全部保留，删除评估属 T5.7 |
| 提交粒度 | T5.1–T5.8 每任务独立提交，可单独 revert；`extension-host` 子命令在无 process 扩展时零开销 |
| T5.7 Effect 化边界 | 收进 `ExtensionRuntime.Service` 的：模块级 `slots`/`importer`/`leaseDriver`/`generationPins`/`dataPins`/`emitLimiters`/`staleHookIds`（`runtime/index.ts:109-163,285,489-493`），每目录部分用 `InstanceState`；`testing.setImporter/setLeaseDriver/setLimits/setTimeouts` 改为 `Layer.mock`；**不收**：`Slot`/`Entry` 数据形状、`createHookOwner`/`makeTimerScope`/`makeProcessScope` 纯函数结构、GlobalBus/ExtensionLeases 全局面。process 成默认后逐项评估删除 pin/fence 冗余分支，每删一项附测试 |

## 11. 与原型文档的偏差声明

- 原型 `ExecutionApplication`（`execution-worker.ts:16-19`）只含 `request/dispose` 两方法；本设计把它展开为"扩展加载 + 代理 host + 实例管理"，loader 之前持 OS 引用、ack 之后不提前释放的规则原样保留（`lifecycle-supervisor.md` §2.1）。
- 原型 `AdmissionSnapshot`/DeploymentStore 的**持久化准入**部分不进入本期：sidecar 崩溃恢复（存活 worker 的发现与重挂接）仍属 `lifecycle-supervisor.md` §5 阻塞项，本期 worker 与 sidecar 同生死（fd-EOF 自杀兜底）。
- 原型 `hello` 单消息扩展为 `hello`+`init` 两段：先版本/身份握手，再下发加载参数，便于 readiness 失败归因到"加载"而非"通道"。

## 12. 待确认决策汇总

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| Q1 | worker 运行时 | A. 与 sidecar 同二进制（Bun） B. 系统 Node | **A**：所有部署形态（CLI 二进制/desktop 内嵌 CLI）天然可解析；Node 仅出现在源码 dev 路径 |
| Q2 | dev execArgv 透传 | spawn 时携带 `process.execArgv`（含 `--conditions=browser`） | 透传，否则 dev 下 worker 与 sidecar 模块解析条件不一致 |
| Q3 | 心跳 | A. 无心跳，exit+deadline 覆盖 B. 周期 ping+看门狗 | **A**；T5.3 死循环用例验证后不满足再加 |
| Q4 | 自动重启参数 | 1s/5s/30s ×3（T5.0 建议值） | 采用；进 `testing.setLimits` |
| Q5 | 资源限制 | Node `--max-old-space-size` / Bun 无对等项 | v1 只记录 RSS 指标不设硬限；Node 运行时可加 flag，Bun 列入后续（cgroups/Job Object 属平台工作） |
| Q6 | worker env | A. 全量继承 sidecar env B. 白名单 | **A**（与 inline 现状权限等价，不引入回归）；凭据仍只走 fd 不进 env |
| Q7 | `input.client` | A. v1 实现（fd 传凭据+SDK 自建）B. v1 打桩抛错 | **B**：三扩展零使用，凭据通路按 §3.5 预留；首个使用者出现时启用 |
| Q8 | Bun fd 适配平台 | darwin 已验证；linux/win 需新适配或替代方案 | T5.1 内解决；若 Bun.spawn 额外 fd 不可用，则 worker 端固定 Node 子命令入口，列为风险项 |
| Q9 | `stdio:"inherit"` | 并入日志流 vs 禁止 | 并入宿主日志流并文档化 |
| Q10 | `server.apiVersion` 未知值 | 丢 server 部分 + warning（同 web） | 采用，与 T2.3 语义对齐 |
