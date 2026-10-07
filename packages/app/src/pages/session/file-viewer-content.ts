import {
  ErrorBoundary,
  Show,
  createComponent,
  createRenderEffect,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js"
import { Dynamic, insert } from "solid-js/web"
import type { FileViewerEntry, FileViewerFile } from "@opencode-ai/ui/file-viewer-registry"

// Render boundary for a file tab's extension viewer: the Show that picks
// between a registered replace-mode extension viewer and the default source
// view, plus the extension viewer surface (scope root, menu row, host bridge).
//
// The host must invoke this inside its loaded render branch, so the viewer
// mounts only once the file content exists and remounts on branch flips
// exactly like the previous inline implementation.
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
  // Default source view element. Invoked inside the Show fallback scope, so
  // its reactive reads only ever rebuild the source view itself.
  defaultContent: () => JSX.Element
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
      return input.activeViewer()
    },
    get fallback() {
      return input.defaultContent()
    },
    children: (entry) => createExtensionSurface(input, entry),
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
  row.className = "flex justify-end gap-2 border-b border-border-weak-base px-3 py-2"
  insert(row, input.menu())
  insert(row, input.openWith())
  root.appendChild(row)

  const boundary = createComponent(ViewerErrorBoundary, {
    get fallback() {
      return (error: unknown) => {
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
        readBytes: input.readBytes,
        readText: input.readText,
        showSource: input.showSource,
      })
    },
  })
  insert(root, boundary)

  return root
}
