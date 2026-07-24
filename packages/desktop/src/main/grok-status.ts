import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execFileAsync = promisify(execFile)
const GROK_SOURCE_URL = "https://grok.com"

export function defaultGrokHome() {
  return join(homedir(), ".grok")
}

export function resolveGrokHome(config?: CliAgentConfig) {
  const override = config?.configHome?.trim()
  return override ? resolveDesktopPath(override) : defaultGrokHome()
}

export async function resolveGrokBinary(config?: CliAgentConfig): Promise<string | undefined> {
  const override = config?.binaryPath?.trim()
  if (override) {
    if (isAbsolute(override) || override.includes("/") || override.includes("\\")) return resolveDesktopPath(override)
    return (await whichCommand(override)) ?? override
  }
  const fromPath = await whichCommand(process.platform === "win32" ? "grok.exe" : "grok")
  if (fromPath) return fromPath
  const managed = join(defaultGrokHome(), "bin", process.platform === "win32" ? "grok.exe" : "grok")
  return (await exists(managed)) ? managed : undefined
}

export async function getGrokInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const configHome = resolveGrokHome(config)
  const configPath = join(configHome, "config.toml")
  const info: CliAgentInfo = { sourceUrl: GROK_SOURCE_URL, installed: false, configHome, configPath, checkedAt: Date.now() }
  try {
    const binaryPath = await resolveGrokBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      info.version = await commandVersion(binaryPath)
      info.installed = !!info.version || (await exists(binaryPath))
    }
    info.configExists = await exists(configPath)
    if (info.configExists) info.details = parseGrokConfigToml(await readFile(configPath, "utf8"))
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }
  return info
}

export function parseGrokConfigToml(text: string): CliAgentDetail[] {
  let section = ""
  let rootModel: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      section = header[1] ?? ""
      continue
    }
    const entry = line.match(/^\s*([\w_]+)\s*=\s*["']([^"']+)["']/)
    if (!entry) continue
    if (section === "ui" && entry[1] === "fork_secondary_model") return [{ label: "Model", value: entry[2]! }]
    if (!section && entry[1] === "model") rootModel = entry[2]
  }
  return rootModel ? [{ label: "Model", value: rootModel }] : []
}

export async function testGrokConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const info = await getGrokInfo(config)
  const logs = [
    `Config home: ${info.configHome ?? "-"}`,
    `Config path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`,
    `Binary: ${info.binaryPath ?? "not found"}`,
    `Version: ${info.version ?? "unknown"}`,
    `Installed: ${info.installed ? "yes" : "no"}`,
    ...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`),
  ]
  if (info.error) logs.push(`Probe error: ${info.error}`)
  if (!info.installed) return { ok: false, logs: [...logs, "Grok Build CLI is not installed or not on PATH."] }
  if (!info.version) return { ok: false, logs: [...logs, "Grok binary was found but `--version` returned no output."] }
  return { ok: true, logs: [...logs, "Grok Build CLI probe succeeded."] }
}

async function commandVersion(command: string) {
  const result = await execFileAsync(command, ["--version"], { timeout: 5000, windowsHide: true, env: process.env }).catch(() => undefined)
  const text = result?.stdout?.trim() || result?.stderr?.trim()
  return text?.split(/\r?\n/)[0]
}

async function whichCommand(command: string) {
  const checker = process.platform === "win32" ? "where" : "which"
  const result = await execFileAsync(checker, [command], { timeout: 3000, windowsHide: true, env: process.env }).catch(() => undefined)
  return result?.stdout?.trim().split(/\r?\n/)[0] || undefined
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
