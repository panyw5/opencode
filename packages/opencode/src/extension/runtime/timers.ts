type Disposable = { dispose(): void }

type TimerScopeOptions = {
  available(): boolean
  track(promise: Promise<unknown>): unknown
  onError(error: unknown): void
}

/** Timers owned by one extension generation; host lifecycle and logging stay injected. */
export function makeTimerScope(options: TimerScopeOptions) {
  const timers = new Set<Disposable>()
  let closed = false

  function schedule(callback: () => unknown, delayMs: number, repeat: boolean): Disposable {
    if (closed || !options.available()) return { dispose() {} }
    let active = true
    let reported = false
    const timer: Disposable = {
      dispose() {
        if (!active) return
        active = false
        timers.delete(timer)
        if (repeat) globalThis.clearInterval(handle)
        else globalThis.clearTimeout(handle)
      },
    }
    function fail(error: unknown) {
      // In-flight interval invocations may reject after the first failure.
      // Cancel future ticks and report at most once for this timer.
      timer.dispose()
      if (reported) return
      reported = true
      options.onError(error)
    }
    function run() {
      if (!active) return
      if (!repeat) {
        active = false
        timers.delete(timer)
      }
      if (closed || !options.available()) {
        timer.dispose()
        return
      }
      try {
        const result = callback()
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          // Do not detach running work on dispose: the host's original pending
          // tracker must still observe completion (or a quiesce timeout).
          options.track(Promise.resolve(result).catch(fail))
        }
      } catch (error) {
        fail(error)
      }
    }
    const handle = repeat ? globalThis.setInterval(run, delayMs) : globalThis.setTimeout(run, delayMs)
    timers.add(timer)
    return timer
  }

  return {
    setTimeout(callback: () => unknown, delayMs: number): Disposable {
      return schedule(callback, delayMs, false)
    },
    setInterval(callback: () => unknown, delayMs: number): Disposable {
      return schedule(callback, delayMs, true)
    },
    dispose() {
      if (closed) return
      closed = true
      for (const timer of timers) timer.dispose()
    },
  }
}
