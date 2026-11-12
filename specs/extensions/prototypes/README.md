# Extension lifecycle 原型（未接入生产）

此目录仅保存 C1 准备阶段的 admission、execution、descriptor ownership 和真实进程测试原型。**它不是生产实现，不是 extension-kit API，也未被产品 main、runtime、registry 或安装流程导入。** 此 package 不属于根 workspace，不应加入根 workspace、生产依赖、产品构建或默认生产测试。

## 布局与边界

- `src/extension/`：7 个独立原型模块。
- `test/extension/`：8 个测试文件、3 个 TS helpers；`fixtures/` 保留 4 个私有 MJS 进程入口。
- `scripts/extension-lifecycle/`：2 个无窗口 Electron 探针，独立 userData/logs，不启动产品 main。
- `package.json`、`tsconfig.json`：原型专用入口，不继承生产 tsconfig，不使用产品 test preload。
- `lifecycle-api-matrix.test.ts` 与 `lifecycle-target.test.ts` 依赖生产 API，**仍留在 `packages/opencode/test/extension/`，不属于本 package**。24 份原型源码、测试及专用探针已核对后迁入本目录，原生产源码/默认测试目录不再保留副本。

默认测试使用 Bun；Node/Bun 运行同一私有进程夹具。ownership 与相应 supervisor 进程测试只在 macOS 验证，Linux/Windows 保持阻塞；Windows 进程树需要 Job Object。`rootExited` 永远不代表进程树已退出，dispose acknowledgement 不授权删除 generation/install 资源。

## 离线复用已安装依赖

此 package 的依赖全部为 **devDependencies**，版本为本次已安装并验证的版本。不新增生产依赖，不运行联网 install，不更新根 package 或 lockfile。

从项目根执行（将最后一个参数替换为已有依赖的 checkout 的绝对路径）

```sh
bun run --cwd specs/extensions/prototypes reuse-installed /absolute/path/to/already-installed/repository
bun run --cwd specs/extensions/prototypes typecheck
bun run --cwd specs/extensions/prototypes test:unit
bun run --cwd specs/extensions/prototypes test:process
bun run --cwd specs/extensions/prototypes test
bun run --cwd specs/extensions/prototypes test:electron
```

`reuse-installed` 只读 donor 的已安装 package，校验精确版本，在**本原型目录的 `node_modules/` 内**建立单包 symlink；不写 donor，不执行依赖生命周期脚本，不下载、不安装，缺包/版本不匹配直接报错。链接不可跨机器携带，换 checkout 后需重新建立；忽略的 `node_modules/` 不应交付。

需复用 effect、zod、fs-native-extensions、electron、typescript、@types/bun、@types/node 及它们原已安装的传递依赖。Electron executable 与 macOS native prebuild 必须已存在。Bun ownership 直接使用 libSystem FFI，不要求加载 Node addon；Node/Electron 用 `import.meta.resolve` 找到 fs-native-extensions manifest，再以该 manifest 建立 `createRequire`，避免依赖原产品源码所在路径。Electron 测试 bundle 临时目录只链接它们实际需要的依赖。

`test:electron` 显式设置 `OPENCODE_EXTENSION_ELECTRON_PROBE=1`；默认 `test` 跳过这些 opt-in 探针。可另设 `OPENCODE_EXTENSION_LIFECYCLE_TRACE=1` 输出字符串事件日志。测试只使用临时私有 guard、执行单元与 userData，不读写真实用户 registry，不关闭已安装应用。

## 验证与已知边界

验证基线为 `db23a41905e6641063da869711ad151a498bb45d`，Bun 1.3.9、Node v25.9.0、Electron 41.2.1（macOS）。在复制前只读运行旧位置 8 个原型测试，两次均为 `71 pass / 8 skip / 2 fail`，共 81 tests：`loadThrow` 存在 transport failure 先于 loader 日志的竞态，另一次出现 Node `exitHang` 相关退出竞态。迁移后第一轮为 `72 pass / 8 skip / 1 fail`，共 81 tests；剩余失败为同类 Bun `loadThrow` 的 `Missing execution barrier: loader-entered`。未通过删除断言、增加 skip 或修改 supervision 语义掩盖失败。

迁移后独立复验仍为 `72 pass / 8 skip / 1 fail`（81 tests，270 expect calls，6.10s），此次失败改为 Bun `disposeHang`：日志显示 `control-disconnected`、OS root exit code 1，issues 却为空，断言所需 `disposeDeadline` 缺失。单独 `test:process` 为 `47 pass / 1 skip / 2 fail`（50 tests，163 expect calls，15.95s），记录 Bun 额外控制管道 `connect ENOENT` 与另一启动 barrier 超时；**不能宣称完整原型测试通过，也未证明这些新增显现的失败完全等同于基线失败**。

`typecheck` 已通过；`test:unit` 为 `24 pass / 0 fail`（3 files，102 expect calls，167ms）。独立 Electron 探针实际运行 `7 pass / 0 fail`（2 files，33 expect calls，2.73s）。修改/新增配置通过 Prettier 检查。这不是产品 GUI 验收，也不证明 Windows/Linux ownership、完整进程树终止、PluginInput/Hooks 代理或持久化 lifecycle store 已实现。独立严格 typecheck 发现的可选 rejection code 已增加显式存在性检查；其余原型逻辑保持不变。

### 后续诊断与监督记账修复

- 新增10项确定性控制测试：停止的 drain/dispose/exit 阶段出现 transport/protocol fatal、未收到 dispose ack 的提前退出、正常 ack→exit0。修前9 fail/1 pass，修后10/0；unit现 **34 pass / 0 fail**，typecheck通过，Electron仍 **7 pass / 0 fail**。
- supervisor 不再只保存stop入口时的fatal；未ack异常根退出保留 `exited`，不把提前EOF伪装成 `disposeDeadline`。rootExited仍tree=unproven，不授权删除资源。
- transport 的spawn/stdio获取统一错误边界、保留原cause并对控制通道失败fail-close；worker和host增加PID/stage/code/path/cause字符串诊断。这不是Bun底层修复。
- 最终代码连续三轮process均 **48 pass / 1 skip / 1 fail**，主工作区合并后复验同结果；完整原型套件 **82 pass / 8 skip / 1 fail**（91 tests），唯一失败同为Bun disposeHang提前control-disconnected→exit1，现issues为 `["exited"]`，原测试仍要求disposeDeadline/force-terminate，**保留红测，不放宽断言**。
- 更早重复运行仍捕获host Bun `node:child_process #createStdioObject → net.connect({fd})` 的ENOENT，无法宣称解决。最小probe的Bun→Bun、Node→Bun、Bun→Node各20轮通过，只证明本轮没有复现，不排除漂移；host附加fd返回connecting=true但没有connect事件，未盲加等待connect。

极小probe（当前工作目录为本原型包）：

```sh
bun ./scripts/fd-transport-probe.mjs "$(command -v bun)" 20
node ./scripts/fd-transport-probe.mjs "$(command -v bun)" 20
bun ./scripts/fd-transport-probe.mjs "$(command -v node)" 20
```

日志证据：`/tmp/execution-a06c-final-process-{1,2,3}.log`、`/tmp/execution-a06c-process-{2,3}.log`（含ENOENT），以及主工作区 `/tmp/ext-followup-prototype-process.log` / `ext-followup-prototype-electron.log`。未做runtime升级、Socket盲替换、skip或超时放宽；原型仍不得接入生产。

