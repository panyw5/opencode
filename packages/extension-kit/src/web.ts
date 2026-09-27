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
  readBytes(): Promise<Uint8Array>
  readText(): Promise<string>
  showSource(): void
}

export type FileViewerContribution = {
  id: string
  component: Component<FileViewerProps>
}

export type ExtensionContext = {
  readonly id: string
  readonly version: string
  readonly fileViewers: {
    register(contribution: FileViewerContribution): Disposable
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
}

export type WebExtension = {
  id: string
  apiVersion: 1
  activate(context: ExtensionContext): void | (() => void) | Promise<void | (() => void)>
}

export function defineWebExtension(extension: WebExtension): WebExtension {
  return extension
}
