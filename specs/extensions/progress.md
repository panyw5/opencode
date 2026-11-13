# Extensions 整改实施状态清单

按 `remediation-plan.md` 任务组织的状态清单（2026-11-13 由日志式记录改写）。每条目的完整实施记录（验证命令、实现细节、偏差与遗留）见 `remediation-plan.md` 对应任务小节；2026-11-13 之前的日志式记录完整保存在 `progress-log.md`，整改前 P0–P4 交付历史见 `delivery.md`。

## 已完成

### Phase 1 规范性修复

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T1.1 | `17015066b5` | `leases.ts` 去 `export namespace`，运行时错误别名清理 | — |
| T1.2 | `a5c37ee1dc` | `packages/extensions/zed` 迁出为 `packages/zed-extension` | `sync-zed.ts` 对迁移前旧 tag 运行会失败（预期） |
| T1.3 | `328271262f` | 扩展版本号与主仓库解耦，发布 tag/digest 冲突检查 | open-extensions 已发布 mathematica-notebook v1.18.65 而仓库内为 1.18.64，下次发布需人工升版；`--clobber` 移除与"相同跳过"属 T3.2 一并完成 |
| T1.4 | `0d4ff8ceb1` | 前端类型与扩展 ID 正则统一（`isExtensionID` 单源 + parity 快照） | — |
| T1.5 | `77f60da181` | 面板状态泄漏修复（`panelState` 迁入 panel-registry，扩展/tab 级 evict） | `layout.tsx` 的 `prune()`（session LRU）未 evict，建议另立任务评估 |
| T1.6 | `df21439b33` | solid 版本读取与偏差检查、`__OPENCODE_EXTENSION_HOST__` 冻结 | CDP 未验证；`env.d.ts` 死声明待修 |

### Phase 2 正确性与安全快修

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T2.1 | `9737d0f201` | 工具名命名空间 `<ns>_<tool>` + 冲突检测；前端双名匹配兼容旧名 | sidecar/CDP 实测未做；B3 智能体中途消失，经主会话验证完整性后提交 |
| T2.2 | `148f1ce2ce` | 激活事件语义："作提示"（前端本已如此，后端补 info 日志） | — |
| T2.3 | `9f3f03b313` | `web.apiVersion` 优雅降级（丢弃 web 部分 + `web.apiVersion:<n>` 告警码） | CDP 未验证 |
| T2.4 | `a1b1159d34` | 权限固定词表六项 + "声明不强制" UI 标注 | CDP 未验证；`design.md` §3.3 旧权限行由 T7.1 统一（本任务已修） |
| T2.5 | `45b27a1589` | `host.spawn` 托管子进程（进程组 TERM→宽限→KILL→等真实 exit），三扩展内核迁移 | sidecar 实测通过；`kernel.status` 的 `Schema.Unknown` 编码 WARN 为存量问题 |
| T2.6 | `f25a831192` | RPC 并发上限 32（拒绝不排队）+ `host.emit` 令牌桶（200/s、突发 400） | — |
| T2.7 | `09761a45a7` | 自动安全模式（crash-strike 计数）、错误边界"停用此扩展"、激活后贡献点核对 | `host.tsx` 接线随 T2.1 提交合入；file-viewer 边界未接归因 flag；CDP 未验证 |

### Phase 3 分发信任链

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T3.1 | `e40701798d` | `stable.json` Ed25519 分离签名 + 可信 origin 强制验签 | 私钥由发布者保管（`ed25519-e1b01f86f6422244`）；UI 签名状态行 CDP 未验证 |
| T3.2 | `7b025e75a6` | `--clobber` 移除、`sequence` 回滚防护（`rollback_detected`） | — |
| T3.3 | `165e9dcc2e` | open-extensions 纯化为分发仓 + `source.commit` 溯源 | 待删清单已经用户确认执行（`5282246`，本地未推送）；根 README/`.gitignore` 旧文案已处理；provenance 门为扩展目录级（用户拍板） |
| T3.4 | `4adcd4117e` | 下载/校验共享规则下沉 `@opencode-ai/util` | — |
| T3.5 | `9a9d4c20af` | 描述符 `engines.opencode` 主机兼容范围 + 目录标灰 | `platform.version` 远程模式可能与 server 版本不一致（服务端门控兜底） |

### Phase 4 SDK 与开发体验

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T4.1 | `f7f2b45e1a` | `wolfram` 拆为 `@opencode-ai/wolfram-lang`（private workspace 包） | hello-viewer 已提交 dist 为陈旧产物，建议发布流程统一重建 |
| T4.2 | `b7b762a9d9` | extension-kit 可构建可发布（tsgo dist + pack.ts exports 重写 + verify-pack） | `dist/*.d.ts` 相对引用无扩展名（nodenext 消费者不可解析）；`npm pack` 中断需 `pack.ts --restore`；D6 仅授权渠道形态，未实际发布 |
| T4.3 | `96ca4c9d6c` | 作者 CLI `extension create/validate/pack` + `web-and-server` 模板 | 编译产物中 `create` 冒烟未跑（需另行 build sidecar） |
| T4.4 | `7427de7ce5` | `defineRpc<Contract>` 类型化 RPC（Standard Schema 协议） | `./rpc` 为扁平字符串导出，待并入 T4.2 exports 条件结构；结构性非法输入现返回 `invalid_input`（行为变化） |
| T4.5 | `bbc5f5cd99` | 依赖声明规范统一（kit/plugin 归 devDependencies） | — |
| T4.6 | `4e49aa0c05` | 共享模块白名单核对（无需新增）+ 构建期写入 `__opencodeBuild.solid` | CDP 未验证 |

### Phase 6 测试与 CI

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T6.1 | `c0b802eb8e` | 常驻 e2e 生命周期测试（零依赖 fixture，10/10 稳定） | fixture 子进程可迁移到 `host.spawn` 以覆盖托管语义 |
| T6.2 | `25d463c454` | Desktop CDP e2e 脚本（pack→安装→渲染断言→停用→卸载） | 实跑发现三项后端行为供决策：①engines prerelease 已修（`b05bf9fde5`）；②卸载墓碑按 sha256 判指纹的跨次打包冲突；③文件对话框搜索当前工作区而非路由会话目录 |
| T6.3 | `1470529500` | fork CI workflow（路径过滤 + 8 job fork 门禁） | **fork 手动 dispatch 验证未完成**（需先 push 到 panyw5/opencode）；blacksmith runner 可用性待首跑确认 |
| T6.4 | `861174712e` | Desktop 主进程扩展测试（暂存/白名单/描述符/签名，依赖注入零 mock） | 全量套件 8 fail / 5 errors 与基线一致（存量 electron mock 污染） |

### 其他已提交的相关改动（非计划任务条目）

- `b05bf9fde5`：`engines.opencode` prerelease 修复——dev 构建版本（`1.18.64-local.*`）永不满足 semver 范围导致开发态安装必败；`checkPluginCompatibility`、`releaseCompatible` 统一经 `satisfiesHostRange` 比较基版本（用户决策：忽略 prerelease）。
- open-extensions 仓库 `5282246`（本地未推送）：按 T3.3 待删清单 `git rm` 两个扩展的镜像源码/dist/test/.turbo 与根 `.DS_Store`，README 改为纯分发仓定位，`.gitignore` 补 `.turbo/`。

### Phase 5 server 进程隔离

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T5.0 | 设计稿 | `process-isolation-design.md` 已确认（§12 十项决策按推荐） | linux/win Bun extra-fd 未验证（Q8 风险项） |
| T5.1 | `9d8d8a7e74` | host-process protocol/transport/supervisor（Bun/Node 双路径全绿） | sidecar 打包需携带 `control-fd.c`（T5.4 已解决）；Electron probe 未迁移（无原型可迁） |
| T5.2 | `2ef2a676ef` | worker 入口 + 代理 host 全矩阵 + `extension-host` 子命令 | notify 超容量丢帧需宿主限速；spawn ENOENT 仅 error 需补 exit |
| T5.3 | `dfd9b14bf7` | runtime 后端分叉 `isolation` + 崩溃重启 + 双后端 matrix | `opencode serve` 启动崩 `parseModels`（仓库既有问题） |
| T5.4 | `0a43ea6960` | desktop 打包修复（bunfs argv、control-fd.c 物化两回归）+ CDP/孤儿实测 | worker stderr 呈 ERROR 级（外观） |
| T5.5 | `6969dfd2e1` | 三扩展 `isolation:"process"` + wls-repl pid 异步修复；sidecar/CDP 全绿 | `ctx.ask` 真实弹窗未端到端；冷启动 ~0.75s、RPC p95 +~80% |
| T5.6 | `9421ee7088` | `tools`/`process:spawn` 宿主强制执行；Node `--permission` 评估否决 | worker 内 `child_process` 仍可裸调（API 级限制非沙箱） |
| T5.7 | `19d79e5eda` | runtime 收编 `ExtensionRuntime.Service`（模块级可变状态 24→0） | `install-service.ts` 模块级 Map 未收（超范围） |
| T5.8 | `165e6c0546` | 缺省 `process`；非 path 来源 inline 警告链（日志+Info.warnings+UI） | sidecar 未重建验证（dev 实例在用） |

### Phase 7 文档收尾

| 任务 | 提交 | 摘要 | 遗留 |
|---|---|---|---|
| T7.1 | `6ac7b52463` | progress.md 状态清单化、lifecycle 合并归档、design 决策块 | `lifecycle-supervisor.md` 内两处 archive 断链待修 |
| T7.2 | `cb2db7a305` | extension-kit 完整作者 README + hello-viewer 示例 README | `isolation-authoring.md` 末段仍为"同进程模型"旧文 |

## 进行中

- 无（整改计划全部 30 项任务已完成）。

## 未开始

- 无。

## 已放弃

- 整改计划内暂无已放弃任务。
- 历史说明：2026-11 生命周期重构期间的 archive → release 来源兼容实验补丁已撤回（见 `archive/lifecycle-rebuild.md`）；阶段 0/1 原型已迁入 `specs/extensions/prototypes/` 并作为 T5.x 设计基础，`lifecycle-supervisor.md` 仍为有效设计文档。

## 跨任务遗留汇总

- **CDP / sidecar 实测缺口**：T1.6、T2.1、T2.3、T2.4、T2.7、T3.1（UI 签名状态行）、T4.3（编译产物 `create` 冒烟）、T4.6 的 CDP/实机验证未做。
- **需 push 后才能验证**：T6.3 fork dispatch；open-extensions `5282246` 未推送。
- **文档/UI 一致性**：`env.d.ts` 死声明（T1.6）；`layout.tsx` `prune()` 未 evict 面板状态（T1.5）。
- **发布流程**：hello-viewer dist 陈旧（T4.1）；mathematica-notebook 下次发布需人工升版（T1.3）；`npm pack` 中断恢复（T4.2）。

### Fork CI 验证（T6.3）

- 首轮 dispatch（run `43370925502`）10 个 job 全部 queued 不调度——`blacksmith-4vcpu-ubuntu-2404` 在本 fork 无 runner（历史同类 workflow 均 cancelled）。`1ec086df6c` 切换为 `ubuntu-latest`（workflow 本就 fork 限定）。
- `6b0eab251a` 修复 CI 暴露的两个环境差异：linux 下 `spawnBunWorker` darwin 门槛（`bun:ffi` cc 需 libc 头文件，linux/arm64 容器验证可行）与 npm<11 `npm pack` 运行 `prepare`（npm#7850，staging 副本剥离生命周期钩子，node:22/npm10 验证）。
- run `43375140162`：**10/10 job 全绿**（opencode/app/desktop/extension-kit/util/wolfram-lang/三扩展/verify-pack）。
