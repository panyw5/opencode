import { createSignal, type Component } from "solid-js"
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

export type FileViewerProps = {
  path: string
  text: string | undefined
}

export type FileViewerEntry = {
  id: string
  owner: string
  title: string
  mode: FileViewerMode
  priority?: number
  extensions?: readonly string[]
  filenames?: readonly string[]
  mime?: readonly string[]
  test?: (target: FileViewerTarget) => boolean
  component: Component<FileViewerProps>
}

const [entries, setEntries] = createSignal<readonly FileViewerEntry[]>([])

export function fileViewerTarget(path: string, mime?: string): FileViewerTarget {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const name = index < 0 ? path : path.slice(index + 1)
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

export function registerFileViewer(entry: FileViewerEntry): () => void {
  setEntries((list) => [...list.filter((item) => item.id !== entry.id), entry])
  return () => setEntries((list) => list.filter((item) => item !== entry))
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
