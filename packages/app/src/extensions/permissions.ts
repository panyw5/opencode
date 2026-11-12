// Declared extension permission vocabulary for the web host. The authoritative
// list is `PERMISSIONS` in packages/opencode/src/extension/schema.ts; this
// mirror is pinned by permissions.test.ts so the copies cannot drift from the
// server schema. Permissions are self-reported by extensions and are not
// enforced at runtime yet — unknown entries stay allowed and are marked in
// the UI instead of rejected.
export const EXTENSION_PERMISSIONS = [
  "fs:read",
  "fs:write",
  "process:spawn",
  "network",
  "tools",
  "settings:secret",
] as const

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number]

export function isKnownExtensionPermission(value: string) {
  return (EXTENSION_PERMISSIONS as readonly string[]).includes(value)
}
