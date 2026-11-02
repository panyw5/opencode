import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { setTimeout as wait } from "node:timers/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { parseDshCredentials, serializeDshCredentials, updateDshCredential } from "@opencode-ai/util/dsh-credentials"
import { resolveDesktopPath } from "./native-path"

export const DSH_DEFAULT_PROVIDER = "deepseek-official"
export const DSH_DEFAULT_MODEL = "deepseek-v4-flash"
export const DSH_DEFAULT_BASE_URL = "https://api.deepseek.com"
export const DSH_API_KEY_REF = "DEEPSEEK_API_KEY"
export const DSH_BASE_URL_ENV = "DEEPSEEK_BASE_URL"

export type DshModelSelection = {
  provider: string
  model: string
  /** Optional endpoint for llm-deepseek; empty means public default / env. */
  baseURL?: string
}

export type DshHomeSnapshot = {
  home: string
  settingsPath: string
  credentialsPath: string
  selection: DshModelSelection
  hasFileApiKey: boolean
  apiKeyEnvSet: boolean
  baseUrlEnvSet: boolean
  settingsExists: boolean
  credentialsExists: boolean
}

export function resolveDshHomePath(configHome?: string) {
  const override = configHome?.trim()
  if (override) return resolveDesktopPath(override)
  const env = process.env.DSH_HOME?.trim()
  if (env) return resolveDesktopPath(env)
  return join(homedir(), ".dsh")
}

export async function readDshHomeSnapshot(configHome?: string): Promise<DshHomeSnapshot> {
  const home = resolveDshHomePath(configHome)
  const settingsPath = join(home, "settings.yaml")
  const credentialsPath = join(home, ".credentials.yaml")
  const settingsExists = await exists(settingsPath)
  const credentialsExists = await exists(credentialsPath)

  let selection: DshModelSelection = {
    provider: DSH_DEFAULT_PROVIDER,
    model: DSH_DEFAULT_MODEL,
    baseURL: "",
  }
  if (settingsExists) {
    try {
      const text = await readFile(settingsPath, "utf8")
      const agent = parseYamlSection(text, "agent-default-model")
      const llm = parseYamlSection(text, "llm-deepseek")
      selection = {
        provider: agent.provider?.trim() || DSH_DEFAULT_PROVIDER,
        model: agent.model?.trim() || DSH_DEFAULT_MODEL,
        baseURL: llm.baseURL?.trim() || "",
      }
    } catch {
      // keep defaults
    }
  }

  let hasFileApiKey = false
  if (credentialsExists) {
    try {
      const text = await readFile(credentialsPath, "utf8")
      const map = parseCredentialsYaml(text)
      hasFileApiKey = !!map.get(DSH_API_KEY_REF)?.trim()
    } catch {
      hasFileApiKey = false
    }
  }

  return {
    home,
    settingsPath,
    credentialsPath,
    selection,
    hasFileApiKey,
    apiKeyEnvSet: !!process.env.DEEPSEEK_API_KEY?.trim(),
    baseUrlEnvSet: !!process.env.DEEPSEEK_BASE_URL?.trim(),
    settingsExists,
    credentialsExists,
  }
}

export async function writeDshModelSelection(
  configHome: string | undefined,
  selection: DshModelSelection,
): Promise<void> {
  const home = resolveDshHomePath(configHome)
  const settingsPath = join(home, "settings.yaml")
  await mkdir(home, { recursive: true, mode: 0o700 }).catch(() => undefined)

  let existing = ""
  try {
    existing = await readFile(settingsPath, "utf8")
  } catch {
    existing = ""
  }

  let next = upsertYamlSection(existing, "agent-default-model", {
    provider: selection.provider.trim() || DSH_DEFAULT_PROVIDER,
    model: selection.model.trim() || DSH_DEFAULT_MODEL,
  })
  const baseURL = selection.baseURL?.trim() ?? ""
  if (baseURL) {
    next = upsertYamlSection(next, "llm-deepseek", { baseURL })
  } else {
    next = removeYamlSection(next, "llm-deepseek")
  }
  await writeFile(settingsPath, next, { encoding: "utf8", mode: 0o600 })
  await chmod(settingsPath, 0o600).catch(() => undefined)
}

/** Read DEEPSEEK_API_KEY from ~/.dsh/.credentials.yaml, falling back to process env. */
export async function readDshApiKey(configHome?: string): Promise<string | undefined> {
  const home = resolveDshHomePath(configHome)
  const credentialsPath = join(home, ".credentials.yaml")
  try {
    const text = await readFile(credentialsPath, "utf8")
    const map = parseCredentialsYaml(text)
    const fileKey = map.get(DSH_API_KEY_REF)?.trim()
    if (fileKey) return fileKey
  } catch {
    // missing or unreadable credentials file
  }
  const envKey = process.env.DEEPSEEK_API_KEY?.trim()
  return envKey || undefined
}

export async function writeDshApiKey(configHome: string | undefined, apiKey: string): Promise<void> {
  const key = apiKey.trim()
  if (!key) throw new Error("API key must be non-empty")
  await updateCredentialsFile(configHome, key)
}

export async function clearDshApiKey(configHome: string | undefined): Promise<void> {
  await updateCredentialsFile(configHome, undefined)
}

async function updateCredentialsFile(configHome: string | undefined, value: string | undefined) {
  const filename = join(resolveDshHomePath(configHome), ".credentials.yaml")
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  // Same exclusive-create lock as DSH. Never steal an uncertain/stale lock.
  const lock = filename + ".lock"
  const deadline = Date.now() + 5000
  console.info("[dsh-home] credentials lock-wait operation=" + (value === undefined ? "clear" : "save"))
  for (;;) {
    try {
      await writeFile(lock, process.pid + "\n", { flag: "wx", mode: 0o600 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) throw new Error("DSH credentials are locked by another writer; retry later")
      await wait(50)
    }
  }
  const temp = filename + "." + randomUUID() + ".tmp"
  try {
    console.info("[dsh-home] credentials lock-acquired reading-document")
    const existing = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    const next = updateDshCredential(existing, DSH_API_KEY_REF, value)
    if (existing === next) return
    console.info("[dsh-home] credentials validated atomic-write")
    await writeFile(temp, next, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await rename(temp, filename)
    console.info("[dsh-home] credentials committed")
  } finally {
    await rm(temp, { force: true })
    await rm(lock, { force: true })
    console.info("[dsh-home] credentials lock-released")
  }
}

/** Parse a minimal credentials YAML mapping (ref -> non-empty string). */
export function parseCredentialsYaml(text: string): Map<string, string> {
  return parseDshCredentials(text)
}

export function serializeCredentialsYaml(map: Map<string, string>): string {
  return serializeDshCredentials(map)
}

/** @deprecated use parseYamlSection("agent-default-model") */
export function parseAgentDefaultModel(text: string): Partial<DshModelSelection> {
  const section = parseYamlSection(text, "agent-default-model")
  const out: Partial<DshModelSelection> = {}
  if (section.provider) out.provider = section.provider
  if (section.model) out.model = section.model
  return out
}

/** @deprecated use upsertYamlSection("agent-default-model", ...) */
export function upsertAgentDefaultModel(text: string, selection: DshModelSelection): string {
  return upsertYamlSection(text, "agent-default-model", {
    provider: selection.provider,
    model: selection.model,
  })
}

/** Extract simple scalar keys from a top-level YAML mapping section. */
export function parseYamlSection(text: string, sectionName: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  let inSection = false
  let sectionIndent = 0
  const out: Record<string, string> = {}
  const header = new RegExp(`^${escapeRegExp(sectionName)}\\s*:`)

  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue
    const indent = raw.match(/^\s*/)?.[0].length ?? 0
    const content = raw.trim()

    if (!inSection) {
      if (header.test(content)) {
        inSection = true
        sectionIndent = indent
      }
      continue
    }

    if (indent <= sectionIndent && content.includes(":")) {
      break
    }

    const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.+)$/.exec(content)
    if (!m) continue
    let value = m[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) out[m[1]!] = value
  }
  return out
}

/** Upsert a top-level YAML mapping section; preserves other sections when possible. */
export function upsertYamlSection(text: string, sectionName: string, fields: Record<string, string>): string {
  const fieldLines = Object.entries(fields)
    .filter(([, value]) => value.trim() !== "")
    .map(([key, value]) => `  ${key}: ${yamlScalar(value.trim())}`)
  const block = [`${sectionName}:`, ...fieldLines, ""].join("\n")

  if (!text.trim()) {
    return `# Managed by OpenCode DeepSeek advisor settings\n${block}`
  }

  const range = findYamlSectionRange(text, sectionName)
  if (!range) {
    const body = text.endsWith("\n") ? text : `${text}\n`
    return `${body}\n${block}`
  }

  const lines = text.split(/\r?\n/)
  const before = lines.slice(0, range.start)
  const after = lines.slice(range.end)
  const parts = [...before, ...block.trimEnd().split("\n"), ...after]
  let out = parts.join("\n")
  if (!out.endsWith("\n")) out += "\n"
  return out
}

/** Remove a top-level YAML mapping section if present. */
export function removeYamlSection(text: string, sectionName: string): string {
  const range = findYamlSectionRange(text, sectionName)
  if (!range) return text
  const lines = text.split(/\r?\n/)
  const before = lines.slice(0, range.start)
  const after = lines.slice(range.end)
  let out = [...before, ...after].join("\n")
  out = out.replace(/\n{3,}/g, "\n\n")
  if (!out.endsWith("\n") && out.length > 0) out += "\n"
  return out
}

function findYamlSectionRange(text: string, sectionName: string): { start: number; end: number } | undefined {
  const lines = text.split(/\r?\n/)
  const header = new RegExp(`^\\s*${escapeRegExp(sectionName)}\\s*:`)
  const start = lines.findIndex((line) => header.test(line))
  if (start < 0) return undefined

  const startIndent = lines[start]!.match(/^\s*/)?.[0].length ?? 0
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]!
    if (line.trim() === "" || /^\s*#/.test(line)) {
      let j = end + 1
      while (j < lines.length && (lines[j]!.trim() === "" || /^\s*#/.test(lines[j]!))) j++
      if (j >= lines.length) {
        end = lines.length
        break
      }
      const nextIndent = lines[j]!.match(/^\s*/)?.[0].length ?? 0
      if (nextIndent <= startIndent && lines[j]!.includes(":")) break
      end = j
      continue
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent <= startIndent && line.includes(":")) break
    end++
  }
  return { start, end }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function yamlScalar(value: string): string {
  if (/^[\w./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
