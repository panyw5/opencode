# 本地扩展发布描述生成工具

**状态：功能实施中，尚不代表已发布或已完成端到端安装验收。** 本文描述本轮新增的本地作者工具；发布地址安装整体设计见 `specs/extensions/release-install-design.md`。支持发布地址安装的**最低宿主版本待实际发布确定**，不能把当前源码版本号当作已发布支持保证。`@opencode-ai/extension-kit` 的**公开 npm 发布状态尚未确认**，本文不声明它已经可以从公共 registry 安装。

## 1. 工具范围

需要从零开始的作者可整体复制 `templates/extensions/server-only/`：它不依赖当前monorepo或未公开kit，提供最小RPC、Node内置测试与标准npm离线打包/描述生成。模板具体用法见该目录README；当前开发状态和实测平台以 `specs/extensions/release-install-tasks.md` 为准。下文的宿主作者工具是额外的严格归档复核方式，不是独立模板运行依赖。

`script/extension-release.ts` 是在 OpenCode 源码工作区内使用的 Bun CLI，从作者准备好的本地 `.tgz` 生成 v1 发布描述。它复用宿主的安全归档解包、manifest 校验和发布描述解析，不向 extension-kit 添加整个 opencode 包依赖，也不是 kit 已发布的命令。

工具只做本地文件工作，**不联网、不上传、不 build、不安装依赖、不执行扩展入口或生命周期脚本**。它读取预构建入口字节做 manifest 验证和指纹计算，而不 `import` 扩展模块。远端 URL 仅作语法校验，不请求、不查询 DNS，不证明远端文件存在、可公开访问或与本地归档相同；安装时仍由宿主安全下载器重新执行网络及内容验证。

## 2. 使用方式

前提是已具备 Bun 和源码工作区所需依赖；本工具不会自动安装缺失依赖。

```sh
bun run script/extension-release.ts \
  --archive ./artifacts/viewer-1.0.0.tgz \
  --artifact-url https://downloads.example.com/viewer/v1.0.0/viewer-1.0.0.tgz \
  --output ./artifacts/stable.json
```

路径相对**当前工作目录**解析，也可使用绝对路径。`--output` 的父目录必须已存在。macOS 的 `/tmp` 等路径可能是系统符号链接；文件路径及其祖先不允许符号链接时，请使用实际路径（例如先用 `realpath` 获取规范路径）。

| 参数             | 说明                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--archive`      | 必填，本地已完成打包的 `.tgz` 普通文件；不接受 ZIP、源码目录或 URL                                                                               |
| `--artifact-url` | 必填，最终将承载**同一归档字节**的绝对 HTTPS 地址，无内嵌凭据、空白、反斜杠或 fragment；允许 query，但不建议把短期签名下载地址作为长期发布物地址 |
| `--output`       | 必填，要新建的 JSON 路径；父目录必须已存在且不含符号链接                                                                                         |
| `--manifest`     | 可选，另一个本地 `package.json` 文件，仅用于核对作者输入；其 `name`、`version`、`opencode.id` 必须与归档实际校验所得内容一致                     |
| `--help`         | 打印用法                                                                                                                                         |

**首版不支持 `--force`，绝不覆盖已有输出。** 最终输出使用排他创建（`wx` 等价标志）；已有普通文件、目录、符号链接（包括悬空链接）一律失败。需要更新稳定描述时，为本轮生成一个新的本地文件，检查后由作者自己的发布流程完成替换；不要把本工具当作远端原子上传工具。

`--manifest` 不是发布描述，也不是仅包含 id/version 的自报身份文件，更不能替换归档里的 `package.json`。即使没有这个参数，也始终验证归档实际 manifest。

## 3. 归档要求与安全边界

- 归档必须是 gzip 压缩的 tar，固定 `package/` 根目录；实际 `package.json` 和其声明的预构建 Web/Server 导出文件必须存在。
- 归档普通文件读取使用 no-follow、类型检查和有界快照；拒绝符号链接输入及含符号链接的父路径。SHA-256 和解包使用**同一份读取后的最终归档字节**，不会对目录、源码或解压后树计算假冒归档摘要。
- 在规范化系统临时目录下创建私有临时目录，调用 `extractArchive`，遵循其默认上限：压缩 100 MiB、解压 512 MiB、单文件 128 MiB、最多 20,000 个条目及其路径/元数据限制。
- 拒绝路径越界、链接、设备条目、`node_modules`、安装配置和归档策略禁止的锁文件等内容。只读取 JSON 和文件字节，不调用包管理器、shell、扩展代码或构建系统；成功或校验失败后清理解包临时目录。
- 通过 `manifest.ts` 的 `load` 校验实际包身份、版本、贡献声明和导出/资源路径，再通过 `parseReleaseDescriptor` 校验生成 JSON 的输出契约。若当前运行环境提供可识别宿主版本，manifest loader 也按已有规则核验 `engines.opencode`；这不代替目标安装宿主的兼容性校验。
- 这些措施不是沙箱、恶意代码扫描、作者认证或签名验证，也不使用户安装并启用后的扩展变成无风险代码。工具不尝试防御恶意本地用户并发替换祖先目录的所有竞态；请在作者自己控制的本地目录运行。

输出只包含 `schemaVersion: 1`、实际 manifest 的 `id` 和 `version`、`artifact.url` 与小写十六进制 `artifact.sha256`，不包含包名、机器本地路径或执行参数。摘要由工具计算，作者不应手写或复制示例摘要。

## 4. 推荐发布顺序

1. 在作者自己的受控流程中完成 build，打包符合归档规则的自包含 `.tgz`。本工具**不负责这一步**。
2. 固定最终 `.tgz` 字节并运行本工具，把预期的不可变、包含版本号的 HTTPS 附件地址填入 `--artifact-url`。
3. 检查生成描述的实际 ID、版本、安装包 URL 及归档摘要；不要在生成后重新打包或修改归档。任何归档字节变化都必须重新生成描述。
4. **先上传安装包**到相应 HTTPS 地址，并在作者自己的发布流程中核验远端提供的确实是同一字节。
5. 最后发布/更新稳定描述地址（例如 `stable.json`），使用托管服务支持的原子替换方式。工具不上传、不验证托管原子性，也不保证附件存在性。
6. 发布地址安装功能实际交付后，使用已明确支持该协议的宿主走预览与确认验收；在最低版本确定前不要宣传所有现有宿主都支持。

稳定描述地址与每版 artifact 地址不是同一概念。描述和摘要同处一个 HTTPS 发布面只证明声明与归档内容一致，**不提供独立作者签名、不可变发布或防回滚保证**。

## 5. 离线测试

新增测试 `packages/opencode/test/extension/release-author.test.ts` 使用 `Bun.spawn` 运行真实 CLI，现场生成 `.tgz` fixture，不请求远端服务。源码及其已有依赖准备好后，从仓库运行：

```sh
bun test ./packages/opencode/test/extension/release-author.test.ts
```

测试涵盖最终归档字节摘要、相对路径、可选 manifest 的 name/id/version 一致性、非法 URL、已有输出/链接、ZIP/伪装 `.tgz`、危险归档条目和扩展未执行标记；真实resolver离线组合另覆盖描述获取、摘要和安装事务。测试依赖当前工作树的 `packages/opencode/src/extension/release.ts`，不能在不含此实现的孤立旧基线另造占位协议。

## 6. 零依赖最小样例（2026-10-20实测）

这是用于核对包格式、生成器和本地安装链的server-only样例，不需要workspace/catalog或公开发布的extension-kit。JS入口已是可执行ESM，故不需要另行构建；实际TS/Solid扩展仍须先构建产物。

```text
release-demo/
├── package/
│   ├── package.json
│   └── server.js
└── artifacts/
```

`package/package.json`：

```json
{
  "name": "opencode-release-demo",
  "version": "1.0.0",
  "type": "module",
  "exports": { "./server": "./server.js" },
  "opencode": {
    "manifestVersion": 1,
    "id": "example.release-demo",
    "displayName": "Release Demo",
    "permissions": []
  }
}
```

`package/server.js`：

```js
export default {
  id: "example.release-demo",
  async activate(host) {
    return {
      rpc: {
        ping: async () => ({ version: host.version, message: "release-demo-ok" }),
      },
    }
  },
}
```

### 打包与生成描述

在作者自己的样例目录执行；`artifacts/`需先存在。下面macOS命令已实测，禁用AppleDouble/xattr元数据并使用ustar：

```sh
COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs \
  -czf artifacts/release-demo-1.0.0.tgz package
```

**不要直接推荐macOS默认 `tar -czf ... package`**：本轮该产物实际包含根目录外的 `._package`、`package/._server.js`等AppleDouble，以及PAX/xattr头；作者工具被安全解包器正确拒绝为 `expected package/ root`。`tar -t`的展示不一定列出所有系统元数据，应以作者工具校验通过为准，不放宽解包策略。GNU tar等其他平台选项不同，本轮未验收，勿将macOS参数当跨平台保证。

回到OpenCode源码项目根执行，替换为实际作者目录绝对路径：

```sh
bun run script/extension-release.ts \
  --archive /绝对路径/release-demo/artifacts/release-demo-1.0.0.tgz \
  --artifact-url https://downloads.example.com/release-demo/v1.0.0/release-demo-1.0.0.tgz \
  --output /绝对路径/release-demo/artifacts/stable.json \
  --manifest /绝对路径/release-demo/package/package.json
```

`downloads.example.com`仅为文档占位地址，工具不会访问它，也没有实际上传文件。生成的`stable.json`中id/version来自归档，摘要来自最终归档字节；摘要随打包元数据变化而变化，不应复制本轮某个固定摘要。

### 离线安装与RPC

纯本地验证安装的是 `.tgz`，不是本地 `stable.json`。请在**临时HOME/XDG、独立registry/data/cache**下执行，不把样例装进日常用户环境。当前源码CLI命令为：

```sh
bun run --cwd packages/opencode dev extension install /绝对路径/release-demo/artifacts/release-demo-1.0.0.tgz \
  --sha256 实际stable.json中的artifact.sha256 --yes --enable
```

这里的本地归档入口仍要求摘要；它与“用户从HTTPS发布地址安装时不用手填”是两个入口。`--enable`是为调用样例RPC显式启用，默认安装不会启用。**本地归档属于archive来源，不要在同一registry中把它直接update成release来源**；后续发布地址测试应新建完整隔离环境，避免触发跨来源身份保护。

启动使用相同隔离registry/data/cache的server，采用该server实际鉴权调用：

```text
POST <server-origin>/extension/example.release-demo/rpc/ping

预期响应：
{"result":{"version":"1.0.0","message":"release-demo-ok"}}
```

### 本轮实际结果与未验证部分

- macOS默认tar失败并被正确拒绝；去除系统元数据的ustar包通过生成器校验。
- 真实CLI离线安装：`state=committed committed=true synced=true cleanupPending=false`。
- 临时Basic API列表显示扩展enabled/ready，真实RPC返回上述version/message；server已停止，样例及临时registry仅保留在系统临时目录作为证据。
- author＋真实resolver离线集成测试复跑 **30 pass / 0 fail（2文件，217断言）**，后者覆盖HTTPS语义的可信transport、自动摘要/v3确认/更新/retained，不等同公网请求。
- 没有上传GitHub/npm，没有将占位URL当真实站点，没有运行公网descriptor→artifact正向安装。公网分发仍需作者先上传最终包、再发布稳定描述，然后用支持该功能的宿主新隔离环境验收。
