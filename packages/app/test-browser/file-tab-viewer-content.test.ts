import { describe, expect, test } from "bun:test"
import {
  Show,
  createComponent,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
} from "solid-js"
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
import { fileViewerSwitchAllowed } from "../src/pages/session/file-viewer-policy"

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
  props?: FileViewerProps
  owner?: ReturnType<typeof getOwner>
  menuMounts: number
  menuCleanups: number
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

function setup(component?: (props: FileViewerProps) => HTMLElement, initiallyLoaded = true, content?: "text" | "self") {
  const [loaded, setLoaded] = createSignal(initiallyLoaded)
  const [text, setText] = createSignal("v1")
  const [revision, setRevision] = createSignal(1)
  const [choice, setChoice] = createSignal<string | undefined>(undefined)
  const [error, setError] = createSignal<string>()
  const [enabled, setEnabled] = createSignal(true)
  const [manifestReady, setManifestReady] = createSignal(true)
  let loads = 0

  const key = fileViewerTabKey("sess-test", "file://notes.md")
  const state = fileViewerTabState(key)
  const log: ViewerLog = { mounts: 0, saved: [], menuMounts: 0, menuCleanups: 0 }
  const viewer = component ?? makeViewerComponent(log)

  const disposeViewer = registerFileViewer({
    id: "test.viewer",
    owner: "test",
    title: "Test viewer",
    mode: "replace",
    content,
    extensions: ["md"],
    component: (props) => {
      log.props = props
      log.owner = getOwner()
      return viewer(props)
    },
  })

  const host = document.createElement("div")
  document.body.append(host)

  const activeViewer = () =>
    !manifestReady() || !enabled() || choice() === "default"
      ? undefined
      : resolveFileViewers(fileViewerTarget("notes.md"))[0]
  const showSource = () => {
    if (!fileViewerSwitchAllowed(state.dirty(), activeViewer()?.id, "default")) return false
    setChoice("default")
    loads += 1
    return true
  }
  const dispose = render(() => {
    return createFileViewerContent({
      activeViewer,
      loaded,
      defaultContent: () =>
        createComponent(Show, {
          get when() {
            return manifestReady() && loaded()
          },
          get fallback() {
            const el = document.createElement("div")
            createEffect(() => {
              el.dataset.testid = error() ? "source-error" : "source-loading"
              el.textContent = error() ?? "Loading"
            })
            return el
          },
          get children() {
            const el = document.createElement("div")
            el.dataset.testid = "source-view"
            createEffect(() => {
              el.textContent = text()
            })
            return el
          },
        }),
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
      showSource,
      path: () => "notes.md",
      menu: () => {
        log.menuMounts += 1
        onCleanup(() => {
          log.menuCleanups += 1
        })
        const el = document.createElement("button")
        el.dataset.testid = "viewer-menu"
        return el
      },
      openWith: () => {
        const el = document.createElement("button")
        el.dataset.testid = "viewer-open-with"
        return el
      },
      onRenderError: () => {},
      errorFallback: (message) => {
        const el = document.createElement("div")
        el.dataset.testid = "error-fallback"
        el.textContent = message
        return el
      },
    })
  }, host)

  return {
    setLoaded,
    setError,
    setEnabled,
    setManifestReady,
    loads: () => loads,
    setText,
    setRevision,
    showSource,
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

function toolbarSlots(host: HTMLElement) {
  return {
    row: host.querySelector<HTMLElement>('[data-slot="file-viewer-toolbar"]')!,
    defaultToolbar: host.querySelector<HTMLElement>('[data-slot="file-viewer-default-toolbar"]')!,
    customToolbar: host.querySelector<HTMLElement>('[data-slot="file-viewer-custom-toolbar"]')!,
  }
}

describe("file tab viewer render boundary", () => {
  test("a viewer without a custom toolbar keeps the default menu and Open With", async () => {
    const app = setup()
    try {
      await tick()
      const { row, defaultToolbar, customToolbar } = toolbarSlots(app.host)
      expect(row).not.toBeNull()
      expect(defaultToolbar.hidden).toBe(false)
      expect(customToolbar.hidden).toBe(true)
      expect(customToolbar.childElementCount).toBe(0)
      expect(defaultToolbar.querySelector('[data-testid="viewer-menu"]')).not.toBeNull()
      expect(defaultToolbar.querySelector('[data-testid="viewer-open-with"]')).not.toBeNull()
      expect(app.log.menuMounts).toBe(1)
    } finally {
      app.dispose()
    }
  })

  test("custom toolbar replacement preserves default controls and ignores stale disposers", async () => {
    const app = setup()
    try {
      await tick()
      const { defaultToolbar, customToolbar } = toolbarSlots(app.host)
      const menu = defaultToolbar.querySelector('[data-testid="viewer-menu"]')
      const openWith = defaultToolbar.querySelector('[data-testid="viewer-open-with"]')
      const first = document.createElement("div")
      const second = document.createElement("div")
      const offFirst = app.log.props!.setToolbar!(first)
      expect(defaultToolbar.hidden).toBe(true)
      expect(customToolbar.hidden).toBe(false)
      expect(customToolbar.firstChild).toBe(first)

      const offSecond = app.log.props!.setToolbar!(second)
      offFirst()
      offFirst()
      expect(customToolbar.firstChild).toBe(second)
      expect(first.parentNode).toBeNull()
      expect(defaultToolbar.hidden).toBe(true)

      offSecond()
      offSecond()
      expect(defaultToolbar.hidden).toBe(false)
      expect(customToolbar.hidden).toBe(true)
      expect(customToolbar.childElementCount).toBe(0)
      expect(second.parentNode).toBeNull()
      expect(defaultToolbar.querySelector('[data-testid="viewer-menu"]')).toBe(menu)
      expect(defaultToolbar.querySelector('[data-testid="viewer-open-with"]')).toBe(openWith)
      expect(app.log.menuMounts).toBe(1)
      expect(app.log.menuCleanups).toBe(0)
    } finally {
      app.dispose()
    }
  })

  test("registering the same toolbar node again has a distinct disposer token", async () => {
    const app = setup()
    try {
      await tick()
      const { defaultToolbar, customToolbar } = toolbarSlots(app.host)
      const element = document.createElement("div")
      const oldOff = app.log.props!.setToolbar!(element)
      const off = app.log.props!.setToolbar!(element)
      oldOff()
      expect(customToolbar.firstChild).toBe(element)
      expect(defaultToolbar.hidden).toBe(true)
      off()
      expect(customToolbar.childElementCount).toBe(0)
      expect(defaultToolbar.hidden).toBe(false)
    } finally {
      app.dispose()
    }
  })

  test("registering owner cleanup restores the default toolbar", async () => {
    const app = setup()
    let disposeOwner: (() => void) | undefined
    try {
      await tick()
      const { defaultToolbar, customToolbar } = toolbarSlots(app.host)
      const element = document.createElement("div")
      runWithOwner(app.log.owner!, () => {
        createRoot((dispose) => {
          disposeOwner = dispose
          app.log.props!.setToolbar!(element)
        })
      })
      expect(customToolbar.firstChild).toBe(element)
      disposeOwner!()
      disposeOwner = undefined
      expect(defaultToolbar.hidden).toBe(false)
      expect(customToolbar.hidden).toBe(true)
      expect(element.parentNode).toBeNull()
    } finally {
      disposeOwner?.()
      app.dispose()
    }
  })

  test("surface disposal clears ownerless toolbar registrations and rejects late registrations", async () => {
    const app = setup()
    try {
      await tick()
      const { defaultToolbar, customToolbar } = toolbarSlots(app.host)
      const setToolbar = app.log.props!.setToolbar!
      const element = document.createElement("div")
      const off = setToolbar(element)
      app.setLoaded(false)
      await tick()
      expect(element.parentNode).toBeNull()
      expect(customToolbar.childElementCount).toBe(0)
      expect(defaultToolbar.hidden).toBe(false)
      off()
      off()
      const late = document.createElement("div")
      setToolbar(late)()
      expect(late.parentNode).toBeNull()
      expect(customToolbar.childElementCount).toBe(0)
      expect(app.log.menuCleanups).toBe(1)
    } finally {
      app.dispose()
    }
  })

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

  test("preview content:self still waits for text and mounts once it is loaded", async () => {
    const app = setup(undefined, false)
    let off: (() => void) | undefined
    let mounts = 0
    try {
      off = registerFileViewer({
        id: "test.viewer",
        owner: "test",
        title: "Preview viewer",
        mode: "preview",
        content: "self",
        extensions: ["md"],
        component: () => {
          onMount(() => {
            mounts += 1
          })
          const el = document.createElement("div")
          el.dataset.testid = "preview-viewer"
          return el
        },
      })
      await tick()
      expect(mounts).toBe(0)
      expect(app.host.querySelector('[data-testid="preview-viewer"]')).toBeNull()
      app.setLoaded(true)
      await tick()
      expect(mounts).toBe(1)
      expect(app.host.querySelector('[data-testid="preview-viewer"]')).not.toBeNull()
    } finally {
      off?.()
      app.dispose()
    }
  })

  test("self viewers mount before text, keeping draft, toolbar and save across source failure/recovery", async () => {
    const app = setup(undefined, false, "self")
    try {
      await tick()
      expect(app.log.mounts).toBe(1)
      expect(app.loads()).toBe(0)
      const viewer = app.host.querySelector('[data-testid="extension-viewer"]')
      const owner = app.log.owner
      const toolbar = document.createElement("div")
      app.log.props!.setToolbar!(toolbar)
      app.log.setDraft!("unsaved notebook")
      app.state.setDirty(true)
      app.setError("another text consumer failed")
      app.setText("cached JSON replaced")
      app.setRevision(2)
      await tick()
      app.setLoaded(true)
      app.setError(undefined)
      await tick()
      app.setLoaded(false)
      app.setRevision(3)
      await tick()
      expect(app.log.mounts).toBe(1)
      expect(app.log.owner).toBe(owner)
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBe(viewer)
      expect(viewer!.dataset.draft).toBe("unsaved notebook")
      expect(viewer!.dataset.revision).toBe("3")
      expect(toolbarSlots(app.host).customToolbar.firstChild).toBe(toolbar)
      expect(app.log.menuCleanups).toBe(0)
      expect(app.state.hasSave()).toBe(true)
      expect(await saveFileViewerTab(app.key)).toBe(true)
      expect(app.log.saved).toEqual(["unsaved notebook"])
    } finally {
      app.dispose()
    }
  })

  test("a self placeholder is replaced once by the real viewer without rebuilding its bridge", async () => {
    const app = setup(
      () => {
        const el = document.createElement("div")
        el.dataset.testid = "placeholder"
        return el
      },
      false,
      "self",
    )
    let off: (() => void) | undefined
    try {
      await tick()
      const row = toolbarSlots(app.host).row
      let mounts = 0
      off = registerFileViewer({
        id: "test.viewer",
        owner: "test",
        title: "Real viewer",
        mode: "replace",
        content: "self",
        extensions: ["md"],
        component: (props) => {
          onMount(() => {
            mounts += 1
          })
          const el = document.createElement("div")
          el.dataset.testid = "real-viewer"
          createEffect(() => {
            el.textContent = String(props.revision?.())
          })
          return el
        },
      })
      await tick()
      const real = app.host.querySelector('[data-testid="real-viewer"]')
      expect(app.host.querySelector('[data-testid="placeholder"]')).toBeNull()
      expect(real).not.toBeNull()
      expect(mounts).toBe(1)
      app.setLoaded(true)
      app.setText("large JSON cache")
      app.setRevision(7)
      app.setError("text load failed")
      app.setLoaded(false)
      await tick()
      expect(mounts).toBe(1)
      expect(app.host.querySelector('[data-testid="real-viewer"]')).toBe(real)
      expect(real!.textContent).toBe("7")
      expect(toolbarSlots(app.host).row).toBe(row)
      expect(app.log.menuMounts).toBe(1)
    } finally {
      off?.()
      app.dispose()
    }
  })

  test("self Source is lazy and dirty rejection leaves the instance and save handler intact", async () => {
    const app = setup(undefined, false, "self")
    try {
      await tick()
      const viewer = app.host.querySelector('[data-testid="extension-viewer"]')
      app.log.setDraft!("draft")
      app.state.setDirty(true)
      expect(app.showSource()).toBe(false)
      await tick()
      expect(app.loads()).toBe(0)
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBe(viewer)
      expect(app.state.hasSave()).toBe(true)
      expect(app.state.dirty()).toBe(true)
      expect(await saveFileViewerTab(app.key)).toBe(true)
      expect(app.log.saved).toEqual(["draft"])
      expect(app.showSource()).toBe(true)
      await tick()
      expect(app.loads()).toBe(1)
      expect(app.host.querySelector('[data-testid="source-loading"]')).not.toBeNull()
      app.setError("Source failed")
      await tick()
      expect(app.host.querySelector('[data-testid="source-error"]')?.textContent).toBe("Source failed")
      app.setError(undefined)
      app.setText("recovered source")
      app.setLoaded(true)
      await tick()
      expect(app.host.querySelector('[data-testid="source-view"]')?.textContent).toBe("recovered source")
    } finally {
      app.dispose()
    }
  })

  test("manifest wait and disabling a self viewer fall back without pretending text is loaded", async () => {
    const app = setup(undefined, false, "self")
    try {
      await tick()
      app.setEnabled(false)
      await tick()
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).toBeNull()
      expect(app.host.querySelector('[data-testid="source-loading"]')).not.toBeNull()
      expect(app.state.hasSave()).toBe(false)
      app.setManifestReady(false)
      app.setEnabled(true)
      await tick()
      expect(app.log.mounts).toBe(1)
      app.setManifestReady(true)
      await tick()
      expect(app.log.mounts).toBe(2)
      expect(app.host.querySelector('[data-testid="extension-viewer"]')).not.toBeNull()
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
      const owner = app.log.owner
      const toolbar = document.createElement("div")
      const { defaultToolbar, customToolbar } = toolbarSlots(app.host)
      const menu = defaultToolbar.firstChild
      runWithOwner(owner!, () => {
        createEffect(() => {
          toolbar.textContent = `${app.log.props!.text()}:${app.log.props!.revision?.()}`
        })
        app.log.props!.setToolbar!(toolbar)
      })
      await tick()
      expect(toolbar.textContent).toBe("v1:1")

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
      expect(app.log.owner).toBe(owner)
      expect(customToolbar.firstChild).toBe(toolbar)
      expect(toolbar.textContent).toBe("v2:2")
      expect(defaultToolbar.hidden).toBe(true)
      expect(defaultToolbar.firstChild).toBe(menu)
      expect(app.log.menuMounts).toBe(1)
      expect(app.log.menuCleanups).toBe(0)

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

  for (const phase of ["setup", "mount"] as const) {
    test(`a viewer that registers a toolbar then throws during ${phase} restores the default controls`, async () => {
      const toolbar = document.createElement("div")
      let off: (() => void) | undefined
      const app = setup((props) => {
        const fail = () => {
          off = props.setToolbar!(toolbar)
          throw new Error(`toolbar ${phase} boom`)
        }
        if (phase === "setup") fail()
        onMount(fail)
        return document.createElement("div")
      })
      try {
        await tick()
        const { defaultToolbar, customToolbar } = toolbarSlots(app.host)
        expect(app.host.querySelector('[data-testid="error-fallback"]')?.textContent).toBe(`toolbar ${phase} boom`)
        expect(defaultToolbar.hidden).toBe(false)
        expect(customToolbar.hidden).toBe(true)
        expect(customToolbar.childElementCount).toBe(0)
        expect(toolbar.parentNode).toBeNull()
        expect(defaultToolbar.querySelector('[data-testid="viewer-menu"]')).not.toBeNull()
        expect(defaultToolbar.querySelector('[data-testid="viewer-open-with"]')).not.toBeNull()
        expect(app.log.menuMounts).toBe(1)
        expect(app.log.menuCleanups).toBe(0)
        off?.()
        expect(defaultToolbar.hidden).toBe(false)
      } finally {
        app.dispose()
      }
    })
  }

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
