function text(value: unknown) {
  if (typeof value !== "string") return
  const next = value.trim()
  if (!next) return
  return next
}

export function normalizeTool(tool: string) {
  const name = text(tool)?.toLowerCase() ?? "tool"
  if (name === "terminal") return "bash"
  if (name === "read_file") return "read"
  if (name === "web_search") return "websearch"
  return name
}

export function hookName(input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const keys = ["hook", "hook_name", "hookName"]
  for (const src of [metadata, input]) {
    for (const key of keys) {
      const value = text(src?.[key])
      if (value) return value
    }
  }
}

function hookType(input: Record<string, unknown>, metadata: Record<string, unknown>) {
  for (const src of [metadata, input]) {
    const value = text(src.hook_type) ?? text(src.hookType)
    if (value) return value
  }
}

export function isCustomHookTool(tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const name = normalizeTool(tool)
  if (name === "hook") return true
  if (name !== "bash") return false

  // Older sessions persisted hooks as bash calls. Require both explicit hook
  // fields so ordinary shell metadata can never affect timeline visibility.
  return !!hookName(input, metadata) && !!hookType(input, metadata)
}
