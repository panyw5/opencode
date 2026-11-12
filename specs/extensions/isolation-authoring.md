# 扩展作者：错误隔离与后台任务

## 钩子的拒绝语义

事件钩子异常被逐条目记录，不中断后续事件。请求型 trigger 钩子不是 fire-and-forget：普通错误继续阻止当前调用，例如 `tool.execute.before` 可以抛错拒绝工具执行；仅扩展换代/变更期间的 `ExtensionMutationError` 被宿主跳过。需要独立恢复的后台错误应由扩展自身处理，不要依赖宿主吞掉所有错误。

`activate` 和实例 `server` 默认有 10 秒截止。不要在激活中等待无限后台循环；返回 service 后再通过托管资源推进后台工作。激活超时的迟到结果会被回收，不可继续注册资源。

## 托管计时器

使用 `host.setTimeout` / `host.setInterval`，而非全局计时器：

```ts
async activate(host) {
  const timer = host.setTimeout(async () => {
    await refreshCache()
  }, 250)
  return {
    async dispose() {
      timer.dispose()
    },
  }
}
```

- handle 的 `dispose()` 可重复调用；宿主也会在所属 activation/instance 结束时撤销 timers，无自定义 dispose 也会回收。
- 回调同步抛错与返回 Promise 的拒绝均记录到所属扩展并停止该 timer；同一个 timer 的并发失败只报告一次。
- `setInterval` 的异步回调可能重叠；需要串行时，await 完成后再安排下一次 timeout。
- 必须返回或 await 自己的异步工作。脱离的 Promise、原生 timer、监听器和任意闭包不在此 scope 的保证内。
- dispose 只阻止未来回调，不强行终止已开始的 Promise。在途工作继续纳入 quiesce，无法停止仍可能需要重启。
- process host 的 timer 不随某一个目录的 hooks 销毁；instance host 的 timer 不得越过所属 hooks 生命周期。

## 状态与恢复边界

清单状态和后端 `server.runtime` 分开：后端失败不应撤销健康 web contribution。可重试错误通过 `POST /global/extension/:id/retry` 清理，`blocked/needsRestart` 不能借 retry、修改设置或重载解除。

当前仍是可信扩展同进程模型，不是安全沙箱。全局 timer 的 `uncaughtException` 仍使 sidecar fatal exit(1)；堆栈路径仅提供尽力归因，不能证明安全恢复或真实扩展身份。未来独立进程原型见 [prototypes/README.md](./prototypes/README.md)，尚未接入生产。
