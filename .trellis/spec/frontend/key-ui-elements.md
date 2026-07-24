
## 圆角缺口
会话列表左上和右上由于巨型圆角产生的四分之一圆缺口的样式说明。

### 选择器

- 左上缺口：[data-component="sidebar-nav-desktop"] 的背景，内部 [data-component="sidebar-panel"] 有左上圆角，露出父容器。
- 右上缺口：main 的左上圆角露出 app-root 背景；Arc 中由 --canvas-base 控制。
- 会话列表表面：[data-component="sidebar-panel"]，使用 --color-border-weaker-base。
- 顶栏：[data-component="titlebar"]，使用 --border-strong-base。

### 配色方案

- 圆角露出色取决于父元素，不是圆角元素本身；应先确认实际承载背景的层级。
- 两个缺口可独立配色：左上与顶栏相接，匹配 --border-strong-base；右上位于会话列表与主内容之间，匹配 --color-border-weaker-base。
- 不要用单一全局画布色强行统一所有缺口；按视觉相邻的表面选择 token，层级关系会更自然。

## 动态状态指示器

### 会话进行中的扩散波纹

- 项目图标右下角的进行中状态是基准实现：固定主体与同尺寸、绝对定位的 ripple 分开渲染。
- `project-activity-ping` 在 `packages/app/src/index.css` 中将 ripple 从原始尺寸扩展到 `scale(2)` 并淡出。需要同类效果时复用该动画与 DOM 结构，不要仅给已有按钮添加伪元素或阴影动画。
- 停止按钮本身已经是实心主体；只需要添加 ripple，不能再叠加实心 dot，否则会遮住按钮并显示为固定的大圆。

```tsx
<div class="relative size-10 shrink-0">
  <Show when={working()}>
    <div data-component="prompt-stop-halo" aria-hidden="true" class="pointer-events-none absolute inset-0 z-0 flex">
      <span data-slot="prompt-stop-halo-ripple" class="absolute inline-flex h-full w-full rounded-full" />
    </div>
  </Show>
  <IconButton class="relative z-1 size-10 rounded-full" icon="stop" />
</div>
```

### 动效可访问性与验证

- `@media (prefers-reduced-motion: reduce)` 会覆盖动画。若一个状态动画必须与项目图标进行中状态保持一致，不要为该组件添加额外的 reduced-motion 禁用规则；否则系统设置开启“减少动态效果”时会只留下固定图形。
- 在 DevTools 验证运行时 DOM，而不是只检查源码。停止状态应包含 `data-component="prompt-stop-halo"` 和 `data-slot="prompt-stop-halo-ripple"`；只有旧的单个 halo 节点表示应用仍在运行旧的前端包，需要重启或刷新。
