import type { BrowserBounds, WindowBrowserApi } from "./types"

export type BrowserDisplaySnapshot = { partition: string | null; bounds: BrowserBounds | null }

export function createBrowserDisplay(input: {
  api?: WindowBrowserApi
  read: () => BrowserDisplaySnapshot
  shown?: () => void
}) {
  let disposed = false
  let started = false
  let lease: number | undefined
  let revision = 0
  let signature: string | undefined
  let confirmed: string | undefined
  const release = (value: number) => {
    void input.api
      ?.releaseDisplay(value)
      .catch((error) => console.warn(`[browser-display] release failed lease=${value} error=${String(error)}`))
  }
  const sync = () => {
    if (disposed || lease === undefined || !input.api) return
    const snapshot = input.read()
    const next = JSON.stringify(snapshot)
    if (signature === next) {
      if (confirmed === next && snapshot.partition && snapshot.bounds) input.shown?.()
      return
    }
    signature = next
    const version = ++revision
    console.debug(
      `[browser-display] submit lease=${lease} revision=${version} partition=${snapshot.partition ?? "none"}`,
    )
    void input.api
      .updateDisplay({ lease, revision: version, ...snapshot })
      .then((accepted) => {
        if (disposed || version !== revision) return
        if (accepted) confirmed = next
        if (accepted && snapshot.partition && snapshot.bounds) input.shown?.()
      })
      .catch((error) => {
        if (version === revision) signature = undefined
        console.warn(`[browser-display] failed lease=${lease} revision=${version} error=${String(error)}`)
      })
  }
  return {
    sync,
    start() {
      if (!input.api || disposed || started) return
      started = true
      void input.api
        .acquireDisplay()
        .then((value) => {
          if (disposed) {
            release(value)
            return
          }
          lease = value
          sync()
        })
        .catch((error) => console.warn(`[browser-display] acquire failed error=${String(error)}`))
    },
    dispose() {
      disposed = true
      if (lease !== undefined) release(lease)
      console.debug(`[browser-display] disposed lease=${lease ?? "pending"}`)
    },
  }
}
