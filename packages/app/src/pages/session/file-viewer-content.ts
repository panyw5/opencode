import {
  ErrorBoundary,
  Show,
  createComponent,
  createRenderEffect,
  getOwner,
  onCleanup,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js"
import { Dynamic, insert } from "solid-js/web"
import type { FileViewerEntry, FileViewerFile } from "@opencode-ai/ui/file-viewer-registry"
import { fileViewerCanMount, fileViewerReadsSelf } from "./file-viewer-policy"

// The boundary is mounted outside the source loading/error gate. Only an
// explicitly self-reading replace viewer may mount before host text exists.
// Its surface and bridge survive loaded/error/cache changes; the source view
// owns those gates inside defaultContent instead.
//
// Neither the branch props nor this module may read the file text in a scope
// whose re-run re-creates the subtree. In Solid the Switch/Show children are
// evaluated inside the surrounding memo's tracking scope, so any text read
// there re-runs the branch on every external content refresh and remounts the
// extension viewer, losing its local draft, owner and save handlers. Text and
// revision therefore flow into the viewer surface as accessors and are read
// only inside the viewer's own reactive scopes.

export type FileViewerContentInput = {
  // A registered replace-mode viewer takes over the tab; undefined renders the
  // default source view.
  activeViewer: Accessor<FileViewerEntry | undefined>
  loaded: Accessor<boolean>
  // Default source view element. Invoked inside the Show fallback scope, so
  // its reactive reads only ever rebuild the source view itself.
  defaultContent: () => JSX.Element
  wrapViewer?: (content: HTMLElement) => JSX.Element
  // Extension viewer surface inputs. `text` and `revision` must stay
  // accessors so external content refreshes reach the mounted viewer without
  // recreating it.
  text: Accessor<string | undefined>
  revision: Accessor<number>
  file: Accessor<FileViewerFile>
  setDirty: (dirty: boolean) => void
  onSave: (handler: () => Promise<void>) => () => void
  readBytes: () => Promise<Uint8Array>
  readText: () => Promise<string>
  showSource: () => void
  path: Accessor<string>
  menu: () => JSX.Element
  openWith: () => JSX.Element
  onRenderError: (input: { id: string; path: string; message: string }) => void
  errorFallback: (message: string) => JSX.Element
}

type ViewerShowProps = {
  when: FileViewerEntry | undefined
  fallback?: JSX.Element
  children: (entry: Accessor<FileViewerEntry>) => JSX.Element
}

// The flow components are aliased with the exact prop shapes used here; the
// generic `createComponent` overloads do not narrow these unions when the
// props object is built by hand (see file.tsx for the same aliasing pattern).
const ViewerShow = Show as unknown as Component<ViewerShowProps>
const ViewerErrorBoundary = ErrorBoundary as unknown as Component<{
  fallback: (error: unknown) => JSX.Element
  children: JSX.Element
}>

export function createFileViewerContent(input: FileViewerContentInput): JSX.Element {
  return createComponent(ViewerShow, {
    get when() {
      const viewer = input.activeViewer()
      // Short-circuit before loaded(): self viewers never subscribe to the
      // source gate, even when another consumer loads or evicts host text.
      return fileViewerCanMount(viewer, fileViewerReadsSelf(viewer) ? false : input.loaded()) ? viewer : undefined
    },
    get fallback() {
      return input.defaultContent()
    },
    children: (entry) => {
      const surface = createExtensionSurface(input, entry)
      return input.wrapViewer?.(surface) ?? surface
    },
  })
}

// The extension viewer surface: scope root for the extension-kit CSS build,
// the viewer menu row, and the viewer component wired to the host bridge. The
// component instance is created through `Dynamic`, so it survives reactive
// prop changes; only a change of `entry().component` swaps it.
function createExtensionSurface(input: FileViewerContentInput, entry: Accessor<FileViewerEntry>): HTMLElement {
  const root = document.createElement("div")
  root.className = "oc-extension-root relative flex min-h-full flex-col"

  createRenderEffect(() => {
    root.setAttribute("data-file-viewer", entry().id)
  })
  createRenderEffect(() => {
    const owner = entry().owner
    if (owner === "builtin") root.removeAttribute("data-extension")
    else root.setAttribute("data-extension", owner)
  })

  const row = document.createElement("div")
  row.dataset.slot = "file-viewer-toolbar"
  row.className = "flex justify-end gap-2 border-b border-border-weak-base px-3 py-2"
  createRenderEffect(() => {
    // This is a host-owned row. Do not rely on extension CSS to hide it:
    // installed archive generations can lag behind the workspace viewer.
    const wls = entry().owner === "local.wls-repl"
    row.style.display = wls ? "none" : ""
    root.style.height = wls ? "100%" : ""
    root.style.minHeight = wls ? "0" : ""
    root.style.overflow = wls ? "hidden" : ""
    if (wls) console.info(`[file-viewer] WLS host layout pinned toolbar=hidden viewer=${entry().id}`)
  })
  const defaultToolbar = document.createElement("div")
  defaultToolbar.dataset.slot = "file-viewer-default-toolbar"
  const defaultControls = document.createElement("div")
  defaultControls.className = "flex items-center justify-end gap-2"
  insert(defaultControls, input.menu())
  insert(defaultControls, input.openWith())
  defaultToolbar.appendChild(defaultControls)
  const customToolbar = document.createElement("div")
  customToolbar.dataset.slot = "file-viewer-custom-toolbar"
  customToolbar.className = "min-w-0 flex-1"
  customToolbar.hidden = true
  row.append(defaultToolbar, customToolbar)
  root.appendChild(row)

  let toolbarToken: object | undefined
  let disposed = false
  const clearToolbar = () => {
    toolbarToken = undefined
    customToolbar.replaceChildren()
    customToolbar.hidden = true
    defaultToolbar.hidden = false
  }
  const setToolbar = (element: HTMLElement) => {
    if (disposed) return () => {}
    // Registration identity must not depend on the element: the same node
    // can be registered again while an earlier disposer is still alive.
    const token = {}
    toolbarToken = token
    customToolbar.replaceChildren(element)
    customToolbar.hidden = false
    defaultToolbar.hidden = true
    const off = () => {
      if (toolbarToken !== token) return
      clearToolbar()
    }
    if (getOwner()) onCleanup(off)
    return off
  }
  onCleanup(() => {
    disposed = true
    clearToolbar()
  })

  const boundary = createComponent(ViewerErrorBoundary, {
    get fallback() {
      return (error: unknown) => {
        // A failing onMount can register after the boundary's initial child
        // cleanup, so owner cleanup alone cannot restore the host controls.
        clearToolbar()
        // Keep the source/viewer switch available if the WLS viewer fails.
        row.style.display = ""
        const message = error instanceof Error ? error.message : String(error)
        input.onRenderError({ id: entry().id, path: input.path(), message })
        return input.errorFallback(message)
      }
    },
    // The viewer component must be created lazily inside the ErrorBoundary's
    // scope: an eager `children` value renders it before the boundary
    // registers, so a viewer that throws on setup would escape the fallback.
    get children() {
      return createComponent(Dynamic, {
        get component() {
          return entry().component
        },
        get file() {
          return input.file()
        },
        text: input.text,
        revision: input.revision,
        setDirty: input.setDirty,
        onSave: input.onSave,
        get setToolbar() {
          return setToolbar
        },
        readBytes: input.readBytes,
        readText: input.readText,
        showSource: input.showSource,
      })
    },
  })
  // Use multi-node insertion so boundary updates only replace their own
  // content, never the toolbar sibling already mounted in the root.
  insert(root, boundary, null)

  return root
}
