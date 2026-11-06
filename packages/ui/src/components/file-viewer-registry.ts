import { createSignal, type Accessor, type Component } from "solid-js"
import { getFilename } from "@opencode-ai/core/util/path"
import { normalizeMimeType } from "../pierre/media"

// Registry of file viewers that can take over (replace) a file tab or add a
// "preview" alongside the source view. Built-in viewers register at module
// scope; extensions register at runtime and must dispose on deactivate.

export type FileViewerMode = "replace" | "preview"

export type FileViewerTarget = {
  path: string
  name: string
  extension: string
  mime?: string
}

export type FileViewerFile = FileViewerTarget & {
  absolutePath: string
  directory: string
}

export type FileViewerProps = {
  file: FileViewerFile
  text: Accessor<string | undefined>
  // Host-observed content revision while the tab is mounted (0 initially).
  // Text-backed viewers observe host text reloads; self-owned replace viewers
  // observe external file changes without forcing the host to read text.
  // Preview-mode hosts may omit it.
  revision?: Accessor<number>
  readBytes(): Promise<Uint8Array>
  readText(): Promise<string>
  // Marks the tab's unsaved state. The host blocks closing a dirty tab until
  // it is saved. Wired for replace-mode tab viewers; preview hosts may omit it.
  setDirty?(dirty: boolean): void
  // Registers the tab's save action. The host runs it when the user saves the
  // active tab (Cmd+S) and clears the dirty flag after it completes. The
  // disposer removes exactly that handler; earlier handlers stay.
  onSave?(handler: () => Promise<void>): () => void
  // Replaces the host toolbar until disposed or the registering owner cleans
  // up. An older disposer never clears a later registration.
  setToolbar?(element: HTMLElement): () => void
  showSource(): void
}

export type FileViewerEntry = {
  id: string
  owner: string
  title: string
  mode: FileViewerMode
  // Only explicit self-owned replace viewers opt out of host text loading.
  // Omitted content preserves the existing host-provided text behavior.
  content?: "text" | "self"
  priority?: number
  extensions?: readonly string[]
  filenames?: readonly string[]
  mime?: readonly string[]
  test?: (target: FileViewerTarget) => boolean
  component: Component<FileViewerProps>
}

const [entries, setEntries] = createSignal<readonly FileViewerEntry[]>([])

export function fileViewerTarget(path: string, mime?: string): FileViewerTarget {
  const name = getFilename(path)
  const dot = name.lastIndexOf(".")
  return {
    path,
    name,
    extension: dot < 0 ? "" : name.slice(dot + 1).toLowerCase(),
    mime: normalizeMimeType(mime),
  }
}

function mimeMatches(pattern: string, mime: string) {
  const value = pattern.toLowerCase()
  if (value.endsWith("/*")) return mime.startsWith(value.slice(0, -1))
  return value === mime
}

function matches(entry: FileViewerEntry, target: FileViewerTarget) {
  if (target.extension && entry.extensions?.some((ext) => ext.toLowerCase() === target.extension)) return true
  if (entry.filenames?.includes(target.name)) return true
  const mime = target.mime
  if (mime && entry.mime?.some((pattern) => mimeMatches(pattern, mime))) return true
  if (!entry.test) return false
  try {
    return entry.test(target) === true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[file-viewer] test failed id=${entry.id} path=${target.path} error=${message}`)
    return false
  }
}

// Registrations stack so an activated extension can temporarily replace its
// manifest placeholder and reveal it again when the extension deactivates.
export function registerFileViewer(entry: FileViewerEntry): () => void {
  const previous = entries().find((item) => item.id === entry.id)
  setEntries((list) => [...list.filter((item) => item.id !== entry.id), entry])
  return () => {
    setEntries((list) => {
      if (!list.includes(entry)) return list
      const next = list.filter((item) => item !== entry)
      return previous ? [...next.filter((item) => item.id !== previous.id), previous] : next
    })
  }
}

// Matching viewers ordered by priority (highest first); ties keep registration order.
export function resolveFileViewers(target: FileViewerTarget): FileViewerEntry[] {
  return entries()
    .filter((entry) => matches(entry, target))
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

export const FileViewerRegistry = {
  register: registerFileViewer,
  resolve: resolveFileViewers,
  entries,
}

// --- Per-tab save state ------------------------------------------------------
// A viewer that lets the user edit the file in place needs a dirty flag and a
// save action that outlive the tab content component: switching tabs unmounts
// the active FileTabContent while the tab itself (and its unsaved edits) stays
// open. State is keyed by an opaque key the host composes from its session key
// and the tab value; the host disposes it when the tab closes.

export type FileViewerTabState = {
  dirty: Accessor<boolean>
  setDirty(value: boolean): void
  hasSave(): boolean
  // Runs the registered save handlers in registration order (a failing handler
  // aborts the run so later ones never see a half-saved file). Resolves true
  // when at least one handler ran, false when the tab has none.
  save(): Promise<boolean>
  onSave(handler: () => Promise<void>): () => void
}

const tabStates = new Map<string, FileViewerTabState>()
const dirtyVersions = new WeakMap<FileViewerTabState, number>()

export function fileViewerTabKey(sessionKey: string, tab: string) {
  return `${sessionKey}\n${tab}`
}

export function fileViewerTabState(key: string): FileViewerTabState {
  const existing = tabStates.get(key)
  if (existing) return existing

  const [dirty, setDirtySignal] = createSignal(false)
  const handlers: Array<() => Promise<void>> = []
  const state: FileViewerTabState = {
    dirty,
    setDirty(value) {
      dirtyVersions.set(state, (dirtyVersions.get(state) ?? 0) + 1)
      setDirtySignal(value)
    },
    hasSave() {
      return handlers.length > 0
    },
    async save() {
      if (handlers.length === 0) return false
      // Snapshot before running: a handler may register or dispose others.
      for (const handler of [...handlers]) await handler()
      return true
    },
    onSave(handler) {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index !== -1) handlers.splice(index, 1)
      }
    },
  }
  tabStates.set(key, state)
  return state
}

export function fileViewerTabDirty(key: string): boolean {
  return tabStates.get(key)?.dirty() ?? false
}

// Clear the dirty flag only if no new edit was reported during the async save.
export function saveFileViewerTab(key: string): Promise<boolean> {
  const state = tabStates.get(key)
  if (!state) return Promise.resolve(false)
  const version = dirtyVersions.get(state) ?? 0
  return state.save().then((handled) => {
    if (handled && (dirtyVersions.get(state) ?? 0) === version) state.setDirty(false)
    return handled
  })
}

export function disposeFileViewerTabState(key: string) {
  tabStates.delete(key)
}
