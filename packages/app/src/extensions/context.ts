import { runWithOwner, type Accessor, type Component, type Owner } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { ToolProps } from "@opencode-ai/ui/message-part"
import type { FileViewerProps } from "@opencode-ai/ui/file-viewer-registry"
import type { ExtensionPanelProps } from "./panel-registry"
import type { ExtensionInfo } from "./types"
import type { Disposable } from "./types"

export type FileViewerContribution = {
  id: string
  component: Component<FileViewerProps>
}

export type ExtensionCommandSource = "palette" | "keybind" | "slash" | "menu"

export type ToolRendererContribution = {
  tool: string
  component: Component<ToolProps>
  estimateHeight?: (input: { part: ToolPart; width: number; viewportWidth?: number; open: boolean }) => number
}

export type PanelContribution = {
  id: string
  component: Component<ExtensionPanelProps>
}

export type CommandContribution = {
  id: string
  run(source?: ExtensionCommandSource): void | Promise<void>
}

export type WebExtensionContext = {
  readonly id: string
  readonly version: string
  readonly fileViewers: { register(contribution: FileViewerContribution): Disposable }
  readonly toolRenderers: { register(contribution: ToolRendererContribution): Disposable }
  readonly panels: { register(contribution: PanelContribution): Disposable }
  readonly commands: { register(contribution: CommandContribution): Disposable }
  readonly assets: { url(relativePath: string): string }
  readonly log: Record<"debug" | "info" | "warn" | "error", (message: string) => void>
  // Bridge to the extension's server part. The host supplies the transport,
  // auth and event stream; see specs/extensions design.md §5.4-§5.6.
  readonly rpc: {
    call<T = unknown>(
      method: string,
      input?: unknown,
      options?: { directory?: string; signal?: AbortSignal; timeoutMs?: number },
    ): Promise<T>
  }
  readonly events: {
    on(name: string, listener: (data: unknown, meta: { directory?: string }) => void): Disposable
  }
  readonly settings: {
    // Reads the server-provided settings snapshot. Secret values are always
    // the mask; extensions never see plaintext.
    get<T = unknown>(key: string): Accessor<T | undefined>
    // Sends a partial patch. Keys whose value is the secret mask are stripped
    // before the request, so an unchanged masked value is never echoed back.
    update(patch: Record<string, unknown>): Promise<void>
  }
}

export type ContextDeps = {
  manifest: ExtensionInfo
  owner: Owner
  valid(): boolean
  subscriptions: Disposable[]
  registerViewer(contribution: FileViewerContribution): () => void
  registerToolRenderer(contribution: ToolRendererContribution): () => void
  registerPanel(contribution: PanelContribution): () => void
  registerCommand(contribution: CommandContribution): () => void
  callRpc(input: {
    method: string
    input?: unknown
    directory?: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<unknown>
  listenEvents(name: string, listener: (data: unknown, meta: { directory?: string }) => void): () => void
  readSetting(key: string): unknown
  updateSettings(patch: Record<string, unknown>): Promise<void>
}

export function extensionViewerID(extensionID: string, viewerID: string) {
  return `ext.${extensionID}.${viewerID}`
}

export function extensionCommandID(extensionID: string, commandID: string) {
  return `ext.${extensionID}.${commandID}`
}

export function declaredViewer(manifest: ExtensionInfo, id: string) {
  return manifest.contributes.fileViewers?.find((viewer) => viewer.id === id)
}

export function declaredToolRenderer(manifest: ExtensionInfo, tool: string) {
  return manifest.contributes.toolRenderers?.find((renderer) => renderer.tool === tool)
}

export function declaredPanel(manifest: ExtensionInfo, id: string) {
  return manifest.contributes.panels?.find((panel) => panel.id === id)
}

export function declaredCommand(manifest: ExtensionInfo, id: string) {
  return manifest.contributes.commands?.find((command) => command.id === id)
}

export function makeExtensionContext(deps: ContextDeps): WebExtensionContext {
  const add = (dispose: () => void) => {
    let disposed = false
    const item = {
      dispose() {
        if (disposed) return
        disposed = true
        dispose()
      },
    }
    deps.subscriptions.push(item)
    return item
  }

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    console[level](`[ext:${deps.manifest.id}] ${message}`)
  }

  const registerDeclared = (
    guard: () => boolean,
    undeclared: string,
    failed: string,
    register: () => () => void,
  ) => {
    if (!deps.valid()) throw new Error(`Extension activation is stale: ${deps.manifest.id}`)
    if (!guard()) throw new Error(undeclared)
    const dispose = runWithOwner(deps.owner, register)
    if (!dispose) throw new Error(failed)
    return add(dispose)
  }

  return {
    id: deps.manifest.id,
    version: deps.manifest.version,
    fileViewers: {
      register(contribution) {
        return registerDeclared(
          () => !!declaredViewer(deps.manifest, contribution.id),
          `Extension registered undeclared file viewer: ${contribution.id}`,
          `Extension viewer registration failed: ${deps.manifest.id}`,
          () => deps.registerViewer(contribution),
        )
      },
    },
    toolRenderers: {
      register(contribution) {
        return registerDeclared(
          () => !!declaredToolRenderer(deps.manifest, contribution.tool),
          `Extension registered undeclared tool renderer: ${contribution.tool}`,
          `Extension tool renderer registration failed: ${deps.manifest.id}`,
          () => deps.registerToolRenderer(contribution),
        )
      },
    },
    panels: {
      register(contribution) {
        return registerDeclared(
          () => !!declaredPanel(deps.manifest, contribution.id),
          `Extension registered undeclared panel: ${contribution.id}`,
          `Extension panel registration failed: ${deps.manifest.id}`,
          () => deps.registerPanel(contribution),
        )
      },
    },
    commands: {
      register(contribution) {
        return registerDeclared(
          () => !!declaredCommand(deps.manifest, contribution.id),
          `Extension registered undeclared command: ${contribution.id}`,
          `Extension command registration failed: ${deps.manifest.id}`,
          () => deps.registerCommand(contribution),
        )
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
    rpc: {
      call<T>(method: string, input?: unknown, options?: { directory?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
        return deps.callRpc({
          method,
          input,
          directory: options?.directory,
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
        }) as Promise<T>
      },
    },
    events: {
      on(name, listener) {
        // Registering an event listener allocates host state, so it must not
        // outlive the activation that created it.
        if (!deps.valid()) throw new Error(`Extension activation is stale: ${deps.manifest.id}`)
        return add(deps.listenEvents(name, listener))
      },
    },
    settings: {
      // A plain accessor over the host's settings snapshot: it reads the
      // reactive sources on every call, so consumers stay live in the client
      // build without requiring a memo owner at creation time.
      get<T>(key: string): Accessor<T | undefined> {
        return () => deps.readSetting(key) as T | undefined
      },
      update(patch) {
        return deps.updateSettings(patch)
      },
    },
  }
}
