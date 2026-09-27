import * as Solid from "solid-js"
import * as SolidWeb from "solid-js/web"
import * as SolidStore from "solid-js/store"
import * as Button from "@opencode-ai/ui/button"
import * as Spinner from "@opencode-ai/ui/spinner"

export type ExtensionHostModules = {
  apiVersion: 1
  versions: { "solid-js": string; opencode?: string }
  modules: Record<string, Record<string, unknown>>
}

export function installExtensionHostModules(opencodeVersion?: string) {
  const host: ExtensionHostModules = {
    apiVersion: 1,
    versions: { "solid-js": "1.9.10", opencode: opencodeVersion },
    modules: {
      "solid-js": Solid,
      "solid-js/web": SolidWeb,
      "solid-js/store": SolidStore,
      "@opencode-ai/ui/button": Button,
      "@opencode-ai/ui/spinner": Spinner,
    },
  }
  ;(globalThis as typeof globalThis & { __OPENCODE_EXTENSION_HOST__?: ExtensionHostModules }).__OPENCODE_EXTENSION_HOST__ = host
  return host
}
