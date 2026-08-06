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

## 圆角凹接 ScoopJoin

浮层/主栏贴 rail 时，左上 `border-radius` 会挖出一块月牙。`ScoopJoin` 用与 rail/titlebar 同色的色块垫在圆角后方，形成连续凹弧，而不是透出 canvas。

- 组件：`packages/app/src/pages/layout/scoop-join.tsx`，`data-component="scoop-join"`
- 尺寸与 Arc 色：`packages/ui/src/styles/arc.css`（默认 12px；Arc 下 `--radius-2xl` + `border-strong-base`）
- 放在圆角面板**后面**（更低 z-index），面板本身保留 `rounded-tl`
- 只调定位；不要复制第二套 scoop DOM 或独立 data-component

```tsx
// 侧栏 session panel（贴 rail 内侧）
<ScoopJoin class="left-0 z-0" />

// 主内容（贴 rail 右缘；侧栏浮层打开时会被盖住）
<ScoopJoin class="hidden xl:block z-[15]" style={{ left: "4rem" }} />
```
