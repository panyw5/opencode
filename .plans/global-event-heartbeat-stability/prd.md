# Sending / Heartbeat Stability - Root Cause Review

> 状态：**completed**
> 日期：2026-08-11

## 1. 目标

定位桌面端发送消息后长期停留在发送状态、`/global/health` 无响应和 heartbeat 中断的问题，并把修复收敛到有运行时证据支持的最小变更。

## 2. 已确认根因

### 2.1 `Snapshot.diffFull` 同步阻塞 Node 事件循环

`SessionSummary.summarize` 会调用 `Snapshot.diffFull(from, to)`。`diffFull` 对每个文本文件调用 `structuredPatch(..., { context: Number.MAX_SAFE_INTEGER })`，底层 Myers 差分在大文本上进入最坏复杂度。

触发条件是已进入 snapshot index 的文本文件随后增长到 2MB 以上。现有 `limit` 只阻止未跟踪大文件首次进入 index，不能阻止已跟踪文件继续增长。

阻塞期间 provider stream 无法被消费，health、heartbeat 和所有业务事件同时停止，因此 UI 一直显示发送中。

运行时证据：

- `20260811T053405/server.old.log` 最后一条 processor 日志停在 `stage=stream-created`。
- V8 CPU profile 中 `execEditLength` 占 93% 以上样本。
- 暂停栈对应 `Notebooks/arakawa-connection.nb`，输入约 2.45MB 和 5.93MB。
- 加入大文件保护后，日志持续出现 `stage=patch-skipped`，随后正常进入 `step-start`、`reasoning-start` 和 `text-start`。

### 2.2 编码目录 header 是独立的路由缺陷

SDK 将 `x-opencode-directory` 写成 `encodeURIComponent(directory)`，服务端此前直接把 header 当作路径。包含空格或特殊字符的目录会路由到错误 instance。

日志已确认请求 header 为 `%2FUsers%2F...%20...`，解码后才是实际 workspace 路径。

该问题可以造成 ghost session，但不是 Node 主线程 100% CPU 的原因。

## 3. 最终保留的变更

### 3.1 大文件 diff 降级

`packages/opencode/src/snapshot/index.ts`：当 `before` 或 `after` 的 UTF-8 字节数超过 2MB 时，不调用 `structuredPatch`，返回 `patch: undefined`。`file`、`additions`、`deletions` 和 `status` 继续保留。

`packages/opencode/test/snapshot/snapshot.test.ts`：覆盖已跟踪文件从小文件增长为大文件后再次变化的回归场景。

### 3.2 目录 header 解码

`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`：对 header 安全执行一次 `decodeURIComponent`，非法百分号编码时保留原值。最终实现不保留诊断期的 raw-header 额外日志。

`packages/opencode/test/server/httpapi-workspace-routing.test.ts`：覆盖 SDK 编码 header 和旧客户端未编码 header。

## 4. 已移除的无效改动

- `cross-spawn-spawner` 的 `setImmediate` 完成调度和进程日志：CPU profile 未指向 child-process close callback。
- `session-working` 将 idle 强制视为非工作状态：只隐藏发送中 UI，会掩盖后端仍在执行或已卡死的事实。
- `session/tools` metadata 合并和开始时间保留：与事件循环阻塞无关。
- heartbeat schema 注册及 instance handler 常量替换：当前生成 SDK 的 SSE runtime 没有配置 `responseValidator`，不会因 union 缺少 heartbeat 而重连。
- instance heartbeat 11 秒测试：只验证既有 `Stream.tick`，没有覆盖已确认根因且显著拖慢测试。
- “业务事件后仍有 heartbeat”测试：单个业务事件无法复现所谓 merge 饿死，并会被合法后台事件打断，实测不稳定。
- `/global/event` 共享 queue 重写：没有可重复证据证明 `Stream.merge` 会在业务事件后永久饿死 heartbeat；当前工作树最终不保留该改写。
- snapshot 大文件跳过日志：行为已有回归测试覆盖，不在每次 session summary 时重复写 info 日志。

## 5. 被排除的假设

### 5.1 SDK schema validator 导致重连

生成 SDK 的 SSE parser 支持可选 `responseValidator`，但当前 client 没有设置它。运行路径只执行 `JSON.parse`，TypeScript union 不参与运行时解析。

### 5.2 `Stream.merge` 被业务事件拖死

现有测试在旧 `Stream.merge` 实现上能收到 heartbeat；日志中的 heartbeat、health 和 provider stream 是同时停止的，更符合主线程同步阻塞，而不是单个 stream 分支饥饿。

### 5.3 child-process close callback 热循环

V8 profile 和暂停栈均定位到 `diff` 包的 `execEditLength`，没有 child-process 调度热点证据。

## 6. 验证重点

```bash
# packages/opencode
bun test test/server/httpapi-workspace-routing.test.ts test/snapshot/snapshot.test.ts --timeout 30000
bun run typecheck

# repository root
git diff --check
```

sidecar 验证应确认：编码目录请求落到正确 workspace；目标 session 能收到完整 assistant 响应；大文件被跳过 patch 后 `/global/health` 仍可响应。
