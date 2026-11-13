# 扩展系统整改计划（Remediation Plan）

状态：**计划，未实施。** 依据 2026-11-12 的扩展架构全面审查（manifest/Web 宿主、server 运行时、安装分发、SDK/测试四个领域）。
用途：交给子智能体分阶段实施。每个任务都写明了文件范围、步骤、验收标准和测试；同一批次的并行任务**文件互不重叠**。

---

## 0. 通用约定（所有子智能体必须遵守）

### 0.1 仓库与发布规则

- 只能推送到 `panyw5/opencode`。扩展发布到 `panyw5/open-extensions` 属于 AGENTS.md 允许的例外。
- **不要 push，不要发布**，除非任务里明确写了。默认只在本地提交。
- 不要关闭已安装的 `/Applications/OpenCode.app`。

### 0.2 编码规范

- `packages/opencode`：遵守 `packages/opencode/AGENTS.md`：
  - 禁止 `export namespace`，改用 `export * as X from "."` / `"./file"`；
  - Effect 写法用 `Effect.fn` 和 `Schema.TaggedErrorClass`；
  - 每实例状态用 `InstanceState`。
- 前端日志**只能输出字符串**，不能输出 object（`packages/desktop/AGENTS.md`、根目录 `CLAUDE.md`）。
- 修 bug 时**每一步都加日志**，统一 `service: "extension"`，并带上 `extension`、`phase`、`gen`、`elapsedMs` 字段。
- 不随意增删已有注释，代码风格向邻近文件看齐。

### 0.3 验证流程（每个任务完成前都要做）

1. 按改动范围在对应包目录内执行（不要在根目录跑 test）：

   ```sh
   cd packages/opencode && bun run typecheck && bun test test/extension
   cd packages/app && bun run typecheck && bun run test:unit -- src/extensions
   cd packages/extension-kit && bun run typecheck && bun run test
   cd packages/desktop && bun run typecheck && bun test
   cd packages/extensions/<name> && bun run typecheck && bun run test && bun run build
   ```

2. 改了后端（`packages/opencode/src`）：先 `cd packages/opencode && bun run script/build.ts`，再重启 `bun run dev:desktop`。dev:desktop 用的是预构建的 sidecar，不会直接用源码。
3. 改了前端，或者改动对用户可见：**必须做 CDP 验证**（9222 端口）。启动前先确认是否已有 electron 实例在运行。

   ```sh
   bun packages/desktop/scripts/cdp.ts targets
   bun packages/desktop/scripts/cdp.ts eval '<表达式>'
   bun packages/desktop/scripts/cdp.ts screenshot /tmp/opencode-cdp.png
   ```

   需要模拟快捷键时，先读用户的键位覆盖设置（见根目录 AGENTS.md）。
4. 自己读后端日志，自己做 sidecar 功能测试：发消息、触发扩展工具、核对返回结果。

### 0.4 交付物

每个任务交付：

- 代码；
- 测试；
- 在本文件对应任务下追加一行"实施记录"，包含提交 hash、验证命令和结果；
- 如果行为有变化，在 `specs/extensions/progress.md` 记一条。

---

## 1. 待确认决策（Phase 0，实施前由用户拍板）

| 编号 | 决策 | 推荐 | 影响任务 |
|---|---|---|---|
| D1 | 扩展工具名的命名空间格式 | `<extName>_<tool>`。`extName` 取 id 最后一段，`-` 转成 `_`；完整 id 写进工具元数据 | T2.1 |
| D2 | 声明的激活事件：严格执行，还是只作提示 | **作提示并写进文档**：贡献点被用到就激活，这和 VS Code 的隐式激活一致；只有 `onStartup` 有额外语义 | T2.2 |
| D3 | `permissions` 的处置方式 | 改成固定词表做校验，UI 标注"声明，不强制"；进程隔离之后对 `tools` 和 `process:spawn` 做粗粒度执行 | T2.4、T5.9 |
| D4 | 描述符签名方案 | **Ed25519 签名 `stable.json`**（Node `crypto.verify` 原生支持，不加依赖），宿主内置可信公钥列表；GitHub attestation 作为补充 | T3.1 |
| D5 | `open-extensions` 仓库的定位 | **只放分发内容**：`stable.json`、签名、README，产物放在 Release；不再同步源码。若保留源码，则标记为只读镜像 | T3.3 |
| D6 | `extension-kit` 的发布渠道 | 发布到 npm（`@opencode-ai/extension-kit`），或以 `.tgz` 形式放到 `open-extensions` 的 Release。现有规则没有授权 npm 发布，**需要用户明确授权** | T4.2 |
| D7 | 进程隔离的粒度 | **每个扩展一个宿主进程**，按需启动；崩溃只影响该扩展 | T5.* |
| D8 | 进程隔离上线后，进程内模式是否保留 | 保留 `isolation: "inline"`，只用于本地 `path` 来源的开发调试；生产安装一律 `process` | T5.10 |
| D9 | 扩展版本号 | 每个扩展独立 semver，从 `sync-version.ts` 中排除；`extension-kit` 继续跟随主版本，直到正式发布 | T1.3 |

---

## 2. 阶段总览与依赖

```text
Phase 0 决策
   │
   ├─► Phase 1 规范性修复（低风险，全部可并行）
   │
   ├─► Phase 2 正确性/安全快修（多数可并行，依赖 D1–D3）
   │
   ├─► Phase 3 分发信任链（依赖 D4/D5，可与 Phase 2 并行）
   │
   ├─► Phase 4 SDK 与开发体验（T4.1 可提前；T4.2 依赖 D6）
   │
   └─► Phase 5 Server 进程隔离（依赖 Phase 2 的 T2.1/T2.5；最大改动，串行为主）
           │
           └─► Phase 6 测试与 CI（T6.1 可提前做，作为 Phase 5 的回归网）
                   │
                   └─► Phase 7 文档与规范收尾
```

**建议执行顺序**：Phase 1 → T6.1（先建端到端回归网）→ Phase 2 / 3 / 4 并行 → Phase 5 → Phase 6 余项 → Phase 7。

---

## Phase 1：规范性修复（低风险）

> 批次 1A 的任务文件互不重叠，可以同时派给多个子智能体。

### T1.1 `leases.ts` 模块形态与运行时错误别名清理

- **文件**：`packages/opencode/src/extension/leases.ts`，以及所有 `ExtensionLeases` 的引用方（先 grep `ExtensionLeases`）；`packages/opencode/src/extension/runtime/index.ts` 中的错误别名。
- **步骤**：
  1. 把 `export namespace ExtensionLeases { ... }` 展开成顶层导出，文件末尾加 `export * as ExtensionLeases from "./leases"`。不需要导出的辅助函数保持不导出。
  2. 引用方改成 `import { ExtensionLeases } from "@/extension/leases"`，其余调用代码不变。
  3. 删除 `runtime/index.ts` 里重复的别名 `ExtensionRpcMethodNotFoundError`/`ExtensionRpcHandlerError`（约第 91–92 行），并把引用改为原类名。删之前 grep 全仓库，确认 HTTP 层和测试里没有按别名做 instanceof 判断。
- **验收**：`src/extension` 下 grep `export namespace` 结果为 0；typecheck 通过；`bun test test/extension` 全绿。
- **实施记录**：`17015066b5`。验证：`bun run typecheck` 通过；`bun test test/extension` 653 pass / 6 skip / 0 fail；`bun test test/server/httpapi-extension.test.ts` 28 pass。偏差：self-reexport 用 `"./leases.ts"` 显式扩展名（Node type-stripping 需要）；HTTP 层按别名 `.name` 的判断为死分支，已改为原类名。

### T1.2 `packages/extensions/zed` 迁出

- **文件**：`packages/extensions/zed/**` → `packages/zed-extension/**`；`script/sync-version.ts` 中的 toml 路径；`.github/workflows/**` 里引用该路径的地方（先 grep `extensions/zed`）。
- **步骤**：
  1. 用 `git mv` 迁移目录。
  2. 更新 `sync-version.ts` 的 toml 路径，以及 workflow、文档里的所有引用。
  3. 确认 `script/extension-publish.ts` 不会再把 zed 当作 opencode 扩展处理。
- **验收**：grep `extensions/zed` 结果为 0；`bun script/sync-version.ts` 在 dry 模式下（或在临时分支上运行后用 `git --no-pager diff --stat` 检查）能正确改写新路径下的 toml。
- **实施记录**：`a5c37ee1dc`。验证：`git grep extensions/zed`（tracked）= 0；`bun script/sync-version.ts` 成功读取新路径 toml。补充改动（计划未列但 grep 发现）：`script/sync-zed.ts`、`script/raw-changelog.ts`（4 处，归类仍为 "Extensions"）、`design.md:1003`；LICENSE 符号链接目标按新深度修正。注意：`sync-zed.ts` 对迁移前的旧 tag 运行会因路径不存在失败（预期）。

### T1.3 扩展版本号与主仓库解耦（依赖 D9）

- **文件**：`script/sync-version.ts`；`packages/extensions/*/package.json`。
- **步骤**：
  1. 在 `scan` 的过滤条件里排除 `packages/extensions/` 前缀，`extension-kit` 保持跟随主版本。
  2. 每个扩展的版本号从当前 `1.18.64` 起改为独立维护：**保持现值不回退**，以免触发降级提示。之后只在扩展内容变化时递增。
  3. `script/extension-publish.ts` 增加检查：如果 `<name>-v<version>` 这个 tag 已存在，且产物摘要和本次构建不同，就报错退出，提示先升版本。这项检查与 T3.2 共用。
- **验收**：运行 sync-version 后，`packages/extensions/*/package.json` 不变；extension-kit 正常更新。
- **实施记录**：`328271262f`。验证：`bun script/sync-version.ts` 无 `updated:` 输出，extensions 与 fixture 均不改写；`extension-publish.ts --help` 正常。补充：scan 额外排除 `/test/`（防止 e2e fixture 版本被改写导致 update 用例语义变为降级）；tag 存在时经 `gh api` 比较 release 资产 digest（回退 stable.json 的 sha256），不同则报错——`--clobber` 移除与"相同则跳过"属 T3.2 范围未做。遗留：`open-extensions` 已发布 mathematica-notebook v1.18.65 而仓库内为 1.18.64，下次发布该扩展需人工升版。

### T1.4 前端类型与正则统一

- **文件**：`packages/app/src/extensions/types.ts`、`packages/app/src/extensions/panel-tab.ts`、`packages/extension-kit/scope.js`（如果它不能 import TS，就保留副本，但加一个测试确保与 schema 一致）。
- **步骤**：
  1. `types.ts` 中 `priority?: number | string` 改为 `number`，与 `schema.ts` 一致；同时修正调用方。
  2. 扩展 ID 正则统一从一个源导出（例如 app 侧的 `extensions/id.ts`）。`panel-tab.ts` 改为引用它。
  3. 新增测试：断言 app、kit 中的正则与 `packages/opencode/src/extension/schema.ts` 的 `ID_PATTERN` 字面量一致。用读取源码字符串做比较的快照测试即可，不需要跨包运行时依赖。
- **验收**：app 的 typecheck 和单测通过。
- **实施记录**：`0d4ff8ceb1`。验证：`bun run typecheck` 通过；`bun test --preload ./happydom.ts ./src/extensions` 170 pass。补充改动：`catalog-install.ts` 中第三处同字面量正则一并归并 `isExtensionID`。`scope.js` 保留副本由 `id.test.ts` 快照锁定一致性。

### T1.5 面板状态泄漏

- **文件**：`packages/app/src/extensions/panel-content.tsx`、`packages/app/src/extensions/panel-registry.ts`（或卸载流程所在文件）。
- **步骤**：
  1. 模块级 `panelState` 增加 `evict(extensionId)` 和 `evictTab(tabKey)`。
  2. 在扩展 dispose、卸载、面板 tab 关闭时调用。
  3. 加日志（字符串格式）：`extension panel state evicted id=<id> count=<n>`。
- **测试**：新增用例：注册面板 → 写入状态 → 卸载扩展 → 断言状态已清空。
- **验收**：单测通过；CDP 验证打开、关闭面板后 `panelState` 的大小能回落（可以通过临时调试接口或日志确认）。
- **实施记录**：`77f60da181`。验证：typecheck 通过；extensions 测试 172 pass（本任务 panel.test.ts 9/9、session-tabs.test.ts 55/55）。偏差：`panelState` 迁入 `panel-registry.ts`（叶子模块，避免 `layout → panel-content → session-layout → layout` 循环依赖）；扩展级 evict 统一挂在 `clearPlaceholders` 漏斗；tab 级 evict 挂在 `layout.tsx` 的 `close()`/`setAll()`。遗留：`layout.tsx` 的 `prune()`（session LRU）未 evict，建议另立任务评估。

### T1.6 共享模块版本与偏差检查

- **文件**：`packages/app/src/extensions/modules.ts`、`packages/app/src/extensions/activation.ts`。
- **步骤**：
  1. `versions["solid-js"]` 不再硬编码，改为从 `solid-js/package.json` 读取（Vite 支持 JSON import），或在构建期注入常量。
  2. 激活时，如果扩展产物声明了构建时的 solid 版本，就和宿主版本比较：minor 不同打 warn 日志，major 不同则拒绝激活并显示错误。扩展产物需要由 kit 的 vite 插件写入版本号，这部分在 T4.6 完成；本任务先实现宿主侧的读取逻辑，字段缺失时跳过检查。
  3. 把 `__OPENCODE_EXTENSION_HOST__` 冻结：用 `Object.freeze` 冻结 `modules` 和各模块对象，再通过 `Object.defineProperty(globalThis, ..., { writable: false, configurable: false })` 安装，防止先加载的扩展篡改后加载扩展拿到的模块。
- **测试**：版本比较的单测，覆盖 minor/major 两种情况；单测断言冻结后赋值无效。
- **验收**：app 单测通过；CDP 中执行 `Object.isFrozen(__OPENCODE_EXTENSION_HOST__.modules)` 返回 `true`。
- **实施记录**：`df21439b33`。验证：typecheck 通过；extensions 测试 180 pass / 0 fail（冻结、版本比较 minor/major/缺失全分支）。实现：solid 版本经 `import solidPackage from "solid-js/package.json"`（JSON import）；ES module namespace 拒绝 `Object.freeze`（其 `[[Set]]` 天然拒绝写入），try/catch 兜底；`__OPENCODE_EXTENSION_HOST__` 经 `defineProperty` 非可写安装 + 幂等保护。遗留：CDP 未验证（dev electron 实例在 reload 后退出）；`env.d.ts:15` 的 `declare var __OPENCODE_EXTENSION_HOST__` 为死声明（文件是模块），建议后续任务修复。

---

## Phase 2：正确性与安全快修

### T2.1 扩展工具名命名空间 + 冲突检测（依赖 D1）

- **文件**：
  - `packages/opencode/src/plugin/index.ts`（约第 478–484 行，扩展 hooks 注入处）或 `packages/opencode/src/tool/registry.ts`（约第 380–384 行）；
  - `packages/opencode/src/extension/manifest.ts`（`toolRenderers.tool` 和 `onTool:` 激活事件的校验）；
  - `packages/app/src/extensions/host.tsx`（工具渲染器的匹配逻辑）；
  - 三个扩展 `server.ts` 中的 `tool` 定义，以及它们 manifest 里的 `toolRenderers` 和 `onTool:` 引用。
- **步骤**：
  1. 扩展来源的工具在并入 ToolRegistry 前统一改名为 `<ns>_<tool>`（D1）。普通 plugin 工具保持不变，属于另一个范畴。
  2. 改名后和内置工具或其他扩展重名的，跳过该工具，打 error 日志，并把扩展状态设为 `error`，错误信息里写明冲突对象。
  3. manifest 里 `toolRenderers[].tool` 和 `onTool:<name>` 写**未加前缀的原名**，由宿主统一加前缀后再匹配，扩展作者不需要知道前缀规则。前端匹配处同步修改。
  4. 历史会话中的旧工具名：渲染器匹配时同时接受旧名（兼容一个版本），并加 deprecation 日志。
- **测试**：
  - 后端：两个扩展声明同名工具 → 各自加上不同前缀；扩展工具名和内置工具同名 → 被拒并进入 error 状态。
  - 前端：渲染器能同时匹配带前缀的新名和旧名。
- **验收**：sidecar 自测中，向会话发消息让模型调用 `wls-repl` 的工具，日志显示带前缀的工具名，UI 渲染器正常显示；CDP 截图确认。
- **实施记录**：`9737d0f201`（B3 串行智能体中途消失，T2.1 部分经主会话验证完整性后提交；T2.3/T2.6 未开始）。验证：typecheck 通过；`bun test test/extension test/tool` 1260 pass / 1 fail（`dsh_consult` 为预存陈旧快照，`c40506c81a` 单独修复）；e2e 用 `e2e_ext_e2e_ping` 通过。实现：后端 `extension/tools.ts` 派生 ns（id 末段、`-`→`_`），app `id.ts` 镜像 + 源码字面量 parity 测试；冲突经 `toolNameConflicts` 记录 + error 日志 + 扩展 error 状态（slot 新增 `"tool"` phase）；前端渲染器 `{primary, legacy}` 双名匹配；三扩展工具改裸名。遗留：sidecar/CDP 实测未做；manifest.ts 未改（原有校验已接受未加前缀名）。

### T2.2 激活事件语义（依赖 D2）

- **文件**：`packages/app/src/extensions/reconcile.ts`、`host.tsx`、`specs/extensions/design.md` §激活。
- **步骤（按推荐方案"作提示"）**：
  1. 在 design.md 里写明：`onStartup` 表示启动即激活；其他事件只用于声明和展示，贡献点被用到就会隐式激活。
  2. manifest 校验：如果某个贡献点没有对应的激活事件，打 info 日志即可，不报错。
  3. 如果 D2 选择"严格执行"，则改为：贡献点被使用时检查是否有对应事件，没有就拒绝并提示。这需要增加测试，还要同步修改三个扩展的 manifest。
- **验收**：文档与行为一致；现有测试通过。
- **实施记录**：`148f1ce2ce`。验证：`bun test test/extension` 659 pass / 0 fail；双端 typecheck 通过。发现：前端已是"提示"语义（`reconcile.ts` 仅消费 `onStartup`，`registerPlaceholders` 为全部贡献点注册占位触发隐式激活），无需改前端代码；后端 `validateContributions` 新增贡献点缺事件时的 info 提示，`settings` 贡献点无对应事件类型不纳入检查。

### T2.3 `web.apiVersion` 优雅降级

- **文件**：`packages/opencode/src/extension/schema.ts`、`manifest.ts`、`registry.ts`；`packages/app/src/extensions/api.ts`。
- **步骤**：
  1. schema 中 `Web.apiVersion` 改为 `Schema.Number`，在 `manifest.ts` 里做语义检查：不支持的版本**只丢弃 web 部分**，产出警告，server 部分照常可用。
  2. `Info` 增加 `warnings?: string[]`，或复用 `error` 字段加上 `webSkipped` 标记，UI 在扩展管理页显示"前端部分需要更新的 OpenCode"。
  3. `manifestVersion` 仍保持硬拒绝（`incompatible` 状态），这是正确的。
- **测试**：manifest 写 `web.apiVersion: 2` → server 部分正常，`web` 为空，带有 warning。
- **验收**：后端测试通过；CDP 中扩展管理页能看到这条警告。
- **实施记录**：`9f3f03b313`（重派智能体完成，与 T2.6 同一批）。验证：`bun test test/extension` 692 pass；app extensions 214 pass；双端 typecheck 通过。实现：`apiVersion` 放宽为 `Schema.Number` + `WEB_API_VERSION=1` 常量；不支持版本丢弃 `manifest.web` 并推入稳定告警码 `web.apiVersion:<n>`（`Info.warnings` 透传，SDK types.gen 手工同步）；app 侧 `warnings.ts` 映射告警码为 i18n，详情页新增 Warnings 卡片；`manifestVersion` 仍硬拒绝。遗留：CDP 未验证。

### T2.4 权限字段规范化（依赖 D3）

- **文件**：`packages/opencode/src/extension/schema.ts`、`manifest.ts`；app 端安装预览和扩展详情 UI（grep `permissions` 定位）；`specs/extensions/design.md` §安全。
- **步骤**：
  1. 定义词表 `PERMISSIONS = ["fs:read", "fs:write", "process:spawn", "network", "tools", "settings:secret"]`，以现有扩展实际用到的为准，先 grep 三个扩展的 manifest。
  2. 校验：未知权限打 warn 日志，并在 UI 标为"未知权限"，不阻止安装（保持向前兼容）。
  3. 安装预览和详情页在权限列表旁加说明："权限为扩展自述，当前版本不做运行时限制"。
  4. 在 design.md 写明执行路线：Phase 5 后对 `tools` 和 `process:spawn` 做执行（T5.9）。
- **验收**：单测覆盖未知权限的情况；CDP 截图确认安装预览中有这条说明。
- **实施记录**：`a1b1159d34`。验证：`bun test test/extension` 659 pass；app extensions+i18n 187 pass；双端 typecheck 通过。词表 = 计划六项（三扩展实际用 `fs:read`/`process:spawn`/`tools`）；app 侧 `permissions.ts` 镜像 + parity 快照测试锁定 schema 字面量；安装预览与详情页标注未知权限 + "声明不强制"说明（en/zh/zht）。遗留：CDP 未验证（无运行实例）；`design.md` §3.3 表格 `opencode.permissions` 行仍为旧列表，留待 T7.1 统一。

### T2.5 扩展子进程托管

- **文件**：
  - `packages/extension-kit/src/server.ts`（新增 API）；
  - `packages/opencode/src/extension/runtime/index.ts`（`createHost`）、`runtime/timers.ts`（参考其代际作用域的写法）；
  - 三个扩展 `server.ts` 和 `mathematica-notebook/src/kernel.ts`（迁移）。
- **步骤**：
  1. `ExtensionHost` 新增 `spawn(command, args, options): ManagedProcess`。它由宿主创建子进程，绑定到当前代际，并使用独立进程组（`detached: true`，dispose 时 `process.kill(-pid)`，Windows 用 `taskkill /T`）。可以参考 `packages/desktop/src/main/process-tree.ts` 的实现思路，但不跨包引用。
  2. dispose 和 quiesce 时：先 SIGTERM，宽限期（默认 3s，可配置）后 SIGKILL，并等待 exit 事件，不能只靠超时就当作已退出。
  3. 每一步都打日志：`extension process spawn/exit/kill id=<id> pid=<pid> gen=<gen>`。
  4. 迁移三个扩展：用到 `spawn`/`child_process` 的地方改为 `host.spawn`。`server()` 里拿不到 host 的，从 `input.extension` 获取。
- **测试**：
  - 扩展启动一个 `sleep 1000` 的子进程 → disable → 断言该 pid 已退出；
  - 子进程忽略 SIGTERM → 宽限期后被 SIGKILL；
  - 子进程再派生孙进程 → 两者都被清理。
- **验收**：后端测试通过；sidecar 自测：启用 wls-repl，执行一次求值，然后停用，用 `ps` 确认 WolframKernel 进程已退出。
- **实施记录**：`45b27a1589`。验证：`bun test test/extension` 706 pass（含 `runtime-process.test.ts` 7 项）；kit 29 pass；三扩展 typecheck/test/build 全过。**sidecar 实测**：wls-repl `kernel.evalAwait`→`"2"`，disable 后 wolframscript+WolframKernel 整组（PGID）消失，日志 spawn→SIGTERM→exit 齐全。实现：`ManagedProcess` 契约入 kit `server.ts`；新 `runtime/process.ts`（node:child_process，Bun/Node 通用；detached 进程组 `-pid` 整杀，Windows `taskkill /T`；TERM→宽限→KILL→等真实 exit）；`Entry.processKills`+`drainProcessKills` 接 disable/reload/quiesce/disposeAll。迁移：wls-repl/mathematica-notebook 内核、hello-viewer、e2e fixture；`sweepStaleKernels` 的 `ps`+kill 孤儿回收有意保留。遗留：`kernel.status` 的 `Schema.Unknown` 编码 WARN 为存量问题；T5.6 权限检查点已在 spawn 内注释预留。

### T2.6 RPC 并发上限与事件限流

- **文件**：`packages/opencode/src/extension/runtime/index.ts`（rpc 入口约第 940 行；`emit` 约第 316 行）。
- **步骤**：
  1. 每个扩展的 RPC 并发上限默认 32，超出直接拒绝，返回 `ExtensionRpcError code=busy`，不排队，避免无界积压。
  2. `host.emit` 按扩展做令牌桶限流（默认 200 条/秒，突发 400），超出部分丢弃，并每秒汇总打一条 warn 日志。
  3. 这些上限放进 testing 覆盖接口，方便测试修改。
- **测试**：并发 33 个慢 RPC → 第 33 个被拒；高频 emit 超出部分被丢弃，并有汇总日志。
- **验收**：后端测试通过。
- **实施记录**：`f25a831192`（重派智能体完成）。验证：`bun test test/extension` 692 pass；typecheck 通过。实现：`RPC_CONCURRENCY_LIMIT=32` 原子准入检查（注册前判断，超限抛 `ExtensionRpcError("busy")` 不排队）；`host.emit` 按扩展令牌桶（200/s、突发 400），丢弃计数 + 每窗口聚合 warn（timer unref）；`testing.setLimits/reset` 可调。测试要点：并发语义是"同时在途"——gate 持锁至 `running+busy+other` 全部落定再断言。

### T2.7 补齐 spec 已承诺但缺失的前端能力

- **文件**：`packages/app/src/extensions/safe-mode.ts`、`host.tsx`、`mount.ts`、`panel-content.tsx`、`activation.ts`。
- **步骤**：
  1. **自动安全模式**：连续两次启动都出现扩展激活失败并导致页面级错误时，下次启动自动进入安全模式，并弹出提示和"重新启用扩展"按钮。计数通过 `window.api.storeGet/storeSet` 持久化（不能用 localStorage）。
  2. 错误边界在"重试"之外增加"停用此扩展"按钮，调用现有的 setEnabled API。
  3. 激活后核对：`activate()` 返回后，检查 manifest 声明的贡献点是否都已注册，缺失的打 warn 日志并在 UI 显示。
- **测试**：安全模式计数逻辑的单测；错误边界按钮的单测（用 happydom）。
- **验收**：CDP 中用一个故意抛错的测试扩展（可以基于 hello-viewer 改出临时版本，测完删除）验证按钮和安全模式。
- **实施记录**：`09761a45a7`（`host.tsx` 接线因与 T2.1 行级交织，随 T2.1 提交合入）。验证：typecheck 通过；extensions 测试 191 pass（+safe-mode 9 例、mount/host 新例）；test-browser extension-mount 10 pass。实现：crash-strike 计数经 `window.api.storeGet/storeSet`（`extension.safeMode.crashes.v1`）持久化、无 api 时内存降级、3s 超时兜底；仅"扩展归因 flag 置位 + 页面级边界"才累加，健康启动清零，URL 参数始终优先；"停用此扩展"经 `requestExtensionDisable` → `setEnabled(id,false)`；激活后 `missingContributions` 核对（settings 由宿主直渲染不核对）。遗留：file-viewer 边界（`file-viewer-content.ts`）未接归因 flag；CDP 未验证。

---

## Phase 3：分发信任链

### T3.1 描述符签名（依赖 D4）

- **文件**：
  - `script/extension-release.ts`（生成签名）、`script/extension-publish.ts`（上传 `stable.json.sig`）；
  - `packages/opencode/src/extension/release.ts`、`install.ts`（校验）；
  - `packages/desktop/src/main/extension-archive.ts`（desktop 拖拽和 release 路径同样要校验）；
  - 新增可信公钥常量文件，例如 `packages/opencode/src/extension/trust.ts`。
- **步骤**：
  1. 签名格式：对 `stable.json` 的原始字节做 Ed25519 分离签名，得到 base64 的 `stable.json.sig`。私钥从环境变量 `OPENCODE_EXTENSION_SIGNING_KEY` 读取，**不能写入仓库或日志**。
  2. 宿主内置 `{ keyId, publicKey, origins: ["https://raw.githubusercontent.com/panyw5/open-extensions/"] }` 列表。描述符 URL 落在受信 origin 内时**必须**验签；不在列表内的来源保持现有行为，但 UI 显示"未签名来源"。
  3. 支持多把公钥，便于轮换；签名文件里带 `keyId`。
  4. 校验失败时直接拒绝，错误码 `signature_invalid`，并打日志（不包含签名内容）。
  5. 在 `release-install-design.md` 中补充签名协议说明。
- **测试**：签名正确 → 通过；篡改一个字节 → 拒绝；keyId 未知 → 拒绝；不受信 origin → 通过并带"未签名"标记。
- **验收**：后端和 desktop 测试通过；在本地用 dry-run 走一遍发布流程，生成签名后，用本地 HTTPS 夹具（已有 `release-integration.test.ts` 可参考）完成一次安装。
- **实施记录**：`e40701798d`。验证：release-signature.test.ts 15 例全过（篡改/未知 keyId/缺失 sig/非可信 origin/多 key 轮换/staged 三场景）；HTTPS 夹具真实安装 `signatureStatus: "verified"`；dry-run 发布产出签名；`bun test test/extension` 688 pass。实现：`stable.json.sig` = JSON 信封 `{keyId, signature(base64)}`，Ed25519 签原始字节，`keyId = ed25519-<sha256(spki)[:16]>`；受信 origin 强制验签，非受信标记 unsigned；私钥仅经 `OPENCODE_EXTENSION_SIGNING_KEY` 注入。注意：内置公钥 `ed25519-e1b01f86f6422244` 的私钥须由发布者保管；UI 签名状态行 CDP 未验证。

### T3.2 产物不可变 + 回滚防护

- **文件**：`script/extension-publish.ts`、`packages/opencode/src/extension/schema.ts`（RegistryRow）、`install.ts`。
- **步骤**：
  1. 发布脚本去掉 `--clobber`。tag 已存在时，比较已发布资产的 sha256：一致就跳过上传；不一致就报错，要求升级版本。
  2. `stable.json` 增加单调递增的 `sequence` 字段（每次发布加 1），并纳入签名。
  3. RegistryRow 增加 `releaseSequence?: number`。执行 `release-current` 更新时，如果新描述符的 `sequence` 比已记录的小，就拒绝，错误码 `rollback_detected`。用户显式降级时，现有预览中的降级标记照常生效，不受影响。
  4. 若升级注册表 schema，要注意 v3 兼容：新字段为可选，不需要升版本号。
- **测试**：sequence 回退被拒；相同 sequence 的重复安装视为幂等。
- **验收**：后端测试通过。
- **实施记录**：`7b025e75a6`。验证：低序列拒绝（注册表不变）、等值幂等、更高放行、在线路径同样拒绝、显式降级预览豁免；dry-run 实测首发 sequence=1、二次=2 自动递增、无私钥真实发布快速失败。实现：`--clobber` 已移除（tag 存在且摘要一致跳过、不同报错升版）；`sequence` 纳入签名载荷；`RegistryRow.releaseSequence` 可选字段不升版本；`rollback_detected` 门在 install.ts（与签名共享文件，随 `e40701798d` 提交）；HTTP 映射 `signature_invalid→UpstreamError`、`rollback_detected→ConflictError`。

### T3.3 `open-extensions` 定位调整（依赖 D5）

- **文件**：`script/extension-publish.ts`。
- **步骤（按推荐方案"只放分发内容"）**：
  1. 去掉 sync source 步骤，发布仓库只提交 `<name>/stable.json`、`<name>/stable.json.sig` 和 README。
  2. 发布前在 monorepo 内校验 git 工作区干净，并把 monorepo 的 commit hash 写进 `stable.json` 的 `source.commit` 字段，用于溯源。
  3. 远端仓库里已有的源码目录**不要自动删除**。生成一份待删清单交给用户确认（这属于破坏性操作）。
- **验收**：dry-run 输出只包含描述符相关文件。
- **实施记录**：`165e9dcc2e`。验证：wls-repl dry-run 端到端（产物仅 `stable.json`+`.sig`，含 `source.commit`/`sequence`）；`verifyDescriptorSignature` 对含 commit 字节验签通过、篡改 commit 被拒；util 154 pass、release 相关 187 pass。实现：去掉 sync source；`--source-commit` 经 `isCommitHex`（40/64 hex）校验后在 stringify+签名**前**注入；扩展目录级 provenance 门（脏则真实发布失败、dry-run 警告）；`staleEntries()` 输出待删清单不自动删。遗留待用户确认：open-extensions 待删清单（`.DS_Store`、两扩展的源码目录）+ 根 README/`.gitignore` 旧文案需手动处理；provenance 作用域选了扩展目录而非仓库根。

### T3.4 统一下载与校验规则

- **文件**：
  - 新增纯函数模块，放在三端都能依赖的位置。实施前先确认 `packages/opencode`、`packages/app`、`packages/desktop` 共同依赖哪个包（检查各自 package.json，候选是 `@opencode-ai/extension-kit` 或 `@opencode-ai/sdk`）。如果没有合适的，就在 `packages/extension-kit/src/protocol.ts` 新建，并加 `./protocol` 导出。
  - `packages/opencode/src/extension/download.ts`、`release.ts`；
  - `packages/desktop/src/main/extension-download.ts`、`archive-digest.ts`；
  - `packages/app/src/extensions/catalog-install.ts`。
- **步骤**：
  1. 抽出这些共享内容：常量（`MAX_ARCHIVE_BYTES = 100 MiB`、`MAX_DESCRIPTOR_BYTES = 64 KiB`）、sha256 格式校验、描述符 URL 规范化、描述符结构解析（schema 无依赖实现，或使用 effect Schema，要看三端是否都能用）。
  2. 三端改为引用共享模块。修正 `archive-digest.ts` 的 200 MiB 上限，与其他地方保持一致。
  3. SSRF 防护（DNS 固定连接地址等）仍只放在 server 端，不要强行共享。
- **测试**：共享模块的单测；三端原有测试保持全绿。
- **验收**：grep `200 \* 1024 \* 1024` 等硬编码上限只剩共享模块一处。
- **实施记录**：`4adcd4117e`。验证：util 单测 146 pass（含新模块 86 例）；三端 typecheck 通过；验收 grep 通过（残留 `64*1024` 均为流式 chunk size）。落点选择：`@opencode-ai/util`（三端现有依赖、`src/*.ts` 源直用、零新增依赖）而非 extension-kit/sdk（不是 desktop/app 依赖）；`isIP` 用 WHATWG 规范化的点分十进制判定等价替换保持零依赖；`isValidVersion`/`isValidRange` 经注入保持无 semver 依赖；SSRF 留服务端。

### T3.5 描述符增加主机兼容范围

- **文件**：`script/extension-release.ts`、`packages/opencode/src/extension/release.ts`、`packages/app/src/extensions/catalog.ts` 及目录 UI。
- **步骤**：生成描述符时，从扩展 `package.json` 的 `engines.opencode` 读取兼容范围，写入 `stable.json` 的 `engines` 字段。目录展示时先判断兼容性，不兼容的标灰并说明原因，不必下载产物。
- **验收**：单测覆盖；CDP 截图确认。
- **实施记录**：`9a9d4c20af`。验证：opencode 688 pass、app 214 pass、util 86 pass；目录 UI 标灰 + "Requires opencode {range}" + Install 禁用。缺省语义：未声明 = 无限制但标记"未声明"（区分于写 `*`）；非法 range 发布期即败；非 semver/dev 宿主版本跳过门控（对齐 `checkPluginCompatibility` 逃生口）；服务端在产物下载前门控，app 目录预检只拉描述符。三扩展声明 `engines.opencode: ">=1.18.0"`。遗留：`platform.version` 远程模式可能与 server 版本不一致（服务端门控兜底仍安全）。

---

## Phase 4：SDK 与开发体验

### T4.1 把 `wolfram` 从通用 SDK 拆出

- **文件**：新建 `packages/wolfram-lang/`（private，workspace 包），把 `packages/extension-kit/src/wolfram.ts` 和对应测试迁过去；更新 `packages/extension-kit/package.json` 的 exports；修改 `wls-repl` 和 `mathematica-notebook` 的依赖和 import。
- **步骤**：
  1. 用 `git mv` 迁移源码和测试，新包的 `package.json` 和 `tsconfig` 参照 extension-kit。
  2. 删除 kit 的 `./wolfram` 导出。
  3. 两个扩展把依赖加到 `devDependencies`（会被打包进产物），并更新 import 路径。
  4. `bun install` 刷新 lockfile。
- **验收**：grep `extension-kit/wolfram` 结果为 0；两个扩展的 build 和 test 通过；产物大小变化不超过 1%。
- **实施记录**：`f7f2b45e1a`。验证：grep=0；kit 18 pass、wolfram-lang 1 pass；三扩展 typecheck/test/build 全过；产物逐字节一致（0% 变化）。新包 `@opencode-ai/wolfram-lang`（private，`packages/*` glob 内会跟随 sync-version 主版本）；两扩展 `highlight.ts` 改 import + devDep `workspace:*`。遗留：hello-viewer 已提交 dist 为陈旧产物（rebuild 会产生 ~11k 行风格 diff，建议发布流程统一重建）。

### T4.2 `extension-kit` 可构建、可发布（依赖 D6）

- **文件**：`packages/extension-kit/package.json`，新增 `build` 脚本和 `tsconfig.build.json`；`vite.js`、`shims.js`、`scope.js` 维持 JS 原样。
- **步骤**：
  1. 用 `tsgo`/`tsc` 生成 `dist/*.js` 和 `dist/*.d.ts`。exports 增加 `types`/`import` 条件，并保留 `development` 条件指向 `src`，让 monorepo 内继续直接使用源码。
  2. 确保 `files`、`publishConfig` 正确，并把 `peerDependencies` 写全：`@opencode-ai/plugin` 的类型依赖要能独立解析，或者把需要的类型内联导出。
  3. 写一份**仓库外构建验证**脚本：在临时目录 `npm pack` kit，用 `templates/extensions/` 新建一个带 web 部分的模板，安装 kit 的 tgz 后完成 build 和 typecheck。
  4. 只有 D6 授权后才执行实际发布。
- **验收**：仓库外构建验证通过。
- **实施记录**：`b7b762a9d9`。验证：`bun run typecheck`/`bun run test`（28 pass）/`bun run build` 通过；`bun script/verify-pack.ts` PASS（tgz 打包 → 临时工程 npm install `file:` tgz + npm 版 plugin → `vite build`/`bun build`/`tsc --noEmit` 全过）；三扩展 build+typecheck、`packages/opencode` typecheck 均不受影响；裸 `npm pack` 经 prepack/postpack 钩子亦产出正确 tgz 且恢复 package.json。实现：仓库内 exports 为 `{types, development, default}` 全指 `./src`（所有工具零配置解析源码，`development` 条件按计划保留）；打包时 `script/pack.ts` 重写为 `{types→dist.d.ts, development→src(随包发布), import/default→dist.js}`——未采用 exports 数组回退（实测 bun 不支持数组回退，Node 支持）。"build": `tsgo -p tsconfig.build.json`（emit dist/{web,server,rpc}.{js,d.ts}+maps）；`vite.js`/`shims.js`/`scope.js` 维持纯 JS 随 `files` 打包；peerDeps 补全 `@opencode-ai/plugin`+solid-js+vite+vite-plugin-solid 并全部 `peerDependenciesMeta.optional`（各子路径按需）；`publishConfig.access: public`、`sideEffects: false`。遗留：`dist/*.d.ts` 内相对引用无扩展名（`./server`），bundler 解析 OK、`nodenext` 消费者不可解析；`npm pack` 中途失败时 postpack 不执行，需 `bun ./script/pack.ts --restore` 恢复；`web-and-server`/`server-only` 模板为无依赖纯 JS starter，不消费 kit，verify-pack 另搭 hello-viewer 式工程验证。

### T4.3 作者 CLI：`opencode extension create | validate | pack`

- **文件**：`packages/opencode/src/cli/cmd/extension.ts`；复用 `src/extension/manifest.ts` 的校验和 `script/extension-release.ts` 的打包、描述符逻辑（必要时把它下沉到 `src/extension/release-author.ts`）；`templates/extensions/`（新增带 web 部分的模板 `web-and-server`）。
- **步骤**：
  1. `validate [dir]`：用安装时的同一套规则校验 manifest、入口文件是否存在、web 资源，以及打包后的路径策略（复用 archive 的路径规则）。
  2. `pack [dir]`：先 validate，再 `npm pack`，并输出 sha256。
  3. `create <dir> --template server-only|web-and-server`：复制模板，并替换 id、名称等占位符。
- **测试**：每个子命令一个 CLI 测试，参考已有的 `test/extension/cli.test.ts`。
- **验收**：`create → validate → pack` 走通，生成的 tgz 能通过本地安装测试。
- **实施记录**：`96ca4c9d6c`。验证：`bun test test/extension` 699 pass；typecheck 通过；standalone 模板测试 6/6（真实 node/npm 仓库外）；cli-author 4/4（tgz 走真实 `extractArchive`+`manifest.load`）。实现：新模块 `release-author.ts`（`validatePackage`/`packPackage`/`createFromTemplate`）；`archive.ts` 抽出 `packPathParts` 供作者端复用同一路径规则；模板经 `with { type: "file" }` 内嵌进二进制；新增 `web-and-server` 模板；三命令 `instance:false` 不走 mutations 门。遗留：编译产物中 `create` 冒烟未跑（需另行 build sidecar）。

### T4.4 类型化 RPC 辅助

- **文件**：`packages/extension-kit/src/web.ts`、`server.ts`，新增 `rpc.ts`；迁移 `hello-viewer` 作为示范。
- **步骤**：
  1. 提供 `defineRpc<Contract>()`。作者在共享的类型文件里声明 `type Contract = { method: { input: I; output: O } }`，server 端得到类型化的 handler 映射，web 端得到类型化的 `call`。
  2. 可选运行时校验：接受符合 Standard Schema 接口的校验器（只用类型协议，不引入 zod 依赖）。
  3. 保持向后兼容：原来的 `rpc.call<T>(name, input)` 不变。
- **测试**：类型测试（通过 `tsgo --noEmit` 的 fixture），以及运行时校验失败时返回 `invalid_input`。
- **验收**：hello-viewer 迁移后，重复的 `typeof` 校验被移除，测试全绿。
- **实施记录**：`7427de7ce5`。验证：kit typecheck + rpc.test 5/5；hello-viewer typecheck/14 test/build 全过；旧 `rpc.call<T>` 兼容。实现：`defineRpc<Contract>` + Standard Schema V1 纯类型协议（零依赖），校验失败抛 `ExtensionRpcError("invalid_input")`（宿主按鸭子类型归一 400）；hello-viewer 新增 `contract.ts` 共享契约，5 处 typeof 校验移除。行为变化：结构性非法输入现返回 `invalid_input`（原静默取默认值）。遗留：`./rpc` 为扁平字符串导出，T4.2 落地后需并入其 types/import 条件结构。

### T4.5 依赖声明规范统一

- **文件**：三个扩展的 `package.json`。
- **步骤**：统一约定：kit 和 plugin 放 `devDependencies`（构建时打包），宿主共享的模块不打包；在 kit README 中写明这一约定。
- **验收**：三个扩展 build 通过，产物与改动前一致或只有微小差异。
- **实施记录**：`bbc5f5cd99`（与 T4.1 合并派发避免 package.json 并发冲突）。验证：三扩展 typecheck/test/build 通过，产物与基线逐字节一致；`bun install --frozen-lockfile` 一致。hello-viewer 的 kit/plugin 从 dependencies 移入 devDependencies（唯一归错类者）；wls-repl 删空 dependencies；kit README 新增"依赖声明约定"节（完整 README 属 T7.2）。

### T4.6 共享模块清单对齐 spec + 构建期写入版本

- **文件**：`packages/app/src/extensions/modules.ts`、`packages/extension-kit/shims.js`、`vite.js`、`test/shims.test.ts`。
- **步骤**：
  1. 对照 `design.md` §7.5 列出的 UI 模块，按实际需要逐个加入（宿主和 kit 白名单同步，由 parity 测试锁定）。只加真正有扩展需要的，每加一个都说明理由。
  2. kit 的 vite 插件把构建时的 `solid-js` 版本写进产物元数据（例如 `export const __opencodeBuild = { solid: "x.y.z" }`，或写入 manifest 的生成字段），供 T1.6 使用。
  3. shim 遇到宿主缺失的导出时抛出明确错误，不再静默返回 `undefined`。
- **验收**：kit 和 app 测试通过；CDP 中三个扩展都能正常激活。
- **实施记录**：`4e49aa0c05`。验证：kit 28 pass、app extensions 214 pass、三扩展 build 全部含 `__opencodeBuild` 具名导出（`{solid:"1.9.10"}` 与 `HOST_SOLID_VERSION` 一致）。实现：vite 插件 `resolveSolidVersion()`（扩展根优先→kit 回退→warn 跳过）+ banner 注入具名导出；shim 缺导出抛错列全缺失名；`modules.test.ts` 加白名单 parity（`--conditions=browser` 子进程逐导出校验）。结论：**白名单无需新增**——三扩展实际消费 `solid-js`、`solid-js/web`、`@opencode-ai/ui/button`、`@opencode-ai/ui/spinner` 均已在列；§7.5 其余模块无使用者暂不暴露。遗留：CDP 未验证。

---

## Phase 5：Server 扩展进程隔离（核心改造）

> 这是收益最大、风险也最高的阶段，要求**串行推进、每步可回退**。
> 原型：`specs/extensions/prototypes/src/extension/execution-{protocol,process,supervisor,worker}.ts`，设计见 `lifecycle-supervisor.md`。
> 现状：三个扩展的 server 端实际只用了 `activate`、`rpc`、`tool`、`dispose`（已用 grep 核实），可以先代理一个受限的 API 子集。

### T5.0 设计确认文档

- **产出**：`specs/extensions/process-isolation-design.md`。
- **内容要点**：
  1. 进程模型（D7）：每个扩展一个宿主进程，按需启动。sidecar 用 `process.execPath` 加隐藏子命令 `opencode extension-host <id>` 启动自身。utilityProcess 只能由 Electron main 创建，而 sidecar 本身就是 utilityProcess，所以这里只能用 `child_process`。dev 环境（`bun run --conditions=browser ./src/index.ts`）的启动参数需要单独处理。
  2. 传输：复用原型的 fd3/fd4 JSON 帧协议（Node 和 Bun 两种适配都已验证）。stdout/stderr 只接入日志。
  3. 代理 API 的范围（第一期）：
     - host 侧：`id`/`version`/`dataDir`/`cacheDir`/`serverUrl`/`settings`/`setTimeout`/`setInterval`/`emit`/`log`/`spawn`；
     - 进程级服务：`rpc` 和 `dispose`；
     - 实例级 `server()`：只支持 `rpc`、`tool`、`event`（单向推送）、`dispose`。
     - **暂不支持** `chat.*`、`permission.*`、`config` 等需要同步改写宿主对象的钩子。manifest 声明 `isolation: "process"` 的扩展如果返回了这些钩子，就报错并说明原因。
  4. 工具代理：worker 内把 `@opencode-ai/plugin/tool` 的 zod 参数 schema 转成 JSON Schema 发给宿主。宿主注册代理工具，`execute` 通过 request 帧调用。`ctx.abort` 映射为 cancel 帧，`ctx.metadata()` 映射为 worker 发给宿主的 notify 帧。其他 ctx 能力逐项列出：要么支持，要么明确不支持。
  5. `PluginInput` 的处理：只传可序列化的部分（`directory`、`worktree`、`serverUrl`）。`client` 由 worker 用 serverUrl 加凭据自建 SDK 客户端；凭据通过 fd 传递，不放环境变量，也不写日志。`$`（BunShell）不提供。
  6. 生命周期映射：现有的 generation、epoch、fence 对应到"进程实例 + 协议 epoch"。dispose 的含义是 drain → dispose → **观察到 OS 退出**，不以超时作为退出的依据。
  7. 崩溃策略：观察到异常退出后，扩展进入 `error` 状态，按指数退避自动重启（1s/5s/30s，最多 3 次），之后保持 `error`，等待手动 retry。在途的 RPC 和工具调用返回 `extension_crashed`。
  8. 资源限制：启动参数里设置 `--max-old-space-size` 等（Node 路径可用；Bun 不支持的部分要写明）；RPC 并发上限沿用 T2.6。
  9. 兼容性：manifest 新增 `server.isolation?: "process" | "inline"`，默认 `inline`，过渡期结束后默认值改为 `process`。另外新增 server `apiVersion`，用于后续演进。
- **验收**：用户确认设计后，才能进入 T5.1。

### T5.1 协议与 supervisor 生产化

- **文件**：新建 `packages/opencode/src/extension/host-process/{protocol,transport,supervisor}.ts`，从原型迁移并按 Effect 规范重写外层：supervisor 作为 `Context.Service`，进程用 `ChildProcessSpawner`，生命周期用 `Effect.acquireRelease`。
- **步骤**：
  1. 迁移协议帧定义和严格解析（保留原型中"拒绝未知字段、未知版本、超长帧"的行为）。
  2. 迁移 supervisor 的 hello、ready、请求上限、cancel、drain、dispose、exit 观察逻辑。
  3. 每一步都打日志，带上 `extension`、`runtime`、`epoch`、`frame` 字段。
  4. 迁移原型中对应的单测和进程测试到 `packages/opencode/test/extension/host-process/`。
- **验收**：迁移过来的测试在 Node 和 Bun 下全绿（原型中的 skip 项要逐项说明）。
- **实施记录**：`9d8d8a7e74`。验证：`bun test test/extension` 809 pass；**Bun/Node 双 worker 路径各 14 条全链路用例全绿**；fd/GC 回归 60 轮绿；typecheck 0 错误。实现：`host-process/` 5 源文件 + `control-fd.c`（darwin Bun extra-fd 适配）；严格 Schema 帧 + `RuntimeIdentity` fence + 反向 `host.call` 通道；supervisor 为 `Context.Service`（scoped worker、init/readiness/drain/dispose/exit 观察、崩溃退避 1s/5s/30s×3）；`terminate` 提升为进程组 SIGKILL。修复实测问题：Bun.spawn 不继承 env、send 同步抛错、drain 在途 settle。遗留：linux/win extra-fd 未验证（Q8 风险）；sidecar 打包需携带 `control-fd.c`（T5.4）；skip 项：Electron probe/admission 持久化→T5.4、ownership lease→T5.3。

### T5.2 worker 入口与 API 代理

- **文件**：新建 `packages/opencode/src/extension/host-process/worker.ts`；在 `packages/opencode/src/cli/cmd/` 注册隐藏子命令 `extension-host`；修改 `packages/extension-kit/src/server.ts` 的类型（增加 isolation 相关的能力说明）。
- **步骤**：
  1. worker 启动流程：读取 fd 控制帧 → 用 `import()` 加载扩展的 server 入口 → 构造代理 host → 调用 `activate` → 回报 ready。
  2. 实现 T5.0 第 3–5 条中的代理。
  3. 工具 schema 转换：先确认 `@opencode-ai/plugin` 用的 zod 版本，以及是否已有 `z.toJSONSchema` 或现成的转换工具；没有的话再评估是否加依赖（遵守依赖规则）。
- **测试**：用 fixture 扩展分别覆盖 rpc、tool（带 metadata 和 abort）、emit、settings 变更推送、timers、spawn。
- **验收**：fixture 测试通过。
- **实施记录**：`2ef2a676ef`（+`13ced05744` 补 T7.1 漏提的归档取代标注）。验证：`bun test test/extension` 831 pass；Bun/Node worker 各 10/10、CLI 2/2；kit 29 pass。实现：`application.ts`（worker 加载器+代理 host，§3 矩阵全覆盖：settings/emit/timers/spawn 信用流控/service.rpc/instance 描述符/ctx.abort+metadata+ask/stub）；`entry.ts`+`src/index.ts` yargs 前拦截（避全局 middleware）；`tool-schema.ts` 复用既有 zod→JSONSchema（零新依赖）。修复实测问题：`proc.*` 早到帧回放、信用计账、frameBytes 一致性、Node ESM 后缀、测试 harness 切片。遗留：notify 超容量丢帧需宿主限速；proc.stdout 生产者须遵守 credit 门控；spawn ENOENT 仅 error 无 exit 需宿主补发。

### T5.3 运行时接入

- **文件**：`packages/opencode/src/extension/runtime/index.ts`、`slot.ts`、`hooks.ts`；`packages/opencode/src/plugin/index.ts`；`packages/opencode/src/extension/manifest.ts`/`schema.ts`（`isolation` 字段）。
- **步骤**：
  1. slot 根据 `isolation` 选择执行后端：`inline` 走现有路径，`process` 交给 supervisor。对外接口（`instanceHooks`、`rpc`、`quiesce`、`retry`、状态事件）保持不变。
  2. 代理工具通过 `hooks.tool` 注入（沿用 T2.1 的命名空间规则）；`bindHook` 的代际检查继续生效。
  3. quiesce 和 disable 时调用 supervisor 的 stop，并等待观察到 rootExited 后才视为完成。结果是 unknown 时，进入 `blocked/needsRestart`，与现有语义保持一致。
  4. 崩溃重启策略（T5.0 第 7 条），状态通过 `extension.status` 推送给 UI。
- **测试**：
  - 扩展抛出 uncaughtException → **sidecar 存活**，其他扩展正常，该扩展进入 error 后自动重启；
  - 扩展死循环 → RPC 超时，stop 时外部终止进程，sidecar 正常；
  - disable、uninstall、update 流程与 inline 模式行为一致（复用 `lifecycle-api-matrix.test.ts`，按两种模式参数化运行）。
- **验收**：后端测试全绿；在 sidecar 中实测：故意让 hello-viewer 的 process 模式副本崩溃，确认后端和其他扩展不受影响。
- **实施记录**：`dfd9b14bf7`。验证：`bun test test/extension` 874 pass；tool/registry+路由 77 pass；**编译产物 sidecar 全链路实测**（hello→init→import→activate→rpc→host.spawn→dispose→exit 0）。实现：`server.isolation`/`apiVersion` schema + Q10 告警；`runtime/host-worker.ts`（supervisor 驱动 + 全代理面 + proc.* 接 T2.5 进程作用域）；崩溃重启/耗尽粘性错误/retry 恢复；`lifecycle-api-matrix`+`e2e-lifecycle` 双后端参数化（38+全生命周期一致）；`OPENCODE_EXTENSION_HOST_ARGV`/`isolationOf` kill-switch。修复：fixture settings schema、worker 错误消息保真、e2e ownership 清理。遗留：`opencode serve` 启动崩 `parseModels` SchemaError——**仓库既有问题**（models.dev 数据与 schema 不兼容，空 config 复现），与隔离无关；linux/win extra-fd（Q8）。

### T5.4 Desktop 集成与打包

- **文件**：`packages/desktop/src/main/sidecar.ts`、`server.ts`（确认子进程环境变量和退出时的清理）；desktop 打包配置（确认 `extension-host` 子命令在打包后的二进制里可用）。
- **步骤**：
  1. sidecar 退出时，supervisor 必须终止所有扩展宿主进程。Electron main 退出时，也要兜底清理进程组。
  2. 打包后的 app 中，`process.execPath` 应指向 sidecar 二进制，要实际验证。
- **验收**：先 `bun run script/build.ts`，再 `bun run dev:desktop`，然后通过 CDP 完成启用扩展、调用扩展、关闭应用三步，确认没有残留的 `extension-host` 进程（用 `ps` 检查）。
- **实施记录**：`0a43ea6960`。验证：typecheck 双包通过；test/extension 875 pass；**编译探针端到端 PASS**（bunfs argv 修复 + control-fd.c 物化编译生效）；**dev:desktop CDP 实测**：process 模式 hello-viewer 变体 install→viewer 渲染→disable→uninstall 全绿，worker 挂在 utilityProcess sidecar 下（`OPENCODE_CLI_PATH`→`bundledCliPath` 链）；SIGTERM 正常退出无残留；`kill -9` sidecar→worker 5s 内 fd-EOF 自杀+`child-process-gone` 自动重启双路径验证。修复两个真实打包回归：`isEmbeddedEntry()`（bunfs argv[1] 误当脚本）+ `control-fd.c` 文本内嵌物化（tcc 对 bunfs 虚拟路径不可见）；`execArgv` 透传（Q2）。遗留：linux/win extra-fd（Q8）；worker stderr 在 sidecar 日志呈 ERROR 级（外观）；Electron utilityProbe 原型不存在无可迁移；`math.spawn` 既有 1 fail（测试自身缺陷）。

### T5.5 迁移三个扩展到 `isolation: "process"`

- **文件**：三个扩展的 `package.json`（manifest）和 `server.ts`。
- **步骤**：
  1. 逐个切换。检查是否用到了不支持的钩子或 `$`，有则改写。
  2. `mathematica-notebook` 和 `wls-repl` 的内核进程通过 `host.spawn` 托管（依赖 T2.5）。
  3. 对比切换前后：RPC 延迟（p50/p95）、首次激活耗时、内存占用，结果记录到实施记录中。
- **验收**：每个扩展的测试通过；sidecar 自测中工具调用、RPC、面板交互都正常；CDP 截图确认。
- **实施记录**：`6969dfd2e1`。验证：三扩展 typecheck/test/build 全过；源码 sidecar 实测（hello-viewer echo+child spawn 全链路、wls-repl 真实内核 `1+1→2` 经 host.spawn 代理、notebook.read 解析；disable 整组回收 pgrep 为空）；CDP 实测（编译 sidecar worker + viewer 渲染 + Echo/Child ping/Greet emit 双向）。审计：三扩展零不支持项；`server:{isolation:"process",apiVersion:1}` 对旧宿主被剥离→向后兼容降级 inline。修复：wls-repl `ManagedProcess.pid` 异步回填导致孤儿清扫失效（改 5s 有界轮询）。性能（源码 worker 粗测）：冷激活 ~0.75s vs inline 2ms；RPC p50 1.30ms（+15%）/p95 3.30ms；worker RSS ~393MB。遗留：`ctx.ask` 真实 agent 弹窗未端到端；hello-viewer dist 未提交（陈旧产物）。

### T5.6 权限的粗粒度执行（依赖 D3、T5.3）

- **文件**：`host-process/worker.ts`，以及宿主侧的代理注册逻辑。
- **步骤**：
  1. 没有声明 `tools` 的扩展，宿主拒绝注册它的工具（宿主侧控制，worker 无法绕过）。
  2. 没有声明 `process:spawn` 的扩展，`host.spawn` 直接拒绝。注意：worker 内部仍然可以直接调用 `child_process`。完全阻止需要使用 Node 的权限模型，在 Bun 下不可用，必须在文档里**如实说明**这是"API 级限制，不是安全沙箱"。
  3. 宿主以 Node 运行时，评估是否给 worker 加上 `--permission --allow-fs-read=<extDir>,<dataDir> --allow-fs-write=<dataDir>`；不能实现的部分要写进文档。
- **验收**：单测覆盖拒绝路径；文档已更新。
- **实施记录**：`9421ee7088`。验证：`bun test test/extension` 879 pass（新增 `runtime-permissions.test.ts` 4 例钉死拒绝路径+inline 不强制）；三扩展全绿。实现：宿主侧两门——`instanceStart` 工具描述符过滤（未声明 `tools`→warn+丢全部工具+扩展不 error）、`onHostCall host.spawn` 拒绝（`denied` 码，worker 收 onError+exit 不算崩溃）；wls-repl/mathematica-notebook 补 `"tools"` 声明；design §6 语义同步为实际行为。**Node `--permission` 评估结论：不采用**——Bun worker 无对等、项目目录边界不可收敛、`--allow-child-process` 与存量裸用冲突；边界声明"API 级限制非安全沙箱"已入文档与注释。遗留：worker 内 `child_process` 仍可裸调（明示）。

### T5.7 运行时 Effect 化重构（借这次改造一并完成）

- **文件**：`packages/opencode/src/extension/runtime/**`、`extension/index.ts`（引用计数的 leases 全局变量）。
- **步骤**：
  1. 把模块级可变单例（`slots`、`importer`、`leaseDriver`、`generationPins`）收进一个 `ExtensionRuntime.Service`，每目录的部分用 `InstanceState`。
  2. 用 `Layer.mock` 替代 `testing.setImporter` 这类测试后门。
  3. 进程隔离成为默认后，评估并删除只为进程内热替换服务的机制（例如某些 pin 和 fence 分支），每删一项都要有测试证明不再需要。
- **验收**：行为不变，全部测试通过；runtime 代码行数和概念数量明显下降，在实施记录中写明对比数据。
- **实施记录**：`19d79e5eda`。验证：test/extension 879 pass 双后端全绿；tool+httpapi 611 pass；typecheck clean。实现：`makeService(options)` 收编全部模块级状态（16 个 `let`→0、8 个可变容器→0）为 `ExtensionRuntime.Service`+`Deps` 双 layer + `makeRuntime` facade（共享 memoMap，保留跨 layer 单例与猴子补丁兼容）；5 个 testing 后门删除→`ExtensionRuntime.make(options)` 每测独立 rt 或真实 fixture 替代，仅留 `reset`。裁剪评估：**零删除**——fence/pins/stale-hook/quiesce 门逐项证明双后端仍需要（保留理由见提交与测试）。指标：runtime/ 3056→3154 行（结构收编，非缩水）；模块级可变状态 24 项→0。遗留：`install-service.ts` 的 `services`/`coordinated`/`monitors` 模块级 Map 未收（超范围）。

### T5.8 默认值切换（依赖 D8）

- 新安装的扩展默认使用 `process`；`inline` 只允许本地 `path` 来源使用，非 `path` 来源声明 `inline` 时打 warn 日志，并在 UI 提示。
- **实施记录**：`165e6c0546`（Phase 5 收官）。验证：test/extension 885 pass；app extensions 218 pass；真 CLI+serve E2E（默认起 worker、受管 inline 警告+保持 inline+日志齐全、path inline 无警告、CLI 预览 Warnings 行）；CDP 实机（warning 映射 + 预览块渲染三语）。实现：`isolationOf` 缺省→process；`inlineIsolationWarning`→`Info.warnings`+`InstallPreview.warnings`+UI 警告块；语义：**非 path 显式 inline=警告但保持 inline**（design §7 执行机制是 visibility 非强制，§10 inline 为回滚路径）；依赖 inline 语义的 fixture 显式声明。顺带修 `runtime.test.ts` stale-copy（`test.deps.resetModuleCopies`）。遗留：sidecar 未重建（dev 实例在用）。

---

## Phase 6：测试与 CI

### T6.1 常驻的端到端生命周期测试（建议在 Phase 2 之前完成）

- **文件**：新建 `packages/opencode/test/extension/e2e-lifecycle.test.ts`；必要时新建 fixture 扩展 `test/extension/fixtures/e2e-ext/`，基于 hello-viewer 的最小功能（rpc、tool、emit、子进程）。
- **流程**：本地打包 fixture → 用 archive 来源安装（本地 HTTPS 夹具或 `local` 来源）→ 首次 RPC 触发激活 → 通过 ToolRegistry 执行工具 → 订阅 emit 事件 → disable（断言 hooks 被撤回、子进程退出）→ enable → update（版本 +1）→ uninstall（断言目录和数据按策略处理）。
- **要求**：不依赖 Wolfram，也不依赖 Electron，**默认运行**，不加 `skipIf`。
- **验收**：本地稳定通过 10 次（`for i in $(seq 10); do bun test test/extension/e2e-lifecycle.test.ts || break; done`）。
- **实施记录**：`c0b802eb8e`。验证：typecheck 通过；e2e 测试 2 pass；连续 10/10 通过；`bun test test/extension` 655 pass / 6 skip / 0 fail。实现：fixture `test.e2e-ext` 零依赖纯 ESM（echo/version/emit.ping/child.start RPC + `e2e_ping` 工具 + host.emit + 懒启动子进程），local tgz 来源走真实 prepare/commit，disable 路径手工复刻 `setEnabled → invalidateHooks → disable`（避开 watcher 竞态）。遗留：T2.5 落地后 fixture 子进程可迁移到 `host.spawn` 以覆盖托管语义。

### T6.2 Desktop CDP 端到端脚本

- **文件**：`packages/desktop/scripts/` 下新增 `extension-e2e-cdp.ts`，参考 `wls-repl/scripts/*-cdp.ts`。
- **流程**：通过 CDP 拖拽或用 API 安装 fixture 扩展 → 打开对应的文件预览器 → 断言渲染结果 → 停用 → 断言 DOM 和样式已移除 → 卸载。
- **验收**：在已有的 dev:desktop 实例上运行通过。脚本不能启动或关闭已安装的 app。
- **实施记录**：`25d463c454`。验证：对运行中的 dev renderer 连续两次完整跑通（EXIT=0）；`--probe`/`--help`/死端点行为正确。实现：`packages/desktop/scripts/extension-e2e-cdp.ts`（885 行）：probe→pack（tar-stream 自打包）→墓碑感知 preclean→archive prepare/commit 安装→API 建会话→嗅探 `/find/file` 实际工作区→打开文件预览断言渲染→disable 断言 DOM/样式移除→uninstall；失败截图 + 尽力清理。实跑发现（后端未改，供决策）：① dev 版本为 prerelease，`semver.satisfies` 永不满足 `engines.opencode` → prepare 必败，脚本打包时剥离 engines 绕过；② 卸载墓碑按 archive sha256 判指纹，跨次打包漂移触发 "different installation" 冲突；③ 文件对话框搜索的是当前工作区而非路由会话目录。

### T6.3 在 fork 上配置 CI

- **文件**：`.github/workflows/extensions.yml`，只在 `panyw5/opencode` 运行。
- **内容**：路径过滤 `packages/opencode/src/extension/**`、`packages/app/src/extensions/**`、`packages/extension-kit/**`、`packages/extensions/**`；执行各包的 typecheck 和 test，以及 T6.1 和 T4.2 的仓库外构建验证。
- **验收**：在 fork 上手动触发一次，全绿。
- **实施记录**：`1470529500`。验证：YAML 解析 + push/PR 路径一致性 + 8 job fork 门禁自查全过；本机抽查 app 214 / util 154 / desktop 扩展测试 6 / verify-pack PASS 全绿。实现：12 条路径过滤（含 desktop main 扩展文件）+ `workflow_dispatch`；job 覆盖 opencode/app/kit/三扩展 matrix/wolfram-lang/util/desktop/verify-pack。偏差：app 用 `bun test --preload ./happydom.ts ./src/extensions`（`test:unit -- src` 会跑全量且有 23 个无关既有失败）；desktop 只跑扩展相关 main 测试（全量套件 electron import 在 bun 下必挂）。遗留：**fork 手动 dispatch 验证未完成**（需先 push 到 panyw5/opencode）；blacksmith runner 可用性待首跑确认。

### T6.4 补充 Desktop 主进程测试

- **文件**：`packages/desktop/src/main/extension-archive.test.ts`（新建）等。
- **覆盖**：拖拽暂存、清理 IPC 的路径白名单、描述符在 main 侧的二次校验、签名校验（T3.1）。
- **实施记录**：`861174712e`。验证：新增 `extension-archive.test.ts` 20 pass；desktop typecheck 通过；全量 624 pass / 8 fail / 5 errors 与基线一致（存量 electron mock 污染，与本任务无关）。实现：`extension-archive.ts` 的 `ipcMain`/`net` 改依赖注入（`index.ts` 传入）使测试零 mock、对套件内 mock.module 抢占免疫；签名用测试内 Ed25519 密钥 + fake sidecar 跑真实 `signDescriptor`/`verifyDescriptorSignature`；覆盖暂存/白名单（含 symlink 逃逸）/描述符边界与 sha256/可信验签与非可信 unsigned 路径。

---

## Phase 7：文档与规范收尾

### T7.1 规范文档整理

- 把 `progress.md` 改写成**状态清单**（已完成 / 进行中 / 未开始 / 已放弃），原来的日志移到 `progress-log.md`。
- 把五份 lifecycle 文档合并成一份现状说明 `lifecycle.md`，历史文档移到 `specs/extensions/archive/`，并在开头标注"已被取代"。
- 在 `design.md` 顶部更新"已确认决策"：信任模型、隔离模式、权限语义、签名。
- **实施记录**：`6ac7b52463`（在 T5.1 串行等待期完成）。实现：progress.md→85 行状态清单（27 项实施记录按 Phase 分表 + 计划外提交），350 行日志移 `progress-log.md`；四份 lifecycle 文档 `git mv` 至 `archive/`（开头加取代标注 + 修断链），合并产出 `lifecycle.md` 现状说明（§1-2 现行语义含 T2.5/T2.6 新机制，§5 T5.x 映射）；design.md 决策块补全 + §3.3 权限行更新；delivery/p2 系列/仓库 README 断链修复。`lifecycle-supervisor.md` 未动（T5.x 在用）。遗留：其内两处 archive 断链待 T5.x 后修。

### T7.2 作者文档

- 新建 `packages/extension-kit/README.md`，内容包括：快速开始（create → dev → validate → pack）、manifest 字段参考、贡献点和激活事件、RPC 和事件、settings 和 secrets、`host.spawn`、隔离模式的限制、发布流程。
- `packages/extensions/hello-viewer` 作为官方示例，README 指向它。
- **实施记录**：`cb2db7a305`（计划全部任务收官）。实现：kit README 扩为 ~250 行完整作者指南（14 节：入口/快速开始/包结构/manifest 字段双表/permissions/贡献点与激活事件/Web API/Server API/RPC 与事件/settings 与 secrets/host.spawn/工具命名空间/隔离模式/发布流程/依赖约定——事实逐条对照实现核实，含 T5.x 最终语义与"非沙箱"边界声明）；hello-viewer 新建 README（结构导览 + 各节↔代码对照表）。遗留：`isolation-authoring.md` 末段仍写"同进程模型"旧文（T7.x 未覆盖的单文件 spec 更新）。

---

## 3. 子智能体派发建议

| 批次 | 并行任务（文件互不重叠） | 前置条件 |
|---|---|---|
| B1 | T1.1、T1.2、T1.4、T1.5、T1.6 | 无 |
| B2 | T1.3、T6.1 | D9 |
| B3 | T2.1、T2.3、T2.6（都涉及 runtime/manifest，**串行**或由同一子智能体完成）；T2.2、T2.4、T2.7（前端为主，可并行） | B1，D1–D3 |
| B4 | T2.5（kit、runtime、三个扩展） | B3 中的 runtime 任务已完成 |
| B5 | T3.1、T3.2（同一子智能体）；T3.4；T3.5；T4.1；T4.5 | D4，D5 |
| B6 | T3.3、T4.2、T4.3、T4.4、T4.6 | B5，D6 |
| B7 | T5.0 → 用户确认 → T5.1 → T5.2 → T5.3 → T5.4 → T5.5 → T5.6 → T5.7 → T5.8（**严格串行**） | B4，T6.1 |
| B8 | T6.2、T6.3、T6.4 | B7 主要部分完成 |
| B9 | T7.1、T7.2 | 全部 |

### 子智能体任务说明模板

```text
你在 /Users/lelouch/apps/opencode 中实施扩展整改计划的任务 <Txx>。
先完整阅读：specs/extensions/remediation-plan.md 的 §0 通用约定和 <Txx> 小节，
以及 packages/opencode/AGENTS.md、根目录 AGENTS.md。
只修改 <Txx> 列出的文件范围；如果必须越界，先停下来，说明原因。
按 <Txx> 的步骤实施，先写失败的测试再改代码，每一步加日志。
完成后执行 §0.3 中与改动范围对应的验证命令，并在 <Txx> 下追加实施记录。
只做本地提交，不要 push。汇报内容：改了哪些文件、测试结果、遗留问题。
```

## 4. 风险与回退

| 风险 | 缓解 |
|---|---|
| T2.1 改工具名后，历史会话或已训练提示词引用的旧名失效 | 渲染器兼容旧名一个版本，并在 progress.md 中记录变更 |
| T3.1 签名上线后，未签名的旧描述符装不上 | 现有已安装扩展不受影响；更新时提示重新从签名来源安装 |
| Phase 5 改动面大 | `isolation` 字段按扩展灰度；`inline` 路径一直保留到 T5.8；每个子任务单独提交，便于 revert |
| Bun 和 Node 的 fd 传输差异 | T5.1 两种运行时都要测；打包后的二进制在 T5.4 实测 |
| 自动安全模式误触发 | 计数只在页面级错误边界触发时累加；正常启动后清零 |
