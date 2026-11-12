import type { ExtensionInfo } from "./types"

export function extensionRuntimeState(item: ExtensionInfo): ExtensionInfo["state"] | "blocked" {
  if (item.server?.needsRestart || item.server?.runtime === "blocked") return "blocked"
  if (item.server?.runtime === "error") return "error"
  return item.state
}

export function extensionRuntimeRetryable(item: ExtensionInfo) {
  return item.enabled && item.state === "ready" && item.server?.runtime === "error" && !item.server.needsRestart
}
