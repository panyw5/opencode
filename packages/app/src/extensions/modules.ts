import * as Solid from "solid-js"
import * as SolidWeb from "solid-js/web"
import * as SolidStore from "solid-js/store"
import * as Button from "@opencode-ai/ui/button"
import * as Spinner from "@opencode-ai/ui/spinner"
import solidPackage from "solid-js/package.json"

export type ExtensionHostModules = {
  apiVersion: 1
  versions: { "solid-js": string; opencode?: string }
  modules: Record<string, Record<string, unknown>>
}

// The shared solid-js build the host bundles, read at build time via Vite's
// JSON import so the declared version can never drift from the real modules.
export const HOST_SOLID_VERSION: string = solidPackage.version

export function installExtensionHostModules(opencodeVersion?: string) {
  const global = globalThis as typeof globalThis & { __OPENCODE_EXTENSION_HOST__?: ExtensionHostModules }
  // A previously installed host is non-configurable by design; later calls
  // reuse it instead of swapping the module surface extensions already saw.
  const existing = Object.getOwnPropertyDescriptor(global, "__OPENCODE_EXTENSION_HOST__")
  if (existing && !existing.configurable) {
    const current = global.__OPENCODE_EXTENSION_HOST__
    if (current) return current
  }
  const host: ExtensionHostModules = {
    apiVersion: 1,
    versions: { "solid-js": HOST_SOLID_VERSION, opencode: opencodeVersion },
    modules: {
      "solid-js": Solid,
      "solid-js/web": SolidWeb,
      "solid-js/store": SolidStore,
      "@opencode-ai/ui/button": Button,
      "@opencode-ai/ui/spinner": Spinner,
    },
  }
  // Freeze before publishing: an extension that loads first must not be able
  // to replace or mutate the modules later extensions receive. Real ES module
  // namespace objects reject Object.freeze (their bindings are non-configurable
  // live bindings) but already refuse writes, so a TypeError just means the
  // module is intrinsically immutable.
  for (const mod of Object.values(host.modules)) {
    try {
      Object.freeze(mod)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
  }
  Object.freeze(host.modules)
  Object.freeze(host.versions)
  Object.freeze(host)
  Object.defineProperty(global, "__OPENCODE_EXTENSION_HOST__", {
    value: host,
    writable: false,
    configurable: false,
    enumerable: true,
  })
  return host
}
