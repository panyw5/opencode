# app 三项基线失败修复任务

历史实施日期：2026-10-06；工作树 `extensions-p0`；用户当时已批准独立计划。

当前状态（2026-10-14）：**三项基线修复已随 `eeac7a5adc` 提交**，不再是未提交候选；尚未合入 dev。本轮仅更新文档，不暂存、不提交、不推送、不合入 dev。原实施验证记录保留，不改变 P2 已验证能力。

当前 `c6e6629773` 基线重新运行 App 全量 unit suite 为 **1671 pass/0 fail（205 文件）**；该结果不代替历史 browser/构建/实机证据，也不代表全仓 opencode suite 已通过。

## 检查项

- [x] 定位注入预览：非注入测试 fixture 与 legacy Background shell 协议冲突。
- [x] 修正非注入 fixture，补 completed/failed 无 metadata 正例，不改识别实现。
- [x] 定位 deadline reducer no-op identity 违约，保留原 toBe 断言。
- [x] 增强重复 deadline/已有可见内容回归并修复实现；两文件定向 13 pass/0 fail。
- [x] 消除 comments/terminal UI context 窄 module mock 污染，验证 rows 单文件与同进程组合。
- [x] app 全量 unit suite 两次独立进程复跑，均 1359 pass/0 fail（171 文件）。
- [x] browser-condition 59/0、UI 218/0、workspace typecheck 18/18、production build 与格式检查通过。
- [x] 同步进度与交付清单，独立列明基线修复新增范围；108 个候选文件逐项核对，无遗漏/重复。

## 红/绿证据

- 原 prompt + render state：8 pass/2 fail，分别为 fixture 预期冲突与同值新对象。
- 增强 render state 回归修复前：4 pass/2 fail；不改变内容未就绪不可见行为。
- 修复后二文件：13 pass/0 fail（31 assertions）；格式检查通过，UI 回归 218 pass/0 fail，legacy 注入协议保持。
- 独立穷举 deadline 的 42 种 phase/overlay/hasContent 组合：字段变化与修复前逐项一致，27 种 no-op 均保留原引用；app typecheck 与 production build 通过，browser-condition 59 pass/0 fail，workspace typecheck 18/18。

- 前两项修复后的 app 全量：1342 pass/1 fail；唯一残留为 rows 导入 `useData` 的 module mock 污染。
- 第三项删除 comments/terminal 的 UI context mock，router stub 与 rows 的既有导出面一致，不新增假 useData、不修改生产导出。主工作树三文件同进程与反向参数均 29 pass/0 fail。
- app 全量首次 1359 pass/0 fail（8.48s）、第二独立进程 1359 pass/0 fail（8.56s），均 171 文件；真正恢复了此前因导入失败而未执行的 rows 用例。
- 最终 workspace typecheck 18/18、browser-condition 59 pass/0 fail（13 文件）、修复六文件 prettier check 与 git diff --check 通过。生产 app build 已在唯一生产行为修改（deadline identity）后通过。

## 变更范围

`packages/app/src/utils/prompt.test.ts`、`pages/session/session-render-state.ts`/`.test.ts`、`context/comments.test.ts`、`context/terminal.test.ts`、`pages/session/timeline/rows.test.ts`。仅 deadline reducer 有生产修改，其他均为测试 fixture/隔离/断言；UI 注入协议和生产 context 导出保持不变。

历史 P2 全量的三失败记录保留为历史，不覆盖；本阶段通过后单独记录新全量结果。
