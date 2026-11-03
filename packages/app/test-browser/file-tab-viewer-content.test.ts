import { describe, expect, test } from "bun:test"
import { Show, createComponent, createEffect, createSignal, getOwner, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import {
  disposeFileViewerTabState,
  fileViewerTabKey,
  fileViewerTabState,
  fileViewerTarget,
  registerFileViewer,
  resolveFileViewers,
  saveFileViewerTab,
  type FileViewerProps,
} from "@opencode-ai/ui/file-viewer-registry"
import { createFileViewerContent } from "../src/pages/session/file-viewer-content"

// Browser-condition contract tests for the file tab viewer render boundary
// (packages/app/src/pages/session/file-viewer-content.ts, used by
// FileTabContent). An external content refresh (watcher reload) must never
// re-create the extension viewer element: text and revision reach the mounted
// viewer as accessors, so its local draft, owner and save handlers survive.
// A viewer that throws on setup must land in the host error fallback.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

type ViewerLog = {
  mounts: number
  saved: string[]
  setDraft?: (value: string) => void
}

// Mimics an extension replace-mode viewer: a local draft signal, a save
// handler registered through the host bridge, and reactive reads of the host
// `text`/`revision` accessors.
function makeViewerComponent(log: ViewerLog) {
  return (props: FileViewerProps) => {
    const [draft, setDraft] = createSignal("original")
    log.setDraft = setDraft

    const el = document.createElement("div")
    el.dataset.testid = "extension-viewer"

    onMount(() => {
      log.mounts += 1
    })

    const off = props.onSave?.(async () => {
      log.saved.push(draft())
    })
    onCleanup(() => off?.())

    createEffect(() => {
      el.dataset.text = props.text() ?? ""
    })
    createEffect(() => {
      el.dataset.revision = String(props.revision?.() ?? 0)
    })
    createEffect(() => {
      el.dataset.draft = draft()
    })
    return el
  }
}

function setup(component?: (props: FileViewerProps) => HTMLElement, initiallyLoaded = true) {
  const [loaded, setLoaded] = createSignal(initiallyLoaded)
  const [text, setText] = createSignal("v1")
  const [revision, setRevision] = createSignal(1)
  const [choice, setChoice] = createSignal<string | undefined>(undefined)

  const key = fileViewerTabKey("sess-test", "file://notes.md")
  const state = fileViewerTabState(key)
  const log: ViewerLog = { mounts: 0, saved: [] }

  const disposeViewer = registerFileViewer({
    id: "test.viewer",
    owner: "test",
    title: "Test viewer",
    mode: "replace",
    extensions: ["md"],
    component: component ?? makeViewerComponent(log),
  })

  const host = document.createElement("div")
  document.body.append(host)

  const dispose = render(() => {
    return createComponent(Show, {
      get when() {
        return loaded()
      },
      get children() {
        return createFileViewerContent({
          // Mirrors file-tabs: the default viewer is chosen through showSource.
          activeViewer: () =>
            choice() === "default" ? undefined : resolveFileViewers(fileViewerTarget("notes.md"))[0],
          defaultContent: () => {
            const el = document.createElement("div")
            el.dataset.testid = "source-view"
            createEffect(() => {
              el.textContent = text()
            })
            return el
          },
          text,
          revision,
          file: () => ({
            path: "notes.md",
            name: "notes.md",
            extension: "md",
            absolutePath: "/repo/notes.md",
            directory: "/repo",
          }),
          setDirty: (dirty) => state.setDirty(dirty),
          onSave: (handler) => {
            const off = state.onSave(handler)
            if (getOwner()) onCleanup(off)
            return off
          },
          readBytes: async () => new TextEncoder().encode(text()),
          readText: async () => text(),
          showSource: () => setChoice("default"),
          path: () => "notes.md",
          menu: () => document.createElement("span"),
          openWith: () => document.createElement("span"),
          onRenderError: () => {},
          errorFallback: (message) => {
            const el = document.createElement("div")
            el.dataset.testid = "error-fallback"
            el.textContent = message
            return el
          },
        })
      },
    })
  }, host)

  return {
    setLoaded,
    setText,
    setRevision,
    showSource: () => setChoice("default"),
    log,
    state,
    key,
    host,
    dispose: () => {
      dispose()
      disposeViewer()
      host.remove()
      disposeFileViewerTabState(key)
    },
  }
}

describe("file tab viewer render boundary", () => {
  test("the loaded branch delays mounting and disposes the viewer on unload", async () => {
    const app = setup(undefined, false)
    try {
      await tick()
      expect(app.log.mounts).toBe(0)
      expect(app.state.hasSave()).toBe(false)
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBeNull()

      app.setLoaded(true)
      await tick()
      expect(app.log.mounts).toBe(1)
      expect(app.state.hasSave()).toBe(true)

      app.setLoaded(false)
      await tick()
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBeNull()
      expect(app.state.hasSave()).toBe(false)
    } finally {
      app.dispose()
    }
  })

  test("external content change keeps the extension viewer mounted with its draft", async () => {
    const app = setup()
    try {
      await tick()
      expect(app.log.mounts).toBe(1)
      const viewer = app.host.querySelector('[data-testid="extension-viewer"]')
      expect(viewer).not.toBeNull()
      expect(viewer!.dataset.text).toBe("v1")
      expect(viewer!.dataset.revision).toBe("1")

      // The user edits the draft and the tab becomes dirty.
      app.log.setDraft!("edited")
      app.state.setDirty(true)
      await tick()
      expect(viewer!.dataset.draft).toBe("edited")

      // External content refresh (watcher reload): new text and revision.
      app.setText("v2")
      app.setRevision(2)
      await tick()

      // Same element, still mounted, draft intact.
      expect(app.log.mounts).toBe(1)
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBe(viewer)
      expect(viewer!.dataset.draft).toBe("edited")
      // Text and revision reached the surviving instance reactively.
      expect(viewer!.dataset.text).toBe("v2")
      expect(viewer!.dataset.revision).toBe("2")

      // The save bridge still runs the surviving viewer's handler.
      expect(await saveFileViewerTab(app.key)).toBe(true)
      expect(app.log.saved).toEqual(["edited"])
      expect(app.state.dirty()).toBe(false)
    } finally {
      app.dispose()
    }
  })

  test("source fallback shows the current content and updates with external changes", async () => {
    const app = setup()
    try {
      await tick()
      expect(app.log.mounts).toBe(1)

      app.showSource()
      await tick()
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBeNull()
      // Owner cleanup unregistered the viewer's save handler with its instance.
      expect(app.state.hasSave()).toBe(false)

      const source = app.host.querySelector('[data-testid="source-view"]')
      expect(source?.textContent).toBe("v1")

      app.setText("v2")
      await tick()
      expect(app.host.querySelector('[data-testid="source-view"]')?.textContent).toBe("v2")
    } finally {
      app.dispose()
    }
  })

  test("a viewer that throws on setup renders the host error fallback", async () => {
    const app = setup(() => {
      throw new Error("viewer boom")
    })
    try {
      await tick()
      // The throw must be caught by the host ErrorBoundary, not escape.
      const fallback = app.host.querySelector('[data-testid="error-fallback"]')
      expect(fallback).not.toBeNull()
      expect(fallback!.textContent).toBe("viewer boom")
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBeNull()
    } finally {
      app.dispose()
    }
  })
})
