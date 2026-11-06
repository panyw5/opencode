import type { Accessor, Component } from "solid-js"

export type Disposable = {
  dispose(): void
}

export type ExtensionFile = {
  path: string
  absolutePath: string
  directory: string
  name: string
  extension: string
}

export type FileViewerProps = {
  file: ExtensionFile
  text: Accessor<string | undefined>
  // Bumped on cached text refresh, or file invalidation for self-reading viewers.
  // Self-reading viewers may mount before text is available.
  revision?: Accessor<number>
  readBytes(): Promise<Uint8Array>
  readText(): Promise<string>
  // Replace-mode viewers may mark unsaved changes and register a save action.
  // Preview-mode hosts can omit these capabilities.
  setDirty?(dirty: boolean): void
  // The host hands out a bare disposer function, not a `Disposable` object
  // (see file-viewer-registry.ts `onSave`), so the returned value must be
  // called directly to unregister the handler.
  onSave?(handler: () => Promise<void>): () => void
  // Replaces the host toolbar until disposed or the registering owner cleans
  // up. An older disposer never clears a later registration.
  setToolbar?(element: HTMLElement): () => void
  showSource(): void
}

export type FileViewerContribution = {
  id: string
  component: Component<FileViewerProps>
}

export type CommandSource = "palette" | "keybind" | "slash" | "menu"

// Structural subset of the host tool part; the host passes its full tool part
// and props, extensions only rely on these fields.
export type ToolRendererPart = {
  tool: string
  state: { status?: string }
  input?: unknown
  metadata?: unknown
}

export type ToolRendererProps = {
  input: Record<string, any>
  metadata: Record<string, any>
  part?: ToolRendererPart
  tool: string
  output?: string
  status?: string
}

export type ToolHeightInput = {
  part: ToolRendererPart
  width: number
  viewportWidth?: number
  open: boolean
}

export type ToolRendererContribution = {
  tool: string
  component: Component<ToolRendererProps>
  estimateHeight?: (input: ToolHeightInput) => number
}

export type PanelProps = {
  state: Accessor<Record<string, string>>
  setState(patch: Record<string, string>): void
  close(): void
  directory: Accessor<string | undefined>
  sessionID: Accessor<string | undefined>
}

export type PanelContribution = {
  id: string
  component: Component<PanelProps>
}

export type CommandContribution = {
  id: string
  run(source?: CommandSource): void | Promise<void>
}

// Bridges to the extension's server part. Since the P2 contract the host
// always provides them: `rpc.call` reaches POST /extension/:id/rpc/:method,
// `events.on` receives the extension's `extension.event` payloads, and
// settings read/write the extension's global settings. Secret values are
// masked end to end; a patch never echoes a masked value back to the server.
export type ExtensionRpcOptions = {
  directory?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type ExtensionRpc = {
  call<T = unknown>(method: string, input?: unknown, options?: ExtensionRpcOptions): Promise<T>
}

export type ExtensionEvents = {
  on(name: string, listener: (data: unknown, meta: { directory?: string }) => void): Disposable
}

export type ExtensionSettings = {
  // Reactive read of the server-provided settings snapshot. Secret values are
  // always the mask placeholder; extensions never see plaintext.
  get<T = unknown>(key: string): Accessor<T | undefined>
  // Sends a partial patch (only the keys being changed). A `null` value
  // removes that key's stored value so the manifest default applies.
  update(patch: Record<string, unknown>): Promise<void>
}

export type ExtensionContext = {
  readonly id: string
  readonly version: string
  readonly fileViewers: {
    register(contribution: FileViewerContribution): Disposable
  }
  readonly toolRenderers: {
    register(contribution: ToolRendererContribution): Disposable
  }
  readonly panels: {
    register(contribution: PanelContribution): Disposable
  }
  readonly commands: {
    register(contribution: CommandContribution): Disposable
  }
  readonly assets: {
    url(relativePath: string): string
  }
  readonly log: {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  readonly rpc: ExtensionRpc
  readonly events: ExtensionEvents
  readonly settings: ExtensionSettings
}

export type WebExtension = {
  id: string
  apiVersion: 1
  activate(context: ExtensionContext): void | (() => void) | Promise<void | (() => void)>
}

export function defineWebExtension(extension: WebExtension): WebExtension {
  return extension
}
