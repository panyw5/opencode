import type { BrowserBounds, WindowBrowserApi } from "./types"

export type BrowserDisplaySnapshot = {
  pageID?: string | null
  /** Deprecated page-routing alias for older callers. */
  partition: string | null
  bounds: BrowserBounds | null
  overlay?: string
}

export function createBrowserDisplay(input: {
  api?: Pick<WindowBrowserApi, "acquireDisplay" | "updateDisplay" | "releaseDisplay"> &
    Partial<Pick<WindowBrowserApi, "capturePreview">>
  read: () => BrowserDisplaySnapshot
  shown?: () => void
  preview?: (pageID: string, image: string) => Promise<void>
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
    const pageID = snapshot.pageID === undefined ? snapshot.partition : snapshot.pageID
    // While covered, geometry and nested overlay changes do not alter the
    // native hit region. Capture once rather than every layout-animation frame.
    const next = JSON.stringify(snapshot.overlay ? { pageID, overlay: true } : { ...snapshot, pageID })
    if (signature === next) {
      if (confirmed === next && pageID && snapshot.bounds && !snapshot.overlay) input.shown?.()
      return
    }
    signature = next
    const version = ++revision
    const submit = () => {
      if (disposed || version !== revision) return
      const frame =
        snapshot.pageID === undefined
          ? snapshot.overlay
            ? { partition: null, bounds: null }
            : { partition: pageID, bounds: snapshot.bounds }
          : snapshot.overlay
            ? { pageID: null, partition: null, bounds: null }
            : { pageID, partition: pageID, bounds: snapshot.bounds }
      const framePageID = "pageID" in frame ? frame.pageID : frame.partition
      console.debug(
        `[browser-display] submit lease=${lease} revision=${version} pageID=${framePageID ?? "none"}`,
      )
      void input
        .api!.updateDisplay({
          lease: lease!,
          revision: version,
          ...("pageID" in frame ? { pageID: frame.pageID } : {}),
          protectedPageID: pageID,
          partition: frame.partition,
          bounds: frame.bounds,
        })
        .then((accepted) => {
          if (disposed || version !== revision) return
          if (accepted) confirmed = next
          if (accepted && pageID && snapshot.bounds && !snapshot.overlay) input.shown?.()
        })
        .catch((error) => {
          if (version === revision) signature = undefined
          console.warn(`[browser-display] failed lease=${lease} revision=${version} error=${String(error)}`)
        })
    }
    if (snapshot.overlay && pageID && input.api.capturePreview) {
      console.debug(`[browser-display] overlay=${snapshot.overlay} capture pageID=${pageID} revision=${version}`)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[browser-display] preview timed out pageID=${pageID}`)
          resolve(undefined)
        }, 1500)
      })
      void Promise.race([input.api.capturePreview(pageID), deadline])
        .then(async (image) => {
          if (disposed || version !== revision) return
          if (image) await input.preview?.(pageID, image)
          if (disposed || version !== revision) return
          console.debug(`[browser-display] preview ready pageID=${pageID} revision=${version} image=${!!image}`)
          submit()
        })
        .catch((error) => {
          console.warn(`[browser-display] preview failed pageID=${pageID} error=${String(error)}`)
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
