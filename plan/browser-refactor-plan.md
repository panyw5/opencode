# 内置浏览器实现审查与重构方案

日期：2026-11-13
范围：`packages/desktop/src/main/browser.ts`、`browser-cdp.ts`、`ipc.ts`、
`packages/app/src/browser/{display,tabs,overlays,types}.ts`、`browser-panel.tsx`、
gpt-pro 与 bridge 调用方。

## 一、整体流程图

```
 ┌──────────────────────── 渲染进程 (SolidJS) ────────────────────────┐
 │  tabs.ts (标签状态)                      browser-panel.tsx (布局采样)│
 │  ├ views{pageID→state}  ← onUpdated       ├ ResizeObserver /        │
 │  ├ active                ← onClosed       │  MutationObserver /      │
 │  ├ pending + navigating  (同一导航记两份) │  resize / scroll → rAF   │
 │  ├ closed{pageID→epoch}  (过期事件过滤)   └ read(): 占位 div rect +  │
 │  └ presentation          ← onPresented        overlay 检测           │
 │                                          display.ts (帧提交器)      │
 │                                          ├ start→acquireDisplay→lease│
 │                                          ├ sync→签名去重→revision++ │
 │                                          ├ 有 overlay→capturePreview│
 │                                          └ updateDisplay{lease,rev, │
 │                                            pageID,bounds,protectedID}│
 └───────────────────────────────────┬────────────────────────────────┘
                                IPC  │ (另有遗留接口 setBounds/setVisible,
                                     │  前端已不调用)
 ┌───────────────────────────────────▼── 主进程 BrowserController ────┐
 │ 全局: displayLease / displayRevision / protectedPageID /            │
 │       pendingPresentationPageID / presentation / epochs             │
 │                                                                     │
 │ updateDisplay ─┬─ 租约/版本过期则拒绝                                │
 │                ├─ 写 protectedPageID，清除 pendingPresentation       │
 │                ├─ 遍历所有 view：visible/bounds → applyBounds(去重)  │
 │                └─ automation 页且 emulationActive → 异步清除仿真一次 │
 │                                                                     │
 │ view 布局尺寸有【三个写入方】:                                       │
 │   ① openPage    → cdp.setViewport (仿真, DPR=1)，每次 openPage 都会  │
 │     重新开启                                                        │
 │   ② applyBounds → native setBounds (可见=面板尺寸 / 隐藏=屏幕外停驻) │
 │   ③ captureScreenshot → 直接 setBounds(1280×800)，绕过 applyBounds   │
 │                                                                     │
 │ protection【三个来源】:                                             │
 │   entry.visible ∪ protectedPageID(显示帧 + 遗留setVisible) ∪        │
 │   pendingPresentation(present)                                      │
 │                                                                     │
 │ 调用方: gpt-pro-driver.present / page-manager(list/close/protection)│
 │         bridge-client(screenshot/click/snapshot) / ipc(open/close)  │
 └────────────────────────────────────────────────────────────────────┘
```

## 二、问题清单

### A. 多个机制争夺同一状态（高优先级）

#### A1. 布局尺寸有三个写入方，规则互相矛盾

- 页面显示过后仿真被清除；之后隐藏时 agent 截图，`captureScreenshot` 把它
  临时改成固定 1280×800，截完再恢复停驻尺寸 → 布局重排两次，截图布局与
  之后点击的布局不一致。**由 bounds 驱动布局改动引入**（此前仿真常开，
  native 尺寸被覆盖，无此问题）。
- DPR 不一致：仍在仿真的页面截图 DPR=1；清除过仿真的页面 native DPR=2，
  图片像素约 4 倍。同样是 bounds 驱动改动引入。
- `openPage` 每次都重新开启仿真。agent 在已显示页面上导航时仿真被重开，
  下一显示帧再清除，来回反复。
- 仿真目前唯一不可替代的作用是"强制 DPR=1"。隐藏页停驻时本就带着
  1280×800 或上次的尺寸，native 已能提供确定布局视口。焦点仿真
  （`setFocusEmulationEnabled`）是独立命令，只是被捆在 `setViewport` 里。

#### A2. protection 有三个来源、两个写入方

- 显示帧和遗留 `setVisible` 都写 `protectedPageID`。
- `pendingPresentationPageID` 只有在某帧恰好保护同一页面时才清除；
  若该帧不来（窗口不存在等），页面一直受保护、永不被清理。
- `getDisplayState()` 只报告一个来源，排查看不到完整状态。

#### A3. 显示租约全局唯一且 `acquireDisplay()` 无条件抢占

- 任何第二个调用者（第二窗口挂载 BrowserPanel、CDP 调试脚本）都会让
  主窗口页面静默消失（2026-11-13 实测复现）。
- 应用支持多窗口（`windows.ts` 两处 `new BrowserWindow`），但视图只挂
  owner 窗口；租约未与窗口绑定。

### B. 冗余与死代码（中优先级）

| # | 位置 | 问题 |
|---|------|------|
| B1 | ipc.ts / preload / types.ts 的 `setBounds`、`setVisible` | 前端已不调用，只在无租约时生效；仍会写 protection（见 A2） |
| B2 | display.ts 与 updateDisplay 的 `partition` 别名分支 | 面板总传 pageID，`pageID===undefined` 遗留分支走不到 |
| B3 | openPage | 导航前后各调一次 applyBounds，第一次多余 |
| B4 | tabs.ts 的 `pending` 与 `state.navigating` | 同一导航请求记两份 {id,url}，需手动同步 |
| B5 | captureScreenshot | 直接调 native 接口 + 手动失效缓存，绕开 applyBounds 唯一出口 |
| B6 | browser-spike.ts | 无任何导入，死文件 |

### C. 演化痕迹

- "想要的状态"（visible/bounds）与"已应用 native 状态"
  （appliedVisible/appliedBounds）分层正确，但并非所有修改都经过同一
  汇合函数：acquireDisplay / releaseDisplay / attachWindow / setVisible
  各自遍历，captureScreenshot 直接改 native。新机制易出现"先停驻再恢复"
  类问题。

## 三、统一方案（已确认：全部实施；截图统一缩放到 1x）

### 方案 1：主进程只有一个汇合函数

- 所有输入（显示帧、attach、截图临时显示、teardown）只修改"想要的状态"，
  然后调用一个 `reconcile()`。
- 截图临时显示改成一个标志位（如 `transientShow`），由 `reconcile()`
  统一处理，不再直接调 native。

### 方案 2：布局尺寸只保留一条规则 —— 始终由 native bounds 决定

- 显示时用面板尺寸，隐藏时停在屏幕外、保持上次尺寸（没有就用 1280×800）。
- **完全去掉尺寸仿真**（`setDeviceMetricsOverride` / `clearDeviceMetricsOverride` /
  `viewportQueue` / `emulationActive` / `emulationClearing`），只保留焦点仿真。
- 截图临时显示沿用停驻尺寸，不再硬编码 1280×800，避免重排。
- 截图统一缩放到 1x（Retina 上图片小、agent 识图友好）。
- **落地前必须用 CDP 实测**：隐藏的停驻视图里 `innerWidth` 是否确实等于
  停驻宽度（hidden view 是否按 bounds 布局）。

### 方案 3：protection 统一计算

- 定义为 `visible ∪ selected ∪ pendingPresentation`，三来源都在
  `getDisplayState` 暴露。
- `pendingPresentation` 在页面被确认显示（ack）后清除，或设超时兜底。

### 方案 4：租约与 owner 窗口绑定

- 非 owner 窗口的 `acquireDisplay` 直接拒绝，不再抢占。

### 方案 5：清理 B1–B6

- 删除 ipc/preload/types 中的 setBounds/setVisible 及其 controller 方法
  （同时消除其 protection 写入路径）。
- 删除 display frame 的 partition 遗留分支（协议可保留字段不再解析）。
- openPage 去掉首次多余 applyBounds。
- tabs.ts 合并 pending/navigating 为单一来源。
- 删除 browser-spike.ts。

## 四、实施阶段

1. **实测先行**：CDP 验证隐藏停驻视图的 innerWidth / devicePixelRatio，
   确认方案 2 前提成立。
2. **主进程汇合**：reconcile() 统一出口；去仿真；截图瞬时显示走
   transientShow 标志；DPR 缩放 1x。
3. **protection / 租约**：统一计算与暴露；租约绑 owner 窗口。
4. **清理**：B1–B6 删除；前端 display.ts/tabs.ts 简化。
5. **每阶段**：`bun run --cwd packages/desktop typecheck` +
   `bun test src/main/`（14+ 项 browser 测试）+ CDP 实测
   （重启 dev:desktop，注意 env 去掉 ELECTRON_RUN_AS_NODE）。

## 五、保持不变

- display lease/revision 过期帧拒绝语义
- epoch / documentEpoch 代际隔离与 stale 事件过滤
- gpt-pro consultation 生命周期（budget 8、grace 30s、safeToClose）
- CDP 点击/截图/快照的坐标正确性
