import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { disposeFileViewerTabState, fileViewerTabKey } from "@opencode-ai/ui/file-viewer-registry"

// Keep-alive for file viewer tabs (P2): a file tab's content must stay mounted
// once it has been shown, because extension viewers hold local state (unsaved
// draft, scroll, registered save handlers) that switching tabs must not
// destroy. Only tabs that were actually activated are mounted, so lazily
// opened background tabs never cost anything until first use.
//
// The instance lifetime is still bounded:
// - closing a tab unmounts its content and disposes the tab's viewer state,
//   whichever path triggered the close,
// - switching sessions unmounts every tab of the previous session and
//   disposes their viewer state.

export type FileTabKeepAliveInput = {
  // Session key of the panel's session; scopes warmed keys and viewer state.
  sessionKey: Accessor<string>
  // Panel content gate (e.g. the open-animation delay): tabs are only warmed
  // and rendered while it is true, matching the pre-keep-alive lazy mount.
  active: Accessor<boolean>
  // Active file tab value (normalized, may be an extension panel tab).
  activeTab: Accessor<string | undefined>
  // All opened (normalized) tab values of the current session.
  openedTabs: Accessor<string[]>
  // Tabs that opt out of keep-alive and keep their previous keyed behaviour.
  skip: (tab: string) => boolean
}

export function createFileTabKeepAlive(input: FileTabKeepAliveInput) {
  const keepable = (tab: string) => !input.skip(tab)

  const [warmed, setWarmed] = createSignal(new Set<string>())

  // Warm a tab the first time it becomes the active file tab with the panel
  // content gate open. Later activations reuse the mounted instance.
  createEffect(() => {
    if (!input.active()) return
    const tab = input.activeTab()
    if (!tab || !keepable(tab)) return
    const key = fileViewerTabKey(input.sessionKey(), tab)
    if (warmed().has(key)) return
    setWarmed((prev) => new Set(prev).add(key))
  })

  // Track closes (any call site: close button, middle click, Cmd+W, panel
  // close action) and session switches, and dispose the viewer state of tabs
  // that went away so no dirty/handler state survives its tab.
  createEffect(
    on([input.sessionKey, input.openedTabs], ([session, list], prev) => {
      if (!prev) return
      const [prevSession, prevList] = prev
      if (prevSession === session) {
        const open = new Set(list)
        const closed = prevList.filter((tab) => !open.has(tab) && keepable(tab))
        if (closed.length === 0) return
        setWarmed((prevSet) => {
          const next = new Set(prevSet)
          let changed = false
          for (const tab of closed) {
            if (next.delete(fileViewerTabKey(session, tab))) changed = true
          }
          return changed ? next : prevSet
        })
        for (const tab of closed) disposeFileViewerTabState(fileViewerTabKey(session, tab))
        return
      }
      // Session switch: every previous tab is gone from this panel. Drop
      // only the previous session's keys so tabs the new session warmed in
      // the same flush survive.
      setWarmed((prevSet) => {
        const next = new Set(prevSet)
        let changed = false
        for (const tab of prevList) {
          if (!keepable(tab)) continue
          if (next.delete(fileViewerTabKey(prevSession, tab))) changed = true
        }
        return changed ? next : prevSet
      })
      for (const tab of prevList) {
        if (!keepable(tab)) continue
        disposeFileViewerTabState(fileViewerTabKey(prevSession, tab))
      }
    }),
  )

  // Safety net when the whole panel goes away (session page unmount, desktop
  // breakpoint flip): the tab list may live on in the layout store, but the
  // mounted viewers do not, so their viewer state must not either.
  onCleanup(() => {
    const session = input.sessionKey()
    for (const tab of input.openedTabs()) {
      if (!keepable(tab)) continue
      disposeFileViewerTabState(fileViewerTabKey(session, tab))
    }
  })

  // Once warmed, keep content mounted even while the preview is collapsed.
  // The host hides inactive content rather than destroying its local draft.
  const kept = createMemo(() => {
    const session = input.sessionKey()
    return input.openedTabs().filter((tab) => keepable(tab) && warmed().has(fileViewerTabKey(session, tab)))
  })

  return { warmed, kept }
}
