let pending: Promise<unknown> | undefined

/** Warm the lazy config page module without navigating. */
export function prefetchConfigPage() {
  if (pending) return pending
  const started = performance.now()
  console.info("[config-perf] prefetch start")
  pending = import("@/pages/config")
    .then(() => {
      console.info(`[config-perf] prefetch done ms=${(performance.now() - started).toFixed(1)}`)
    })
    .catch((err: unknown) => {
      pending = undefined
      console.info(
        `[config-perf] prefetch failed err=${err instanceof Error ? err.message : String(err)}`,
      )
    })
  return pending
}

export function prefetchConfigPageWhenIdle() {
  if (typeof window === "undefined") return
  const run = () => {
    void prefetchConfigPage()
  }
  const ric = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }
  ).requestIdleCallback
  if (typeof ric === "function") {
    ric(run, { timeout: 4000 })
    return
  }
  window.setTimeout(run, 1500)
}
