# OpenCode worktree 用途与进度调查

调查时间：2026-10-25 21:36，Asia/Shanghai。范围为当前仓库的全部已登记 worktree。

后续补充：[全部本地分支用途与保留状态](/Users/lelouch/apps/opencode-task-2/specs/branch-inventory-2026-10-25.md)。该清单覆盖本轮未单独列出的 P0/P1 阶段分支、48 个自动 agent 分支、随机命名分支及其他验证快照，并区分分支标签与实际工作区成果。本页数量与活跃状态保留为上述时间的快照。

清理更新：2026-10-25 21:51，已验证并删除本地 P0/P1 分支；21:57 又按用户要求删除了 31 个空闲 `worktree-agent-*` 标签，保留 17 个占用分支，具体见上述分支清单。承载 P2 的 `extensions-p0` 目录保留；本任务没有删除任何 worktree 或未提交成果。

共 59 条记录：58 个目录存在，1 条失效；现存目录中 50 个有未提交状态、8 个干净；24 个处于 detached HEAD，3 个被仍存活的 Claude 会话锁定。这里的未提交状态不等于任务未完成：多数扩展子任务已交接给整合树，但隔离副本仍保留原始补丁。

主要未落地成果集中在两处：扩展整合分支有 43 条 dev 不包含的提交；会话协作功能则保留了大量未提交实现，停在 A10。另有三个正在进行的内置 Computer Use 只读调查。不能按目录名、是否干净或提交日期直接判断能否删除。

## 关键工作区

| 工作区 | 用途 | 当前进度 |
| --- | --- | --- |
| `/Users/lelouch/apps/opencode`，`dev` | 主开发与集成工作区 | HEAD `be5e76cec8`；20 个未提交状态条目，涉及引用当前会话新建会话、侧栏样式、全文检索、shell 提示与模型快照。不是干净发布基线。 |
| `/Users/lelouch/apps/opencode/.claude/worktrees/extensions-p0`，`claude/extensions-p2-design` | 扩展系统整合与验收；目录名 P0 已过时 | HEAD `6faed064da`；相对 dev 落后 1 条、独有 43 条；另外 4 个未提交条目。已推进到 P2 runtime、P3a 安装管理、release 安装、独立模板、wls-repl 调试器、目录安装及重装修复，尚未合入 dev。 |
| `/Users/lelouch/apps/opencode/.worktrees/session-collaboration`，`codex/session-collaboration` | 跨会话引用、读取、创建、发送与干预 | HEAD `ffa0b01ba4` 是 dev 祖先，落后 369 条，无分支独有提交；81 个未提交状态条目。计划记载 A01–A09 已验收，A10 进行中，A11–A18 待做，不能视为完整交付。 |
| `/Users/lelouch/.codex/worktrees/a131/opencode`，detached | 流式消息滚动后重新接管底部跟随的修复 | HEAD `c59a2b229f`，落后 dev 292 条；4 个条目。新增 `shouldResumeLiveBottom`、恢复 live/follow 状态、前后日志及测试，未提交；旧基线代码与当前 dev 已演化，不能直接整包覆盖。 |
| `/Users/lelouch/.codex/worktrees/scroll-v11852-baseline/opencode`，`codex/scroll-v11855-test` | 旧版滚动行为对照与回归环境 | 实际 HEAD 为 1.18.55 的 `6b5e0a120a`，落后 dev 137 条；当前仅图标修改。另有专用 stash 保留回归 harness，不能因当前无功能代码差异认定没有成果。 |
| `/Users/lelouch/apps/opencode-task-2`，`task/2` | 本次 worktree 调查 | 调查开始时与 dev 同为 `be5e76cec8`，干净；本次仅新增此清单。 |

### 扩展整合树的实际完成边界

- P0/P1 和 P2 runtime、贡献点、设置及启停管理已有提交；P2 核心提交为 `eeac7a5adc`。
- P3a 安装、更新、移除的主实现提交为 `86619dfa4a`；release 安装、模板、wls-repl 与拖拽安装等后续成果已在 `6216969c38` 本地提交。进度文档中较早的“未提交”不再描述这些代码的当前 Git 状态。
- 10 月 25 日又提交了目录安装、卡片统一、启动清理恢复、purge-aware CAS 及同字节归档重装修复；最新整合提交是 `6faed064da`。旧子任务不应重新整体合入，以免覆盖这些修正。
- 最新重装记录报告后端组合 589 pass / 0 fail、typecheck 通过，并有隔离开发版安装、移除后立即重装的实机闭环。这些是原任务记录，不是本次重跑结果。
- 仍有边界：sidecar 直接从公网 release URL 安装在本机 fake-IP 网络下被拒，目录安装已通过 renderer 下载及本地归档通道验通；完整多服务器、跨平台与故障矩阵没有整体验收证据。
- 当前 4 个未提交条目是 `file/index.ts`、模型快照、`content-search.ts` 及其测试，主要是检索性能与日志，不是“整个扩展功能仍未提交”。

进度依据：[扩展进度](/Users/lelouch/apps/opencode/.claude/worktrees/extensions-p0/specs/extensions/progress.md)、[wls-repl 最新任务记录](/Users/lelouch/apps/opencode/.claude/worktrees/extensions-p0/specs/extensions/wls-repl-tasks.md)及实际提交图。判断当前提交状态时，以 Git 为准。

### 会话协作的实际完成边界

已验收 A01–A09：schema、目标定位、权限、发现与详情、分页 transcript、变更读取、只读工具接入、引用 UI、持久操作记录。A08 记录有 Electron CDP 9222 的 19 项断言验收，但使用隔离内存 SDK/storage fixture，不代表真实 sidecar 或模型推理已验通。

A10 停在独立创建的取消、事实性 outcome 与崩溃恢复修正；A10.2 后台 dispatch 尚未开始。A11 发送、A12 创建/发送工具与卡片、A13 活动聚合、A14 问答干预、A15 权限干预、A16 可见审计、A17 managed owner 路由、A18 完整 sidecar/桌面验收均 Pending。不能将九个 Accepted 解读为整个功能完成一半的准确工作量百分比。

依据：[完整计划及验收表](/Users/lelouch/apps/opencode/.worktrees/session-collaboration/.trellis/tasks/09-12-session-collaboration/plan.md:374)。

## 正在使用的 Computer Use 调查树

下表路径均以 `/Users/lelouch/apps/opencode/.claude/worktrees/` 为前缀。三者 HEAD 都是 `fecd50d21f`，与本地 `origin/dev` 相同，但任务明确要求只读研究原主工作区，不基于隔离树实现。

| 目录 | 任务 | 状态 |
| --- | --- | --- |
| `agent-a019cd7416ba5f22b` | 内置 `computer_*` 总体架构、状态、审批与焦点恢复方案 | 干净且锁定；调查时原会话仍有新日志，尚无最终交接。 |
| `agent-ac3f256194fdbfc59` | Computer service 到 Electron main/sidecar 的认证私有通道、取消与 runtime 接入 | 干净且锁定；调查中，尚无最终交接。 |
| `agent-afb60e1722b473264` | Computer 面板、预览、急停、人工接管、Electron/Swift helper 包装与构建 | 干净且锁定；调查中，尚无最终交接。 |

三个锁都关联仍存活的 PID `16067`，原会话 ID 为 `a48277be-cd3a-4707-a5f8-958c4ca09c59`。干净是因为任务只读，不是可清理信号。它们相对 dev 的大幅分叉来自上游历史，不表示本任务实现了数千条新提交。

## 扩展历史子任务逐树清单

下列 49 个目录均位于 `/Users/lelouch/apps/opencode/.claude/worktrees/`。加上上文 3 个 Computer Use 树和 1 个扩展整合树，即全部 53 个 Claude worktree。

“条目”指 `git status --short` 的行数；未跟踪目录可能折叠为一条，不等于实际文件数。“交接”是原会话报告状态，不表示隔离树自己已提交，也不表示每个残留文件都经过逐字节整合核验。历史测试数只用于说明当时交付程度，不是当前 HEAD 的重新验证。

### P1 与 P2 实现

| 目录 | 用途 | 未提交条目 | 原任务进度 |
| --- | --- | ---: | --- |
| `agent-a00b67133829f4786` | P1 manifest、registry、事件、服务与 CLI | 9 | 已交接；12 项测试、类型检查及 CLI 冒烟通过。 |
| `agent-a22d65b962b1f24cd` | P1 extension-kit 与 hello-viewer | 4 | 已交接；kit 7 项测试、示例构建通过。 |
| `agent-aa857c1e38d859aea` | P1 前端 ExtensionHost、惰性激活与清理 | 9 | 已交接；6 项 host 测试通过，整包类型检查当时依赖父树契约。 |
| `agent-p2-contract` | P2 server/web manifest、设置与 kit server 契约 | 8 | 保留契约实现及测试；分支仍停在 P1 HEAD，未找到同名会话日志，不能单独确认该副本最终交接结论。 |
| `agent-ac2e0f7e8d3154f23` | 重复分配的 P2 契约实现准备 | 0 | 已明确停止重复实现；仅建分支，无代码成果。 |
| `agent-a5aa65cb9502749be` | P2 设置数据层与事件 | 34 | 已交接；扩展 25、bus 21 项测试及类型检查通过。多数额外改动是测试用基线脚手架，不属于最终交付。 |
| `agent-a30d7ed373905100e` | P2 server runtime、RPC 生命周期 | 6 | 已交接；runtime 14、扩展 28 项测试通过。 |
| `agent-a5f9b7ac4bb166bc9` | P2 源码 watcher 与热重载 | 2 | 已交接；watch 13、扩展 27 项测试及类型检查通过。 |
| `agent-a1c6109b307cb3047` | P2 HTTP RPC 路由、超时与取消 | 7 | 已交接；定向 20 项通过。副本中的 runtime 是临时 stub，不能拿整个树直接集成。 |
| `agent-ab3e7c20a2fa0c00c` | P2 settings HTTP 端点 | 9 | 已交接；6 项新测试及类型检查通过，有 owned patch。 |
| `agent-a9a143013d4b20a2e` | P2 tool renderer、panel、command 前端贡献点 | 7 | 已交接，与前端 bridge 子任务已对齐整合顺序。 |
| `agent-a3ecca560092814fb` | P2 前端 RPC、events、settings 桥 | 9 | 已交接；44 项扩展测试及类型检查通过。 |
| `agent-a7a5855e5df42efdb` | P2 hello-viewer RPC、事件、工具与子进程示例 | 9 | 已交接；9 项测试及 Node ESM 产物冒烟通过。 |
| `agent-a00e7eda37aea1f6d` | P2 manifest 驱动最小设置 UI | 17 | 已交接；14 项新测试及类型检查通过，包含入口和掩码/清空处理。 |
| `agent-a1253ef19d860921a` | runtime 热重载真实路径、代际竞态、取消等修复 | 16 | 已交接；runtime 25、扩展 39 项通过；根目录保留两个补丁。 |
| `agent-a97c236a19e3cee64` | runtime 设置 defaults、晚到 hooks 守卫与多 Effect scope 引用计数 | 21 | 已交接四文件 owned patch；6 项新增回归先红后绿，扩展 79 项及类型检查通过；其余契约是测试用副本。 |
| `agent-af0249a456e9be957` | 域过滤、单项容错、reconcile 幂等、失败清理与 RPC timeout | 10 | 已交接；59 项测试及类型检查通过。 |
| `agent-af5ba124cc8bebfb7` | Vite CSS selector scope 与 DOM 宿主挂载 | 10 | 已交接，报告声明实现和验证完成；隔离副本仍保留改动。 |
| `agent-a647f13176160a75a` | 编辑 viewer 的 revision、dirty、save 与关闭拦截 | 18 | 已交接；同时保留为编译复制的依赖契约，不应整体覆盖整合树。 |

### 审查与集成修复

| 目录 | 用途 | 未提交条目 | 原任务进度 |
| --- | --- | ---: | --- |
| `agent-aaf5d4800e458554a` | 前端工具 renderer 响应性、扩展 mount 等三项修复 | 5 | 已交接 owned patch；记录有类型检查通过。 |
| `agent-ad80ec022358d29b3` | RPC OpenAPI 可选 requestBody 与 SDK input 丢失修复 | 27 | 已交接；空 body、合法 input、坏 body 和 OpenAPI 契约测试通过；仅少量 owned delta，其他为临时依赖。 |
| `agent-a2b98b0fc6efadac2` | 文件 tab keepalive，防切页丢编辑草稿 | 6 | 已交接；文件清单区分了自身修改和复制依赖。 |
| `agent-add0f733b3bb86402` | auth_token Base64URL、带冒号密码与错误优先级 | 2 | 已交接；18 项测试及类型检查通过；相关 stash 当前仍存在。 |
| `agent-a1bef340b0d404620` | 异步 reconcile 旧 refresh 覆盖新状态的竞态 | 1 | 已交接最小补丁与生产 helper 红绿测试；当时要求主树应用后再跑整体检查。 |
| `agent-a8031cd7f5bb83055` | watcher 并发 refresh 重复订阅修复尝试 | 661 | 原会话以模型参数 API 错误结束，未找到成功交接；大量工作区差异不等于完成 661 项修改，指定 watch 文件当前无 tracked diff。需单独核对，不能整体集成或直接删除。 |
| `agent-a5f8d140c8039e0c2` | app tests 窄 UI mock 污染及 rows 回归保护 | 2 | 已交接 patch；主要产物在 mirror 与补丁，报告有组合红绿验证。 |
| `agent-a476b485a6ec85ebf` | 扩展设置迁到 Config 页 | 16 | 原会话以额度耗尽结束，留有 UI/helper/test 草稿，无最终成功交接。后续整合树已继续推进该区域，不能将旧草稿当待直接合入成果。 |
| `agent-a0d353c53ad000225` | 启停管理 API/host、互斥与跨 server stale guard | 3 | 已交接实现并做后续只读复核；记录有 82 项扩展测试及类型检查通过。 |

### P3a 安装与清理

| 目录 | 用途 | 未提交条目 | 原任务进度 |
| --- | --- | ---: | --- |
| `agent-a42f534476bc21266` | 安全归档解包与校验 | 2 | 已交接；59 项测试及严格类型检查通过。 |
| `agent-a490cd8512588c2f7` | HTTPS 下载、摘要与网络安全限制 | 2 | 已交接；85 项测试及严格类型检查通过。 |
| `agent-a6898065b1e3eaee2` | 严格 npm 依赖图、下载与物化 | 2 | 已交接；25 项测试、139 次断言通过。 |
| `agent-a3dc8e8e3009b369b` | registry observer | 2 | 已交接；8 项测试通过。 |
| `agent-a87a44dace6e83bfd` | prepare/commit 安装事务与 CAS | 11 | 已交接，后续确认 leases 接口兼容；副本含复制的配套模块。 |
| `agent-ac701b8c12c25701d` | runtime mutation fence、quiesce 与代际门禁 | 8 | 已交接；最终记录 56 项测试及类型检查通过，末轮仅修 fixture。 |
| `agent-a1a664722430ed70e` | CLI install、update、uninstall | 15 | 已交接两个 owned 文件；8 项离线测试及类型检查通过。 |
| `agent-aaaf0b398273b0185` | install API 客户端测试 | 4 | 已交接测试；SDK 与 install-api.ts 是测试依赖副本，不属于独立交付。 |
| `agent-a1161217d33a114dc` | 安装、更新、移除确认 UI | 5 | 已交接；10 项真实 Solid 契约、83 次断言及类型检查通过；非真实 GUI E2E。 |
| `agent-ab1232e1753ae34a7` | 安装服务、HTTP 与 host 状态一致性只读审查 | 0 | 已交接两个确认问题；干净符合审查性质，不代表当时没有工作。 |
| `agent-aea18ed56e3357b08` | generation/data 租约和进程存活证明 | 2 | 已交接；20 项测试及类型检查通过。 |
| `agent-a08806efc28b285cf` | generation GC、purge 与重启恢复清理 | 2 | 已交接；18 项测试通过。 |
| `agent-a418f05be3d5486d7` | data/cleanup/leases 删除安全与竞态只读审查 | 0 | 已交接两个确认问题，后续补充不改变结论。 |
| `p3a-http-install-owned` | P3a HTTP 安装接口预留工作树 | 0 | 干净 detached `3a0d101b22`，无该树独有提交或工作区实现；名称提示接口任务，但本次未找到独立交接证据。 |

### Release 安装与独立模板

| 目录 | 用途 | 未提交条目 | 原任务进度 |
| --- | --- | ---: | --- |
| `agent-a74417f544c3ccb6c` | release descriptor resolver、下载与端到端集成测试 | 5 | 已交接实现及追加测试；最后追加的 integration 测试当时未运行，不能把它算作该隔离树已验通。 |
| `agent-adbf3332d4cdd3c8a` | release 来源与 registry v3/receipt/retained 契约 | 7 | 已交接；定向 47、扩展 456 项通过；当时类型检查受其他切片未集成阻塞。 |
| `agent-adc1c106c4b8ffb96` | release CLI 与 HTTP 适配、独立升版确认 | 5 | 已交接补丁；语法和补丁检查通过，运行时验证当时留给整合树。 |
| `agent-a1c7ea125a6c3ab62` | release UI、固定来源更新、registry v3 确认及翻译 | 14 | 已交接；62 项回归通过，旧 SDK 类型阻塞留给主树生成后复验。 |
| `agent-a8d253ebaca1016ed` | 本地 descriptor 作者工具与说明 | 3 | 已交接；28 项真实 CLI 离线测试通过。 |
| `agent-a9aa6ee366330f0b3` | 独立模板 npm pack 与 release descriptor 脚本 | 1 | 已交接；Node 测试 6/6，通过真实离线 pack。 |
| `agent-acabe7ca3138089d0` | 独立模板的宿主集成测试 | 1 | 已交接 3 项集成测试；隔离树当时缺模板/宿主实现，仅做语法检查。整合树后来另有完整模板验收记录。 |

## 失效记录

`opencode/witty-wolf` 的登记目录是：

`/private/var/folders/65/5rshty290gzg25m1qkfyvrqh0000gn/T/opencode-httpapi-global-61501/data/opencode/worktree/012780c4098d08caa4ea8c479ed0a4690489f38d/witty-wolf`

目录已不存在，Git 明确标为 `prunable gitdir file points to non-existent location`，HEAD `8158e4e70c`。路径显示它来自 HTTP API 全局测试临时数据，具体原任务未进一步确认。这是失效管理记录，不是一个仍有未提交代码的现存目录；本次没有 prune，也没有删除对应分支。

## 集成与清理风险

1. **主树和扩展树正在并行改同一检索模块。** 两者都修改 `packages/opencode/src/session/content-search.ts` 及测试，但方案不同：主树新增 trigram/短词检索和 FTS row-map migration；扩展树调整回填 batch、批量 rowid 删除与让步时间并补性能日志。它们都未提交，单看分支提交无法发现，后续集成必须人工处理。
2. **会话协作不是已保存于 feature commits 的成果。** 分支没有 dev 之外的独有提交，主体在 81 个未提交状态条目中。共享 stash 还保留迁移备份，但不能把 stash 当作最新工作区的完整替代品。
3. **大多数旧 agent 树是补丁交接副本。** 同一个目录里的基线脚手架、stub、镜像和真正 owned delta 混在一起。只能按原任务所有权核对，不能把整个 status 当作尚待合入列表。
4. **失败尝试不能按常规已交接树处理。** `agent-a8031cd7f5bb83055` 和 `agent-a476b485a6ec85ebf` 分别以 API 参数错误和额度错误结束，应先归档/核对其残留，再决定保留策略。
5. **干净不等于可删。** 三个锁定 Computer Use 树正在研究；只读审查树本来就不应有改动。若清理历史树，应先核对会话已结束、owned 成果已进入整合树或有可靠备份。
6. **共享 stash 还有独立价值。** 已看到 scroll 回归 harness、会话协作迁移备份、扩展同步备份及 token 修复 stash。stash 名称不保证内容已废弃，索引也会变化，不应照旧日志里的 `stash@{0}` 直接操作。

优先保留主开发树、扩展整合树、会话协作树、三个活跃调查树和滚动修复草稿。历史已交接树可作为后续清理候选，但本次没有执行逐补丁等价审计或授权删除。失效 `witty-wolf` 记录与明确停止的重复契约树可优先进入清理审查。

## 证据与调查范围

Git 证据包括全部 worktree 的登记、目录存在性、`status --short`、HEAD、相对 dev 的提交差异、关键 reflog、提交文件清单及共享 stash。任务用途同时对照 `/Users/lelouch/.claude/projects/` 中对应 agent 的原始任务和交接文本；3 个活跃树还核对了锁所属进程存活。未找到日志的条目已在表中明确保留不确定性。

本次未 fetch 或联网核验远端状态，因此“尚未合入 dev”仅指本地 dev；不据此断言远端是否存在独立 feature branch。未重新跑产品测试、发送 sidecar 消息或启动/停止任何应用；表中的测试数均为历史任务证据，不是本次验收。除当前 `task/2` 分支新增本清单外，没有修改其他工作区、清理 stash/worktree、合并、变基、推送或触发 GitHub Actions。
