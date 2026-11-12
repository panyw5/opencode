export type FileViewerContribution = {
  id: string
  title: string
  extensions?: string[]
  filenames?: string[]
  mime?: string[]
  priority?: number | string
  mode?: "replace" | "preview"
  content?: "text" | "self"
}

export type ToolRendererDeclaration = {
  tool: string
}

export type CommandDeclaration = {
  id: string
  title: string
  category?: string
  keybind?: string
  slash?: string
}

export type PanelDeclaration = {
  id: string
  title: string
  icon?: string
}

export type SettingDefinition = {
  type: "string" | "number" | "boolean"
  title: string
  description?: string
  default?: string | number | boolean
  enum?: Array<string | number>
  secret?: boolean
}

export type ExtensionInfo = {
  id: string
  version: string
  displayName: string
  name?: string
  source?:
    | { type: "path"; path: string }
    | { type: "npm"; spec: string; registry: string; integrity: string }
    | { type: "archive"; location: string; sha256: string }
    | {
        type: "release"
        descriptor: string
        extensionID: string
        version: string
        artifact: string
        sha256: string
        descriptorSha256: string
      }
  permissions?: string[]
  revision?: number
  installId?: string
  enabled: boolean
  state: "ready" | "disabled" | "error" | "incompatible"
  error?: string
  activation: string[]
  // User-facing settings snapshot from the server. Secret values arrive as
  // `SECRET_MASK`; the plaintext never crosses the API boundary.
  settings?: Record<string, unknown>
  contributes: {
    fileViewers?: FileViewerContribution[]
    toolRenderers?: ToolRendererDeclaration[]
    commands?: CommandDeclaration[]
    panels?: PanelDeclaration[]
    settings?: Record<string, SettingDefinition>
  }
  server?: {
    hasService: boolean
    hasInstanceHooks: boolean
    runtime: "idle" | "loading" | "ready" | "error" | "blocked"
    error?: string
    needsRestart: boolean
  }
  web?: { base: string; entry?: string; styles: string[]; apiVersion: 1 }
}

export type ExtensionStatusEvent = {
  type: "extension.status"
  properties: {
    id: string
    version: string
    state: "installed" | "enabled" | "disabled" | "error" | "blocked" | "changed" | "removed"
    error?: string
  }
}

export type Disposable = { dispose(): void }
