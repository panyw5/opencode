import { runWithOwner, type Component, type Owner } from "solid-js"
import type { FileViewerProps } from "@opencode-ai/ui/file-viewer-registry"
import type { ExtensionInfo } from "./types"
import type { Disposable } from "./types"

export type FileViewerContribution = {
  id: string
  component: Component<FileViewerProps>
}

export type WebExtensionContext = {
  readonly id: string
  readonly version: string
  readonly fileViewers: { register(contribution: FileViewerContribution): Disposable }
  readonly assets: { url(relativePath: string): string }
  readonly log: Record<"debug" | "info" | "warn" | "error", (message: string) => void>
}

export type ContextDeps = {
  manifest: ExtensionInfo
  owner: Owner
  valid(): boolean
  subscriptions: Disposable[]
  registerViewer(contribution: FileViewerContribution): () => void
}

export function extensionViewerID(extensionID: string, viewerID: string) {
  return `ext.${extensionID}.${viewerID}`
}

export function declaredViewer(manifest: ExtensionInfo, id: string) {
  return manifest.contributes.fileViewers?.find((viewer) => viewer.id === id)
}

export function makeExtensionContext(deps: ContextDeps): WebExtensionContext {
  const add = (dispose: () => void) => {
    const item = { dispose }
    deps.subscriptions.push(item)
    return item
  }

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    console[level](`[ext:${deps.manifest.id}] ${message}`)
  }

  return {
    id: deps.manifest.id,
    version: deps.manifest.version,
    fileViewers: {
      register(contribution) {
        if (!deps.valid()) throw new Error(`Extension activation is stale: ${deps.manifest.id}`)
        if (!declaredViewer(deps.manifest, contribution.id)) {
          throw new Error(`Extension registered undeclared file viewer: ${contribution.id}`)
        }
        const dispose = runWithOwner(deps.owner, () => deps.registerViewer(contribution))
        if (!dispose) throw new Error(`Extension viewer registration failed: ${deps.manifest.id}`)
        return add(dispose)
      },
    },
    assets: {
      url(relativePath) {
        const base = deps.manifest.web?.base
        if (!base) throw new Error(`Extension has no web asset base: ${deps.manifest.id}`)
        const url = new URL(relativePath.replace(/^\/+/, ""), base)
        if (url.origin !== new URL(base).origin) {
          throw new Error(`Extension asset origin mismatch: ${deps.manifest.id}`)
        }
        return url.href
      },
    },
    log: {
      debug: (message) => log("debug", message),
      info: (message) => log("info", message),
      warn: (message) => log("warn", message),
      error: (message) => log("error", message),
    },
  }
}
