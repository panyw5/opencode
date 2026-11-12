/**
 * Public tool names for extension-provided tools (decision D1). Extension
 * hooks keep their manifest-declared names; the ToolRegistry exposes each one
 * as `<ns>_<tool>` where `ns` is the extension id's last segment with `-`
 * mapped to `_` (extension ids disallow `_`, so the mapping is stable and
 * collision-detectable). The web host mirrors this derivation in
 * `packages/app/src/extensions/id.ts`; keep them in sync.
 */
export function extensionToolNamespace(id: string) {
  return id.slice(id.lastIndexOf(".") + 1).replaceAll("-", "_")
}

/** Namespaced name an extension tool is registered under in the ToolRegistry. */
export function extensionToolName(id: string, tool: string) {
  return `${extensionToolNamespace(id)}_${tool}`
}

export * as ExtensionTools from "./tools"
