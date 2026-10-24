# wls-repl — WolframScript REPL & 断点调试扩展

OpenCode 扩展（`local.wls-repl`）：为 `.wls` 文件提供 Python REPL/pdb 风格的运行与调试体验。

- 在代码任意（多个）行上点击 gutter 添加断点
- Run 运行到断点停下，右侧变量面板显示 `User`` context 的符号定义
- 暂停时在底部输入框求值任意表达式（检视变量）
- Continue / Step（单顶层语句）/ Abort / Restart / Stop
- 空闲时同一输入框即 REPL：kernel 常驻，变量状态跨求值保持
- Print 输出、内核消息、语句结果流式进入控制台

## Agent 工具：`wolfram_eval`

扩展同时注册一个 LLM 工具 `wolfram_eval`（实例级 hooks）：

- 参数 `code`（必填）+ `path`（可选，某个 `.wls` 文件的绝对路径）。
- 带 `path` 时复用该文件在 viewer 里跑的那个 kernel——**Agent 和你共享变量状态**：
  你断点调试时定义的 `q`，Agent 用 `q * 7` 能直接得到结果；不带 `path` 时用项目目录
  独立的共享 kernel（变量跨调用保持）。
- 设置 `exposeTool`（`always`/`never`，默认 `always`）随时启停，执行时实时读取。

## 架构

```
┌─ web viewer (src/web.tsx) ─┐   RPC    ┌─ server service (src/server.ts) ─┐
│ 断点 gutter / 变量面板 /    │ ───────> │ KernelManager：按文件路径一对一    │
│ 控制台 + 求值输入           │ <─────── │ wolframscript 子进程生命周期        │
└────────────────────────────┘  events  └────────────┬───────────────────┘
                                                     │ spawn + ctl 文件追加
                                                     v
                                       ┌─ bridge.wls（kernel 内常驻桥）─┐
                                       │ ctl 文件 !tail -f 阻塞读 JSON 行 │
                                       │ stdout: RS+nonce+JSON 协议行    │
                                       │ Read[HoldComplete[Expression]]  │
                                       │ 切分顶层语句 + 断点暂停循环       │
                                       └────────────────────────────────┘
```

关键事实（实测得出，写代码前请勿凭直觉更改）：

- `wolframscript -file` 模式下 `Input[]`/`InputString[]` 读不到宿主管道（`$Input` 指向脚
  本文件）；`OpenRead` 拒绝管道/FIFO/`/dev/stdin`；`OpenConnect` 在 wolframscript 中不执
  行（返回未求值表达式）。唯一可用控制通道是**宿主向控制文件追加 JSON 行 + bridge 用
  `OpenRead["!tail -n +1 -f <ctl>"]` 跟随读取**（`Read[s, String]` 阻塞到下一行到达）。
- `Read[s, HoldComplete[Expression]]` 是官方支持的"不求值逐条读取"原语，天然处理多行表
  达式/字符串/注释；配合 `StreamPosition` 差值映射语句起始行号。注释独立 span 会得到
  `HoldComplete[Null]`，直接跳过。
- bridge 全部代码包在 `Begin["WLSBridge`"]...End[]` 中：Module/Table 局部名在解析时会在
  `Global`` 创建同名符号，与用户变量撞名会产生 `shdw` 告警；隔离 context + `Off[General::shdw]`
  根治。
- `Definition[Symbol[name]]` 会触发 `Definition::ssym`（HoldAll 不接受非字面量）；用
  `ToExpression[name, InputForm, HoldComplete]` + RuleDelayed 模式替换把符号传入
  `OwnValues/DownValues` 才能取到定义文本。
- **wolframscript 忽略 SIGTERM**（阻塞在 Read 时）。停止内核必须走 ctl `{"op":"shutdown"}`
  → SIGTERM → SIGKILL 三级，且 SIGKILL 升级必须在 await 路径内执行（unref 定时器在宿主
  快速退出时永远不触发，曾导致测试泄漏孤儿进程）。
- 宿主进程被直接 kill 时不运行 dispose；kernel 以 detached 进程组运行因此幸存。服务在
  `dataDir/kernel-pids.json` 记录 `{kernelPid, hostPid, ctlPath}`，下次激活时清扫"宿主
  pid 已死"的 kernel（并发活宿主互不误杀）。

## 断点语义

语句粒度：语句 S 会在「存在断点行 ∈ (上一条已执行语句结束行, S 的结束行]」时于执行前
暂停。断点打在多行语句内部、注释行或语句间空行上时，等效于停在下一个可执行语句前。
`Step` = 执行当前语句后停在下一个顶层语句前。不支持 Step Into。

## 独立打包与安装（自包含归档）

运行时零外部依赖：`dist/server.js` 只含 `node:*` 内建导入（kit/plugin 已内联打包），
`dist/web/index.js` 无任何裸导入。因此可直接打成自包含 `.tgz` 离线安装：

```bash
bun run build                      # 重新构建最新 dist
npm pack --offline --pack-destination /tmp/wls-pkg   # files 白名单只带 dist + README
shasum -a 256 /tmp/wls-pkg/*.tgz

# 隔离环境安装（勿装进日常 registry；替换摘要为上一步输出）
HOME=$ISO/home XDG_DATA_HOME=$ISO/data ... \
  opencode extension install /tmp/wls-pkg/<name>-<version>.tgz --sha256 <hex> --yes --enable
```

2026-10-24 已实测：归档 80KB；隔离 CLI 安装 committed/synced；dev Electron（隔离
registry）安装后打开 `.wls` 自动激活、断点/暂停/变量面板全链路正常，kernel 由
`extension-modules/<id>/<内容指纹>/dist/bridge.wls`（安装副本）启动；配置页 Update/
Remove 可用，移除后 kernel 进程清零。npm 公网安装仍不可行（kit 未发布）；release URL
（GitHub 等）安装需先上传归档再发布 descriptor，属后续公网分发决策。

## 开发

```bash
bun install
bun run build        # vite build + bun build server + 拷贝 bridge.wls 到 dist/
bun run typecheck
bun test test        # 无 wolframscript 时真实集成测试自动跳过
opencode extension link "$(pwd)"   # 路径链接，watcher 会热重载
```

修改 `src/bridge.wls` 或 `src/server.ts` 后需重跑 `bun run build`（运行时加载的是
`dist/` 拷贝）；`src/web.tsx` 由 `vite build --watch`（`bun run dev`）处理。

设置（Settings → Extensions → WolframScript REPL）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `wolframscriptPath` | `wolframscript` | wolframscript 可执行文件路径 |
| `statementTimeoutSeconds` | 60 | 单条语句 TimeConstrained 超时 |
| `maxKernels` | 2 | 并发 kernel 上限，超出按 LRU 逐出 |

## 边界

- 只读视图：编辑请切回默认源码视图（"打开方式"），改完回来重新 Run。
- 断点/控制台状态仅在内存中，刷新/关闭标签即失（与宿主既有草稿边界一致）。
- Run 重跑整个文件且不清空 `User`` 符号；Restart 才重置状态。
- 中断 = Restart（丢状态）；语句超时 = 终止本轮运行。
- Agent 与用户的共享只到"同一路径的 kernel"；目录级工具 kernel 与文件 kernel 相互独立。
- macOS + wolframscript 13.3 实测；Windows（`tail`/`ps` 依赖）与 Linux 未验收。
