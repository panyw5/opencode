import { isFilePath, localPath, normalizePath } from "./config-source"

export type ConfigPluginEntry = string | [string, Record<string, unknown>]

export function pluginSpecifier(entry: ConfigPluginEntry) {
  return Array.isArray(entry) ? entry[0] : entry
}

export function pluginKey(value: string) {
  const next = localPath(value)
  if (isFilePath(value) || value.includes("/") || value.includes("\\")) return normalizePath(next)
  const last = value.lastIndexOf("@")
  return last > 0 ? value.slice(0, last) : value
}

function isRelativePluginSpecifier(value: string) {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../")
}

function configFileURL(path: string) {
  return path.startsWith("file://") ? path : `file://${path}`
}

/** Resolves a JSONC plugin entry the same way the server resolves relative specs. */
export function configPluginKey(entry: ConfigPluginEntry, configPath: string) {
  const value = pluginSpecifier(entry)
  if (!isRelativePluginSpecifier(value)) return pluginKey(value)
  return pluginKey(new URL(value, configFileURL(configPath)).href)
}

export function relativePluginSpecifier(path: string, configPath: string) {
  const target = normalizePath(localPath(path))
  const base = normalizePath(localPath(new URL(".", configFileURL(configPath)).href))
  if (target.startsWith(base + "/")) return `./${target.slice(base.length + 1)}`
  return path
}

export function updatePluginEntries(input: {
  entries: unknown
  configPath: string
  key: string
  nextSpecifier: string
  enabled: boolean
}): ConfigPluginEntry[] {
  const entries = Array.isArray(input.entries)
    ? input.entries.filter(
        (entry): entry is ConfigPluginEntry =>
          typeof entry === "string" ||
          (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "object" && entry[1] !== null),
      )
    : []
  const matching = entries.filter((entry) => configPluginKey(entry, input.configPath) === input.key)
  const remaining = entries.filter((entry) => configPluginKey(entry, input.configPath) !== input.key)
  if (!input.enabled) return remaining
  return matching.length ? [...remaining, matching.at(-1)!] : [...remaining, input.nextSpecifier]
}
