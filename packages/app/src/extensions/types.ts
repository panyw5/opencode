export type FileViewerContribution = {
  id: string
  title: string
  extensions?: string[]
  filenames?: string[]
  mime?: string[]
  priority?: number | string
  mode?: "replace" | "preview"
}

export type ExtensionInfo = {
  id: string
  version: string
  displayName: string
  enabled: boolean
  state: "ready" | "disabled" | "error" | "incompatible"
  error?: string
  activation: string[]
  contributes: { fileViewers?: FileViewerContribution[] }
  web?: { base: string; entry: string; styles: string[]; apiVersion: 1 }
}

export type ExtensionStatusEvent = {
  type: "extension.status"
  properties: {
    id: string
    version: string
    state: "installed" | "enabled" | "disabled" | "error" | "changed"
    error?: string
  }
}

export type Disposable = { dispose(): void }
