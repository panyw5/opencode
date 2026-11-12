// Canonical extension id shape for the web host. The authoritative literal is
// `ID_PATTERN` in packages/opencode/src/extension/schema.ts; this mirror is
// pinned byte-for-byte by id.test.ts so the app and extension-kit copies
// cannot drift from the server schema.
export const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

// `ExtensionID` in schema.ts caps the id at 64 characters on top of the pattern.
export const EXTENSION_ID_MAX = 64

export function isExtensionID(value: string) {
  return value.length <= EXTENSION_ID_MAX && EXTENSION_ID_PATTERN.test(value)
}

// Tool namespacing (D1): extension tools are exposed as `<ns>_<tool>` where ns
// is the id's last segment with `-` mapped to `_`. Mirrors the authoritative
// implementation in packages/opencode/src/extension/tools.ts — manifests and
// renderer contributions keep the unprefixed name; the host prefixes here.
export function extensionToolNamespace(id: string) {
  return id.slice(id.lastIndexOf(".") + 1).replaceAll("-", "_")
}

export function extensionToolName(id: string, tool: string) {
  return `${extensionToolNamespace(id)}_${tool}`
}

// Names a tool renderer should answer to: the namespaced name is canonical;
// the unprefixed name is kept as a legacy alias for one version so parts
// recorded before namespacing still resolve (see T2.1 deprecation logging).
export function extensionToolRendererNames(id: string, tool: string): { primary: string; legacy?: string } {
  const primary = extensionToolName(id, tool)
  return primary === tool ? { primary } : { primary, legacy: tool }
}
