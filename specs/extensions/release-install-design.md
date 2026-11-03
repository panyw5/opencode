# 发布地址安装设计：免手填 SHA-256

> 集成更新（2026-11-03）：实现已通过 `2cca27da78` 合入本地 dev，未推送、未发布。完整验收缺口仍保留；当前集成证据见 `specs/extensions/delivery.md` 顶部，以下状态核对保留合入前基线，协议说明不变。

状态：**方案已批准，核心链路已实现并随 `6216969c38` 本地提交；完整集成/发布验收未完成。** 状态核对：2026-11-03，当前 HEAD `6faed064da`；当前交付入口为 `specs/extensions/delivery.md`。

设计日期：2026-10-18；实施批准及核对：2026-10-19。实施基线 `86619dfa4a`，新增 release 来源、注册表 v3、自动摘要解析、HTTP/SDK/CLI/UI 及作者本地工具；当时的未提交限制不代表后续提交状态。本次只更新文档，不提交、不推送、不合并、不操作真实用户注册表。桌面目录辅助下载已另行实现并验证，不替代本文 CLI/server release 下载器的公网正向验收；实际结果与未验证项见 `specs/extensions/release-install-tasks.md`、`specs/extensions/wls-repl-tasks.md`。

实施确定的兼容决策：首次release成功提交时，明确确认后同锁原子将整个registry从v2升v3，之后不自动降级；prepare/取消不升级v2。需先停止/升级共享registry/data/cache的旧进程，人工声明不是机器存活证明。旧实现拒未知格式的已核实范围及历史静态证据见任务记录。

本文以下保留协议与设计说明，不将能力描述等同于公网/跨平台验收。

本文所有工作区路径均相对项目根。总设计入口：`specs/extensions/design.md`；当前实施与验收状态：`specs/extensions/progress.md`、`specs/extensions/p3a-tasks.md`。

## 1. 目标与非目标

### 1.1 目标

- 普通用户只填写一个稳定 HTTPS 发布地址，无需查找或转填 SHA-256。
- 摘要由发布工具生成，安装器自动获取并验证；不以取消校验换取操作简化。
- 延续现有 prepare → preview → confirm → commit、默认停用、幂等回执与未知结果查询流程。
- 将稳定发布来源与每版安装包地址分离，支持同一来源的手动升级。
- 对同进程代码信任、权限非沙箱及 secret 存储维持现有边界，不宣传为安全认证。

### 1.2 首版非目标

- 不识别 GitHub 仓库主页，不克隆仓库，不安装自动源码 ZIP/tar.gz，不执行远程构建。
- 不引入市场、GitHub API、账户授权、私有仓库凭据、后台自动升级。
- 不引入作者签名、可信发布者认证、密钥轮换、撤销或防回滚协议。
- 不引入版本目录、多渠道选择器、多平台安装包选择或多级描述文件跳转。
- 不把旧 archive/path/npm 来源静默转换成 release，不自动接管其设置、secret 或 retained data。

## 2. 用户流程与界面

### 2.1 来源入口

| 来源 | 用户输入 | 行为 |
| --- | --- | --- |
| 发布地址（新增） | 稳定 HTTPS JSON 地址 | 自动获取描述及摘要，安全下载、校验和预览 |
| npm 包（保留） | registry 包名及可选版本 | 保持现有 registry integrity 机制 |
| 高级：直接归档（保留） | HTTPS `.tgz` 地址及 SHA-256 | 保持现有显式摘要要求，不自动放宽 |

发布地址模式不显示 SHA-256 编辑框；预览按钮置于地址输入框右侧，沿用当前等高布局。高级入口的隐藏/展开只是呈现调整，不改变 archive 的请求或来源身份语义。

```text
来源
[发布地址                                  ▾]

扩展发布地址
[https://example.com/viewer/stable.json] [预览安装]
```

下载和校验由**当前连接的 OpenCode server**执行，不由浏览器直接请求，以保证远程 server 和桌面 sidecar 行为一致。URL 必须能被该 server 访问；不支持公开地址失败后回退访问本地/内网镜像。

### 2.2 预览与确认

预览前不执行扩展代码。完成描述解析、下载、摘要验证、安全解包和 manifest 一致性检查后，显示原有名称、版本、贡献点、权限及权限差异，并增加：

- 发布来源：初始发布描述地址的主机及公开路径。
- 安装包下载来源：安装包请求地址的主机；与发布来源不同则明确展示，不把跨域本身当可信证明。
- 包完整性：与发布描述中的 SHA-256 一致。
- 发布者身份：未通过数字签名验证。
- 含服务端代码、同进程权限信任及新装默认停用提示。

不得显示“安全认证通过”“可信扩展”“已验证作者”等误导性结论。详情可展示实际摘要供排障，无需用户编辑。

继续保留降级/同版本重装提示、dirty/saving/busy/safe-mode 门禁、服务器切换失效和取消语义；确认后才提交。

## 3. 发布描述协议 v1（提案）

### 3.1 文件示例

下面的全零摘要**仅用于展示 JSON 结构**，不是任何真实安装包的摘要，不能原样用于发布。

```json
{
  "schemaVersion": 1,
  "id": "example.viewer",
  "version": "1.0.0",
  "artifact": {
    "url": "https://github.com/example/viewer/releases/download/v1.0.0/viewer-1.0.0.tgz",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

### 3.2 字段与验证

| 字段 | 约束 |
| --- | --- |
| `schemaVersion` | 必须为数值 `1`；未知协议版本拒绝，不降级猜测 |
| `id` | 复用宿主 ExtensionID 校验，必须等于实际包 manifest 的扩展 ID |
| `version` | 复用扩展包版本校验，并与实际 manifest 的版本一致；不直接套用 npm-only 更新入口 |
| `artifact.url` | 绝对、无内嵌凭据的 HTTPS URL，指向单个预构建 `.tgz`；首版拒绝相对 URL |
| `artifact.sha256` | 64 位十六进制，内部统一小写；对下载得到的归档实体字节计算并比较 |

JSON 必须满足严格结构校验；不解释任意命令、脚本、安装参数或另一个描述地址。首版拒绝未知字段，不承诺未定义扩展字段兼容性。描述中的元数据不能替代包 manifest 校验或宿主兼容性检查。

v1 仅提供当前目标版本。没有远程版本列表，不支持按任意历史版本查询；如需固定内容，作者可以提供不再修改的版本描述地址，但其来源身份与可变 stable 地址不同，不能静默互换。

## 4. 作者发布流程

```text
构建 Web/Server 产物
    ↓
打包合规、自包含的 .tgz（package/ 根目录）
    ↓
对最终归档字节计算 SHA-256
    ↓
生成发布描述文件
    ↓
先上传版本化安装包，最后更新稳定发布描述
```

- 作者维护源码仓库，用户安装预构建产物；发布描述不是扩展包内 `package.json` 的替代物。
- 打包继续遵守现有归档限制，不携带 node_modules、链接或安装配置，不依赖安装期脚本。
- 可使用 GitHub Release 附件存储安装包，GitHub Pages 或其他静态 HTTPS 服务承载稳定描述；不要求使用 GitHub。
- 推荐不可变、包含版本的 artifact URL，更新 stable.json 时使用服务商支持的原子发布方式；上传顺序错误造成暂时不可用时明确失败，不安装旧内容冒充新版本。
- 发布工具/CI 自动生成摘要及 JSON。脚手架、CI 模板和发布命令尚未实现，不在本文冒称已有。

## 5. 来源身份与升级

### 5.1 新增 release 来源

新增 `release`，不要在解析后仅持久化为 archive。概念模型如下，字段命名与注册表版本方案需实施前最终确定：

```text
请求：
  type = release
  url = 稳定发布描述地址

持久化来源：
  type = release
  descriptor = 规范化后的初始发布地址
  extensionID = 已验证的扩展 ID
  resolvedVersion = 本次安装版本
  artifact = 本次安装包请求地址
  sha256 = 本次已验证归档摘要
  descriptorSha256 = 本次实际解析的描述字节摘要
```

稳定身份是 **descriptor + extensionID**；version、artifact URL、artifact 摘要和 descriptor 内容摘要是本次解析快照，不参与稳定身份比较。仅凭新描述自报相同 id，不能取得旧来源的身份。

### 5.2 URL 规范化

- descriptor 必须为绝对 HTTPS URL，无用户名/密码；首版拒绝 query 和 fragment，以免签名参数、渠道参数、凭据泄漏和身份歧义。
- 使用统一 URL 解析与序列化规则；scheme/host、默认端口按标准规范化，保留规范化后的完整路径。不得自行把不同路径、大小写敏感路径或尾斜杠合并。
- 身份始终使用**初始 descriptor 地址**，不使用重定向终点/CDN 地址；跨主机重定向每跳均接受网络安全校验。
- artifact URL 可以按下载器规则携带必要 query，但不作为稳定身份，也不得原样显示或记录敏感查询参数；不支持借此传递私有仓库鉴权。原始URL如何持久化及其脱敏字段，实施前须明确，不能将短期签名下载URL当长期更新入口。
- 不能直接照搬 archive 去 query/hash 的现有策略；release 的规则必须在前后端、CLI、registry 和 retained data 身份比较中一致。

### 5.3 手动更新

1. 从已保存的 descriptor 地址获取当前描述。
2. 核对来源身份、扩展 ID 和包名连续性；实际包 name/id 变更不得由描述自行授权。
3. 下载并验证新候选，比较版本、权限和贡献点。
4. 展示升级/同版本重装/降级预览，用户明确确认后提交。

首版只实现“更新到该发布地址当前指向的版本”，不后台自动更新。现有 `{kind: update, id, version}` 是 npm-only 语义，不直接复用于 release。

### 5.4 来源迁移与旧来源

- descriptor URL 变化属于来源迁移；v1 默认拒绝通过普通更新迁移，提示不支持，不能仅弹通用确认后绕过来源绑定。
- archive → release 等跨类型迁移不自动执行；须未来独立设计迁移确认、revision、retained settings/secret/data 隔离和回执协议。
- 旧来源保持原安装、更新、卸载行为；不能因新增 release 放宽同 ID 数据保护。

## 6. prepare / commit 与内容绑定

### 6.1 prepare

- 使用同一有界操作预算依次获取描述和 artifact，验证结构与摘要后安全解包。
- 校验实际 manifest 的 id/version/name、宿主兼容性与现有归档门槛；任何失败不执行扩展、不修改 registry。
- 冻结本次 descriptor 字节/摘要、稳定来源身份、resolved artifact/version/hash、manifest fingerprint、候选 tree 摘要、registry revision 与完整预览。
- 上述快照应纳入现有 operation/capability 绑定；描述文件不是新的执行脚本或外部确认能力。

### 6.2 commit

- 不重新获取描述、不重新选择 latest、不切换 artifact。
- 按现有 archive 候选内容路径重验暂存树、复制结果、manifest 和 revision；沿用 runtime fence/quiesce 与 CAS。
- 用户预览 A 后远端变成 B，确认仍只能提交已冻结的 A；候选过期或丢失则重新预览，不能偷偷下载 B。
- 取消、超时、进程重启、提交响应丢失沿用已有边界：未提交 prepared 不跨重启恢复；持久化提交按 receipt 查询，不能把不确定状态当失败后盲重装。
- 保留“committed 但未同步”“cleanupPending/needsRestart”等真实结果，不伪装成事务回滚。

## 7. 网络和信任边界

### 7.1 有界获取

- descriptor 建议上限 **64 KiB**；artifact 继续使用现有最多100 MiB限制；描述与包共用prepare总预算，不分别叠加出无限等待。
- 继承现有安全下载器：只允许无凭据 HTTPS，DNS/公网地址检查、固定已验证连接地址、TLS 主机验证、每跳重新检查，最多3次重定向；不自动放宽内网、回环或本地文件访问。
- descriptor 只解析严格UTF-8 JSON，不渲染HTML；非法结构、未知版本、缺失摘要、摘要不符、ID/version不符都明确拒绝，不静默回退不校验模式。
- 只获取一个描述和一个artifact，不递归发现仓库/市场，不隐式读取 checksums.txt 或猜测同名资源。
- capability仅走现有受保护header，不能传给artifact主机；UI/SDK/CLI继续遵循取消、服务器切换、重定向和脱敏约束。

### 7.2 能提供的保证

| 能力 | 本设计 v1 |
| --- | --- |
| 不手填 SHA-256 | 提供 |
| 检查包与发布描述的一致性 | 提供 |
| 确认前检查实际版本/权限/来源 | 提供 |
| 确认内容与提交内容绑定 | 提供 |
| 作者身份认证、独立数字签名 | 不提供 |
| 发布面被控制后包和摘要同时替换的防护 | 不提供 |
| 防回滚、反重放或不可变发布保证 | 不提供；同版本/降级明确预览 |
| 沙箱或恶意代码检测 | 不提供 |

同一HTTPS发布面提供摘要与包时，检查的是该发布面声明与内容一致，不是独立信任证明。后续签名方案还需可信密钥来源、轮换、撤销、失效与恢复规则，不能只增加一个signature字段。

## 8. 兼容性与实施触点

本轮已实现release公开请求和持久化来源，原npm/archive/path继续保留。变更覆盖以下链路，而不是仅隐藏输入框：

| 层级 | 需要实施/复核 |
| --- | --- |
| 契约 | install-schema、Source、Info/preview/result相关联合；生成HTTP/OpenAPI/SDK契约 |
| 解析 | 小体积descriptor schema、稳定URL规范化、manifest一致性、候选快照绑定 |
| 持久化 | registry来源比较、retained来源、ownership/data/receipt、清理恢复及日志脱敏 |
| 服务 | prepare/commit、runtime协调、observer、取消与未知状态查询 |
| 客户端 | UI请求/预览/来源标签、CLI输入及交互确认、多语言文案 |
| 发布工具 | 自包含归档打包及描述生成，独立仓库示例和发布说明 |

兼容策略已确定并实现为首次release提交原子升v3：v1/v2仅接受旧来源，v3接受release；expectedRegistryVersion与row/retained revision共同参与批准和最终锁内CAS。旧格式读取错误不回退空对象覆盖，observer支持版本化revision token。没有自动降级/跨来源迁移；历史版本仅按已核实范围记录，不宣称所有外部旧写入者均能安全拒绝。最低发布宿主版本尚未分配。

旧archive/npm/path无需自动迁移；仍需回归旧entry的读取、设置、secret掩码、卸载与恢复。不得以支持release为由放宽legacy或未知来源数据的保护。

### 当前实现核对入口

- `packages/opencode/src/extension/install-schema.ts`：公开来源、prepare和preview契约。
- `packages/opencode/src/extension/schema.ts`：持久化Source及复用类型。
- `packages/opencode/src/extension/install.ts`：来源获取、prepare绑定、候选树与commit。
- `packages/opencode/src/extension/download.ts`：HTTPS/重定向/摘要/大小/时间约束。
- `packages/opencode/src/extension/registry.ts`：实施前需要继续核实的来源与revision门禁。
- `packages/app/src/pages/install-actions-state.ts`：UI输入、来源联合及校验。
- `packages/app/src/extensions/install-api.ts`：API调用、capability与redirect:error。
- `packages/app/src/components/dialog-install-extension.tsx`：表单、预览和确认状态机。

## 9. 验收清单（交付门槛；自动化与实机范围见任务记录）

- [ ] 单一发布地址可prepare，摘要自动取得且实际校验，新装默认停用。
- [ ] JSON未知版本/字段、超限、错误编码、缺摘要及非法URL均拒绝。
- [ ] descriptor/artifact私网、混合DNS答案、TLS降级、重定向绕过及超时受限。
- [ ] 摘要损坏、manifest id/version/name不符、归档越界/链接等拒绝且不执行代码。
- [ ] npm/archive/path原流程、HTTP鉴权、SDK capability脱敏与CLI确认保持不变。
- [ ] 同一descriptor可更新到新artifact URL；更换descriptor或跨来源类型不静默迁移。
- [ ] retained设置、secret、data/ownership及跨registry身份保护不会被新来源绕过。
- [ ] prepare后远端描述改变、CDN内容替换或候选树被改，不出现“预览A提交B”。
- [ ] 并发revision冲突、取消、TTL、重启、未知提交查询与清理恢复符合现有门槛。
- [ ] UI显示真实来源和完整性级别，不冒称签名或作者认证；dirty/saving/busy/切server回归通过。
- [ ] 旧宿主/旧进程识别或拒绝release的方式经过兼容测试，不发生破坏性写回。
- [ ] 使用隔离registry在Vite/Electron/内嵌Web验证新增链路，按实际范围记录证据，不借用旧截图。

## 10. 当前结论

推荐的通用发布描述协议已在当前工作树实现，GitHub仓库地址发现和市场仍留后续。发布地址输入、自动摘要、release来源、显式v3开通及本地描述生成工具已有自动化证据；公网HTTPS正向安装、完整三形态GUI和跨平台矩阵尚未验收。高级直接归档入口仍要求显式SHA-256，签名/沙箱/自动来源迁移未提供。详见 `specs/extensions/release-install-tasks.md`。
