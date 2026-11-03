# OpenCode 独立服务端扩展模板

这是一份可整体复制到独立Git仓库的 **server-only、零外部依赖** 模板。它提供 `ping` RPC，不包含Web界面、文件预览器或面板，也不依赖monorepo的workspace/catalog及未确认公开发布的extension-kit。

**宿主要求：**需要支持当前扩展API的OpenCode。发布地址安装的最低正式版本尚未确定；不要把源码里的版本号或普通已安装发行版当支持保证。Node.js 22或更新版本和npm用于本地测试/打包；无需执行 `npm install`。

## 开始开发

将整个目录复制到你自己的项目目录，之后所有命令在复制后的目录执行。

```text
package.json
src/server.js
test/server.test.mjs
test/release.test.mjs
scripts/release.mjs
README.md
.gitignore
```

先修改 `package.json` 中的 `name`、`version`、`opencode.id`、`displayName`、描述和权限声明。`src/server.js`从包文件读取ID，避免两处常量不一致；`private: true`防止意外npm发布，不阻止本地打包。如果今后确实发布npm包，单独核对发布配置后再改变它。

```bash
npm test
```

当前入口是纯JavaScript ESM，不需要build。需要TypeScript或Web/Solid时应另配构建链，不能直接把源文件打包就期待宿主帮你编译。扩展代码与宿主同进程，权限声明不是沙箱；只启用你信任的代码。

## 本地链接调试

```bash
opencode extension link /绝对路径/你的扩展目录
```

新的开发链接默认启用；重链接已有项保留其启停状态。宿主监听实际导出入口的变化，本模板直接编辑 `src/server.js` 即是入口变化；若改为构建产物，则需要构建器持续写出产物。热重载不保证任意定时器或不配合任务能被安全终止，出现needsRestart按提示重启专用开发实例。

启用后调用当前server的真实RPC，使用它要求的鉴权：

```text
POST <server-origin>/extension/<你的opencode.id>/rpc/ping

{"result":{"version":"0.1.0","message":"extension-starter-ok"}}
```

版本来自安装的package.json/宿主上下文，修改版本后预期响应也应变化。没有另一个“activate”接口要先调用，RPC会按宿主规则激活。

## 离线打包

```bash
npm run pack
```

脚本调用标准 `npm pack --offline --ignore-scripts`，不运行生命周期脚本、不安装依赖、不上传。`files`白名单包含src，npm默认package.json/README等文档可能同时入包；测试、发布脚本、artifacts、node_modules、.env不应进入归档。

包输出到 `artifacts/`。已有同名tgz或描述文件不覆盖；更新版本或使用新的受控输出目录，而不是依赖force。Node/npm启动与文件处理设计为跨平台，但当前仅在实际测试记录所列平台验证，不能将其等同Windows/Linux验收。

## 生成发布描述

正常发布使用这一条命令即可，它会**重新打包并对本次最终归档计算摘要**：

```bash
npm run release -- \
  --artifact-url https://downloads.example.com/starter/v0.1.0/starter.tgz \
  --output artifacts/stable.json
```

URL是将来托管同一tgz的绝对HTTPS地址，不可带用户名/密码或fragment；query允许，但不推荐短期签名URL作为长期发布产物。示例域名只是占位，不存在已发布模板包。脚本不访问该URL、不验证其可用性。

`npm run`自身会遵守npm的pre/post脚本语义；模板没有这些钩子。内部打包调用使用 `--ignore-scripts`，不会运行 `prepack`/`prepare` 等包生命周期。若作者以后添加 `prerelease`/`prepack` 等npm-run钩子，应自行审查，不把本工具当执行沙箱。命令结束标准输出的最后一行JSON给出实际 `archive`、`output` 和 `descriptor`，可供CI读取。

不要先执行pack再用相同版本release覆盖产物：两者均拒绝已有同名tgz。为一次发布直接执行release，上传它打印的那一份tgz，不要重新压缩后继续沿用旧描述摘要。

生成的JSON是：

```text
schemaVersion = 1
id / version = 当前包元数据
artifact.url = 作者提供的安装包地址
artifact.sha256 = 本次最终tgz字节的SHA-256
```

脚本用同次npm pack返回的name/version/integrity和前后package.json快照检查常见误配，不在模板内重写tar解析器。因此它假设作者控制目录且无并发修改，不是恶意本地竞态下的完整归档身份验证器。宿主安装时仍会安全解包并核对实际manifest。需要更强的发布前复核时，可在OpenCode源码工作区使用其 `script/extension-release.ts` 对实际包独立生成描述比较；这不是模板运行依赖。

## 发布与安装

1. 上传本次release生成的最终tgz到 `artifact.url`，核对远端字节没有变化。
2. **最后**把生成JSON发布到稳定HTTPS地址，如 `https://你的域名/扩展/stable.json`；使用托管方支持的原子替换方式。
3. 用户在支持该功能的OpenCode中选择“发布地址”，只填稳定JSON地址，预览并确认；不填写GitHub仓库主页，也不用手填摘要。
4. 首次release安装可能要求将整个共享注册表升v3并确认旧进程停机前提；普通 `--yes` 不代替升级许可，卸载不会降级。新安装默认停用，需显式启用。

本地tgz的CLI安装属于另一个入口，仍需摘要：

```bash
opencode extension install /绝对路径/最终包.tgz --sha256 实际生成摘要 --yes
```

请先用临时registry/data/cache验收，不要把模板装入日常环境。开发link、本地archive和release是不同来源，不能同ID静默迁移或接管旧数据；改用新的完整隔离环境测试发布来源。

同一HTTPS发布面提供的摘要只是内容一致性信息，不是作者签名、恶意代码扫描或安全认证。本模板不上传GitHub/npm、不创建仓库、不自动升级，也不提供私有仓库鉴权。
