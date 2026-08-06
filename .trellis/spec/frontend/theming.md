Theming rule

- 业务视觉状态必须使用 `html[data-color-scheme]`，例如 `html[data-theme="arc"]``[data-color-scheme="light"]`。
- prefers-color-scheme 只能用于应用选择为 system 前的首屏预加载或纯 OS 集成行为；不能用于主题配色。
- `light-dark()` 同样依赖 CSS 的 color-scheme，而主题上下文会在动态样式中写入 `:root { color-scheme: <mode> }`，可用于同一 token 的简单双态值；复杂主题覆盖
  仍优先属性 selector。

- 组件只消费语义 token，例如 `--surface-base-hover`、`--button-secondary-hover`，不写主题色常量。主题文件负责在根或局部容器重定义 token。
- Portal 浮层不继承触发器的局部 token，必须由主题根选择器直接覆盖实际浮层节点，例如 `[data-component="tooltip"]`、`[data-component="project-rail-label"]`。
- 对主题样式先核对组件输出的 `data-component/data-slot`，不要猜 selector。上次 `tooltip-content` 就是不存在的节点。
- 新增主题规则的验证矩阵至少包含：应用浅色 + 系统深色、应用深色 + 系统浅色、应用跟随系统。这样能立即暴露双状态冲突。