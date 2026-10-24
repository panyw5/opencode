type Change = { type: string; properties?: unknown }
type Dependencies = {
  subscribe(signal: AbortSignal): Promise<{ stream: AsyncIterable<Change> }>
  change(event: Change): void
}

export function watchVisibleFile(deps: Dependencies) {
  const stop = new AbortController()
  let attempt: AbortController | undefined
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  let restart = false
  let delay = 1000
  const clearHeartbeat = () => {
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = undefined
  }
  const reconnect = () => {
    restart = true
    delay = 1000
    attempt?.abort()
    wake?.()
  }
  void (async () => {
    while (!stop.signal.aborted) {
      attempt = new AbortController()
      const resetHeartbeat = () => {
        clearHeartbeat()
        heartbeat = setTimeout(() => attempt?.abort(), 45_000)
      }
      try {
        resetHeartbeat()
        const response = await deps.subscribe(attempt.signal)
        for await (const event of response.stream) {
          if (stop.signal.aborted || attempt.signal.aborted) break
          resetHeartbeat()
          if (event.type === "file.watcher.updated") {
            delay = 1000
            deps.change(event)
          }
        }
      } catch (error) {
        if (!attempt.signal.aborted) {
          delay = Math.min(delay * 2, 30_000)
          console.warn(`[file-preview] watch failed error=${String(error)} retryMs=${delay}`)
        }
      } finally {
        clearHeartbeat()
      }
      if (stop.signal.aborted) break
      if (restart) {
        restart = false
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        retry = setTimeout(resolve, delay)
      })
      if (retry) clearTimeout(retry)
      wake = undefined
    }
  })()
  return {
    reconnect,
    dispose() {
      stop.abort()
      reconnect()
      clearHeartbeat()
      if (retry) clearTimeout(retry)
    },
  }
}
