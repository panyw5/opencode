import type { PluginOption } from "vite"

export type ExtensionKitOptions = {
  entry?: string
  outDir?: string
  /** Explicit extension id used for CSS scoping; defaults to `opencode.id` from package.json. */
  scope?: string
}

export default function extensionKit(options?: ExtensionKitOptions): PluginOption[]
