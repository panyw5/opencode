import { execFile } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type {
  CliAgentConfig,
  CliAgentDetail,
  CliAgentInfo,
  CliAgentTest,
  DshPluginEntry,
  DshPluginInventory,
} from "../preload/types"
import { resolveDesktopPath } from "./native-path"
import {
  clearDshApiKey,
  DSH_DEFAULT_BASE_URL,
  DSH_DEFAULT_MODEL,
  DSH_DEFAULT_PROVIDER,
  readDshApiKey,
  readDshHomeSnapshot,
  resolveDshHomePath,
  writeDshApiKey,
  writeDshModelSelection,
  type DshHomeSnapshot,
  type DshModelSelection,
} from "./dsh-home"

const execFileAsync = promisify(execFile)
const DSH_SOURCE_URL = "https://github.com/deepseek-ai/deepseek-harness"

export function defaultDshHome() {
  return resolveDshHomePath()
}

export function resolveDshHome(config?: CliAgentConfig) {
  return resolveDshHomePath(config?.configHome)
}

export type { DshHomeSnapshot, DshModelSelection }

export async function resolveDshBinary(config?: CliAgentConfig): Promise<string | undefined> {
  const override = config?.binaryPath?.trim()
  if (override) {
    if (isAbsolute(override) || override.includes("/") || override.includes("\\")) {
      const path = resolveDesktopPath(override)
      if (await exists(path)) return path
      return path
    }
    const fromPath = await whichCommand(override)
    if (fromPath) return fromPath
    return override
  }

  const candidates = process.platform === "win32" ? ["dsh.exe", "dsh"] : ["dsh"]
  for (const name of candidates) {
    const found = await whichCommand(name)
    if (found) return found
  }
  return undefined
}

export async function getDshInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const checkedAt = Date.now()
  const configHome = resolveDshHome(config)
  const home = await readDshHomeSnapshot(config?.configHome)
  const info: CliAgentInfo = {
    sourceUrl: DSH_SOURCE_URL,
    installed: false,
    configHome,
    configPath: home.settingsPath,
    checkedAt,
    dsh: {
      provider: home.selection.provider,
      model: home.selection.model,
      baseURL: home.selection.baseURL || "",
      hasFileApiKey: home.hasFileApiKey,
      apiKeyEnvSet: home.apiKeyEnvSet,
      baseUrlEnvSet: home.baseUrlEnvSet,
      settingsPath: home.settingsPath,
      credentialsPath: home.credentialsPath,
    },
  }

  try {
    const binaryPath = await resolveDshBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      const version = await commandVersion(binaryPath)
      info.version = version
      info.installed = !!version || (await exists(binaryPath))
    }

    info.configExists = home.settingsExists || home.credentialsExists
    info.details = details({
      "Config home": configHome,
      Provider: home.selection.provider,
      Model: home.selection.model,
      "Base URL": home.selection.baseURL || (home.baseUrlEnvSet ? "DEEPSEEK_BASE_URL env" : DSH_DEFAULT_BASE_URL),
      Credentials: home.hasFileApiKey ? "file key present" : "no file key",
      "API key env": home.apiKeyEnvSet ? "DEEPSEEK_API_KEY set" : "not set",
    })
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }

  return info
}

export async function getDshHomeConfig(config?: CliAgentConfig): Promise<DshHomeSnapshot> {
  return readDshHomeSnapshot(config?.configHome)
}

export async function getDshApiKey(config?: CliAgentConfig): Promise<string | undefined> {
  return readDshApiKey(config?.configHome)
}

export async function setDshHomeConfig(
  config: CliAgentConfig,
  input: {
    provider?: string
    model?: string
    baseURL?: string
    apiKey?: string
    clearApiKey?: boolean
  },
): Promise<DshHomeSnapshot> {
  const provider = input.provider?.trim() || DSH_DEFAULT_PROVIDER
  const model = input.model?.trim() || DSH_DEFAULT_MODEL
  const baseURL = input.baseURL?.trim() || ""
  await writeDshModelSelection(config.configHome, { provider, model, baseURL })
  if (input.clearApiKey) {
    await clearDshApiKey(config.configHome)
  } else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    await writeDshApiKey(config.configHome, input.apiKey)
  }
  return readDshHomeSnapshot(config.configHome)
}

export async function testDshConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const logs: string[] = []
  try {
    const info = await getDshInfo(config)
    logs.push(`Config home: ${info.configHome ?? "-"}`)
    logs.push(`Credentials path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`)
    logs.push(`Binary: ${info.binaryPath ?? "not found"}`)
    logs.push(`Version: ${info.version ?? "unknown"}`)
    logs.push(`Installed: ${info.installed ? "yes" : "no"}`)
    logs.push(...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`))
    if (info.error) logs.push(`Probe error: ${info.error}`)

    if (!info.installed) {
      logs.push("DeepSeek Harness CLI is not installed or not on PATH.")
      logs.push("Install with: npm i -g @deepseek-ai/dsh")
      logs.push("Then export DEEPSEEK_API_KEY or configure credentials under ~/.dsh.")
      return { ok: false, logs }
    }

    if (!info.version) {
      logs.push("dsh binary was found but `-V` returned no output.")
      return { ok: false, logs }
    }

    logs.push("DeepSeek Harness CLI probe succeeded.")
    return { ok: true, logs }
  } catch (error) {
    logs.push(error instanceof Error ? error.message : String(error))
    return { ok: false, logs }
  }
}

const DEFAULT_PLUGIN_PROFILE = "headless"

/** Parse `dsh --dump-config` YAML-ish text into plugin rows. */
export function parseDshDumpConfig(text: string): DshPluginEntry[] {
  const plugins: DshPluginEntry[] = []
  let source: string | undefined
  let current: DshPluginEntry | undefined
  let inConfig = false
  let configLines: string[] = []

  const flushConfig = () => {
    if (!current || !inConfig) return
    const preview = configLines.join("\n").trim()
    if (preview) current.configPreview = preview.length > 600 ? `${preview.slice(0, 600)}…` : preview
    inConfig = false
    configLines = []
  }

  const flushCurrent = () => {
    flushConfig()
    if (current) plugins.push(current)
    current = undefined
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "")
    if (!line.trim()) continue

    const section = /^#\s*==\s*(.+)\s*$/.exec(line)
    if (section) {
      flushCurrent()
      source = section[1]!.trim()
      continue
    }

    const idMatch = /^- id:\s*(.+)\s*$/.exec(line)
    if (idMatch) {
      flushCurrent()
      current = {
        id: unquoteYamlScalar(idMatch[1]!),
        source,
      }
      continue
    }

    if (!current) continue

    if (/^ {2}name:\s*/.test(line)) {
      flushConfig()
      current.name = unquoteYamlScalar(line.slice("  name:".length))
      continue
    }

    if (/^ {2}disabled:\s*/.test(line)) {
      flushConfig()
      const rawValue = line.slice("  disabled:".length).trim()
      if (rawValue === "true") current.disabled = true
      else if (rawValue === "false") current.disabled = false
      else current.disabled = rawValue
      continue
    }

    if (/^ {2}config:\s*$/.test(line)) {
      flushConfig()
      inConfig = true
      configLines = []
      continue
    }

    if (inConfig) {
      if (/^ {2}\S/.test(line) && !/^ {4}/.test(line)) {
        flushConfig()
        // Fall through so a sibling key on this line is still processed.
      } else {
        configLines.push(line)
        continue
      }
    }

    if (/^ {2}name:\s*/.test(line)) {
      current.name = unquoteYamlScalar(line.slice("  name:".length))
    } else if (/^ {2}disabled:\s*/.test(line)) {
      const rawValue = line.slice("  disabled:".length).trim()
      if (rawValue === "true") current.disabled = true
      else if (rawValue === "false") current.disabled = false
      else current.disabled = rawValue
    }
  }

  flushCurrent()
  return plugins
}

export async function listDshPlugins(
  config?: CliAgentConfig,
  profile = DEFAULT_PLUGIN_PROFILE,
): Promise<DshPluginInventory> {
  const checkedAt = Date.now()
  const resolvedProfile = profile.trim() || DEFAULT_PLUGIN_PROFILE
  const empty: DshPluginInventory = {
    profile: resolvedProfile,
    checkedAt,
    plugins: [],
    sources: [],
  }

  try {
    const binaryPath = await resolveDshBinary(config)
    if (!binaryPath) {
      return {
        ...empty,
        error: "DeepSeek Harness CLI (`dsh`) not found on PATH.",
      }
    }

    const env: NodeJS.ProcessEnv = { ...process.env }
    const home = resolveDshHome(config)
    if (home) env.DSH_HOME = home

    const result = await execFileAsync(binaryPath, ["--profile", resolvedProfile, "--dump-config"], {
      timeout: 20_000,
      windowsHide: true,
      env,
      maxBuffer: 8 * 1024 * 1024,
    })
    const text = result.stdout?.toString() ?? ""
    const plugins = parseDshDumpConfig(text)
    const sources = [...new Set(plugins.map((plugin) => plugin.source).filter(Boolean) as string[])]
    return {
      profile: resolvedProfile,
      checkedAt,
      binaryPath,
      plugins,
      sources,
    }
  } catch (error) {
    return {
      ...empty,
      binaryPath: await resolveDshBinary(config).catch(() => undefined),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Absolute path of a profile's user patch file under DSH_HOME. */
export function resolveDshProfilePatchPath(configHome: string | undefined, profile: string) {
  const home = resolveDshHomePath(configHome)
  const name = profile.trim() || DEFAULT_PLUGIN_PROFILE
  return join(home, "profiles", name, "cordis.patch.yml")
}

/**
 * Enable/disable one plugin by editing the profile's cordis.patch.yml.
 * Returns the refreshed inventory after the write.
 */
export async function setDshPluginEnabled(
  config: CliAgentConfig | undefined,
  input: { profile?: string; id: string; enabled: boolean },
): Promise<DshPluginInventory> {
  const profile = input.profile?.trim() || DEFAULT_PLUGIN_PROFILE
  const id = input.id.trim()
  if (!id) throw new Error("plugin id is required")
  if (/\s/.test(id) || id.includes(":") || id.includes("#")) {
    throw new Error(`invalid plugin id: ${JSON.stringify(id)}`)
  }

  const patchPath = resolveDshProfilePatchPath(config?.configHome, profile)
  await mkdir(join(patchPath, ".."), { recursive: true }).catch(() => undefined)

  let existing = ""
  try {
    existing = await readFile(patchPath, "utf8")
  } catch {
    existing = "[]\n"
  }

  const next = upsertPluginDisabledPatch(existing, id, !input.enabled)
  await writeFile(patchPath, next, { encoding: "utf8", mode: 0o600 })
  return listDshPlugins(config, profile)
}

/**
 * Upsert/remove a `disabled` flag for one plugin id in a cordis patch YAML list.
 * When disabling: ensures `- id: <id>` with `disabled: true`.
 * When enabling: removes `disabled: true` for that id; drops the entry if it only carried disabled.
 */
export function upsertPluginDisabledPatch(text: string, id: string, disabled: boolean): string {
  const entries = splitTopLevelYamlListEntries(text)
  const targetIndex = entries.findIndex((entry) => entryId(entry) === id)

  if (disabled) {
    if (targetIndex >= 0) {
      entries[targetIndex] = setEntryDisabled(entries[targetIndex]!, true)
    } else {
      entries.push(`- id: ${id}\n  disabled: true`)
    }
  } else if (targetIndex >= 0) {
    const cleared = setEntryDisabled(entries[targetIndex]!, false)
    if (!cleared.trim() || cleared.trim() === `- id: ${id}`) {
      entries.splice(targetIndex, 1)
    } else {
      entries[targetIndex] = cleared
    }
  }

  if (entries.length === 0) {
    return [
      "# Your patch layer for this dsh profile, applied after every bundle layer:",
      "# a top-level YAML array of loader patch entries (id-targeted config",
      "# overrides, disables, and insert lists; `!!js` expressions allowed).",
      "[]",
      "",
    ].join("\n")
  }

  const body = entries.map((entry) => entry.replace(/\s+$/, "")).join("\n")
  return `${body}\n`
}

/** Split a top-level YAML sequence into raw entry blocks (starting with `- `). */
export function splitTopLevelYamlListEntries(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)
  const entries: string[] = []
  let current: string[] = []

  const flush = () => {
    if (current.length === 0) return
    const block = current.join("\n").trimEnd()
    if (block) entries.push(block)
    current = []
  }

  for (const line of lines) {
    if (/^\s*#/.test(line) && current.length === 0) continue
    if (line.trim() === "[]" && current.length === 0) continue
    if (/^- /.test(line)) {
      flush()
      current.push(line)
      continue
    }
    if (current.length > 0) current.push(line)
  }
  flush()
  return entries
}

function entryId(entry: string): string | undefined {
  const match = /^- id:\s*(.+)\s*$/m.exec(entry)
  if (!match) return undefined
  return unquoteYamlScalar(match[1]!)
}

function setEntryDisabled(entry: string, disabled: boolean): string {
  const lines = entry.split(/\r?\n/)
  const out: string[] = []
  let sawDisabled = false
  for (const line of lines) {
    if (/^ {2}disabled:\s*/.test(line)) {
      sawDisabled = true
      if (disabled) out.push("  disabled: true")
      continue
    }
    out.push(line)
  }
  if (disabled && !sawDisabled) {
    // Insert disabled after the id line when possible.
    if (out.length > 0 && /^- id:\s*/.test(out[0]!)) {
      out.splice(1, 0, "  disabled: true")
    } else {
      out.push("  disabled: true")
    }
  }
  // Drop empty trailing lines.
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop()
  return out.join("\n")
}

function unquoteYamlScalar(value: string): string {
  let text = value.trim()
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    text = text.slice(1, -1)
  }
  return text
}

async function commandVersion(command: string) {
  for (const args of [["-V"], ["--version"]] as const) {
    const result = await execFileAsync(command, [...args], {
      timeout: 5000,
      windowsHide: true,
      env: process.env,
    }).catch(() => undefined)
    const text = result?.stdout?.trim() || result?.stderr?.trim()
    if (!text) continue
    return text.split(/\r?\n/)[0]
  }
  return undefined
}

async function whichCommand(command: string) {
  const checker = process.platform === "win32" ? "where" : "which"
  const result = await execFileAsync(checker, [command], {
    timeout: 3000,
    windowsHide: true,
    env: process.env,
  }).catch(() => undefined)
  const line = result?.stdout?.trim().split(/\r?\n/)[0]
  return line || undefined
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function details(values: Record<string, string | undefined>): CliAgentDetail[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => ({ label, value: value! }))
}
