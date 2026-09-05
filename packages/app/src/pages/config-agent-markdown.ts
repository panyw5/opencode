export const AGENT_PERMISSION_ACTIONS = ["allow", "ask", "deny"] as const
export type AgentPermissionAction = (typeof AGENT_PERMISSION_ACTIONS)[number]

export const KNOWN_AGENT_PERMISSION_KEYS = new Set([
  "*",
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "project_task_create",
  "project_task_list",
  "project_task_get",
  "project_task_mount",
  "project_task_update",
  "scheduled_task_create",
  "scheduled_task_list",
  "scheduled_task_get",
  "scheduled_task_update",
  "scheduled_task_delete",
  "scheduled_task_run_now",
  "scheduled_task_runs",
  "question",
  "webfetch",
  "websearch",
  "codesearch",
  "codex_consult",
  "claude_consult",
  "grok_consult",
  "dsh_consult",
  "repo_clone",
  "repo_overview",
  "lsp",
  "doom_loop",
  "skill",
  "plan_enter",
  "plan_exit",
])

export type AgentPermissionCapsule = {
  id: string
  permission: string
  pattern?: string
  action: string
  known: boolean
  validAction: boolean
}

export type ParsedAgentMarkdown = {
  hasFrontmatter: boolean
  model?: string
  mode?: string
  permissions: AgentPermissionCapsule[]
}

const FRONTMATTER_RE = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n|$)/

export function isAgentPermissionAction(value: string): value is AgentPermissionAction {
  return (AGENT_PERMISSION_ACTIONS as readonly string[]).includes(value)
}

export function parseAgentMarkdown(text: string): ParsedAgentMarkdown {
  const hit = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!hit) return { hasFrontmatter: false, permissions: [] }

  const data = parseYamlMap(hit[1], 0)
  const model = scalar(data.model)
  const mode = scalar(data.mode)
  return {
    hasFrontmatter: true,
    model: model || undefined,
    mode: mode || undefined,
    permissions: permissionCapsules(data.permission, data.tools),
  }
}

export function upsertAgentMarkdownModel(text: string, model: string | undefined): string {
  const nextModel = model?.trim() || undefined
  const formatted = nextModel ? formatYamlScalar(nextModel) : undefined
  const hit = text.match(FRONTMATTER_RE)
  if (!hit) {
    if (!formatted) return text
    const nl = newlineOf(text)
    const prefix = text.length > 0 ? `${nl}${nl}` : nl
    return `---${nl}model: ${formatted}${nl}---${prefix}${text}`
  }

  const nl = hit[1] || newlineOf(text)
  const lines = hit[2].split(/\r?\n/)
  const nextLines: string[] = []
  let found = false
  for (const line of lines) {
    if (/^model:[ \t]*/.test(line)) {
      found = true
      if (formatted) nextLines.push(`model: ${formatted}`)
      continue
    }
    nextLines.push(line)
  }
  if (!found && formatted) {
    let insertAt = 0
    while (insertAt < nextLines.length && !nextLines[insertAt]!.trim()) insertAt++
    nextLines.splice(insertAt, 0, `model: ${formatted}`)
  }

  const nextBlock = nextLines.join(nl)
  if (!nextBlock.trim()) {
    return text.slice(hit[0].length)
  }
  return `---${hit[1]}${nextBlock}${hit[3]}---${hit[4]}${text.slice(hit[0].length)}`
}

export function formatYamlScalar(value: string) {
  if (!value) return '""'
  if (/^(true|false|null|~)$/i.test(value)) return JSON.stringify(value)
  if (/[\s:#{}[\],&*!|>'"%@`]/.test(value)) return JSON.stringify(value)
  return value
}

function newlineOf(text: string) {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function scalar(value: unknown) {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function permissionCapsules(permission: unknown, tools: unknown): AgentPermissionCapsule[] {
  const merged: Record<string, unknown> = { ...fromTools(tools), ...fromPermission(permission) }
  const capsules: AgentPermissionCapsule[] = []
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(merged)) {
    pushCapsules(capsules, seen, key, value)
  }
  return capsules
}

function fromPermission(permission: unknown): Record<string, unknown> {
  if (typeof permission === "string") return { "*": permission.trim() }
  if (permission && typeof permission === "object" && !Array.isArray(permission)) {
    return permission as Record<string, unknown>
  }
  return {}
}

function fromTools(tools: unknown): Record<string, unknown> {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return {}
  const out: Record<string, unknown> = {}
  for (const [tool, enabled] of Object.entries(tools as Record<string, unknown>)) {
    const on = enabled === true || enabled === "true" || enabled === "allow"
    const action = on ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      out.edit = action
      continue
    }
    out[tool] = action
  }
  return out
}

function pushCapsules(capsules: AgentPermissionCapsule[], seen: Set<string>, permission: string, value: unknown) {
  if (typeof value === "string") {
    capsules.push(makeCapsule(seen, permission, undefined, value))
    return
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
      capsules.push(makeCapsule(seen, permission, pattern, typeof action === "string" ? action : String(action ?? "")))
    }
    return
  }
  if (value == null || value === "") return
  capsules.push(makeCapsule(seen, permission, undefined, String(value)))
}

function makeCapsule(seen: Set<string>, permission: string, pattern: string | undefined, action: string): AgentPermissionCapsule {
  const trimmedAction = action.trim()
  const normalizedPattern = pattern?.trim()
  const displayPattern = !normalizedPattern || normalizedPattern === "*" ? undefined : normalizedPattern
  const base = `${permission}:${displayPattern ?? "*"}:${trimmedAction}`
  let id = base
  let n = 1
  while (seen.has(id)) {
    n += 1
    id = `${base}#${n}`
  }
  seen.add(id)
  return {
    id,
    permission,
    pattern: displayPattern,
    action: trimmedAction,
    known: KNOWN_AGENT_PERMISSION_KEYS.has(permission),
    validAction: isAgentPermissionAction(trimmedAction),
  }
}

function parseYamlMap(block: string, minIndent: number): Record<string, unknown> {
  const lines = block.split(/\r?\n/)
  return parseMapLines(lines, { index: 0 }, minIndent)
}

function parseMapLines(
  lines: string[],
  cursor: { index: number },
  minIndent: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let mapIndent: number | undefined

  while (cursor.index < lines.length) {
    skipBlankLines(lines, cursor)
    if (cursor.index >= lines.length) break

    const line = lines[cursor.index]!
    const indent = lineIndent(line)
    if (mapIndent === undefined) {
      if (indent < minIndent) break
      mapIndent = indent
    } else if (indent < mapIndent) {
      break
    } else if (indent > mapIndent) {
      cursor.index += 1
      continue
    }

    const parsed = parseKeyedLine(line.slice(indent))
    if (!parsed) {
      cursor.index += 1
      continue
    }
    cursor.index += 1

    if (parsed.block) {
      result[parsed.key] = parseBlockScalar(lines, cursor, mapIndent, parsed.block)
      continue
    }
    if (parsed.hasValue) {
      result[parsed.key] = parsed.value
      continue
    }

    skipBlankLines(lines, cursor)
    const next = lines[cursor.index]
    if (next !== undefined && lineIndent(next) > mapIndent) {
      result[parsed.key] = next.trimStart().startsWith("- ")
        ? parseListLines(lines, cursor, mapIndent)
        : parseMapLines(lines, cursor, mapIndent + 1)
      continue
    }
    result[parsed.key] = ""
  }

  return result
}

function parseListLines(lines: string[], cursor: { index: number }, parentIndent: number): unknown[] {
  const result: unknown[] = []
  while (cursor.index < lines.length) {
    skipBlankLines(lines, cursor)
    if (cursor.index >= lines.length) break
    const line = lines[cursor.index]!
    const indent = lineIndent(line)
    if (indent <= parentIndent) break
    const trimmed = line.slice(indent)
    if (!trimmed.startsWith("- ")) break
    cursor.index += 1
    const rest = trimmed.slice(2).trim()
    if (!rest) {
      skipBlankLines(lines, cursor)
      const next = lines[cursor.index]
      if (next !== undefined && lineIndent(next) > indent) {
        result.push(parseMapLines(lines, cursor, indent + 1))
        continue
      }
      result.push("")
      continue
    }
    result.push(parseInlineValue(rest))
  }
  return result
}

function parseBlockScalar(
  lines: string[],
  cursor: { index: number },
  parentIndent: number,
  style: "|" | ">",
): string {
  const blockLines: string[] = []
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]!
    if (!line.trim()) {
      blockLines.push("")
      cursor.index += 1
      continue
    }
    if (lineIndent(line) <= parentIndent) break
    blockLines.push(line)
    cursor.index += 1
  }
  const nonempty = blockLines.filter((line) => line.trim())
  const indent = nonempty.length ? Math.min(...nonempty.map(lineIndent)) : 0
  const text = blockLines.map((line) => line.slice(Math.min(indent, line.length))).join(style === ">" ? " " : "\n")
  return cleanScalar(text)
}

function parseKeyedLine(trimmed: string):
  | { key: string; hasValue: true; value: unknown; block?: undefined }
  | { key: string; hasValue: false; value?: undefined; block?: "|" | ">" }
  | undefined {
  const parsed = splitKeyedLine(trimmed)
  if (!parsed) return
  const raw = parsed.rest
  if (!raw) return { key: parsed.key, hasValue: false }
  const block = raw.match(/^([|>])[-+]?$/)
  if (block) return { key: parsed.key, hasValue: false, block: block[1] as "|" | ">" }
  return { key: parsed.key, hasValue: true, value: parseInlineValue(stripInlineComment(raw)) }
}

function splitKeyedLine(trimmed: string): { key: string; rest: string } | undefined {
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) return
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quoted = parseQuoted(trimmed, 0)
    const after = trimmed.slice(quoted.next)
    const colon = after.match(/^\s*:/)
    if (!colon) return
    return { key: quoted.value, rest: after.slice(colon[0].length).trim() }
  }
  const match = trimmed.match(/^([A-Za-z0-9_.*?/~-]+)\s*:(?:\s*(.*))?$/)
  if (!match) return
  return { key: match[1]!, rest: (match[2] ?? "").trim() }
}

function parseInlineValue(raw: string): unknown {
  const value = raw.trim()
  if (!value) return ""
  if (value.startsWith("{") || value.startsWith("[")) {
    const parsed = parseFlow(value, 0)
    if (parsed) return parsed.value
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    return parseQuoted(value, 0).value
  }
  return unquoteScalar(value)
}

function parseFlow(input: string, start: number): { value: unknown; next: number } | undefined {
  let i = skipSpace(input, start)
  if (input[i] === "{") return parseFlowMap(input, i)
  if (input[i] === "[") return parseFlowSeq(input, i)
  return
}

function parseFlowMap(input: string, start: number): { value: Record<string, unknown>; next: number } {
  const result: Record<string, unknown> = {}
  let i = start + 1
  while (i < input.length) {
    i = skipSpace(input, i)
    if (input[i] === "}") return { value: result, next: i + 1 }
    if (input[i] === ",") {
      i += 1
      continue
    }
    const key = parseFlowKey(input, i)
    i = skipSpace(input, key.next)
    if (input[i] !== ":") {
      result[key.value] = ""
      continue
    }
    i = skipSpace(input, i + 1)
    const value = parseFlowItem(input, i)
    result[key.value] = value.value
    i = skipSpace(input, value.next)
    if (input[i] === ",") i += 1
  }
  return { value: result, next: i }
}

function parseFlowSeq(input: string, start: number): { value: unknown[]; next: number } {
  const result: unknown[] = []
  let i = start + 1
  while (i < input.length) {
    i = skipSpace(input, i)
    if (input[i] === "]") return { value: result, next: i + 1 }
    if (input[i] === ",") {
      i += 1
      continue
    }
    const value = parseFlowItem(input, i)
    result.push(value.value)
    i = skipSpace(input, value.next)
    if (input[i] === ",") i += 1
  }
  return { value: result, next: i }
}

function parseFlowKey(input: string, start: number): { value: string; next: number } {
  const i = skipSpace(input, start)
  if (input[i] === '"' || input[i] === "'") return parseQuoted(input, i)
  let j = i
  while (j < input.length && input[j] !== ":" && input[j] !== "," && input[j] !== "}" && input[j] !== "]") j++
  return { value: input.slice(i, j).trim(), next: j }
}

function parseFlowItem(input: string, start: number): { value: unknown; next: number } {
  const i = skipSpace(input, start)
  if (input[i] === "{") return parseFlowMap(input, i)
  if (input[i] === "[") return parseFlowSeq(input, i)
  if (input[i] === '"' || input[i] === "'") return parseQuoted(input, i)
  let j = i
  while (j < input.length && input[j] !== "," && input[j] !== "}" && input[j] !== "]") j++
  return { value: unquoteScalar(input.slice(i, j).trim()), next: j }
}

function parseQuoted(input: string, start: number): { value: string; next: number } {
  const quote = input[start]
  if (quote === "'") {
    let i = start + 1
    let out = ""
    while (i < input.length) {
      if (input[i] === "'" && input[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      if (input[i] === "'") return { value: out, next: i + 1 }
      out += input[i]
      i += 1
    }
    return { value: out, next: i }
  }

  let i = start + 1
  let out = ""
  while (i < input.length) {
    if (input[i] === "\\") {
      const next = input[i + 1]
      if (next === "n") out += "\n"
      else if (next === "t") out += "\t"
      else if (next) out += next
      i += 2
      continue
    }
    if (input[i] === '"') return { value: out, next: i + 1 }
    out += input[i]
    i += 1
  }
  return { value: out, next: i }
}

function skipBlankLines(lines: string[], cursor: { index: number }) {
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      cursor.index += 1
      continue
    }
    break
  }
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0].length ?? 0
}

function skipSpace(input: string, start: number) {
  let i = start
  while (i < input.length && (input[i] === " " || input[i] === "\t" || input[i] === "\n" || input[i] === "\r")) i++
  return i
}

function stripInlineComment(value: string) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || value[i - 1] === " ")) {
      return value.slice(0, i).trim()
    }
  }
  return value
}

function unquoteScalar(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return parseQuoted(trimmed, 0).value
  }
  return cleanScalar(trimmed)
}

function cleanScalar(value: string) {
  return value.replace(/\s+/g, " ").trim()
}
