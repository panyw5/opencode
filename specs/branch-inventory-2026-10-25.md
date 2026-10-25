# OpenCode 本地分支用途与保留状态

补充调查时间：2026-10-25 21:45，Asia/Shanghai。当时共 80 个本地分支，其中 48 个为 `worktree-agent-*`；它们不是 48 项互不相干、等待合并的功能。扩展阶段分支、任务分支、自动生成的旧标签和验证快照混在同一个分支列表里，是数量膨胀的主要原因。

本清单补足[第一轮 worktree 调查](/Users/lelouch/apps/opencode-task-2/specs/worktree-inventory-2026-10-25.md)没有覆盖的分支引用。第一轮是 21:36 的 59 条 worktree 快照；本轮登记数已变为 58：三个 Computer Use 调查树不再登记，新增了 task/3 与 task/4。这里的变化不是本次执行的清理操作。

## 空闲 agent 分支清理结果

2026-10-25 21:57，按用户要求删除了 31 个未被 worktree 检出的 `worktree-agent-*` 本地分支，保留其余 17 个仍被检出的自动分支。删除前重新确认候选与上一轮一致，全部提交均由本地 `origin/dev` 保留；执行时再次检查 worktree 占用，并以原 SHA 校验的原子事务删除。下方逐项表格已在这 31 行标记“分支已删除”，保留原 tip 供核对。

本次不删除目录、未提交文件或 stash，不触碰其他功能分支。P2 保持 `6faed064da`；dev 在并发任务中已从旧快照的 `be5e76cec8` 前进到 `64c0136f29`，首次事务因此校验中止，刷新状态后重试成功，本次没有更新 dev。删除后复核还观察到 `task/4` 分支与其 worktree 登记被并发移除，不属于这次只含 31 个 agent 标签的事务；因此最新观察到的本地分支总数是 46，而非仅扣除 31 后的 47。17 个保留的 agent 分支 tip 均未改变。

## P0 和 P1 清理结果

2026-10-25 21:51，按用户要求移除了本地分支 `claude/extensions-p0` 和 `claude/extensions-p1`，本地分支数由 80 降至 78。删除前再次验证：两者相对 `claude/extensions-p2-design` 的独有提交数都为 0，且均未被 worktree 检出；使用校验三个分支原提交哈希的原子引用事务删除，避免删除期间分支变动造成误操作。

P2 保持 `6faed064da`，dev 保持 `be5e76cec8`。目录 `/Users/lelouch/apps/opencode/.claude/worktrees/extensions-p0` 仍存在并检出 P2，它只是目录名含 P0，不在本次删除范围内。没有删除目录、未提交文件、stash 或其他分支，也没有合并、变基或推送。下表保留两个已删除分支的原 SHA 和历史用途，其余条目为 21:45 的调查快照。

## 分支与工作区的区别

分支只是指向一个提交的名字；worktree 才有自己当前检出的 HEAD 和未提交文件。创建 agent worktree 时自动留下的 `worktree-agent-xxx` 分支，后来不会因为该目录切到别的分支或 detached HEAD 而自动消失。

因此，一个 agent 可以同时留下旧自动分支和新任务分支，而真正实现仍未提交。只看 `git branch -vv` 的最后一条提交说明，会把旧上游提交误当成任务内容；只看“未合入 dev”的分支数，也会把上游历史差异误当成未交付工作。

## 扩展阶段与任务分支

| 分支 | 用途 | 当前提交与保留状态 |
| --- | --- | --- |
| `claude/extensions-p0` | 扩展宿主注册表及架构设计的第一阶段 | 已于 21:51 删除本地分支；原 tip `3d7f675f09`，2 条扩展提交全部保留在 P2 历史中。 |
| `claude/extensions-p1` | 本地扩展链接、资源服务、kit/Vite 构建与前端惰性加载 | 已于 21:51 删除本地分支；原 tip `8158e4e70c`，P0 后新增 5 条、累计 7 条扩展提交全部保留在 P2 历史中。 |
| `claude/extensions-p2-design` | 后续扩展实现、安装发布、wls-repl 与整合验收主线 | `6faed064da`；仍由目录 `extensions-p0` 检出，名字和目录不同。拥有 43 条 dev 不包含的提交，是需要继续关注的成果主线。 |
| `claude/extensions-p2-contract` | P2 manifest/settings/server 契约切片 | 分支仍是 P1 的 `8158e4e70c`；由 `agent-p2-contract` 检出，契约修改留在未提交文件中，分支本身没有新增提交。 |
| `p2-contract-worker-impl` | 重复分配的 P2 契约切片准备 | `8158e4e70c`；目录 `agent-ac2e0f7e8d3154f23`。原任务明确停止重复实现，未产生代码修改。 |
| `p2-frontend-contributions` | tool renderer、panel、command 前端贡献点 | `8158e4e70c`；目录 `agent-a9a143013d4b20a2e`，已交接的未提交切片。 |
| `p2-http-rpc-impl` | HTTP RPC 路由、超时与取消 | `8158e4e70c`；目录 `agent-a1c6109b307cb3047`，已交接的未提交切片。 |
| `p2-rpc-openapi` | RPC 可选 body 与 SDK input 契约修复 | `8158e4e70c`；目录 `agent-ad80ec022358d29b3`，已交接 owned patch。 |
| `p2-runtime-fix` | runtime 设置默认值、代际守卫与多 scope 生命周期修复 | `8158e4e70c`；目录 `agent-a97c236a19e3cee64`，已交接四文件 patch。 |
| `p2-runtime-http-settings` | 设置更新 HTTP 端点 | `8158e4e70c`；目录 `agent-ab3e7c20a2fa0c00c`，已交接 owned patch。 |
| `p2-runtime-own` | server runtime 与 RPC 生命周期 | `8158e4e70c`；目录 `agent-a30d7ed373905100e`，已交接 runtime 实现。 |
| `agent/token-decode-fix` | auth_token Base64URL、带冒号密码与错误优先级修复 | `8158e4e70c`；目录 `agent-add0f733b3bb86402`，已交接的两文件改动与共享 stash 均保留。 |

阶段关系是 P0 → P1 → P2 整合主线。P0/P1 不需要再作为独立 feature 整体合并到 P2。上表除 P2 整合主线外，当前分支提交都已经在 P2 主线历史中；这不等于各目录的未提交草稿都已逐字节验收或可以丢弃。原任务的验收与残留状态见第一轮逐树清单。

## 自动生成的 agent 分支

清理前的 48 个 `worktree-agent-*` 分支只指向 8 个已有基线。40 个分支指向本地 `origin/dev` 已包含的旧上游提交，另外 8 个指向本地 dev 或扩展整合树已包含的基线。以 `dev`、`claude/extensions-p2-design` 和 `origin/dev` 的可达提交并集为保留集合，这 48 个分支都没有集合之外的提交。

清理前其中 17 个仍被对应 worktree 检出，22 个对应目录已经 detached，8 个对应目录改用任务分支，1 个对应目录不再登记；后面这 31 个空闲标签现已删除。下面“用途”指原 agent 任务，不是分支 tip 提交标题；所有未提交成果仍须看实际 worktree。

### 自动分支是否可以删除

删除 P0/P1 后再次复核，48 个自动分支的分类没有变化：**31 个空闲分支可以仅删除分支标签**，它们的提交均已由本地 `origin/dev` 保留，也没有 worktree 检出这些名字。对应目录即使仍存在，也已处于 detached HEAD 或检出其他任务分支，删除旧标签不会删除目录和其中的未提交文件。

**另外 17 个仍被 worktree 检出的分支暂时保留**。它们没有额外任务提交，但仍是那些工作区当前的分支；要继续清理，应先确认工作区不再使用、保留未提交成果，再解除分支占用，不能为清空列表而直接删除工作目录。具体名单对应下表“仍检出此分支”的行。

这些自动分支的用途是保存 agent 初始基线或标记隔离工作环境，不是独立功能交付。空闲标签删除的主要收益是减少分支列表噪音；提交已经由其他引用保留，单删标签几乎不节省磁盘空间。真正占空间的 worktree 目录是另一项清理，不能和删分支混为一谈。上一轮仅评估可删性，随后用户明确要求清理，已于 21:57 删除 31 个空闲标签，17 个占用分支继续保留。

| 自动分支 | 原分支 tip | 原 agent 用途 | 分支清理与 worktree 状态 |
| --- | --- | --- | --- |
| `worktree-agent-a00b67133829f4786` | `3d7f675f09` | P1 manifest、registry、事件、服务与 CLI | 仍检出此分支 |
| `worktree-agent-a00e7eda37aea1f6d` | `083ed266e0` | P2 manifest 驱动最小设置 UI | 分支已删除；detached @8158e4e70c |
| `worktree-agent-a08806efc28b285cf` | `388406238b` | generation GC、purge 与重启恢复清理 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a0d353c53ad000225` | `907b3bc518` | 启停管理 API/host、互斥与跨 server stale guard | 仍检出此分支 |
| `worktree-agent-a1161217d33a114dc` | `388406238b` | 安装、更新、移除确认 UI | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a1253ef19d860921a` | `083ed266e0` | runtime 热重载真实路径、代际竞态、取消等修复 | 分支已删除；detached @8158e4e70c |
| `worktree-agent-a1a664722430ed70e` | `388406238b` | CLI install、update、uninstall | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a1bef340b0d404620` | `907b3bc518` | 异步 reconcile 旧 refresh 覆盖新状态的竞态 | 仍检出此分支 |
| `worktree-agent-a1c6109b307cb3047` | `083ed266e0` | P2 HTTP RPC 路由、超时与取消 | 分支已删除；已切到 p2-http-rpc-impl |
| `worktree-agent-a1c7ea125a6c3ab62` | `388406238b` | release UI、固定来源更新、registry v3 确认及翻译 | 分支已删除；detached @86619dfa4a |
| `worktree-agent-a22d65b962b1f24cd` | `3d7f675f09` | P1 extension-kit 与 hello-viewer | 仍检出此分支 |
| `worktree-agent-a2b98b0fc6efadac2` | `0112a92c41` | 文件 tab keepalive，防切页丢编辑草稿 | 分支已删除；detached @8158e4e70c |
| `worktree-agent-a30d7ed373905100e` | `083ed266e0` | P2 server runtime、RPC 生命周期 | 分支已删除；已切到 p2-runtime-own |
| `worktree-agent-a3dc8e8e3009b369b` | `388406238b` | registry observer | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a3ecca560092814fb` | `083ed266e0` | P2 前端 RPC、events、settings 桥 | 分支已删除；detached @8158e4e70c |
| `worktree-agent-a418f05be3d5486d7` | `388406238b` | data/cleanup/leases 删除安全与竞态只读审查 | 仍检出此分支 |
| `worktree-agent-a42f534476bc21266` | `388406238b` | 安全归档解包与校验 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a476b485a6ec85ebf` | `907b3bc518` | 扩展设置迁到 Config 页 | 仍检出此分支 |
| `worktree-agent-a490cd8512588c2f7` | `388406238b` | HTTPS 下载、摘要与网络安全限制 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a5aa65cb9502749be` | `31d708b0c8` | P2 设置数据层与事件 | 仍检出此分支 |
| `worktree-agent-a5f8d140c8039e0c2` | `907b3bc518` | app tests 窄 UI mock 污染及 rows 回归保护 | 仍检出此分支 |
| `worktree-agent-a5f9b7ac4bb166bc9` | `083ed266e0` | P2 源码 watcher 与热重载 | 分支已删除；detached @8158e4e70c |
| `worktree-agent-a647f13176160a75a` | `8158e4e70c` | 编辑 viewer 的 revision、dirty、save 与关闭拦截 | 仍检出此分支 |
| `worktree-agent-a6898065b1e3eaee2` | `388406238b` | 严格 npm 依赖图、下载与物化 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a74417f544c3ccb6c` | `388406238b` | release descriptor resolver、下载与端到端集成测试 | 分支已删除；detached @86619dfa4a |
| `worktree-agent-a7a5855e5df42efdb` | `8158e4e70c` | P2 hello-viewer RPC、事件、工具与子进程示例 | 仍检出此分支 |
| `worktree-agent-a8031cd7f5bb83055` | `907b3bc518` | watcher 并发 refresh 重复订阅修复尝试 | 仍检出此分支 |
| `worktree-agent-a87a44dace6e83bfd` | `388406238b` | prepare/commit 安装事务与 CAS | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-a8d253ebaca1016ed` | `388406238b` | 本地 descriptor 作者工具与说明 | 分支已删除；detached @86619dfa4a |
| `worktree-agent-a97c236a19e3cee64` | `0112a92c41` | runtime 设置 defaults、晚到 hooks 守卫与多 Effect scope 引用计数 | 分支已删除；已切到 p2-runtime-fix |
| `worktree-agent-a9a143013d4b20a2e` | `083ed266e0` | P2 tool renderer、panel、command 前端贡献点 | 分支已删除；已切到 p2-frontend-contributions |
| `worktree-agent-a9aa6ee366330f0b3` | `388406238b` | 独立模板 npm pack 与 release descriptor 脚本 | 仍检出此分支 |
| `worktree-agent-aa857c1e38d859aea` | `3d7f675f09` | P1 前端 ExtensionHost、惰性激活与清理 | 仍检出此分支 |
| `worktree-agent-aaaf0b398273b0185` | `388406238b` | install API 客户端测试 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-aaf5d4800e458554a` | `0112a92c41` | 前端工具 renderer 响应性、扩展 mount 等三项修复 | 分支已删除；detached @8158e4e70c |
| `worktree-agent-ab1232e1753ae34a7` | `388406238b` | 安装服务、HTTP 与 host 状态一致性只读审查 | 仍检出此分支 |
| `worktree-agent-ab3e7c20a2fa0c00c` | `083ed266e0` | P2 settings HTTP 端点 | 分支已删除；已切到 p2-runtime-http-settings |
| `worktree-agent-ac2e0f7e8d3154f23` | `083ed266e0` | 重复分配的 P2 契约实现准备 | 分支已删除；已切到 p2-contract-worker-impl |
| `worktree-agent-ac701b8c12c25701d` | `388406238b` | runtime mutation fence、quiesce 与代际门禁 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-acabe7ca3138089d0` | `388406238b` | 独立模板的宿主集成测试 | 仍检出此分支 |
| `worktree-agent-ad80ec022358d29b3` | `0112a92c41` | RPC OpenAPI 可选 requestBody 与 SDK input 丢失修复 | 分支已删除；已切到 p2-rpc-openapi |
| `worktree-agent-adbf3332d4cdd3c8a` | `388406238b` | release 来源与 registry v3/receipt/retained 契约 | 分支已删除；detached @86619dfa4a |
| `worktree-agent-adc1c106c4b8ffb96` | `388406238b` | release CLI 与 HTTP 适配、独立升版确认 | 分支已删除；detached @86619dfa4a |
| `worktree-agent-add0f733b3bb86402` | `907b3bc518` | auth_token Base64URL、带冒号密码与错误优先级 | 分支已删除；已切到 agent/token-decode-fix |
| `worktree-agent-aea18ed56e3357b08` | `388406238b` | generation/data 租约和进程存活证明 | 分支已删除；detached @3a0d101b22 |
| `worktree-agent-af0249a456e9be957` | `8158e4e70c` | 域过滤、单项容错、reconcile 幂等、失败清理与 RPC timeout | 仍检出此分支 |
| `worktree-agent-af523efb2fa59a929` | `b471c2b449` | P1 extension-kit 与 Vite 工具链只读研究 | 分支已删除；对应目录未登记 |
| `worktree-agent-af5ba124cc8bebfb7` | `8158e4e70c` | Vite CSS selector scope 与 DOM 宿主挂载 | 仍检出此分支 |

`worktree-agent-af523efb2fa59a929` 是本轮额外追溯的条目：其原任务是 2026-09-27 的 extension-kit/Vite 只读研究，已经交付研究报告，没有对应现存登记树；不是一项遗失的代码实现。

### 一个具体例子

`worktree-agent-a1c6109b307cb3047` 仍指向上游 `083ed266e0`，标题是 “docs(go): simplify usage limit explanation”。但这个 agent 实际负责扩展 HTTP RPC；其目录后来改检出 `p2-http-rpc-impl`，基于 P1 `8158e4e70c` 留下实现。两个分支名属于同一任务的环境演变，不是两个独立功能，也不能从 Go 文档标题推断任务用途。

## 随机命名的 opencode 分支

这些分支的 reflog 只记录从现有 HEAD/dev 创建，没有后续功能提交。它们是旧隔离环境留下的基线标签，而不是各自新增的一套实现。随机名字本身不包含任务语义；除 `witty-wolf` 的临时测试目录外，没有足够证据把每个随机名字绑定到更具体会话。

| 分支 | 基线与用途范围 | 当前状态 |
| --- | --- | --- |
| `opencode/brave-eagle` | P1 快照 `8158e4e70c` | 已包含在扩展整合树，无登记 worktree。 |
| `opencode/cosmic-canyon` | P0 快照 `3d7f675f09` | 已包含在扩展整合树，无登记 worktree。 |
| `opencode/kind-knight` | P0 快照 `3d7f675f09` | 已包含在扩展整合树，无登记 worktree。 |
| `opencode/playful-forest` | 数学模式整合点 `53b7b94e9a` | 已包含在 dev，无登记 worktree。 |
| `opencode/playful-nebula` | P1 快照 `8158e4e70c` | 已包含在扩展整合树，无登记 worktree。 |
| `opencode/push-dev` | 从 dev 的 quick assistant 上下文提交 `485e1b9a13` 创建 | 没有后续 push 任务提交；已包含在 dev，无登记 worktree。 |
| `opencode/sunny-island` | 数学模式整合点 `53b7b94e9a` | 已包含在 dev，无登记 worktree。 |
| `opencode/tidy-engine` | P1 快照 `8158e4e70c` | 已包含在扩展整合树，无登记 worktree。 |
| `opencode/witty-wolf` | HTTP API 全局测试临时目录中的 P1 快照 | worktree 目录已消失，登记为 prunable；分支提交已包含在扩展整合树。 |

## 其他本地分支

| 分支 | 用途与状态 |
| --- | --- |
| `dev` | 本地主开发与集成分支，`be5e76cec8`，由主工作区检出；本轮不修改该分支。 |
| `codex/model-selection-redesign` | 会话模型选择状态重构，`10ebb441ae`；无登记 worktree。相对三条主保留引用有 2 条不同 SHA 的提交，但 `git cherry -v dev` 两条均为 `-`，说明已有补丁等价提交在 dev 中，并非两项全新未集成功能。 |
| `codex/scroll-v11852-baseline` | 旧版滚动对照基线，实际后续 cherry-pick 到 1.18.53 的 `de25678728`；当前无 worktree 检出。4 条不同 SHA 的提交在 `git cherry -v dev` 中全部为 `-`，属于补丁等价的历史快照。 |
| `codex/scroll-v11855-test` | 1.18.55 滚动测试基线，`6b5e0a120a`；由旧名 `scroll-v11852-baseline/opencode` 目录检出。提交已在 dev，工作区图标及相关回归 stash 另行保留。 |
| `codex/session-collaboration` | 跨会话协作未完工主线，`ffa0b01ba4`；分支提交是 dev 祖先，但大量实现仍未提交，不能因“已合并”判断可丢弃。 |
| `release-verify/1.18.57` | 1.18.57 发布验证点，`7d636a2659`；已在 dev，无登记 worktree。 |
| `release-verify/1.18.60-r2` | 1.18.60 第二轮发布验证点，`b20530836f`；已在 dev，无登记 worktree。 |
| `release-verify/1.18.60-r3` | 1.18.60 第三轮发布验证点，`5f65bf18d9`；已在 dev，无登记 worktree。 |
| `task/2` | 本次 worktree/branch 调查，当前目录检出；基于 `be5e76cec8`，调查报告尚未提交。 |
| `task/3` | 另一独立任务的隔离分支，目录 `/Users/lelouch/apps/opencode-task-3`；当前提交为 `be5e76cec8`。具体任务内容不从编号猜测。 |
| `task/4` | 21:45 调查时为另一独立任务的隔离分支；21:57 复核时该分支与 worktree 登记已被并发移除，不属于本次 agent 标签清理。 |

补丁等价由 Git patch-id 机制判断，不保证当前最终代码或产品行为与旧分支完全相同；这里用它区分“不同 SHA”与“尚未集成的新补丁”，不替代功能验收。

## 保留判断

真正需要继续跟进的是扩展整合主线、会话协作未提交成果、滚动修复工作区，以及仍在使用的独立任务环境。P0/P1、旧自动 agent 标签、随机 opencode 标签与 release 验证点大多是历史引用，不应被统计成数十项待做功能。

可以把没有额外提交、没有 worktree 检出的旧引用列为清理审查候选，但不能据此删除对应目录、未提交补丁或 stash；17 个仍检出自动分支的目录也不能当作孤立标签处理。21:45 的调查阶段未做清理；21:51 按用户要求删除 P0/P1 两个本地分支，21:57 又按要求删除 31 个空闲 agent 标签。本任务没有切换其他工作区、合并、变基、推送或触发 Actions。

## 核验范围

逐个核对全部 `refs/heads` 的名称、tip、worktree 占用、reflog、相对 dev/扩展整合树/origin 的提交可达性；两个不同 SHA 的历史功能分支另用 `git cherry -v dev` 检查补丁等价。agent 用途沿用第一轮原任务证据，并补读了无现存 worktree 的 `af523efb2fa59a929` 原会话。

没有 fetch 或联网查询；`origin/dev` 指本地已有远端跟踪引用，不代表本轮核实了服务器最新状态。没有重新运行产品测试，本次核验目标是分支引用和任务归属。
