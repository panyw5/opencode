# 生命周期重构：描述符所有权与 Electron 验证

> 已被 `../lifecycle.md` 取代（2026-11-13）。本文仅作历史参考，不再更新。

状态：**已迁入 `specs/extensions/prototypes/` 的独立实验，生产安装器没有接入，仅 macOS 有验证。** 原型完整进程套件当前非全绿，历史通过记录不覆盖新运行，见[当前证据](../prototypes/README.md#验证与已知边界)。生产接入以前置完成隔离加固 A/B 为条件。

入口：[实施计划](./lifecycle-rebuild-plan.md)；资源与 API 清单：[阶段 0](./lifecycle-foundation.md)；目标依据：[审计](./lifecycle-rebuild.md)。本阶段不删除旧 lease、gate、retained 或真实用户扩展数据。

## 1. 已实现的提供者

- `specs/extensions/prototypes/src/extension/ownership.ts`：非阻塞共享/独占所有权、私有目录/文件验证、固定 marker、存储身份复核和异步释放。
- `specs/extensions/prototypes/src/extension/ownership-native.ts`：macOS BSD flock 的 Node/Electron 与 Bun 适配。
- `fs-native-extensions@1.5.3`：固定原生依赖；使用其 macOS NAPI prebuild 提供 Node/Electron 的描述符锁，不自行实现 Node addon。

`tryAcquireOwnership(file, mode)` 只返回 acquired 或 busy；不支持的平台或无法加载的原生实现抛出结构化 `OwnershipError`，不会授予退化租约。模式必须显式传入，不自动升级共享租约。

```ts
const result = await tryAcquireOwnership(guard, "exclusive")
if (result.status === "busy") {
  // 保持 durable task 待处理，不执行删除或宣告完成。
  return
}
await using lease = result.lease
await lease.assertHeld()
// 在整个依赖操作期间保持 lease；不能与 release 并发执行该操作。
```

### 1.1 安全条件

1. guard 在已有的宿主私有、本地、canonical 目录中，目录与文件属于当前用户；文件为普通文件、0600、单链接，不接受符号链接。
2. 用 O_CREAT/O_RDWR/O_NOFOLLOW 创建或打开，永不通过 truncate、unlink 或替换文件来解锁。首次初始化 marker 也必须先取得独占锁。
3. 共享读者可并存；独占者排斥所有其他描述符。busy 只是当前不能取得所有权，不表示旧 owner 已死，也不授权重建 guard。
4. marker 固定为 `opencode.extension-ownership:1` 加换行；未知内容保留并报错。它不包含设置、secret、PID、时间戳或生命周期状态。
5. 内核锁属于打开的描述符。正常释放关闭该描述符并等待完成；进程强制退出由 OS 回收描述符。其他描述符的普通 open/close 不能解除仍存活的租约。
6. `assertHeld()` 校验原目录与 guard 的 dev/ino、权限和链接属性，并在异步检查后再次确认租约未释放。路径被替换或释放中的检查不能作为继续修改的许可。
7. 释放幂等，同一租约的重复释放共享完成结果。Bun 的 FFI library 在描述符关闭后才释放；Node addon 的映射由 Node loader 持有，不是扩展 generation 的运行 pin。
8. 这是协作式宿主所有权，不是防止同 UID 可信扩展任意写宿主文件的安全沙箱；所有读者和写入器必须遵守同一协议。网络文件系统不在已验证范围内。

### 1.2 仍由协调器负责的条件

guard 本身不证明某个 generation 仍可被加载。取得共享引用时，协调器仍须在 mutation guard 下检查 store、installation/generation 和准入 epoch；删除前必须撤销准入并协调所有读者退出。旧 owner 的迟到提交由 durable revision/epoch 拒绝，不能只靠一个 flock 替代。

这批尚未定义或启用生产 guard 布局与回收。测试只在所有描述符和进程都已释放后删除自身临时目录。最终卸载中如何删除 guard 元数据、避免新读取者重新取得旧身份，需要连同 store 的准入撤销一起实现，不能提前 unlink 活跃锁文件。

## 2. 平台适配与被排除的机制

| 形态                   | 当前实现                                | 当前证据/限制                                                         |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| macOS Node             | 固定包内的 NAPI binary，BSD flock       | 实际 Node 进程持有、强杀、跨运行时争用及其他 FD 关闭场景              |
| macOS Electron utility | 同一 NAPI binary 与 BSD flock           | 真正 utilityProcess.fork；不是 ELECTRON_RUN_AS_NODE 替代              |
| macOS Bun              | bun:ffi 调 libSystem 的 flock/\_\_error | 同一 BSD flock 协议；含成功与 busy 路径测试                           |
| Linux                  | 提供者明确拒绝                          | Node addon 使用 OFD 锁，Bun 共用协议尚未验证，不能混用 flock 当作等价 |
| Windows                | 提供者明确拒绝                          | 锁、文件 ACL、Job Object 与占用删除仍待实现和实测                     |

Node/Electron 显式选择并加载固定包的 NAPI binary；包入口的 runtime resolver 不参与所有权协议。Bun 1.3.9 缺少 `uv_get_osfhandle` 和 `uv_translate_sys_error`：仅能 require 成功不代表锁 API 可用；调用依赖的 NAPI/C libuv 路径会导致 Bun 进程崩溃。因此 Bun 使用 macOS 系统 flock 适配，不调用这些入口，也不把崩溃捕获当作恢复策略。

依赖版本、binary 路径和 NAPI 调用签名是显式适配条件；升级依赖必须重新执行 Node/Bun/Electron 的成功、busy、崩溃释放和普通 FD 操作用例。原生文件无法交付或加载时必须报 unsupported，不能生成永久 `.unsupported` 引用。

### 2.1 为什么不使用 SQLite 事务作租约

本轮在隔离目录实测了 Node/Bun SQLite guard，包括实际 Electron utility 的持锁与强杀释放。它能通过基本互斥和崩溃测试，但不足以满足引用证明。

反例：Node 在 SQLite 共享事务仍存活时，用另一文件描述符 open/close 同一数据库；外部进程随后可取得独占事务。进程级 POSIX record lock 会受其他 FD 关闭影响，原 SQLite connection 仍可能认为自己持锁。文件工具等宿主代码不能承受这个隐含条件，因此 SQLite guard 未作为实现保留。

固定回归是：owner 持有共享引用 → owner 内另开并关闭同一 guard → 外部独占者仍须 busy。该场景在 Node、Bun 和实际 Electron utility 中均覆盖。主生命周期存储仍按阶段 0 决定使用单一原子 registry 快照；guard 不是另一个状态数据库。

## 3. 真实进程与 Electron 探针

`test/extension/fixtures/ownership-worker.mjs` 运行实际所有权提供者，提供 acquire/assert/release/touch/exit 命令。touch 刻意用独立 FD 打开、关闭 guard。Node 和 Bun 直接运行同一源入口；Electron 使用同一入口的 Node ESM bundle。

`specs/extensions/prototypes/scripts/extension-lifecycle/main.cjs` 是隔离、无窗口的测试 app，仅 fork 探针 utility，不导入产品 main、server、用户设置或扩展 registry。测试为每次运行建立独立 userData/logs 和模块目录，运行后等待 utility 与 main 退出再删除目录，不关闭安装版 OpenCode。

- 正常退出：worker 释放描述符并确认 → utility exit → 探针 main exit。
- 强制退出：main 只向自己创建且已确认 PID 的 utility 发送 SIGKILL → utility exit → 检查原 guard inode 可重新取得独占锁。
- 控制通道断开：main 停止所属 utility，等待 exit 后退出；不依赖未来 UI 或 registry observer 恰好触发。
- stdout/stderr 断开也触发收尾，避免测试 runner 退出后留下无窗口 Electron main。

Electron 的 utilityProcess.kill() 在实测中可能产生 exit code 0；代码 0 不能单独证明扩展做过正常 dispose。强杀回归使用 SIGKILL 和实际重获锁来验证 OS 资源释放，不把退出码当作完整进程树证明。

所有权探针本身不是完整 RuntimeSupervisor。后续[执行实例增量](../lifecycle-supervisor.md)已有内部 JSON 请求准入/排空和单根监督，但受管子孙进程树、旧 owner 接管和全部 Hooks 代理仍未完成；utility exit 不能代替任意子进程退出证明。

## 4. 验证命令与范围

从项目根执行（依赖准备见原型 README）：

```sh
bun run --cwd specs/extensions/prototypes test:process
bun run --cwd specs/extensions/prototypes test:electron
bun run --cwd specs/extensions/prototypes typecheck
```

所有权用例覆盖共享/独占互斥、最后一个读者释放、竞争者关闭不伤害现存 owner、重复释放、检查与释放并发、路径替换、未知 marker、symlink、权限错误，以及 Node/Bun owner 的 SIGKILL 后重获锁。未验证平台有专门的拒绝测试，不因 macOS 结果通过就被记为支持。

Electron 用例显式开启，只验证本轮新提供者与真实 utility process。原有 `OPENCODE_EXTENSION_LIFECYCLE_TARGET=1` 五个目标契约测试仍用于追踪旧生产生命周期的缺口，不能因为新所有权提供者通过就标为已修复。

执行环境为 macOS，Bun 1.3.9、Node v25.9.0，实际 utility 使用 Electron 41.2.1 的 Node v24.14.1。本轮最终定向组合为 **28 pass / 9 skip / 0 fail**：跳过项包括五个尚未满足的生产目标契约、三个需要显式开启的 Electron 用例，以及仅在非 macOS 执行的平台拒绝用例。

显式开启的实际 Electron 组合为 **3 pass / 0 fail**；并发运行的独立 ownership 测试进程为 **12 pass / 1 skip / 0 fail**。结束后检查无本批探针/夹具进程残留。`bun run typecheck`、新增脚本的 Node 语法检查和 `bun install --frozen-lockfile --ignore-scripts` 通过；依赖锁仅增加该原生包及其传递依赖，没有修改工作区版本。

本地原始结果在 `.artifacts/extension-lifecycle/phase1.vTbRGv/{focused,electron,independent-ownership,typecheck,cdp}.log`，是忽略的运行产物。开发实例的 CDP 9222 本轮不可连接；没有为此关闭安装版应用或启动产品 main，也不将无窗口 utility 测试记为产品 GUI 验收。

Linux/Windows、签名/asar/发布版原生依赖交付、真实 WLS 更新卸载及完整生命周期仍未验收；提供者没有替换生产 leases 或 installer。

## 5. 下一步门槛

1. 将[执行根监督与准入模型](../lifecycle-supervisor.md)接入 durable Store，完成全部读者登记、epoch 提交与可恢复接管。
2. 实现并实测 Linux/Bun 与 Node 的同协议锁，以及 Windows 锁/ACL/Job Object；前置证据不齐不启用生产写入器。
3. 在 Node/Electron 构建与打包中交付所需 prebuilds，验证签名、asar 外加载和支持的 CPU/运行时；源码探针链接依赖不能替代这一项。
4. 只有完整监督与 Store/cleanup executor 连通后，替换旧 leases/pins 和 installer 编排；旧格式数据与证明文件仍走显式迁移。
