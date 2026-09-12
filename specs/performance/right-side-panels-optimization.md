# 右侧文件与审查面板优化实现方案

状态：待实施。本文只规定方案，不代表相关功能已实现。

项目路径：`/Users/lelouch/apps/opencode`

覆盖范围：桌面端右侧「所有文件」「更改」「审查」，及其文件预览、数据服务和跨平台路径处理。

## 1. 目标与实施边界

### 1.1 目标

- 文件清单不依赖完整 patch 或 before/after 文本。
- 折叠文件不解析补丁、不创建代码查看器、不初始化评论编辑控制器。
- 同一工作区、差异模式的刷新串行合并，不因文件事件风暴并发计算全量 Git diff。
- 刷新保留旧内容和对象身份，不先清空整个列表。
- 「更改」树直接由变更路径构建，不读取真实目录。
- 「所有文件」只挂载视口内的可见行；审查重内容只在视口附近挂载。
- macOS、Windows、远程文件系统的路径比较、请求和缓存键遵循同一明确契约。
- 保留文件选择、评论原始行号、粘性标题、滚动恢复、拖拽和键盘操作。

### 1.2 不做的事情

- 不改数据库中的项目目录和历史 session 标识，不进行全库路径迁移。
- 不把客户端系统当作远程文件系统平台。
- 不直接把全量上下文缩成三行而继续从 before/after 重新计算 diff。
- 不通过增大 Worker 数量、缓存条目数或固定延迟掩盖重复工作。
- 不在第一阶段同时重写虚拟列表、公开接口和所有全局路径调用点。
- 不引入重命名识别等与性能无关的行为变化；保留现有 no-renames 语义。
- 不改变旧版公开接口的默认返回格式，新增能力采用兼容式扩展或独立接口。

### 1.3 已确认的基线

- 开发版 Electron 的隔离测量：100 个文件，每文件改 2 行、携带 3000 行上下文，总 patch 约 6.95 MiB；仅现有内容 memo 首次解析约 65 ms，相同顺序重建约 25–29 ms。该测量不包含网络、组件挂载及代码渲染，也不是正式性能门槛。
- 「所有文件」关闭后仅宽度归零，本次测试的 33 个文件按钮仍挂载；界面状态已恢复。
- 当前路径测试通过：core 8 项，app 文件路径 37 项。现有通过用例未覆盖下述原始文件名和标准 Windows file URL 问题。
- 当前开发版选中的是非 Git 工作区，不能据此给出真实大型 Git 会话的端到端性能结论。

## 2. 现有实现与目标结构

### 2.1 主要现有文件

| 职责 | 现有文件（相对项目根） |
| --- | --- |
| 面板挂载、显隐、文件 tab | `packages/app/src/pages/session/session-side-panel.tsx` |
| 模式选择、VCS 请求、事件监听、审查定位 | `packages/app/src/pages/session.tsx` |
| 真实目录树、过滤、递归行 | `packages/app/src/components/file-tree.tsx` |
| 目录状态及请求去重 | `packages/app/src/context/file/tree-store.ts` |
| 文件内容、watcher、文件缓存 | `packages/app/src/context/file.tsx`、`packages/app/src/context/file/watcher.ts` |
| 面板路径及内部 file tab | `packages/app/src/context/file/path.ts` |
| 文件预览 | `packages/app/src/pages/session/file-tabs.tsx` |
| session diff 数据服务 | `packages/app/src/context/global-sync/session-diff-service.ts` |
| 审查列表、展开、评论控制器 | `packages/ui/src/components/session-review.tsx` |
| 补丁解析、文本恢复与缓存 | `packages/ui/src/components/session-diff.ts` |
| Pierre 查看器生命周期 | `packages/ui/src/components/file.tsx` |
| Worker 与共享行级虚拟化 | `packages/ui/src/pierre/worker.ts`、`packages/ui/src/pierre/virtualizer.ts` |
| 上下文感知路径工具 | `packages/core/src/util/path.ts` |
| SDK 工作区路径上下文 | `packages/app/src/context/sdk.tsx`、`packages/app/src/pages/layout/helpers.ts` |
| Git 清单与 patch | `packages/opencode/src/git/index.ts`、`packages/opencode/src/project/vcs.ts` |
| 文件列表、读取 | `packages/opencode/src/file/index.ts` |
| session 历史差异存储读取 | `packages/opencode/src/session/summary.ts` |
| 公开 API | `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`、`handlers/instance.ts` |

### 2.2 目标结构

```text
SDK 工作区上下文 + 路径边界适配
  -> 工作区身份 / 文件身份
  -> review-data-service
       -> 轻量 manifest -> 计数 / 状态标记 / 纯路径更改树
       -> 可见且展开文件 -> 单文件 patch -> Worker 解析 -> DiffViewer
  -> file-tree-store
       -> 按需目录列表 -> 独立展开状态 -> 可见行索引 -> 虚拟化
  -> file-content-service
       -> content-only read -> 文件预览
```

新增模块名称是建议，并非现有文件：

- `packages/app/src/pages/session/review-data-service.ts`：模式数据、合并刷新、manifest 和文件内容生命周期。
- `packages/app/src/pages/session/change-tree-model.ts`：变更路径索引和目录状态汇总。
- `packages/app/src/context/file/identity.ts`：工作区相对文件身份适配，不另造全局路径规范。
- `packages/app/src/context/file/visible-tree.ts`：目录树可见行索引。
- `packages/app/src/components/change-tree.tsx`：纯路径更改树。
- `packages/ui/src/pierre/diff-metadata-cache.ts`：有界解析结果缓存。

先将异步状态机提取成可独立测试的纯服务，再接组件；避免继续扩大 `session.tsx`。

## 3. 跨平台路径契约：必须先确定

### 3.1 四种值不能混用

| 值 | 用途 | 禁止事项 |
| --- | --- | --- |
| 逻辑路径 LogicalPath | API、展示、保留文件名拼写；Windows 分隔符为 `/` | 不因身份比较而改成小写 |
| 路径身份 PathIdentity | Map/Set、请求去重、节点 key、缓存命中 | 不传给文件读取或 shell |
| 原生路径 NativePath | 后端文件系统、Git cwd、Electron shell、watcher 边界 | 不作为前端树节点和持久化新键 |
| tab / URL / route slug | UI 标签或传输编码 | 不当作原始文件名，不重复解码 |

已有 core `Path.logical/identity/native/isInside/relative/route` 应优先复用。注意：目前 `Path.logical` 和 `Path.identity` 不统一折叠 dot segments；不能假设仅调用 identity 就能去除 `.` 和 `..`。需要项目相对解析时，使用显式的 resolve-within 操作并独立测试。

### 3.2 平台来自路径拥有者

- 优先使用后端返回的文件系统平台与能力信息；在现有 `/path` 返回中兼容增加可选 metadata，字段名在 API 设计时最终确定。
- 复用 `sdk.pathContext`，不让 FileProvider 再自行依据路径前缀推断整套规则。
- 已明确本地连接时，旧后端可沿用现有本地 platform fallback。
- 远程平台未知时，保留现有保守 POSIX 策略，不折叠大小写、不重写反斜杠；取得明确的远程 Windows metadata 后再使用 Windows 分隔符语义。
- 远程 Windows 的大小写比较策略需要明确能力，不能仅把 context.kind 改成本地以启用现有 case-fold。
- 虚拟工作区和 URL 命名空间保持不透明，不套用文件系统大小写或分隔符规则。

### 3.3 macOS 与 Windows 的具体规则

| 场景 | 规范 |
| --- | --- |
| macOS/POSIX `src/a\b.ts` | 反斜杠是文件名字符，不拆为目录；编码到 tab 时成为 `%5C` |
| macOS/POSIX 大小写 | 保留大小写并默认区分身份，不因为常见卷不区分大小写就全局 lowercase |
| Windows `C:\Repo\src\App.ts` | 逻辑路径 `C:/Repo/src/App.ts`；身份按现有明确本地 Windows 策略比较 |
| Windows 相对 `src\App.ts` | 根据工作区 Windows 上下文转成 `src/App.ts`，不能因没有盘符就漏掉处理 |
| Windows `C:foo` | 是 drive-relative，不当作 `C:/foo`；新的文件读取接口拒绝该歧义输入 |
| Windows `\foo` | 是 rooted-relative，不擅自补盘符；协议入口要求明确绝对路径或工作区相对路径 |
| UNC `\\server\share\Repo` | 逻辑路径 `//server/share/Repo`；保留 server/share 根，不折叠成单 `/` |
| 不同 Windows 盘符或 UNC share | 不得匹配同一工作区，不得简单去掉首字符后当相对路径 |
| Windows case-sensitive 目录 | 当前全局策略不支持这类精细身份。首阶段保持已有策略；若宣称支持，必须先引入后端能力和大小写测试，不能悄悄合并两个真实文件 |
| `/tmp` 与 `/private/tmp` | 仅在明确 macOS 本地工作区且后端确认规范根/别名时匹配，不对任意平台字符串做替换 |
| 中文、NFC/NFD、空格、emoji | 不在客户端任意 Unicode 归一化；保留后端权威拼写；需要别名时由后端确认 |
| Windows extended-length/device path | 不进入通用逻辑路径替换；设备命名空间拒绝，合法 extended-length 本地路径在后端专门适配，并补 Windows 实机测试 |

### 3.4 原始路径、Git 输出、内部 tab、标准 file URL 分别解析

当前 `createPathHelpers` 对所有输入统一执行 strip query/hash、decodeURIComponent、Git unquote，必须拆开：

- 原始路径：不删除 `#`/`?`，不解码 `%20`，不去引号。这些都可能是 POSIX 文件名字符。
- Git 输出：只在 Git 语法边界解 quote/octal；优先复用现有 `-z` 结构化输出。已经解码的路径不得再次 unquote。
- 内部 tab：兼容已有 `file://src/app.ts` 格式，但它不是标准绝对 file URL；保留专用 parser，按段编码/解码一次。内部 tab 中的 authority-looking 首段仍是相对文件路径。
- 标准 file URL：用明确的 URL 输入分支解析 `file:///C:/...` 和 `file://server/share/...`；正确处理 Windows pathname 前的盘符斜杠和 UNC host。
- route slug：只使用 `Path.route` 编解码，不再当文件名解 URL。

建议新入口使用显式 source 判别，例如 raw、git、tab、file-url；内部调用点不能依赖字符串猜测。旧 `normalize(input)` 保留临时兼容包装器，逐个迁移生产者和消费者后再收紧。

UTF-8 Git 解码器必须同时处理八进制字节和直接出现的 Unicode 字符，不能对任意 Unicode 字符 `charCodeAt` 后塞入 Uint8Array。无效转义不应静默映射到另一个文件。

已复现、应新增回归断言：

```text
工作区 C:\repo + file:///C:/repo/src/App.ts
  当前输出 C:/repo/src/App.ts；应得到 src/App.ts

原始 POSIX 路径 src/a#b.ts
  当前输出 src/a；应保持 src/a#b.ts

原始 POSIX 路径 src/a%20b.ts
  当前输出 src/a b.ts；应保持 src/a%20b.ts

POSIX 文件 src/a\b.ts 转内部 tab
  当前变成 file://src/a/b.ts；应保留反斜杠文件名并可往返
```

### 3.5 工作区相对路径与文件身份

新的 resolve-within 适配器负责：

1. 按 source 解传输编码，按拥有者平台解释分隔符。
2. 区分绝对、相对、drive-relative、UNC、虚拟值；拒绝不符合入口契约的类型。
3. 使用段级边界检查，不能让 `/repo2` 命中 `/repo`，不能让 `C:/repo2` 命中 `C:/repo`。
4. 对明确相对输入处理 dot segments；不得逃出允许根。符号链接及 `..` 的实际解析仍由后端决定，不能把词法 isInside 当作安全证明。
5. 将合法文件转为工作区相对逻辑路径，保留名称大小写及 POSIX 反斜杠。
6. 产生比较身份；Windows 相对路径不能直接调用目前只对绝对本地路径 fold 的 `Path.identity`。需结合明确工作区根和身份策略计算。

建议每个节点保存 `fileKey`、`path`、`name`，可另有 `repositoryPath`。`fileKey` 用于身份，`path` 是实际请求路径；严禁用 lowercase key 读文件。

工作区键至少包含连接/服务域身份、文件系统命名空间和 directory identity。不能仅用 projectID：同一项目的不同 worktree 必须隔离。连接切换需要 namespace epoch，旧请求不得回写新连接。

复合键使用嵌套 Map 或结构化 tuple 编码，不用 `directory + "\n" + file`：POSIX 路径可以包含换行。内容键再包含 mode、session/turn、revision、context 和 schema/parser version。

Git 返回的 repository-relative 路径与 SDK directory-relative 路径需要单独映射；工作区位于仓库子目录时，结合 repo root 和 `Git.prefix` 确定基准，不通过随意字符串截断处理。

### 3.6 持久化兼容

- 新树展开状态、文件选择和审查锚点使用带版本的新键；不全量覆盖旧数据。
- 首次读取旧状态，通过专用 legacy tab/path parser 迁移，保留原记录作为回退。
- 对已丢失字符、歧义路径，不推测原文件；保留未解析状态并记录原因。
- 不修改全局 `pathKey`、`toLogicalPath`、数据库键以一次性统一所有调用者。先在本面板范围使用显式 PathContext 适配，避免影响全局缓存和路由。
- 内容缓存保持非持久化；无需迁移旧的 patch 文本缓存。

## 4. 第一阶段：消除重复工作，保持旧接口

### 4.1 可观测性先行

新增可开关的性能跟踪，默认仅记录慢操作/错误与窗口聚合，不逐文件刷日志，不记录文件正文或 patch。

日志用字符串，字段包含 traceID、workspace namespace、mode、reason、revision、队列等待、请求/后台阶段耗时、字节数、缓存命中、创建/复用/卸载数量、被合并事件数。完整路径仅调试开关下输出，默认用身份摘要。

后台拆开 status/stats/patch/read/serialization 阶段；前端拆开 response/normalize/index/parse/viewer-ready 阶段。所有失败、取消、过期丢弃、缓存淘汰均有对应原因日志。日志不得把 Desktop JS 对象直接打印到 console。

### 4.2 VCS 合并刷新服务

修改 `session.tsx`，把 `vcsTask/vcsRun/resetVcs/loadVcs/stopVcs` 移入建议的 review-data-service。服务生命周期绑定连接和工作区，不绑定审查 DOM 的挂载。

每个 workspace/mode 保存：data、initialLoading、refreshing、error、dirty、requestedGeneration、appliedGeneration、inflight、flushTimer。

状态规则：

1. 首次没有数据时显示 loading；后台刷新有数据时仅显示 refreshing，保留旧列表。
2. 文件事件只置 dirty；采用短合并窗口，初始建议 150 ms，持续事件设置最大等待窗口，参数由测量决定。
3. 请求进行时不删除 inflight。事件继续合并到 dirty，不并发启动第二次请求。
4. 响应只提交给相同 connection epoch、workspace 和 mode；记录应用的 generation。
5. 若期间又发生事件，允许提交为暂时旧值但标记 dirty，随后最多启动一个补刷；不得谎称数据已经 fresh。
6. 错误保留旧数据和 dirty，使用有界退避重试，不立即自旋；未打开时不持续重试。
7. 隐藏时保留 dirty，取消未启动任务；已完成响应可入缓存，但不触发重内容挂载。
8. workspace/connection 切换取消未启动任务并隔离旧结果。支持 AbortSignal 时取消不再需要的请求，但不能假设前端 abort 已终止后台 Git 子进程。

后台相同请求并发计算采用 Effect 服务/InstanceState 生命周期与 `Effect.cached` 等既有模式共享；实现时验证请求中断是否传播到 Git 进程。前端 single-flight 是必需保证，后台取消是额外能力。

审查打开、手动刷新、idle 状态、branch 更新、watcher 都进入同一调度入口，不能保留旁路 force-fetch。

### 4.3 稳定更新

- VCS 列表按 fileKey 协调更新，未变化记录保持身份；只新增、删除或修改对应节点。
- 目录刷新保留未变化 node 的代理身份及 children 顺序身份；用协调更新/字段比较，不逐次覆盖所有对象。
- 版本字段和统计变化不应自动销毁未改变内容的 DiffViewer。
- synthetic 更改节点由索引持有稳定对象，不在每个目录 memo 中重新创建。
- 更新发生在 batch 内，避免多个字段更新触发中间状态渲染。

### 4.4 真正延迟解析

将重内容拆为 ReviewDiffBody 子组件；只在展开、未被大文件保护阻止、且已允许挂载时创建内容 memo 和查看器。折叠标题直接使用 status/additions/deletions，不为旧记录 badge 解析大补丁；未知 status 显示通用 modified 或在正文载入后补全。

评论先在列表级按 fileKey 建索引，标题只获取评论数。编辑控制器、annotation bridge 和全局监听在重内容边界创建。展开 membership 使用 Set/索引而非每项反复扫描整个 open 数组。

保留现有 500 changed-lines 的用户保护，但另外记录总字符、最长行与解析耗时。点击 render anyway 只解除对应文件保护，不解除全局并发预算。

第一阶段保留面板关闭时的既有卸载行为也可接受，前提是重开没有全量解析，状态和缓存位于组件之外。动画通过轻量 shell 重放，不依赖销毁全部重内容。

## 5. 第二阶段：拆分 manifest 与单文件内容

### 5.1 数据模型

建议的 manifest 包含 revision、mode、规范 directory、路径能力，以及每项 fileKey、path、repositoryPath（必要时）、status、additions、deletions、binary/contentKind、contentRevision。不得携带 patch/before/after。

内容响应包含 fileKey、manifestRevision、contentRevision、patchFormat、patch、truncated、unavailableReason；必要时包含 immutable before/after 引用。空文本、二进制、超限、不存在、缺失历史快照必须是可区分状态，不能统一返回空 patch。

### 5.2 API 兼容式扩展

具体 URL 为设计建议：

| 能力 | 实施建议 |
| --- | --- |
| Git/branch manifest | 新增 `GET /vcs/changes?mode=git|branch`；复用现有 status/stats，但 branch 必须针对同一 base ref，不能直接复用仅 working-tree 的 `/vcs/status` |
| 单文件 patch | 新增 `GET /vcs/diff/file?mode=...&path=...&revision=...&context=...` |
| session/turn manifest | 为现有 session diff 增加显式轻量能力或新增 changes endpoint，session 和 turn 均明确版本/消息边界 |
| session/turn 单文件 patch | 从对应历史差异或快照读取，不从当前工作树伪造历史内容 |
| content-only read | file read 增加兼容参数或独立读取能力，旧默认仍保留 Git 补丁返回 |

新增 query/success/error schema 在 Effect HttpApi group 定义，handler 关闭捕获稳定服务；同步 public schema/覆盖检查与 SDK 生成产物。使用 `packages/sdk/js/script/build.ts` 既有生成流程，不手改生成文件代替契约更新。

旧后端通过 capability 选择旧全量接口；404/明确不支持才回退，鉴权错误、权限错误和网络错误不当作不支持。

### 5.3 版本一致性

- manifest 固定解析出的 HEAD/base commit，包含 working-tree generation。
- working tree 并非原子快照。请求开始/结束检查 generation，并结合目标文件状态/摘要验证；结果发生变化时返回明确 stale revision 错误，让服务重新取 manifest。
- 不把仅仅递增一个 watcher counter 宣称为文件系统事务。外部编辑与 watcher 延迟仍需内容校验和最终一致性处理。
- session/turn 使用历史快照/存储版本，before 和 after 引用必须属于同一个内容版本。
- 新接口后端重复校验路径范围、repository mapping 与权限；前端规范化不是权限检查。
- 对真实读取路径执行既有授权范围检查，并针对符号链接、已删除文件和最近存在父目录验证边界。不能把新增词法 helper 当成完整的 symlink 安全实现。

### 5.4 后台工作量

- Git manifest 不生成 patch；未跟踪文件计数如需读取，采用有界并发/内容版本缓存，不声称其完全无 I/O。
- 单文件 patch 使用 Git native patch，不先遍历全部文件。
- 首版 session manifest 可从现有存储读取完整差异后投影字段：收益是减少传输和前端解析，不声称已消除后台 JSON 读取。
- 后续在 summarize 时并行产出 manifest 和按文件内容索引，先写内容再发布 manifest 版本；避免版本指向未完成内容。不需要第一版修改数据库结构。
- 二进制/media 展示使用该版本的快照引用；无法恢复历史内容时明确提示，不悄悄用当前文件替代。

### 5.5 纯路径更改树

新增 change-tree-model，一次构建 parent -> ordered children / trie。沿每个路径逐段插入，同时汇总目录 kind 和统计，接近 O(总路径段数 + 各目录局部排序)。不用各目录遍历所有 files/dirs。

目录节点和叶子都包含稳定 fileKey 与保留拼写的 path；同一 Windows 身份出现多种拼写时优先权威 manifest spelling；发现真实冲突则记录错误，不在未知平台静默合并。

changes 的展开状态独立于 all。可以自动展开变更祖先，但不触发 file.tree.expandDir，不读取 filesystem，删除路径照常显示。

「所有文件」的变更状态通过 manifest 索引 O(1) 查询；不订阅 patch 内容，不因为正文缓存变化重算整树。

## 6. 第三阶段：差异解析、缓存与查看器增量更新

### 6.1 直接消费 patch metadata

扩展 UI File diff mode，让它明确接受解析后的 FileDiffMetadata；调用 Pierre render 的 fileDiff 参数，不再强制 oldFile/newFile 重新生成 diff。

复用 `parsePatchFiles` 或合适的 Pierre patch parser，保留原始 hunk 的 oldStart/newStart、context、无末尾换行和二进制信息。审核多文件 patch/引用路径匹配，不能无条件拿第一个文件。

兼容旧 before/after 输入，但只作为 fallback。现有 preloadedDiff 若继续保留，必须真正接到 hydrate/render 路径并有测试；否则不把未消费的参数当作缓存能力。

在直接 metadata 路径通过原始行号和评论回归后，单文件默认 context 才可缩为 3–20 行。扩展上下文通过明确的版本化范围请求；历史版本缺少完整内容时禁止伪造未改动行。

### 6.2 解析 Worker 与预算

保留现有 Shiki Worker 池，另评估 patch parsing 是否适合复用任务协议或独立轻量 Worker；不直接修改第三方 Worker 的私有协议。

小 patch 可在闲时解析，超过经过基线确定的字符/耗时阈值转 Worker。队列优先级为当前焦点、视口内展开项、overscan；过期任务丢弃。初始内容请求并发建议 2–4、解析并发 1–2，均为待校准参数。

「展开全部」只改变逻辑 open 集合，不立即加载和初始化所有文件。目标文件定位可临时提升任务优先级。

### 6.3 缓存

按 workspace namespace + mode + session/turn + fileKey + contentRevision + context + parserVersion 键缓存。模块内使用非响应式 Map 保存大文本/metadata，响应式 store 只持有状态和轻量引用。

采用 byte-budget LRU：命中移动到 MRU，估算 patch、metadata、文本和可选高亮占用，避免按固定条目计数。初始总预算建议 32–64 MiB，需按实际堆采样校准；不要给每种 mode 各自无限叠加预算。

锁定当前正在选择/编辑/展示内容，其他内容按预算淘汰。隐藏已展开项可保留 metadata，但不无限保留 DOM 实例。workspace/connection 移除时清理对应缓存与任务。

### 6.4 查看器更新分类

- 内容版本不变、仅统计/标题变化：不操作查看器。
- annotations/selection 变化：使用对应 setter，只更新差异部分；无变化跳过 rerender。
- diffStyle/options 变化：审核当前 Pierre 支持的增量更新 API，优先 setOptions/rerender，不能假定所有配置都能原地变更。
- fileDiff 版本变化：更新 metadata/render；若第三方限制必须重建，则只重建对应文件。
- 模式切换/文件卸载：清理资源，但缓存和展开/选择状态保留在外部模型。

保留共享行级 virtualizer，不对同一代码区叠加竞争滚动根的第二套行级虚拟器。对 preserve/ready/restore 的布局读取统一调度到帧边界，避免每项交错读写。

## 7. 第四阶段：所有文件可见行与审查文件级懒挂载

### 7.1 所有文件

先提取 visible-tree 纯模型，输出 fileKey、parentKey、depth、type、expanded、path。仅遍历已展开目录，目录列表与展开状态分离；文件请求入队且有并发上限。

使用仓库已有虚拟化方案，初始固定行高按实际样式测量。当前节点 h-6 且有 gap，不能直接假定步长就是 24 px；加载行/错误行也纳入模型。

overscan 初始建议上下各 8–16 行；DOM 行数应随视口大小有界，而非固定要求所有设备小于 100 行。折叠/展开时保留可见锚点，避免跳动。

保留 tree/treeitem 的可访问语义、方向键/展开/选择、拖拽数据和有效命令键绑定。普通行尽量复用单图标；如果 hover 换色必须双图标，只为实际挂载行创建。

目录深度装饰改由可见行/祖先信息推导，移除现有用于画线的全展开子树 deeps 扫描，或将其变成局部增量数据。

### 7.2 审查

首版保留所有轻量文件标题和稳定 anchors，仅对正文做 visibility gate。使用统一 observer/调度器，而非每文件独立轮询。正文未挂载时提供估算/已测高度占位，避免滚动范围塌陷。

定位流程改为模型驱动：定位 fileKey -> 确认逻辑展开 -> 提升内容任务 -> 挂载正文 -> 等待明确 ready -> 二次精确定位评论。替换现有最多 60/120 帧的盲目 DOM 重试，保留超时和取消日志。

评论编辑或文本选择中的正文暂时 pin，不因刚移出视口就销毁。焦点和编辑草稿明确外置/保持，防止用户输入丢失。

只有轻量标题仍在大规模用例中成为主要瓶颈时，才引入完整文件级虚拟列表。完整虚拟化必须重做 sticky header、动态高度和模型索引定位，不作为第一轮必做项。

### 7.3 显隐与滚动恢复

面板 shell 可持续挂载；隐藏时停止重内容加载/解析和无意义 DOM 更新。空闲窗口后按预算释放查看器，不用固定延迟定义正确性。

review scroll 写入按帧合并，与文件 tab 已有调度方式保持一致；持久化还需检查底层是否合并，不能每 scroll event 直接触发完整存储写入。

保存 fileKey + intra-item offset 作为主锚点，绝对 x/y 作兼容回退。展开集合、样式和内容版本改变后采用锚点恢复；用户交互立即取消自动恢复。header-only、全文准备与评论 ready 分开通知，避免重复抢滚动位置。

## 8. 文件预览与文件列表后台优化

- content-only read 不执行 Git diff/show/structuredPatch，保留原文本的空白、CRLF 和末尾换行；不沿用当前 trim 作为新读取语义。
- 预览 cache key 使用读取结果的 contentRevision，避免每次挂载对大文本进行多次全量 checksum；旧后端 fallback 在服务层只算一次。
- 普通代码虚拟化同时考虑行数、字符数、最长行与 wrap，不仅看 500,000 字符阈值。阈值由 CDP 基线确定。
- watcher 对关闭/淘汰内容优先标记 stale，而不是因为曾有 FileState 就立即重读；当前可见或确实需要的文件才重新载入。
- 文件列表的 ignore matcher 按工作区和 ignore 文件版本缓存，在 `.gitignore`/`.ignore` 变化时失效；范围和既有忽略语义不在此次顺带修改。
- 目录数据可以有字节/节点预算，但已展开和正在选择的路径必须受保护；先量化长期内存再决定是否实施目录 LRU。

## 9. 测试与验收

### 9.1 路径测试矩阵

纯函数测试必须显式传入 darwin/win32/linux context，可在 macOS 上验证 Windows 字符串规则；不能用宿主 `path` 的默认语义模拟 Windows。

| 类别 | 必测用例 |
| --- | --- |
| POSIX 原始文件名 | `a#b.ts`、`a?b.ts`、`a%20b.ts`、`a\b.ts`、引号、空格、换行、中文、不同 Unicode 拼写 |
| Windows drive | 原生/正斜杠/混合分隔符、盘符大小写、路径大小写、盘符根、不同盘符、drive-relative、rooted-relative |
| UNC | 原生 UNC、逻辑 UNC、标准 file URL、share 根、不同 share、host 大小写及明确身份策略 |
| URL 与 tab | 标准 Windows/POSIX file URL、内部相对 tab、编码 `%23/%25/%5C`、只解码一次、query/hash 不混入 raw 文件名 |
| 工作区边界 | `/repo` 对 `/repo2`、`C:/repo` 对 `C:/repo2`、dot segments、外部绝对路径、仓库子目录、不同 worktree |
| 命名空间 | mac 客户端连 Windows 后端、Windows 客户端连 POSIX/WSL/SSH 后端、虚拟工作区、两个连接相同 directory |
| 身份与请求 | 等价 Windows 输入合并一个 node/请求，但实际读取 path 保留权威拼写；mac 不随意合并大小写或反斜杠文件名 |
| 根/别名 | `/`、`C:/`、UNC share；mac 后端确认的 tmp/private 别名；不能跨平台套用别名 |
| Git 边界 | NUL 分隔路径、quoted/octal UTF-8、已解码路径不二次处理、仓库子目录 prefix 映射 |

补充现有 core path、app path、watcher、file-cache-key 和 file-tree 测试，并给新增 identity/model/service 配独立测试。迁移现有测试中刻意保留原生相对分隔符的断言时，说明新 logical contract，不简单删测试。

### 9.2 服务与后端测试

- 1000 次事件只产生合并后的串行刷新，同 key 并发为 1；持续事件期间在最大等待窗口内有进展。
- 请求中途发生变化会补刷；旧 workspace/connection 响应不回写；错误退避不自旋。
- 刷新前后未变化节点身份相同，改变一个文件只更新对应项，不先清空 data。
- manifest 不生成 patch；单文件接口不走全仓库 patchAll。
- git/branch/session/turn 模式版本正确；branch base ref 与 manifest 一致。
- stale revision、binary、truncated、missing snapshot、permission denied 有独立明确响应。
- 仓库子目录、空仓库、未跟踪文件、删除文件、CRLF、多 hunk、无末尾换行、超长行、中文文件名正确。
- content-only read 的 Git 调用次数为零，原始字节/换行语义正确。
- 新 HttpApi endpoint/schema 与 SDK 同步；鉴权、workspace routing 和覆盖检查不过度回退。
- 后端路径穿越、跨盘符、UNC 与符号链接范围测试不依赖前端校验。

### 9.3 组件与性能测试

- 100/1000 个折叠审查项：解析计数为零、查看器创建计数为零。
- 「展开全部」：正文请求和解析有预算，视口外不立即初始化所有查看器。
- 100/1000/10000 文件变更索引：构建耗时随总路径段数增长，无每目录全局扫描；目录请求数为零。
- 单目录 10000 文件：真实挂载行数受 viewport + overscan 约束。
- 只刷新一个文件：其他标题、查看器、选区、评论草稿不重建。
- 热重开：不重复请求 fresh manifest，不全量解析，内存预算以内复用 metadata。
- 滚动、panel resize、样式切换、评论定位、新增/编辑/删除、拖拽、键盘导航正确。
- 隐藏面板不继续触发正文重任务；重开后消费 dirty 状态，界面不长期停留旧数据。
- 记录冷/热打开至首个可交互列表、首个可见正文 ready、长任务数量/最长任务、帧间隔、响应字节、堆增长和 viewer mount 数。

可先采用目标：受控 fixture 的列表热打开不引入超过 50 ms 的面板主线程任务；收益与基线比较，端到端正文耗时不硬套网络无关的绝对阈值。时间门槛必须用多次采样和固定环境，先把计数/身份/并发等确定性指标设为 CI 强约束。

### 9.4 实机验证要求

- 前端通过开发版 Electron CDP 9222 测试；先检查是否运行，不关闭已安装的正式 OpenCode。
- 测试前读取实际 keybind overrides；尽量点击语义按钮，不能用源码默认快捷键猜测。
- 后台日志由实施者直接读取，验证实际 Git 请求、错误、合并和取消行为；不得要求用户代读日志或代测功能。
- Windows 字符串单测不能代替 Windows 实机/CI：额外验证 Git pathspec、UNC 文件读取、file URL、原生 shell 边界和 CRLF。
- Windows CI/远程 action 仅在 `panyw5/opencode` 执行，push 也仅到该 fork；未得到请求时不主动 push 或触发 action。
- 改到 sidecar/IPC 功能时由实施者完成端到端测试；本面板优化不为测试而向用户现有会话发送无关消息。

## 10. 建议实施批次与完成标准

| 批次 | 改动范围 | 完成标准 |
| --- | --- | --- |
| A：基线与路径契约 | 路径适配、显式 source、sdk.pathContext 接入、新测试、日志；不改全局 DB/路由键 | raw/tab/URL 往返、Windows/UNC 身份、mac 特殊文件名通过；后续模块只消费合法 logical path/fileKey |
| B：调度与惰性解析 | review-data-service、事件入口合并、保留旧数据、稳定 reconcile、ReviewDiffBody | 刷新并发 1；100 个折叠项解析 0；未变化项不重建 |
| C：纯路径更改树 | change-tree-model/change-tree、独立展开状态、manifest 索引接口 | 「更改」目录请求 0；移除 D × F 扫描；all 展开不被 changes 污染 |
| D：轻量 API 与按需内容 | VCS/session manifest、单文件 patch、content-only read、API/SDK、版本协议 | 列表无 patch；只有需要文件取内容；历史版本及原始行号正确；旧后端可回退 |
| E：metadata/Worker/cache/viewer | 直接 patch metadata、解析任务队列、byte LRU、增量更新 | 不从恢复文本再 diff；视口优先；同内容换样式尽量复用；超限可控 |
| F：可见行与正文窗口 | all 虚拟化、review body gate、锚点定位、隐藏暂停、滚动合并 | 大目录 DOM 有界；评论和选区不丢；滚动/定位/重开跨平台通过 |
| G：后台和长期内存优化 | ignore matcher 缓存、stale 内容策略、可选目录预算 | 日志证明后台重复工作减少，长期切换/打开无不可控内存增长 |

C 可先复用旧响应里的轻量字段，先消除目录 I/O；D 再替换数据来源。E 的直接 metadata 与行号回归完成前，不启用缩短 patch context 的新行为。

每批次单独评审和验证，保留可回退边界。新接口能力、差异 metadata 路径、all 虚拟化分别控制，避免一个总开关掩盖故障来源。回退只替换具体路径，不撤销已经通过的跨平台正确性修复。

推荐先完成 A–C：它们直接消除已确认的重复工作，并为后续 API 和虚拟化提供可靠路径身份。最终以同一组 fixture 的请求次数、解析次数、对象复用和 CDP traces 对比验收，而不是以动画看起来更快作为完成标准。
