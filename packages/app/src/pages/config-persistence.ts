import type { Config } from "@opencode-ai/sdk/v2/client"
import { applyEdits, modify, parse } from "jsonc-parser"

export type ProjectConfigRecord = {
  file: {
    label: string
    path: string
  }
  text: string
}

type McpEntry = NonNullable<Config["mcp"]>[string]
type ProviderEntry = NonNullable<Config["provider"]>[string]

export type McpSelection = {
  scope: "global" | "project"
  directory: string
  name: string
}

export function mcpSelectionID(input: McpSelection): string {
  return `mcp:${input.scope}:${encodeURIComponent(input.directory)}:${encodeURIComponent(input.name)}`
}

export function parseMcpSelectionID(input: string): McpSelection | undefined {
  const match = /^mcp:(global|project):([^:]*):([^:]+)$/.exec(input)
  if (!match) return
  return {
    scope: match[1] as McpSelection["scope"],
    directory: decodeURIComponent(match[2]),
    name: decodeURIComponent(match[3]),
  }
}

export function formatArgv(argv: string[]): string {
  if (argv.some((arg) => /[\r\n]/.test(arg))) return JSON.stringify(argv)
  return argv
    .map((arg) => {
      if (arg && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
      return `'${arg.replaceAll("'", `'"'"'`)}'`
    })
    .join(" ")
}

export function parseArgv(input: string): string[] {
  const trimmed = input.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
      throw new Error("Command JSON must be an array of strings.")
    return parsed
  }
  const result: string[] = []
  let token = ""
  let started = false
  let quote: "'" | '"' | undefined
  let escaped = false
  let escapedInDouble = false

  const push = () => {
    if (!started) return
    result.push(token)
    token = ""
    started = false
  }

  for (const char of input) {
    if (escaped) {
      if (escapedInDouble && !['"', "\\", "$", "`"].includes(char)) token += "\\"
      token += char
      started = true
      escaped = false
      escapedInDouble = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      escapedInDouble = quote === '"'
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    token += char
    started = true
  }
  if (escaped) throw new Error("Command ends with an incomplete escape.")
  if (quote) throw new Error("Command contains an unterminated quote.")
  push()
  return result
}

function object(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function mcpEntries(input: string): Record<string, McpEntry> {
  const config = object(parse(input))
  const mcp = object(config?.mcp)
  return (mcp ?? {}) as Record<string, McpEntry>
}

function providerEntries(input: string): Record<string, ProviderEntry> {
  const config = object(parse(input))
  const provider = object(config?.provider)
  return (provider ?? {}) as Record<string, ProviderEntry>
}

function order(record: ProjectConfigRecord) {
  return (
    {
      "config.json": 0,
      "opencode.json": 1,
      "opencode.jsonc": 2,
      ".opencode/opencode.json": 3,
      ".opencode/opencode.jsonc": 4,
    }[record.file.label] ?? -1
  )
}

function merge(left: unknown, right: unknown): unknown {
  const a = object(left)
  const b = object(right)
  if (!a || !b) return right
  const result: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) result[key] = key in result ? merge(result[key], value) : value
  return result
}

function sorted(records: ProjectConfigRecord[]) {
  return [...records].sort((a, b) => order(a) - order(b))
}

export function declaredProviderEntry(records: ProjectConfigRecord[], name: string): ProviderEntry | undefined {
  let result: ProviderEntry | undefined
  for (const record of sorted(records)) {
    const entries = providerEntries(record.text)
    if (!Object.hasOwn(entries, name)) continue
    result = merge(result, entries[name]) as ProviderEntry
  }
  return result
}

export function declaredMcpEntry(records: ProjectConfigRecord[], name: string): McpEntry | undefined {
  let result: McpEntry | undefined
  for (const record of sorted(records)) {
    const entries = mcpEntries(record.text)
    if (!Object.hasOwn(entries, name)) continue
    result = merge(result, entries[name]) as McpEntry
  }
  return result
}

export function declaredMcpEntries(records: ProjectConfigRecord[]): Record<string, McpEntry> {
  return sorted(records).reduce(
    (result, record) => merge(result, mcpEntries(record.text)) as Record<string, McpEntry>,
    {},
  )
}

export function mcpDeclarationRecords(records: ProjectConfigRecord[], name: string): ProjectConfigRecord[] {
  return records.filter((record) => Object.hasOwn(mcpEntries(record.text), name))
}

export function selectProjectMcpConfig(
  records: ProjectConfigRecord[],
  name: string,
  creating: boolean,
): ProjectConfigRecord | undefined {
  const declared = sorted(records)
    .reverse()
    .find((record) => Object.hasOwn(mcpEntries(record.text), name))
  if (declared || !creating) return declared
  return (
    records.find((record) => record.file.label === ".opencode/opencode.jsonc") ??
    records.find((record) => record.file.label === "opencode.jsonc") ??
    records[0]
  )
}

function patch(input: string, path: (string | number)[], value: unknown): string {
  return applyEdits(
    input,
    modify(input, path, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    }),
  )
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function emptyMapAsUndefined(input: unknown) {
  const value = object(input)
  if (value && Object.keys(value).length === 0) return undefined
  return input
}

function declaredValue(raw: unknown, effective: unknown, next: unknown): unknown {
  if (same(effective, next)) return raw
  const after = object(next)
  if (!after) return next
  const before = object(effective) ?? {}
  const declared = object(raw) ?? {}
  return Object.fromEntries(
    Object.entries(after).flatMap(([key, value]) => {
      const resolved = declaredValue(declared[key], before[key], value)
      return resolved === undefined ? [] : [[key, resolved]]
    }),
  )
}

export function updateProjectMcpText(
  input: string,
  name: string,
  value: McpEntry | undefined,
  effective?: McpEntry,
  declared?: McpEntry,
): string {
  if (value === undefined) {
    const updated = patch(input, ["mcp", name], undefined)
    return Object.keys(mcpEntries(updated)).length === 0 ? patch(updated, ["mcp"], undefined) : updated
  }
  if (!effective) return patch(input, ["mcp", name], value)

  const before = object(effective) ?? {}
  const after = object(value) ?? {}
  const raw = object(declared ?? mcpEntries(input)[name]) ?? {}
  const type = after.type
  const controlled =
    type === "local"
      ? ["type", "command", "environment", ...(before.type === "remote" ? ["url", "headers"] : [])]
      : ["type", "url", "headers", ...(before.type === "local" ? ["command", "environment"] : [])]
  return controlled.reduce((text, key) => {
    const next =
      key === "headers" || key === "environment"
        ? declaredValue(raw[key], before[key], after[key])
        : after[key]
    if (same(before[key], next)) return text
    if ((key === "headers" || key === "environment") && same(before[key], after[key])) return text
    return patch(text, ["mcp", name, key], next)
  }, input)
}

export function changedProviderEntry(
  effective: ProviderEntry | undefined,
  next: ProviderEntry,
  apiKeyDirty: boolean,
  declared?: ProviderEntry,
): ProviderEntry | undefined {
  if (!effective) return next
  const before = object(effective) ?? {}
  const after = object(next) ?? {}
  const result: Record<string, unknown> = {}
  for (const key of ["name", "npm"]) {
    if (!Object.hasOwn(after, key) || same(before[key], after[key])) continue
    result[key] = after[key]
  }
  if (!same(before.env, after.env)) result.env = after.env ?? []
  if (!same(before.models, after.models)) result.models = declaredValue(object(declared)?.models, before.models, after.models ?? {})

  const beforeOptions = object(before.options) ?? {}
  const afterOptions = object(after.options) ?? {}
  const declaredOptions = object(object(declared)?.options) ?? {}
  const options: Record<string, unknown> = {}
  for (const key of ["baseURL", "headers"]) {
    const beforeValue = key === "headers" ? emptyMapAsUndefined(beforeOptions[key]) : beforeOptions[key]
    const afterValue = key === "headers" ? emptyMapAsUndefined(afterOptions[key]) : afterOptions[key]
    if (same(beforeValue, afterValue)) continue
    options[key] =
      key === "headers"
        ? declaredValue(declaredOptions[key], beforeValue, afterValue ?? {})
        : (afterValue ?? "")
  }
  if (apiKeyDirty) options.apiKey = afterOptions.apiKey ?? ""
  if (Object.keys(options).length > 0) result.options = options
  return Object.keys(result).length > 0 ? (result as ProviderEntry) : undefined
}

export function globalProviderPatch(
  provider?: NonNullable<Config["provider"]>,
  disabledProviders?: string[],
): Config {
  return {
    ...(provider && Object.keys(provider).length > 0 ? { provider } : {}),
    ...(disabledProviders ? { disabled_providers: disabledProviders } : {}),
  }
}
