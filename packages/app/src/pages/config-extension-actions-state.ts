import type { ExtensionInfo } from "@/extensions/types"

export function extensionToggleBlocked(input: {
  item: ExtensionInfo
  enabled: boolean
  busy: boolean
  dirty: boolean
  saving: boolean
}) {
  if (!input.enabled) return "safe-mode" as const
  if (input.busy || input.saving) return "busy" as const
  if (input.dirty) return "dirty" as const
  if (!input.item.enabled && input.item.state === "incompatible") return "incompatible" as const
}
