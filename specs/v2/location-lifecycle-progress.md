# Location Lifecycle 实施进度（交接笔记）

> 任务：按 `specs/v2/location-lifecycle.md` 逐步实施 4 个 PR。本文件记录进度，供新会话接续。
> 更新时刻：**PR1 全部完成并已提交**。下一阶段是 PR2（后端工作租约）。

## 全局约束

- 仓库 `/Users/lelouch/apps/opencode`，分支 `dev`，push 只到 fork `panyw5/opencode`。
- 工作区有用户未提交 WIP（`global-sync.tsx`、`sidecar.ts`、`project.ts`、`models-snapshot.js`、`instance-context.ts` 里的 existsSafe→404 注释、
  `project.test.ts`、`session-file-changes.*`、`session-status-float.tsx`）。**提交只 stage 自己的文件**。
- 测试命令：
  - 后端：`cd packages/opencode && bun test test/...`
  - 前端：`cd packages/app && bun test --preload ./happydom.ts ./src/...`
  - typecheck：`cd packages/opencode && bun run typecheck`（tsgo）
- Effect 4.0.0-beta.66 坑：`Effect.fork` 不存在，用 `effect.pipe(Effect.forkChild)`；`SynchronizedRef.makeUnsafe/modify/get` 可用；
  错误用 `Schema.TaggedErrorClass`，`yield* new XError(...)` 即 fail；`catchTags` 的 key 是完整 `_tag` 字符串（如 `"LocationLifecycle.LocationUnavailable"`）。
- 测试规范：`testEffect(layer)`、`it.live` 真实时钟、`tmpdirScoped({git:true})`、并发同步用 Deferred 不用 sleep。
- 层拓扑：大 `Layer.provide([...])` 列表内兄弟层互不注入，需求向外冒泡；同名 layer const（如 `AppFileSystem.defaultLayer`、`InstanceLayer.layer`）
  按引用 memoize 共享实例。`InstanceLayer.layer = InstanceStore.defaultLayer + 真 InstanceBootstrap`。
- 禁用 Agent 子代理。

## 已完成

### PR1.1 特性化测试（已提交 `c459f8449b` test(instance): cover directory lifecycle gaps）

- `packages/opencode/test/project/instance-lifecycle-gaps.test.ts`（新）：3 个测试全过——
  缺失目录可 load 成功、dispose 后无围栏复活（bootstrap 2 次）、worktree 删除后实例仍留缓存（同 ctx 对象）。
- `packages/app/src/context/global-sync/child-store.test.ts`（追加 2 个测试）：disposeDirectory 触发 onDispose、
  dispose 后 child() 再触发 onBootstrap。5 个测试全过。

### PR1.2 LocationLifecycle 影子准入门禁（已提交 `202edc00d8` feat(instance): add location lifecycle admission gate）

- `packages/opencode/src/project/location-lifecycle.ts`（新）：
  - 错误：LocationNotFound/Unavailable/Deleting/Deleted/Busy/GenerationMismatch/DeleteFailed（tag 前缀 `LocationLifecycle.`）。
  - `Service` + `Interface`：`provide({directory, purpose}, effect)`（准入→existsSafe→store.load→markRunning→effect(provide InstanceRef)→ensuring release）
    和 `snapshot(locationID)`（扫内存 Map，**未加 location.ts getByID**，PR3 再说）。
  - 内存态：`Map<canonicalDir, Entry>`，Entry.ref = SynchronizedRef<EntryState>；generation 恒 0；无空闲回收（shadow 模式）。
  - `layer` 需 `InstanceStore.Service | AppFileSystem.Service`；`defaultLayer` 自含二者（仍需外部给 InstanceBootstrap）。
  - 日志：`[location-lifecycle] admission-request/lease-acquired/lease-released/runtime-started ...`。
- `packages/opencode/test/project/location-lifecycle.test.ts`（新）：4 个测试全过——并发准入共享一次 boot 且 leases=2
  （注意要双 Deferred 屏障防快照竞态）、成功/typed fail/defect/中断都释放租约、boot 失败回 stopped 可重试、
  缺失目录→LocationUnavailable 且不 bootstrap。

## 已完成：PR1.3 HTTP 实例路由接入 lifecycle（两个提交）

### `2bc1ff268b` fix(server): tolerate bun placeholder response on async upgrade rejection

- 接入 lifecycle 后中间件多了 `existsSafe`（异步 fs），暴露一个 **Bun node:http 兼容层既有坑**：
  upgrade 请求若未在同一事件循环 tick 内被消费，Bun 的 `onNodeHTTPRequest` 会给 socket 分配占位
  `ServerResponse`；platform-node `makeUpgradeHandler` 的惰性 `nodeResponse()` 再 `assignSocket` 就抛
  `ERR_HTTP_SOCKET_ASSIGNED`，fiber 死亡、响应被吞，WS 客户端无限挂起（最小复现：handler 里一个
  `Effect.yieldNow` 就触发；Node 无此问题）。
- 修复：`patches/@effect%2Fplatform-node@4.0.0-beta.66.patch`（bun patch，已登记进 package.json
  `patchedDependencies` + bun.lock）——惰性创建前先查 `socket._httpMessage`，有则复用占位响应。
  升级成功路径不受影响（不触发惰性创建）。
- 教训：**upgrade 路由的任何拒绝响应都不能跨越异步边界**，除非有此补丁。

### `95682de616` refactor(server): admit instance routes through lifecycle

- `instance-context.ts`：`provideInstanceContext` 改走 `lifecycle.provide({directory, purpose:"http-request"}, ...)`。
  **catchTags 换成 `Effect.catchIf(isAdmissionError, ...)`**——泛型 E 下 catchTags 的 handler 参数会被推成
  `LocationUnavailable | Extract<E, ...>` 联合，访问 `.directory` 直接 TS 报错；catchIf + 类型谓词没这问题。
  轻量路径加了 existsSafe→404（`missingDirectoryResponse` 共用，die 一个 HttpServerResponse 穿透 error boundary）。
- `server.ts`：大 provide 列表在 `AppFileSystem.defaultLayer` 后加
  `LocationLifecycle.layer.pipe(Layer.provide(AppFileSystem.defaultLayer))`。
- 测试：`httpapi-instance-context.test.ts` 补 404 测试；**decode-fallback 测试改为先 mkdir 那个乱码目录**
  （门禁会拒缺失目录，原测试断言的"乱码路径也能 load"正是被消除的行为）；`httpapi-promptasync-context.test.ts`
  层列表同样补 `LocationLifecycle.layer`（缺了会 "Service not found"）。

### PR1 收尾验证结果

- `bun test test/project/`：113 pass 0 fail。`bun run typecheck`：干净。
- `bun test test/server/`：仅剩 3 个**既有失败**（stash 基线同样挂）：`httpapi-compression` 阈值测试、
  `project-init-git`、`httpapi-session` not-found 测试；`httpapi-math-worker` 偶发 flaky（基线也会）。
- **不要并行跑两个 bun test**（数据库/端口争用会假超时）。

## 待办（PR2–PR4）

- **PR2** `refactor(session)` / `refactor(runtime)`：`scheduled-task/service.ts` line ~109 直接 `instances.load({directory})` →
  改走 `lifecycle.provide({purpose:"scheduled-task"})`；session 执行（purpose `session-run`）、PTY（`pty`）、background job（`background-job`）同样包租约。
  验证成功/失败/中断/finalizer 恰好释放一次租约。空闲回收保持关闭。
- **PR3** `feat(project)` / `fix(worktree)`：`location.sql.ts` 加列 `lifecycle_state/lifecycle_generation/delete_operation_id/time_unavailable/time_deleted`
  + 迁移（不得因本地路径缺失就标 deleted）；`location.ts` 加 `getByID`；`LocationLifecycle.delete`（fail-if-busy、deleting 围栏、幂等 operationID）；
  `worktree/index.ts` remove 改为 `LocationLifecycle.delete` 内的文件系统适配器；启动恢复 deleting 行（目录不在→补完墓碑；仍在→保持围栏）。
- **PR4** `feat(instance)` / `fix(app)`×2（两半必须同发）：启用 2 分钟空闲回收（TestClock 测）；前端 `global-sync.tsx` onDispose 移除
  `client.instance.dispose()`；project close 改纯 detach，移除 `layout.tsx` ~line 776-820 的 lastProject/路由注册复活路径。
- spec 的 Test Invariants（15 条）和 Release Validation（8 条）在收尾时对照。

## 验证过的关键事实

- `store.load({directory: 不存在})` 成功（fs.up 上探不到 .git → fallback dir:hash）——已用测试证实。
- `bun run typecheck` 在 PR1.2 后干净。
- 并发准入测试需要双屏障：bothInside（等两个都进来）+ bothObserved（等两个都快照完），否则租约释放与快照竞态。
