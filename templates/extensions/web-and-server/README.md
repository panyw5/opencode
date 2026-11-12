# OpenCode 独立 Web+服务端扩展模板

这是一份可整体复制到独立Git仓库的 **web+server、零外部依赖** 模板。它提供一个 `.ocstarter` 文件查看器（web 部分）和一个 `ping` RPC（server 部分），不依赖 monorepo 的 workspace/catalog 及未确认公开发布的 extension-kit。

**宿主要求：**需要支持当前扩展API的OpenCode。发布地址安装的最低正式版本尚未确定；不要把源码里的版本号或普通已安装发行版当支持保证。Node.js 22或更新版本和npm用于本地测试/打包；无需执行 `npm install`。

## 开始开发

将整个目录复制到你自己的项目目录，之后所有命令在复制后的目录执行。

```text
package.json
src/server.js
src/web.js
src/web.css
test/server.test.mjs
test/web.test.mjs
test/release.test.mjs
scripts/release.mjs
README.md
.gitignore
```

先修改 `package.json` 中的 `name`、`version`、`opencode.id`、`displayName`、描述和权限声明，并保持 `src/web.js` 中 `id` 与 `opencode.id` 一致（宿主激活时会校验两者相等）、`src/web.css` 中 `[data-extension="<id>"]` 前缀一致。`src/server.js` 从包文件读取ID。`private: true` 防止意外 npm 发布，不阻止本地打包。

```bash
npm test
```

当前入口是纯 JavaScript ESM，不需要 build。web 部分直接读取宿主注入的 `__OPENCODE_EXTENSION_HOST__` 共享模块（`solid-js`、`solid-js/web`、`@opencode-ai/ui/*`）；组件是返回 DOM 节点的普通函数，`props.text` 等 accessor 需要在 `createEffect` 中读取才有响应式更新。若改用 Solid/TypeScript 构建链，应让 `@opencode-ai/extension-kit` 的 vite 插件处理共享模块与 CSS 作用域前缀，本模板手写 `[data-extension="<id>"]` 前缀仅适用于无构建场景。

`contributes.fileViewers` 声明的查看器由 `activation` 中的 `onFileViewer:starter` 触发隐式激活；`activate(context)` 必须注册同名贡献点（`id: "starter"`），否则宿主会报告 manifest/代码漂移。

扩展代码与宿主同进程，权限声明不是沙箱；只启用你信任的代码。

## 本地链接调试

```bash
opencode extension link /绝对路径/你的扩展目录
```

新的开发链接默认启用；重链接已有项保留其启停状态。宿主监听实际导出入口的变化，本模板直接编辑 `src/web.js`/`src/server.js` 即是入口变化；若改为构建产物，则需要构建器持续写出产物。打开一个 `.ocstarter` 文件即可看到查看器；热重载不保证任意定时器或不配合任务能被安全终止，出现 needsRestart 按提示重启专用开发实例。

启用后调用当前 server 的真实 RPC，使用它要求的鉴权：

```text
POST <server-origin>/extension/<你的opencode.id>/rpc/ping

{"result":{"version":"0.1.0","message":"web-extension-starter-ok"}}
```

## 校验与打包

可以使用 opencode 自带的作者命令（无需本模板的脚本）：

```bash
opencode extension validate .
opencode extension pack .
```

`validate` 用安装时的同一套规则检查 manifest、入口文件和打包路径；`pack` 先 validate 再 `npm pack`，输出 tgz 与 sha256。

也可以继续使用模板自带的离线脚本：

```bash
npm run pack
```

脚本调用标准 `npm pack --offline --ignore-scripts`，不运行生命周期脚本、不安装依赖、不上传。`files` 白名单包含 src，npm 默认 package.json/README 等文档可能同时入包；测试、发布脚本、artifacts、node_modules、.env 不应进入归档。

包输出到 `artifacts/`。已有同名 tgz 或描述文件不覆盖；更新版本或使用新的受控输出目录，而不是依赖 force。

## 生成发布描述

正常发布使用这一条命令即可，它会**重新打包并对本次最终归档计算摘要**：

```bash
npm run release -- \
  --artifact-url https://downloads.example.com/starter/v0.1.0/starter.tgz \
  --output artifacts/stable.json
```

URL 是将来托管同一 tgz 的绝对 HTTPS 地址，不可带用户名/密码或 fragment；query 允许，但不推荐短期签名 URL 作为长期发布产物。命令结束标准输出的最后一行 JSON 给出实际 `archive`、`output` 和 `descriptor`，可供 CI 读取。

不要先执行 pack 再用相同版本 release 覆盖产物：两者均拒绝已有同名 tgz。

生成的 JSON 是：

```text
schemaVersion = 1
id / version = 当前包元数据
artifact.url = 作者提供的安装包地址
artifact.sha256 = 本次最终 tgz 字节的 SHA-256
```

## 发布与安装

1. 上传本次 release 生成的最终 tgz 到 `artifact.url`，核对远端字节没有变化。
2. **最后**把生成 JSON 发布到稳定 HTTPS 地址，如 `https://你的域名/扩展/stable.json`；使用托管方支持的原子替换方式。
3. 用户在支持该功能的 OpenCode 中选择"发布地址"，只填稳定 JSON 地址，预览并确认；不填写 GitHub 仓库主页，也不用手填摘要。
4. 首次 release 安装可能要求将整个共享注册表升 v3 并确认旧进程停机前提；普通 `--yes` 不代替升级许可，卸载不会降级。新安装默认停用，需显式启用。

本地 tgz 的 CLI 安装属于另一个入口，仍需摘要：

```bash
opencode extension install /绝对路径/最终包.tgz --sha256 实际生成摘要 --yes
```

请先用临时 registry/data/cache 验收，不要把模板装入日常环境。开发 link、本地 archive 和 release 是不同来源，不能同 ID 静默迁移或接管旧数据；改用新的完整隔离环境测试发布来源。

同一 HTTPS 发布面提供的摘要只是内容一致性信息，不是作者签名、恶意代码扫描或安全认证。本模板不上传 GitHub/npm、不创建仓库、不自动升级，也不提供私有仓库鉴权。
