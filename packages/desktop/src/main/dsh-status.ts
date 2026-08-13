import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"
import {
  clearDshApiKey,
  DSH_DEFAULT_BASE_URL,
  DSH_DEFAULT_MODEL,
  DSH_DEFAULT_PROVIDER,
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
