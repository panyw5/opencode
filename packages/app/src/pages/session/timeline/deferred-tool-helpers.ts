import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

const hydratedKeys = new Set<string>()

function normalizeTool(tool: string) {
  const name = tool.trim().toLowerCase() || "tool"
  if (name === "terminal") return "bash"
  if (name === "read_file") return "read"
  if (name === "web_search") return "websearch"
  return name
}

export function toolHydrationKey(sessionID: string, partID: string) {
  return `${sessionID}\n${partID}`
}

export function isToolPartHydrated(key: string) {
  return hydratedKeys.has(key)
}

export function markToolPartHydrated(key: string) {
  hydratedKeys.add(key)
}

export function clearToolPartHydration(sessionID?: string) {
  if (!sessionID) {
    hydratedKeys.clear()
    return
  }
  const prefix = `${sessionID}\n`
  for (const key of [...hydratedKeys]) {
    if (key.startsWith(prefix)) hydratedKeys.delete(key)
  }
}

/** Collapsed completed tools can use a same-height shell; live/open tools must render fully. */
export function shouldDeferToolPart(part: Part, defaultOpen?: boolean) {
  if (part.type !== "tool") return false
  if (defaultOpen) return false
  const status = part.state.status
  if (status === "pending" || status === "running") return false
  return true
}

export function toolPlaceholderCopy(part: ToolPart): { title: string; subtitle?: string } {
  const tool = normalizeTool(part.tool)
  const state = part.state
  const input = (state.status === "pending" ? {} : (state.input ?? {})) as Record<string, unknown>
  const title =
    (state.status === "completed" || state.status === "running" || state.status === "error"
      ? state.title?.trim()
      : undefined) || tool

  const keys = ["description", "command", "cmd", "filePath", "path", "query", "pattern", "name"]
  let subtitle: string | undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value !== "string") continue
    const next = value.trim()
    if (!next) continue
    subtitle = next.length > 72 ? `${next.slice(0, 69)}...` : next
    break
  }

  return { title, subtitle }
}

export function scheduleIdleHydrate(cb: () => void, timeout = 1200) {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => cb(), { timeout })
    return () => cancelIdleCallback(id)
  }
  const id = window.setTimeout(cb, 48)
  return () => clearTimeout(id)
}
