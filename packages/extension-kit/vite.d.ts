import type { PluginOption } from "vite"

export type ExtensionKitOptions = {
  entry?: string
  outDir?: string
}

export default function extensionKit(options?: ExtensionKitOptions): PluginOption[]
