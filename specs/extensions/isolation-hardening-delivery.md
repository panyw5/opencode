# 扩展隔离加固交付记录

## 范围与决策

依据 [isolation-hardening-plan.md](./isolation-hardening-plan.md)；实施基线 `db23a41905`，所有修改仍在工作区，**未提交、未推送、未创建 PR**。保留原有未提交改动。

- D1：请求型 trigger 普通错误继续拒绝；仅扩展条目的 `ExtensionMutationError` 被跳过。
- D2：新增 `POST /global/extension/:id/retry`，未知 404；禁用、变更中或 blocked 409；不清 blockers、清理失败记录或 pins。
- D3：24 份独立生命周期原型源码/测试/专用探针迁至 `prototypes/`，保留 `lifecycle-api-matrix` / opt-in `lifecycle-target` 于生产测试目录。原型没有接入产品。

## 已实现

### 后端与缓存

- activate/server 默认 10 秒截止，测试可覆写；原始任务仍被 pending 跟踪。激活超时保持错误并使迟到 service 失效；server 超时仅使本调用过期，不破坏其他目录的 generation。
- `instanceHooks` 并行逐扩展收集，保 registry 顺序；blocked、lease 失败和瞬态 mutation 只跳过所属扩展。返回前只回收自身已失效 hooks。
- 真实双层 InstanceState 回归额外修复：tool/plugin 失效间隙重建、首次安装 registry 尚无 ID 的缺席缓存、后到失效被旧轮合并吞掉。采用 tool→plugin→tool、release 后 task-turn 兜底、revision 重跑，不在持有 fence 时热循环。installer 原失效次数断言保持。
- SlotStore 收敛每扩展 entry/loading/generation/epoch/pending/requests/hooks/清理错误及正交 fence/quiesce/blocked；迁移日志集中。运行模块拆为 `runtime/{index,slot,module-cache,hooks,timers}.ts`，原 `runtime.ts` 保持兼容导出。
- `ServerInfo` 始终可读 runtime/error/needsRestart；清单状态与后端健康分离。目录 server 错误和 timer 错误作为非粘性诊断可见，不阻止后续实例重试；server 成功清对应错误。

### 插件与前端

- event 每条目保护同步异常与 Promise/thenable 拒绝，不终止消费 fiber，不等待慢 hook。trigger 保持普通拒绝语义和成功归因边界。
- 工具 renderer 的 setup、响应式 accessor/effect 与 insert 均处于局部 ErrorBoundary，显示工具名、错误和 Retry；保 props identity、scope CSS、兄弟节点与清理。
- 命令捕获同步和异步错误，字符串日志+toast；placeholder 消费真实 handler 结果。
- SDK/OpenAPI 与 App 手写类型同步；配置列表/详情展示运行错误、重启阻塞与安全重试。重试 UI 按 ID+连接身份重置，token 防迟到 finally 清新连接 busy。

### 短期资源与崩溃面

- `host.setTimeout/setInterval` 返回可撤销句柄；activation 与每个实例分别归属。失败/超时/迟到、hooks dispose、disable/reload/quiesce 都撤销相应资源；已开始 Promise 继续 pending 跟踪。
- timer 同步/异步失败被归因并停止该 timer。原生 uncaughtException 仍 fatal exit(1)，仅按堆栈缓存路径提供尽力归因，**不声称沙箱或进程级隔离**。
- 作者说明：[isolation-authoring.md](./isolation-authoring.md)。

## 测试证据

先红后绿：A1/A2 新回归 0/8→绿；B1 runtime 0/3→绿；API 0/3→绿；A4 四项 mount 先红；真实缓存 1/2→3/0，后到请求回归3/1→4/0；timer 接线1/6→7/0；目录超时可见性3/1→4/0；跨连接 UI 4/2→6/0。

| 验证 | 结果 |
|---|---|
| opencode `test/extension test/plugin`（原型迁出后的最终套件） | **798 pass / 6 skip / 0 fail**，804 tests / 48 files；6 skip 为显式目标/平台条件，不记作通过 |
| HTTP/API/SDK/OpenAPI 与隔离回归组合 | **58 pass / 0 fail**，5 files |
| App extensions unit | **165 pass / 0 fail**，19 files |
| 定向 browser：mount/runtime-status/config-actions | **11 pass / 0 fail**，包含独立 JSX contract 子进程（runtime-status 内6项） |
| timers 纯模块 | **16 pass / 0 fail** |
| desktop sidecar-error + server | 已执行通过，含真实 fatal 子进程 exit=1 |
| extension-kit browser-condition | **19 pass / 0 fail** |
| opencode/App/desktop/SDK/extension-kit typecheck | 五包均通过 |
| 独立原型 typecheck + unit | 通过；unit **24 pass / 0 fail** |

**完整套件最初未全绿；后续用户选择继续排查，当前结果已更新（不抹去历史失败）：**

- App 完整 unit 初为2150 pass / 10 fail；补local.channel测试契约及IM纯逻辑测试导入边界后，最终 **2161 pass / 0 fail**。
- 完整 browser 初为109 pass / 1 fail；更新tabs/Kobalte Select/布局契约，并修复CLI/Native RPC实际保存入口缺失后，最终 **110 pass / 0 fail**。保留了保存不触发ACP探测、来源pin、A-B-A与capability隔离等断言。
- 设置组件业务修复通过独立Electron CDP实际点击：save=1、probe=0，patch为cli-json；截图 `/tmp/ext-followup-cli-save.png`。无真实服务器配置变更，保存使用注入fixture回调。
- 独立进程原型的Bun管道问题随后已定位并修复：兼容层Socket与原生Subprocess GC重复关闭同一个附加fd，误关复用后的新管道。独立原型改用原生Bun.spawn+原子CLOEXEC副本，保留原强断言；最终完整原型 **84 pass / 8 skip / 0 fail**，process连续三轮 **49 pass / 1 skip / 0 fail**，Electron **7/0**，typecheck通过；强制GC下Bun300轮/Node100轮0失败。仅macOS原型适配，不接生产、不升级全局Bun。详见 [prototypes/README.md](./prototypes/README.md)。
- 早期 25ms 隔离测试预算在多文件组合时健康扩展偶发超时；测试默认改为150ms，行为断言不放宽，生产仍10秒。

## 实际后端与 Electron 验证

### Bun 源码服务

隔离 root `/private/tmp/codeg-acp-501/98065-b4389a80/opencode-extension-isolation-agkIyG`，独立 HOME/XDG/TMP/registry、随机扩展 ID、loopback mock 模型（无真实凭据/外部模型）。`packages/desktop/scripts/extension-isolation-smoke.ts` 核验身份后自行发送两次真实消息，确认健康 hello 与 throwing-card 服务端工具 completed、模型收到工具输出并生成最终回复；挂起激活10秒超时、dispose抛错后第二次仍成功。已亲自读 backend.log：activation timeout、hooks/service dispose failed、blocked 均存在。

### Electron CDP 9222

复用原开发 Electron，不关闭/重启安装版；通过其 browser API 新建独立非持久验证页面，连接上述隔离后端+本地App dev server，未改变主 renderer 的服务器连接。

已验证并亲自查看截图：

- `/tmp/ext-isolation-electron-tools.png`：抛错卡 fallback + Retry，健康兄弟工具正常、输入框保留；点击 Retry 仍只影响该卡。
- `/tmp/ext-isolation-electron-error.png`：activation timeout 可见、Retry 可点击；实际点击后清错误并刷新。
- `/tmp/ext-isolation-electron-blocked.png`：三扩展各自显示 ERROR / RESTART REQUIRED / ENABLED；blocked详情无retry，API retry实际返回409。
- 浏览器侧补充截图 `/tmp/ext-isolation-browser-tools.png`。

验证页均已关闭；本次 Bun后端/mock/App dev server到后台时限后自动停止。原开发 Electron与安装版未关闭。上述GUI验证不是发布包验证；最终非粘性错误/跨连接token补丁另以定向契约验收。

### 真实 Electron Node utility sidecar

已通过独立无窗口 Electron41.2.1 / Node24.14.1 执行真实 sidecar.ts 临时bundle，使用私有userData及HOME/XDG/TMP/registry，确认挂起激活/清理抛错后两次消息与健康工具完成。最终冻结代次证据root `/private/tmp/codeg-acp-501/98065-b4389a80/opencode-extension-isolation-mUb4OK`；构建前后 index/slot/hooks SHA一致，index为 `c80d268ce438abf3dae8d4f7008989f6a1c051d997ea1d80404cc42fcfc8a98a`。两次会话 `ses_ffe5e325c428effe5EWTDL9TPQ`、`ses_ffe5e325c41c5ffekJlf6U0vev` 均通过；主会话已亲自读最终侧车日志73行超时、672–674行清理错误。不是用Bun替代Node；所有自建Electron/utility/mock已按PID与root核验清理，不影响既有应用。

## 保留边界

1. 独立进程执行/完整 Hooks 序列化、durable lifecycle、跨平台进程树证明仍是独立项目；同进程同步死循环/原生异常无法由Promise截止隔离。
2. 原生 timer、脱离 Promise、任意闭包仍可能存活，pins 保持至进程退出；托管 timer 非取消已在途工作的强制手段。
3. 状态迁移日志集中；对外保留既有 error/blocked 发布及可查询状态，不对每个 loading/ready 内部迁移额外广播 changed，避免纯重构引入刷新循环。
4. 未运行 Linux/Windows、签名/asar/发行包、真实 WLS 生命周期验证。
