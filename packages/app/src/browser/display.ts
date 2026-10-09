import type { BrowserBounds, WindowBrowserApi } from "./types"

export type BrowserDisplaySnapshot = { partition: string | null; bounds: BrowserBounds | null; overlay?: string }

export function createBrowserDisplay(input: {
  api?: Pick<WindowBrowserApi, "acquireDisplay" | "updateDisplay" | "releaseDisplay"> &
    Partial<Pick<WindowBrowserApi, "capturePreview">>
  read: () => BrowserDisplaySnapshot
  shown?: () => void
  preview?: (partition: string, image: string) => Promise<void>
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
    // While covered, geometry and nested overlay changes do not alter the
    // native hit region. Capture once rather than every layout-animation frame.
    const next = JSON.stringify(snapshot.overlay ? { partition: snapshot.partition, overlay: true } : snapshot)
    if (signature === next) {
      if (confirmed === next && snapshot.partition && snapshot.bounds && !snapshot.overlay) input.shown?.()
      return
    }
    signature = next
    const version = ++revision
    const submit = () => {
      if (disposed || version !== revision) return
      const frame = snapshot.overlay ? { partition: null, bounds: null } : snapshot
      console.debug(
        `[browser-display] submit lease=${lease} revision=${version} partition=${frame.partition ?? "none"}`,
      )
      void input
        .api!.updateDisplay({ lease: lease!, revision: version, partition: frame.partition, bounds: frame.bounds })
        .then((accepted) => {
          if (disposed || version !== revision) return
          if (accepted) confirmed = next
          if (accepted && snapshot.partition && snapshot.bounds && !snapshot.overlay) input.shown?.()
        })
        .catch((error) => {
          if (version === revision) signature = undefined
          console.warn(`[browser-display] failed lease=${lease} revision=${version} error=${String(error)}`)
        })
    }
    if (snapshot.overlay && snapshot.partition && input.api.capturePreview) {
      const partition = snapshot.partition
      console.debug(`[browser-display] overlay=${snapshot.overlay} capture partition=${partition} revision=${version}`)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[browser-display] preview timed out partition=${partition}`)
          resolve(undefined)
        }, 1500)
      })
      void Promise.race([input.api.capturePreview(partition), deadline])
        .then(async (image) => {
          if (disposed || version !== revision) return
          if (image) await input.preview?.(partition, image)
          if (disposed || version !== revision) return
          console.debug(`[browser-display] preview ready partition=${partition} revision=${version} image=${!!image}`)
          submit()
        })
        .catch((error) => {
          console.warn(`[browser-display] preview failed partition=${partition} error=${String(error)}`)
          submit()
        })
        .finally(() => clearTimeout(timer))
      return
    }
    submit()
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
