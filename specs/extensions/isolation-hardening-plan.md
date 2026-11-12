# 扩展系统：错误隔离与状态管理优化/修复计划

状态：**A1–A4、B1/B2、C1/C2 短期实现已落地；最终验证与已知边界见[交付记录](./isolation-hardening-delivery.md)。** 计划原审查基线：`830085869f`；实施工作区复核基线：`db23a41905`。独立进程执行未接入生产，不提交/推送。

已确认决策：D1 保留普通 trigger 错误拒绝语义，只跳过扩展变更错误；D2 新增实际路由 `POST /global/extension/:id/retry`；D3 原型迁至 `specs/extensions/prototypes/`，24 份原位置副本经核对及用户确认后移除，API matrix/target 测试留原位。

实施修正：server 超时使用单次 expired token，不推进全局 generation；stale 采用释放后 task-turn 失效而非单次 microtask，并用真实双层 ScopedCache 回归固定 tool→plugin→tool 及后到失效 revision 重跑，避免缺席状态永久缓存。下文保留原计划作为设计依据，具体实现以交付记录为准。
依据：2026 扩展系统审查结论（探针测试实测，见 §0）。

## 0. 已确认问题（按严重度）

| # | 问题 | 位置 | 实测结果 | 影响面 |
|---|---|---|---|---|
| P1 | 后端 `activate()` / `server()` 无超时，`instanceHooks` 串行 await | `extension/runtime.ts` `ensureService` / `callServerInternal` / `instanceHooks` | A 的 activate 永不返回 → `instanceHooks` >2s 未返回 | 整个实例的 `Plugin.state` 挂起，所有会话、所有插件和扩展被卡住 |
| P2 | 单扩展 blocked（needsRestart）导致 `instanceHooks` 整体抛错 | `runtime.ts` `instanceHooks` 中的 `available()` + 末尾全量复查 | A 清理失败后，B 的 hooks/tools 也加载不了 | 重启前所有扩展钩子不可用，同时拖垮普通插件 |
| P3 | Plugin 管道无逐条目隔离 | `plugin/index.ts` `trigger`（`Effect.promise`）、event 订阅（`Effect.sync` 循环） | 推断：同步抛错 → defect，中断触发链或终止事件 fiber；变更期间 `bindHook` 会同步抛 `ExtensionMutationError` | 普通安装/更新也可能打断该实例的事件流 |
| P4 | 前端工具渲染器无 ErrorBoundary；命令 `onSelect` 无 try/catch | `app/src/extensions/mount.ts`、`host.tsx` `registerCommand` | 代码审查 | 渲染错误冒泡到页面级边界 |
| P5 | 运行时状态对外不可见 | `registry.ts` `info()`：`state` 只由 enabled 决定；`describe()` 只有 hasService/hasInstanceHooks | 代码审查 | UI/API 看不到 activate 失败、超时、needsRestart |
| P6 | 后端状态分散在十余个模块级集合 | `runtime.ts`（1233 行） | 代码审查 | 难以推理、难以扩展，修改容易引入回归 |
| P7 | 同进程运行：扩展的 `uncaughtException` 会让桌面端 sidecar `exit(1)` | `desktop/src/main/sidecar.ts:69` | 代码审查 | 任何扩展计时器抛错都会拖垮整个后端 |
| P8 | lifecycle 重构原型（`lifecycle-state`、`execution-*`、`ownership*`）未提交且未接入 | `extension/` 下 `??` 文件 | git status | 两套架构并存，方向不明 |

## 1. 原则

1. **一个扩展的任何失败（抛错、挂起、清理失败）只能让它自己进入 error/blocked，不能改变其他扩展或普通插件的可用性。**
2. 不放宽现有的生命周期安全保证：fence/quiesce/needsRestart 语义、generation 防迟到、pins 都保留。
3. 每一步都要加日志（`service: "extension"`，带 `extension`、`phase`、`gen`、`epoch`、`elapsedMs`）。
4. 每个修复先写失败的回归测试（把本次探针转成正式测试），再改代码。
5. 修完后按 AGENTS.md 要求做 CDP 验证和 sidecar 自测。

## 2. 阶段 A：止血（P1–P4，优先，约 2–3 天）

### A1. 后端激活和实例钩子超时（P1）

改动：`runtime.ts`

- 新增 `ACTIVATE_TIMEOUT_MS = 10_000`、`SERVER_TIMEOUT_MS = 10_000`，和前端保持一致；可通过 `testing` 覆盖。
- `ensureService`：activation 与超时竞争。超时后：
  - `entry.status = "error"`，`entry.error = "activation timed out after Nms"`，调用 `publishError`；
  - 执行 `invalidate(id)`，让迟到的 resolve 走现有 generation 检查，进而执行 `disposeService(..., 0)`；
  - 迟到的 activation 仍然 `track(id, …)`，以便 quiesce 能观察到。
- `callServerInternal`：同样处理超时。超时后迟到的 hooks 由已有的 `disposeHooks` 路径回收；本实例跳过该扩展，不标记 sticky error（server 与目录相关），但要打 warn 并发布事件。
- `instanceHooks`：把串行 for 循环改为**逐扩展独立的 Promise**（`Promise.allSettled`），结果保持原 registry 顺序。

日志：`activate start/ok/fail/timeout`、`server start/ok/fail/timeout`、`late activation disposed`。

测试（`test/extension/runtime.test.ts` 新增 describe "cross-extension isolation"）：
- A 的 activate 挂起 → `instanceHooks` 在超时内返回 `[B]`；A 的状态为 error，并收到 `extension.status=error`。
- A 迟到 resolve → service 被 dispose，不会出现在 entries 中。
- A 的 server 挂起 → 返回 `[B]`；下一个实例会重试 A。
- quiesce 期间存在迟到 activation 时，quiesce 仍会等它结束（不回归）。

### A2. 把 `instanceHooks` 的失败范围收窄到单个扩展（P2）

原设计意图：变更进行中不能成功返回 `[]`，否则会污染无限期的 Plugin/ToolRegistry 缓存。

新语义：

| 扩展状态 | 处理 |
|---|---|
| `blockers.has(id)`（needsRestart） | **跳过**，记录 error 日志 + 发布状态事件（见 A5/B1）；不抛出。重启前它不会再变好，缓存它的缺席是正确的 |
| fence / quiescing（瞬态变更） | **跳过**，并把本次结果标记为 `stale` |
| 结束时检测到 mutationEpoch 变化 | 同样标记为 `stale` |

- `stale` 的处理：`instanceHooks` 照常返回健康扩展的结果，然后在 microtask 中调用 `invalidateHooks()`，触发一次重建。
- 需要确认：`install-service.ts` `stop()` 释放 fence 后已经会调用 `invalidateHooks()`。A2 的兜底失效用来覆盖"instanceHooks 跨越 release 才结束"的竞态，两者是幂等的。
- `LeaseError` 同理：只影响该扩展，跳过并打日志，不再全局抛出。
- 删除末尾的"全量 `available()` 复查后 throw"，改为只计算 stale 标记。
- 保留：已产出 hooks 的扩展如果在返回前进入变更，仍然 dispose 它的 hooks 并从结果中移除。

测试：
- 探针用例转正：A 为 blocked → 返回 `[B]`，不抛出。
- A 处于 fence 中 → 返回 `[B]`；release 后 `invalidateHooks` 被调用，下一次返回 `[A, B]`。
- 现有用例 `rejects ... instanceHooks` 中断言 `.rejects.toThrow(ExtensionMutationError)` 的部分（约第 275 行）需要按新语义更新，并在 PR 中说明行为变化。

### A3. Plugin 管道逐条目隔离（P3）

改动：`plugin/index.ts`

- **事件订阅**：对每个 entry 分别 `try { const r = hook(...); if (thenable) r.catch(log) } catch (e) { log }`。一个钩子抛错不能终止 fiber，也不能跳过后续 entry。
- **trigger**：需要先确定策略。
  - 现状：普通插件用抛错来表达"拒绝"，例如 `tool.execute.before` 抛错以阻止工具执行，**这个语义必须保留**。
  - 方案：只对 `id.startsWith("extension:")` 的条目做隔离。`ExtensionMutationError` 视为"该扩展本次不参与"，跳过并打 debug 日志；其他错误默认保持原有的传播语义，与插件一致。另提供一个待议选项：在 extension-kit 文档中明确"钩子抛错 = 拒绝"。
  - **决策点 D1**：扩展钩子抛出普通错误时，是"阻止"（与插件一致）还是"记录并忽略"？建议与插件一致，只吞掉 `ExtensionMutationError`。
- `config` 钩子已经有 catch，不需要改。

测试（`test/plugin/`）：
- 扩展的 event 钩子同步抛错 → 后续事件仍能送达其他插件。
- 扩展处于变更中时 `trigger("chat.message")` → 跳过该扩展，流程继续。
- 普通插件在 `tool.execute.before` 抛错 → 仍然能阻止工具执行（不回归）。

### A4. 前端隔离补齐（P4）

- `mount.ts` `extensionScopedMount`：在 scope root 内用 `ErrorBoundary` 包裹组件。fallback 为一行小型错误卡片（工具名 + 错误信息 + Retry），并输出 `console.error("[extension-tool] render failed id=… tool=…")`。
  - 注意：`insert` 必须在 boundary 内执行，参照 `file-viewer-content.ts` 的懒创建做法。
- `host.tsx` `registerCommand`：`onSelect` 用 try/catch 包裹，同时处理 Promise 拒绝 → toast + `console.error`。
- 测试：`test-browser/extension-mount.test.ts` 增加"渲染时抛错 → 显示 fallback，兄弟节点不受影响"；`host.test.ts` 增加命令抛错的用例。

### A5. 阶段 A 验证

- `bun test test/extension test/plugin`（packages/opencode）全部通过；App `bun test` 加 browser-condition 套件通过；各包 typecheck 通过。
- **sidecar 自测**：在隔离 registry 中放 3 个 fixture 扩展：`hang-activate`、`throw-dispose`、正常的 `hello`。启动 dev 后端，自己发送消息，确认会话正常完成、`hello` 的工具可用；然后读后端日志，确认能看到 timeout/blocked 日志。
- **CDP 验证**（9222，先检查是否已有 Electron 在运行）：在配置页确认三个扩展的状态展示正确；在会话中触发一个会抛错的工具渲染器 fixture，确认只有该卡片显示 fallback；截图保存到 `/tmp/ext-isolation-*.png`。

## 3. 阶段 B：状态可见与统一模型（P5, P6，约 3–4 天）

### B1. 对外暴露运行时状态（P5）

- `schema.ts` `ServerInfo` 扩展为：
  ```ts
  { hasService, hasInstanceHooks,
    runtime: "idle" | "loading" | "ready" | "error" | "blocked",
    error?: string, needsRestart: boolean }
  ```
- `runtime.describe(id)` 始终返回值，不再在 entry 不存在时返回 undefined：blocked 和 error 来源于 `blockers`、`failedDisposals`、error entry 和超时记录。
- `index.ts` `list/get`：`server` 不再只在 `state === "ready"` 时才附带。
- `StatusState` 新增 `"blocked"`；quiesce 判定 needsRestart 时发布该状态。
- 重新生成 SDK/OpenAPI。
- UI：`extension-card.tsx` / `config-extension-detail.tsx` 展示"运行错误：…（重试）"和"需要重启 OpenCode"；重试复用现有 reload 路径（`notifySettings` 清 sticky 的逻辑可以抽成 `retry(id)` API）。
- **决策点 D2**：是否新增 `POST /extension/:id/retry`？建议新增，只清除 sticky error，不清除 blocked。

### B2. 运行时状态收敛为每扩展一个 Slot（P6）

在 A 和 B1 的测试作为安全网的前提下做**纯重构，不改变行为**：

```ts
type Slot = {
  id: string
  phase: "idle" | "loading" | "activating" | "ready" | "error" | "mutating" | "quiescing" | "blocked"
  generation: number
  mutationEpoch: number
  entry?: Entry
  loading?: Promise<Entry | undefined>
  pending: Set<Promise<unknown>>
  requests: Set<AbortController>
  liveHooks: Set<ExtensionHooks>
  failedDispose: boolean
  error?: { phase: "import" | "activate" | "server" | "dispose" | "timeout"; message: string; at: number }
}
const slots = new Map<string, Slot>()
```

- 用 `transition(slot, from[], to, reason)` 集中处理状态迁移：非法迁移直接抛错，每次迁移输出一条日志，迁移后发布 `extension.status`。
- `gated()`、`assertAvailable()`、`describe()` 都改为从 `phase` 推导。
- 拆分文件：`runtime/module-cache.ts`（复制/导入/剪枝）、`runtime/slot.ts`（状态机）、`runtime/hooks.ts`（bind/finalize）、`runtime/index.ts`（门面）。`runtime.ts` 对外导出保持不变。
- 验收：现有 `runtime.test.ts`、`registry-concurrency`、`install-service`、`lifecycle-api-matrix` 全部通过，不修改任何断言。

## 4. 阶段 C：架构方向（P7, P8，需决策，周期另估）

### C1. 先决定 lifecycle 原型的去留（P8）

- **决策点 D3**：
  - (a) 提交原型，作为"阶段 0/1 基础设施"继续推进到 RuntimeSupervisor 接入；
  - (b) 移到 `specs/extensions/prototypes/` 或单独分支，主线暂不保留。
- 建议 (a)，但需满足：单独一个 PR、只包含测试和文档、README 标明"未接入生产"；并在 `lifecycle-rebuild-plan.md` 中把本计划的 A/B 阶段登记为前置项。

### C2. sidecar 崩溃面（P7）

- 短期（可与阶段 A 一起做）：
  - 在 `createHost` 中为扩展提供 `host.setTimeout` / `host.setInterval` 包装，自动捕获并归因到扩展，dispose 时统一清理；在 extension-kit 文档中推荐使用。
  - 在 `uncaughtException` 处理中尝试按堆栈路径（`extension-modules/<id>/`）归因并记录到日志，但仍保持 fatal，因为进程状态可能已损坏。
- 长期：通过 C1 的 execution-supervisor 把扩展后端放进独立的 utility process，API 走代理。这是根治方案，需要单独立项，覆盖 PluginInput/Hooks 的序列化边界和兼容性声明。

## 5. 交付顺序与 PR 划分

| PR | 内容 | 依赖 |
|---|---|---|
| 1 | A1 + A2 + 回归测试（runtime） | — |
| 2 | A3（plugin 管道）+ 测试 | D1 |
| 3 | A4（前端 boundary/command）+ browser 测试 + CDP 验证 | — |
| 4 | B1（schema/SDK/UI 状态）+ CDP 验证 | PR1, D2 |
| 5 | B2 纯重构 | PR1–4 |
| 6 | C1 原型处置 / C2 短期 | D3 |

每个 PR 合并前都要完成：定向测试、typecheck、sidecar 自测（自己发消息并检查日志）；涉及 UI 的 PR 还要做 CDP 截图验证。只推送到 `panyw5/opencode`。

## 6. 待决策

- **D1**：扩展钩子抛出普通错误时的语义（阻止 vs 忽略）。
- **D2**：是否新增 retry API。
- **D3**：lifecycle 原型是提交还是移出主线。
