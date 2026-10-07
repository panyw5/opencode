import type { ExtensionInfo } from "@/extensions/types"

const PREFIX = "extension:"

export function extensionPick(id: string) {
  return `${PREFIX}${id}`
}

export function parseExtensionPick(pick: string) {
  if (!pick.startsWith(PREFIX)) return
  const id = pick.slice(PREFIX.length)
  return id || undefined
}

export function extensionSelection(items: readonly ExtensionInfo[], pick: string) {
  if (items.length === 0) return parseExtensionPick(pick) ? pick : ""
  const id = parseExtensionPick(pick)
  return extensionPick(items.find((item) => item.id === id)?.id ?? items[0].id)
}

export function extensionSelectionKey(items: readonly ExtensionInfo[]) {
  return JSON.stringify(items.map((item) => item.id))
}
