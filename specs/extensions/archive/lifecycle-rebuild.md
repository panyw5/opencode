# 扩展生命周期重构：事实审计与目标契约

> 已被 `../lifecycle.md` 取代（2026-11-13）。本文仅作历史参考，不再更新。

状态：**审计和重构方案，不是实现完成或验收报告。**

基线：`abc63ce659`。本轮先复现了 WLS 安装失败，并做过 archive → release 的实验性修补；在用户要求整体重构后，已撤回该组源码及测试修改，不把来源兼容分支作为交付方案。

## 1. 用户要求与不可退让的结果

- 安装、更新、卸载是同一套生命周期，不再让 UI、桌面桥、CLI 和恢复器各自补状态。
- 卸载意味着删除扩展拥有的程序包、设置（包括 secret）、数据、缓存、临时文件、宿主注册项并终止扩展进程树。
- 卸载不能在未来安装上留下“来源不匹配”的历史障碍。
- 删除失败必须可见、可重试、可跨进程重启恢复；不能提前显示“卸载成功”。
- 更新不能因为候选包下载或验证失败破坏原安装。运行切换失败必须有确定恢复路径。
- 不删除用户的 `.wls`、`.nb`、项目文件、开发链接指向的源代码、系统 Wolfram 安装或其他不属于扩展的文件。
- 不用删除所有锁、按 TTL 猜测进程死亡、忽略数据归属等方式换取“安装成功”。

## 2. 已核实的问题，而不是推测

### 2.1 本次安装失败链路

实际旧 registry 的 `retained["local.wls-repl"]` 是 archive 来源；新的目录安装是 release 来源。

旧记录与公开 stable.json 的包摘要均为：

```
004716ab52a77584c6ac8a984572bd45f73bb790889e859ed881cadc0cced288
```

链路：

```
桌面下载、校验成功
→ prepare 成功
→ commit 进入 registry
→ retained 来源继承检查拒绝
→ 明确失败被弹窗当作 unknown
→ 查询状态只能得到 failed，原错误原因丢失
```

证据：

- 后端：`~/.local/share/opencode/log/2026-11-11T081337.log`，多次 prepare 成功、commit started，没有 durable commit。
- Renderer：开发版 `logs/20261111T081335/renderer.log`，`commit response failed code=conflict`。
- `registry.ts:commitInstallation`：retained 来源决定新安装能否取得旧数据。
- `dialog-install-extension.tsx:commit`：所有异常统一转为 `installationUnknown()`。

这不是本次下载失败，也不是 stable.json 地址有误。

### 2.2 当前卸载的默认语义就是保留，而不是清除

- `install.ts:prepare`：`purgeData` 默认 false。
- `registry.ts:commitRemoval`：移除 active row，同时建立 retained，默认留下设置和 secret 分类。
- UI 以“保留数据”为默认，CLI 对 purge 也采用选项。
- retained 既参与数据安全校验，又影响后续安装批准，导致卸载历史成为安装身份的一部分。

不能仅把默认值改为 true：以下清理和运行时问题仍然存在。

### 2.3 运行时无法证明自己已卸载

`runtime.ts:defaultImporter` 直接在 sidecar 中 `import()` 后端扩展。

`generationPins` / `dataPins` 的注释和实现明确规定：即使严格 quiesce 成功，也把引用保留到进程退出。原因是导入的 JS 仍可能保留 timer/raw closure。

因此：

```
dispose 成功 ≠ 所有代码停止 ≠ data lease 释放 ≠ 包可收集
```

这与“不重启即可干净卸载”的目标冲突。不能直接删掉 pin 来掩盖问题，否则旧代码可能访问新安装的数据。

### 2.4 Bun 测试证明不了 Electron 清理能力

`leases.ts:nativeDriver` 只在 Bun + Darwin/Linux 下经 `bun:ffi` 使用 flock；Node/Electron 和 Windows 返回 unsupported。

`acquireReferenceUnsafe` 写入 `.unsupported`；`inspect` 遇到这种证明永远返回 busy。证明文件设计为不删除。

实际用户扩展目录中已存在多份 `.unsupported`，不是理论上的平台分支。

结果：即使 Node sidecar 正常释放某个本地引用，后续收集也无法据此证明旧引用已死亡。用 Bun 运行通过的 cleanup 测试不能代表 Electron。

### 2.5 崩溃恢复存在只有“保留”没有“恢复”的终点

- `cleanup.ts:recover` 对 trash 的访问者直接返回 deferred，不执行恢复删除。
- `cleanup.ts:withTrashClaim` 使用 mkdir claim，进程崩溃后没有可靠接管路径。
- `leases.ts:gated` 明确规定崩溃留下的 `.gate` 不回收；安全保守，但会形成永久不可用状态。
- `registry.ts:finishPurge` 完成后仍保留 purged tombstone。

保留不确定资源本身是安全策略，但必须配套可执行的恢复机制。不能把“永不误删”误写成“清理已经实现”。

### 2.6 状态不是单一事实来源

- registry receipts 持久化 commit / cleanupPending。
- installer Operation 另有内存 result。
- `status()` 通常返回内存 result，后台更新 receipt 后不保证同步到该 result。
- `recoverInstallations()` 依赖启动或 registry observer 触发，没有保证所有待清理任务终将被重新调度。
- UI 根据 committed 显示完成，即使 cleanupPending；安装后刷新失败也可能抛到 commit 调用层。

必须区分：持久化变更成功、运行切换成功、清理完成、客户端刷新成功。不能用一个异常或布尔值代替四件事。

### 2.7 测试的通过条件本身容许残留

`install-service.test.ts` 的替换测试明确断言：

- `cleanupPending === true`；
- 更新后旧 server.js 仍存在。

这可作为“保守保留”的测试，但不能作为生命周期完成的验收。

## 3. 新模型：安装实例、运行实例、操作分离

### 3.1 身份不再由历史下载地址决定

- extension ID：用户看到的扩展身份。
- installation ID：一次干净安装的身份；卸载完成后消失；重装生成新 ID。
- generation ID：该安装的一次版本部署；更新产生新 generation。
- source：当前版本的下载及更新渠道，不承担旧数据访问授权。
- operation ID：一次事务的进度、失败信息、恢复步骤。

数据和缓存归属于 installation ID，不归属于下载临时路径。更新保留 installation ID，卸载销毁整个 installation；下一次安装不继承旧 installation。

若未来需要保留/恢复配置，设计成显式导出/导入，不通过隐藏 retained 自动继承。本次不保留一个“卸载但其实没卸载”的模式。

### 3.2 唯一生命周期协调器

```
UI / HTTP / Desktop IPC / CLI
          ↓
ExtensionLifecycle
  ├─ ArtifactResolver（npm/release/archive/local）
  ├─ DeploymentStore（原子 registry + durable operations）
  ├─ RuntimeSupervisor（启动/停止/等待退出）
  └─ CleanupExecutor（逐项、持久化、幂等）
```

所有入口调用同一协调器。Desktop 的网络代理、文件选择和字节暂存仍是传输适配器，不拥有自己的安装、重装或清 tombstone 协议。

### 3.3 可终止的运行单元是先决条件

后端扩展转到受 supervisor 管理的独立执行进程，宿主通过受版本约束的 RPC 代理访问工具、hooks 和扩展 RPC。

- 运行资源按 installation/generation 归属。
- stop：禁止新调用 → 取消/排空请求 → dispose → 等待退出；超时终止执行进程及其受管子进程树。
- 进程退出得到确认后才释放运行引用。
- 不能让一个旧扩展的永久 pin 绑住整个 sidecar 生命周期。
- CLI/Bun 与 Electron/Node 必须使用同一监督协议，不能让 Bun FFI 是否存在改变卸载语义。
- 不宣称这是安全沙箱：扩展仍是受信代码。宿主不能回滚任意扩展在管理目录之外造成的外部副作用。

工程前置项：逐项列出 `ServerExtension`、Plugin Hooks、tool schema、metadata/attachments、events、取消信号等跨进程协议；不能把函数对象直接 structuredClone，也不能只为 WLS 写私有例外。

前端：卸载必须撤销资源 token、卸载 viewer/工具渲染器、移除样式及作用域注册项、拒绝迟到响应。现有同 realm ESM 不能保证任意不受管 JS timer 消失；若要强保证任意前端代码物理停止，必须另行改为可销毁的隔离执行上下文，不能对当前同 realm API 作虚假保证。

## 4. 三条流程

### 4.1 安装

```
resolve → download → verify → extract → validate → prepared
→ confirm → acquire mutation ownership → revalidate
→ materialize generation → publish installation
→ synchronize runtime/registrations → clean staging → completed
```

- 预览不执行扩展代码，不修改现有安装。
- 包摘要、manifest、贡献点和用户确认绑定同一候选。
- 发布前失败删除本操作候选，不更改现有安装。
- 如果旧 uninstall 尚未完成，协调器推进它或显示具体清理任务，不执行来源继承特例。
- 新安装得到新 installation ID 和干净数据命名空间；不能把历史垃圾接进新实例。
- 成功但客户端刷新失败只能报告“已安装，界面刷新失败”，不能把已确认 commit 降为 unknown。

### 4.2 更新

```
active A → stage/verify B（A 仍可用）
→ confirm → fence A → stop A and wait exit
→ switch to B → runtime readiness/registration checks
→ retire A → clean old generation + staging → completed B
```

- 更新保留 installation、设置和数据，替换 generation。
- 下载/校验失败：A 不停、不改。
- 切换前失败：清候选，A 仍是 active。
- 切换后 readiness 失败：持久化 rollback 决策，恢复 A 的指针并重新启动 A；失败结果不得只写警告。
- 在 readiness 确认前不能收集 A。
- extension 未启用或按需激活：明确验收“部署和协议可用”边界，不为预览而偷偷执行代码。
- 自动 rollback 的范围是托管部署/运行状态；任意扩展数据迁移不可能凭指针回滚。未来的数据迁移必须独立声明并具备备份/恢复协议；没有协议就不支持破坏性迁移。

### 4.3 卸载

```
installed → uninstall intent persisted → removing
→ revoke frontend/API admission → stop runtime/process tree → verify exit
→ detach active installation
→ delete generations → delete owned data/cache/settings/secrets
→ delete staging/trash/temporary records → verify manifest of resources
→ remove uninstall task → absent/completed
```

- 只有最后验证通过才显示“已卸载”。
- 若被另一实例占用或文件删除失败，保留 durable task，显示阶段/原因和重试入口，不恢复为假成功。
- 中间态记录用于恢复本次清理，完成即删除；不保留用于控制未来安装的 tombstone。
- 清理必须按记录的归属和不可变路径执行，不能按扩展 ID 递归扫用户目录。
- 开发链接只移除链接注册和宿主拥有的资源，不删除开发项目目录。
- 用户项目文档、Wolfram 安装不在删除清单内。

## 5. 持久化状态与恢复

对外至少区分：

```
prepared / applying / synchronizing / cleaning / completed
failed / rollingBack / rolledBack / blocked / unknown
```

- completed 是对应操作的后置条件已验证，不是 registry rename 成功的别名。
- operation journal 记录决定、目标路径、generation/installation 身份、已完成步骤和经过脱敏的结构化错误。
- commit、status、启动恢复和后台重试都读同一 durable operation；内存只做缓存。
- 事务回执可保留有界的审计历史，但不包含设置/secret，不参与新安装身份校验。具体保留时间/数量作为可测试策略明确确定。
- unknown 仅用于确实无法读取 durable outcome；明确拒绝必须保留原因。
- 删除先持久化目标，再移入宿主私有 quarantine，再幂等删除；每一步都能在崩溃后继续。
- 锁的生命周期由 OS/可确认的进程监督提供；禁止“超时删锁就当旧进程死了”。跨进程/跨运行时锁协议必须先实测，再依赖其清理能力。
- 旧 `.unsupported` 不可直接删掉当作死亡证明。迁移必须识别旧宿主仍在运行的情形，协调退出；不能误杀安装版 OpenCode。
- 旧 retained/settings/data 迁移为一次显式的卸载清理任务，不转换为新安装的继承权限。无法确认归属的文件必须显示具体阻塞，不能静默删或静默略过。

## 6. 实施顺序与移除清单

1. 锁定契约和资源清单；编写当前实现必然失败的端到端后置条件测试。
2. 实现 Node/Electron 与 Bun 共用的 runtime supervisor/运行引用协议；先验证退出及进程树回收。
3. 实现 durable operation store 和幂等清理 executor；故障注入验证每个 rename/delete 边界。
4. 让安装、更新、卸载统一调用协调器；迁移旧状态。
5. 移除默认 retained、来源继承特例、永久 unsupported 退化路径、只报告不处理的 trash 恢复、内存/receipt 双重状态。
6. UI/CLI/HTTP/IPC 只呈现同一状态与原因；更新 SDK、所有语言和协议测试。
7. 真实 Electron 及实际 WLS 安装/求值/更新/卸载/重装，核查磁盘和进程，不只截图看 enabled。

各项是依赖顺序，不是允许长期交付一个“默认清除=true，但实际上永远清不掉”的中间产品。

## 7. 验收矩阵

### 正常操作

- fresh install → 启用 → WLS 发送表达式并收到正确结果。
- update：下载/prepare 期间 A 的 kernel 仍能求值；B ready 后 RPC 来自 B；A 进程和旧包实际消失。
- uninstall：运行中的 kernel、挂起 RPC、打开的 viewer、样式、事件/命令注册均清理；托管包/数据/缓存/设置/secret 不存在。
- uninstall → 通过同来源重装，以及 archive → release、release → archive、npm → release 重装：新 installation 不继承旧数据、不受历史来源阻塞。
- 重复执行 20 次 install/update/uninstall，托管部署/数据/垃圾和进程数量不增长；审计回执遵循明确的有界策略。

### 故障恢复

- 下载断网、摘要不匹配、解压失败、空间不足、manifest 不兼容。
- dispose 抛错/超时、子进程拒绝退出、RPC 在切换期间返回、viewer 迟到渲染。
- materialize、publish、stop、switch、quarantine、删除各边界杀进程并重启。
- rename 后删除一半、权限不足、Windows 文件占用、另一宿主正在使用同 generation。
- commit 响应丢失但 durable commit 成功；明确 rejected；status 读取失败；刷新失败。
- 旧 `.unsupported`、崩溃 `.gate`、旧 trash 和 retained 的真实迁移夹具。
- 两个进程并发安装/更新/卸载同扩展，A→B→A 连接切换，不能操作错服务器。

### 必须分别执行的平台

- 实际 Electron Node sidecar（本机 CDP 9222）。
- Bun CLI/server。
- 远程服务器管理入口。
- 所支持的 macOS/Linux/Windows：锁、退出及删除语义分别测，不以 Bun/macOS 成功代替其他平台。

## 8. 本轮边界

本轮完成：真实失败复现、日志/registry/摘要核对、完整关键路径审计和以上重构契约。实验性来源兼容补丁已撤回。

未完成：supervisor、统一 durable 状态机、干净卸载、新恢复器、平台矩阵及最终 CDP 验收。不能将实验中一次安装成功或已有单测结果写作这些目标已交付。
