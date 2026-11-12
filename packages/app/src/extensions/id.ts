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
