# @opencode-ai/extension-kit

OpenCode 扩展开发工具包（SDK）。

## 依赖声明约定

扩展的 `package.json` 遵循统一约定：

- **`devDependencies` 放一切会被打包进产物的内容**：`@opencode-ai/extension-kit`、`@opencode-ai/plugin`、以及扩展自带的库（如 `@opencode-ai/wolfram-lang`、`virtua`）。web 产物由 Vite 打包、server 产物由 `bun build` 打包，运行时不解析 `node_modules`，所以这些依赖只需要在构建期存在。
- **宿主共享的模块不打包，也不声明为运行时依赖**：`solid-js`、`@opencode-ai/ui` 由宿主通过共享模块机制提供（见 kit 的 Vite 插件与 `shims.js`），构建时会被替换为宿主 shim。它们留在 `devDependencies` 只是为了类型检查。
- **`dependencies` 保持为空或不写**：扩展包发布后不会经历 `npm install`，声明运行时依赖没有意义，只会误导读者。
