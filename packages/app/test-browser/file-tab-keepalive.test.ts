import { describe, expect, test } from "bun:test"
import { For, createComponent, createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { insert, render } from "solid-js/web"
import {
  disposeFileViewerTabState,
  fileViewerTabDirty,
  fileViewerTabKey,
  fileViewerTabState,
  saveFileViewerTab,
} from "@opencode-ai/ui/file-viewer-registry"
import { createFileTabKeepAlive } from "../src/pages/session/file-tab-keepalive"

// Browser-condition contract tests for the file viewer tab keep-alive: a file
// tab's content mounts lazily on first activation, stays mounted (hidden and
// inert) across tab switches so extension viewers keep their local draft and
// save handlers, and is unmounted plus disposed when the tab closes.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

type ViewerLog = {
  mounts: Map<string, number>
  drafts: Map<string, string>
  saved: string[]
  setDraft: Map<string, (value: string) => void>
}

const isExtTab = (tab: string) => tab.startsWith("ext:")

// Mimics the extension viewer + FileTabContent save bridge contract: the
// viewer registers a save handler on setup (returning a disposer wired to its
// own cleanup) and keeps its draft in local component state. The element
// mirrors the keep-alive DOM contract: it stays mounted, hidden and inert
// while its tab is not active.
function FakeViewer(props: { sessionKey: Accessor<string>; tab: string; active: Accessor<boolean>; log: ViewerLog }) {
  const key = () => fileViewerTabKey(props.sessionKey(), props.tab)
  const [draft, setDraft] = createSignal(props.log.drafts.get(props.tab) ?? "original")
  props.log.setDraft.set(props.tab, setDraft)

  onMount(() => {
    props.log.mounts.set(props.tab, (props.log.mounts.get(props.tab) ?? 0) + 1)
  })

  const viewerSave = fileViewerTabState(key())
  const off = viewerSave.onSave(async () => {
    props.log.drafts.set(props.tab, draft())
    props.log.saved.push(props.tab)
  })
  onCleanup(() => off())

  const el = document.createElement("div")
  el.dataset.testid = `viewer-${props.tab}`
  createEffect(() => {
    el.classList.toggle("hidden", !props.active())
    if (props.active()) el.removeAttribute("inert")
    else el.setAttribute("inert", "")
  })
  createEffect(() => {
    el.textContent = `${props.tab}#${draft()}`
  })
  return el
}

function Harness(props: {
  sessionKey: Accessor<string>
  fileActive: Accessor<boolean>
  activeTab: Accessor<string | undefined>
  openedTabs: Accessor<string[]>
  log: ViewerLog
}) {
  const keepAlive = createFileTabKeepAlive({
    sessionKey: props.sessionKey,
    active: props.fileActive,
    activeTab: props.activeTab,
    openedTabs: props.openedTabs,
    skip: isExtTab,
  })
  const container = document.createElement("div")
  insert(
    container,
    createComponent(For, {
      get each() {
        return keepAlive.kept()
      },
      children: (tab) =>
        createComponent(FakeViewer, {
          sessionKey: props.sessionKey,
          tab,
          active: () => props.fileActive() && props.activeTab() === tab,
          log: props.log,
        }),
    }),
  )
  return container
}

function setup() {
  const [sessionKey, setSessionKey] = createSignal("sess-a")
  const [fileActive, setFileActive] = createSignal(true)
  const [activeTab, setActiveTab] = createSignal<string | undefined>("file://a.ts")
  const [openedTabs, setOpenedTabs] = createSignal<string[]>(["file://a.ts"])
  const log: ViewerLog = { mounts: new Map(), drafts: new Map(), saved: [], setDraft: new Map() }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(Harness, {
        sessionKey,
        fileActive,
        activeTab,
        openedTabs,
        log,
      }),
    host,
  )
  return {
    setFileActive,
    setSessionKey,
    setActiveTab,
    setOpenedTabs,
    log,
    host,
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}

const viewer = (host: HTMLElement, tab: string) => host.querySelector(`[data-testid="viewer-${tab}"]`)

describe("file tab keep-alive", () => {
  test("switching tabs keeps the mounted viewer instance (mount count stays 1)", async () => {
    const app = setup()
    try {
      await tick()
      expect(app.log.mounts.get("file://a.ts")).toBe(1)

      app.setOpenedTabs(["file://a.ts", "file://b.ts"])
      app.setActiveTab("file://b.ts")
      await tick()
      expect(app.log.mounts.get("file://a.ts")).toBe(1)
      expect(app.log.mounts.get("file://b.ts")).toBe(1)

      app.setActiveTab("file://a.ts")
      await tick()
      expect(app.log.mounts.get("file://a.ts")).toBe(1)
      expect(app.log.mounts.get("file://b.ts")).toBe(1)
    } finally {
      app.dispose()
    }
  })

  test("inactive viewer stays mounted hidden and inert", async () => {
    const app = setup()
    try {
      await tick()
      app.setOpenedTabs(["file://a.ts", "file://b.ts"])
      app.setActiveTab("file://b.ts")
      await tick()

      const a = viewer(app.host, "file://a.ts")
      expect(a).not.toBeNull()
      expect(a!.classList.contains("hidden")).toBe(true)
      expect(a!.hasAttribute("inert")).toBe(true)

      const b = viewer(app.host, "file://b.ts")
      expect(b!.classList.contains("hidden")).toBe(false)
      expect(b!.hasAttribute("inert")).toBe(false)
    } finally {
      app.dispose()
    }
  })

  test("a background tab opened but never activated is not mounted", async () => {
    const app = setup()
    try {
      await tick()
      app.setOpenedTabs(["file://a.ts", "file://lazy.ts"])
      await tick()
      expect(app.log.mounts.has("file://lazy.ts")).toBe(false)
      expect(viewer(app.host, "file://lazy.ts")).toBeNull()
    } finally {
      app.dispose()
    }
  })

  test("a dirty inactive tab keeps its draft and stays savable", async () => {
    const app = setup()
    try {
      await tick()
      app.setOpenedTabs(["file://a.ts", "file://b.ts"])

      // Edit in the viewer of tab a, then switch away — the draft must survive.
      const keyA = fileViewerTabKey("sess-a", "file://a.ts")
      const stateA = fileViewerTabState(keyA)
      app.log.setDraft.get("file://a.ts")!("edited")
      stateA.setDirty(true)
      app.setActiveTab("file://b.ts")
      await tick()

      expect(app.log.mounts.get("file://a.ts")).toBe(1)
      expect(stateA.dirty()).toBe(true)

      // Save still reaches the inactive tab's registered handler, and it
      // writes the draft captured from the surviving component instance.
      expect(await saveFileViewerTab(keyA)).toBe(true)
      expect(app.log.saved).toEqual(["file://a.ts"])
      expect(app.log.drafts.get("file://a.ts")).toBe("edited")
      expect(stateA.dirty()).toBe(false)
    } finally {
      app.dispose()
    }
  })

  test("collapsing the preview keeps a dirty viewer mounted and savable", async () => {
    const app = setup()
    try {
      await tick()
      const key = fileViewerTabKey("sess-a", "file://a.ts")
      app.log.setDraft.get("file://a.ts")!("collapsed draft")
      fileViewerTabState(key).setDirty(true)
      app.setFileActive(false)
      await tick()
      expect(app.log.mounts.get("file://a.ts")).toBe(1)
      expect(viewer(app.host, "file://a.ts")?.hasAttribute("inert")).toBe(true)
      expect(await saveFileViewerTab(key)).toBe(true)
      expect(app.log.drafts.get("file://a.ts")).toBe("collapsed draft")
      app.setFileActive(true)
      await tick()
      expect(app.log.mounts.get("file://a.ts")).toBe(1)
    } finally {
      app.dispose()
    }
  })

  test("closing a tab unmounts its viewer and disposes its save state", async () => {
    const app = setup()
    try {
      await tick()
      const keyA = fileViewerTabKey("sess-a", "file://a.ts")
      fileViewerTabState(keyA).setDirty(true)
      expect(fileViewerTabDirty(keyA)).toBe(true)

      app.setOpenedTabs([])
      app.setActiveTab(undefined)
      await tick()

      expect(viewer(app.host, "file://a.ts")).toBeNull()
      // The state was disposed together with the tab: a fresh mount starts clean.
      expect(fileViewerTabState(keyA).hasSave()).toBe(false)
      disposeFileViewerTabState(keyA)
    } finally {
      app.dispose()
    }
  })

  test("switching sessions disposes the previous session's viewer state", async () => {
    const app = setup()
    try {
      await tick()
      const keyA = fileViewerTabKey("sess-a", "file://a.ts")
      fileViewerTabState(keyA).setDirty(true)
      expect(fileViewerTabDirty(keyA)).toBe(true)

      app.setSessionKey("sess-b")
      app.setOpenedTabs(["file://c.md"])
      app.setActiveTab("file://c.md")
      await tick()

      expect(fileViewerTabDirty(keyA)).toBe(false)
      expect(fileViewerTabState(keyA).hasSave()).toBe(false)
      expect(viewer(app.host, "file://c.md")).not.toBeNull()
      disposeFileViewerTabState(fileViewerTabKey("sess-b", "file://c.md"))
    } finally {
      app.dispose()
    }
  })
})
