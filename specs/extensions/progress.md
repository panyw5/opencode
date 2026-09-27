# Extensions 实施进度

更新时间：2026-09-27

## 当前状态

- 总体状态：**P0 已完成并验证，待提交**。
- 工作分支：`claude/extensions-p0`
- 工作目录：`.claude/worktrees/extensions-p0`
- 设计文档：[`design.md`](design.md)
- 下一阶段：P1（web 扩展加载链路）。

## P0：宿主改造

状态：**已完成**

### 已完成内容

- 新增 `FileViewerRegistry`：
  - 支持按扩展名、完整文件名、MIME 和自定义 `test` 匹配。
  - 支持优先级排序。
  - 注册方法返回 disposer，扩展停用后可撤销注册。
- 将 CSV/TSV 表格预览迁移为内置 `preview` viewer。
- 文件标签页支持 `replace` viewer：
  - 有候选 viewer 时显示“打开方式”。
  - 可在默认源码查看器和自定义 viewer 之间切换。
  - 无候选 viewer 时不显示额外入口。
- `registerTool` 和 `registerPartComponent` 支持注销并恢复之前的注册项。
- 新增工具调用高度估算注册表，并接入虚拟时间线高度估算。
- 新增 `ext://<extensionID>/<panelID>` 面板标签骨架：
  - 标签解析与生成。
  - 面板注册与注销。
  - 标题、图标、组件和初始 query state。
  - 组件级 `ErrorBoundary`。
  - 扩展停用后保留标签并显示“扩展不可用”。
- 新增英文、简体中文、繁体中文文案。
- 完成扩展系统完整设计文档。

### 主要文件

- [`packages/ui/src/components/file-viewer-registry.ts`](../../packages/ui/src/components/file-viewer-registry.ts)
- [`packages/ui/src/components/file-table-preview.tsx`](../../packages/ui/src/components/file-table-preview.tsx)
- [`packages/ui/src/components/file-media.tsx`](../../packages/ui/src/components/file-media.tsx)
- [`packages/ui/src/components/message-part.tsx`](../../packages/ui/src/components/message-part.tsx)
- [`packages/app/src/pages/session/file-tabs.tsx`](../../packages/app/src/pages/session/file-tabs.tsx)
- [`packages/app/src/extensions/panel-tab.ts`](../../packages/app/src/extensions/panel-tab.ts)
- [`packages/app/src/extensions/panel-registry.ts`](../../packages/app/src/extensions/panel-registry.ts)
- [`packages/app/src/extensions/panel-content.tsx`](../../packages/app/src/extensions/panel-content.tsx)
- [`packages/app/src/pages/session/timeline/tool-height.ts`](../../packages/app/src/pages/session/timeline/tool-height.ts)

## 验证结果

### 自动化测试

- `packages/ui` typecheck：通过。
- `packages/app` typecheck：通过。
- UI 测试：**207 pass，0 fail**。
- P0 app 定向测试：**233 pass，0 fail**。
- app browser 测试：**39 pass，0 fail**。
- `git diff --check`：通过。

### Electron CDP 实机验证

使用 worktree 构建并启动开发版 Electron，验证完成后已停止该开发实例；未关闭安装版 OpenCode。

已验证：

- CSV 表格预览及“预览/源码/预览”切换正常。
- TSV 表格预览正常。
- Markdown 预览正常。
- PNG base64 预览正常。
- TypeScript 和未知扩展名回退源码查看器正常。
- 动态注册 `.hello` replace viewer 后：
  - 自定义 viewer 能接管文件。
  - `path`、`text` props 正确。
  - “打开方式”菜单正确显示并切换 viewer。
  - 注销后恢复默认源码查看器，菜单入口消失。
- 动态注册 `ext://test.demo/notes?key=fixture&foo=bar` 面板后：
  - 标题、图标、组件和初始 state 正确。
  - 注销后标签保留，并显示“扩展不可用”。
- 开发版日志未发现与本次改动相关的未捕获异常。
- 所有 CDP 临时探针均已移除。

## 已知限制

- PDF 标签页仍显示现有的“PDF不可预览”fallback。
- 根因是现有 `/file/content` 对 PDF 返回空二进制内容，而当前文件标签页没有可用的原始字节读取通道。
- 这不是 P0 引入的回归；设计中的 P1 `/file/raw` 会解决该问题。
- 扩展面板 `setState` 当前是进程内内存状态，不改写 tab URL，也不跨应用重启持久化；完整持久化留给 ExtensionHost。

## P1：web 扩展加载链路

状态：**待开始**

计划内容：

1. 扩展注册表及 `opencode extension link/list/enable/disable`。
2. 仅含 web 部分的 `Extension.Service`。
3. `/global/extension` 清单 API。
4. 带能力令牌的 `/extension-asset/...` 资源路由。
5. `/file/raw` 精确字节读取接口。
6. `extension.status` 事件。
7. `ExtensionHostProvider`、共享 Solid 模块桥和懒激活。
8. `@opencode-ai/extension-kit` 的 web 类型与 Vite 插件。
9. `hello-viewer` 端到端示例。
10. Desktop、内嵌 Web UI、Vite 开发环境三形态验收。

## 后续阶段

- P2：server 扩展入口、RPC、事件、设置和开发热重载。
- P3：npm/归档安装、升级、卸载、管理界面和市场索引。
- P4：WolframScript Notebook 与首批文件预览扩展。
